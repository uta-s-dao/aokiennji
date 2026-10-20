import './legacy-sqlite-harness';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import * as cheerio from 'cheerio';
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type Source,
  type StoredChatMessage,
} from '../lib/contracts';

// Uses real configured APIs and the real chat pipeline. Only the cloned DB is changed.
async function main() {
  if (!process.env.OPENAI_API_KEY) throw Error('OPENAI_API_KEY is required');
  if (process.env.LOCAL_AGENT_API_URL)
    throw Error('Disable LOCAL_AGENT_API_URL: this test requires the actual OpenAI API');
  const root = resolve(
    process.argv[2] ||
      `.data/verification/source-priority-${new Date().toISOString().replace(/[:.]/g, '-')}`,
  );
  if (!root.startsWith(resolve('.data/verification') + sep))
    throw Error('Use an isolated .data/verification directory');
  mkdirSync(root, { recursive: true });
  const sandbox = join(root, 'sandbox');
  mkdirSync(sandbox, { recursive: true });
  const originalFile = resolve(process.env.DATA_DIR || '.data', 'aokienji.sqlite');
  const snapshot = (database: Database.Database) =>
    Object.fromEntries(
      [
        'settings',
        'sources',
        'supplier_knowledge',
        'products',
        'documents',
        'conversations',
        'messages',
        'orders',
      ].map((table) => {
        const rows = database.prepare(`SELECT json FROM ${table} ORDER BY rowid`).all();
        return [
          table,
          {
            count: rows.length,
            hash: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
          },
        ];
      }),
    );
  const original = new Database(originalFile, { readonly: true });
  const before = snapshot(original);
  await original.backup(join(sandbox, 'aokienji.sqlite'));
  original.close();
  const clone = new Database(join(sandbox, 'aokienji.sqlite'));
  const saved = JSON.parse(
    (clone.prepare('SELECT json FROM settings WHERE id=1').get() as { json: string }).json,
  );
  const settings: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...saved,
    responseProvider: 'openai',
    responseModel:
      saved.responseModel ||
      process.env.OPENAI_MODEL ||
      DEFAULT_SETTINGS.responseModel ||
      'gpt-4.1-mini',
    decisionProvider: process.env.TYPESAFE_API_KEY ? 'jev' : 'local',
    searchProvider: 'openai',
    flags: {
      ...DEFAULT_SETTINGS.flags,
      ...saved.flags,
      webSearch: true,
      aiResearch: false,
      orders: false,
      autoOrder: false,
      autoQuote: false,
    },
  };
  clone.prepare('UPDATE settings SET json=? WHERE id=1').run(JSON.stringify(settings));
  clone.exec(
    'DELETE FROM messages; DELETE FROM conversations; DELETE FROM research_notes; DELETE FROM ai_calls; DELETE FROM audit_events; DELETE FROM sessions; DELETE FROM rate_limits;',
  );
  clone.close();
  process.env.DATA_DIR = sandbox;
  process.env.DEMO_MODE = 'true';
  process.env.ALLOW_LIVE_ORDERS = 'false';
  const { answerChat, currentMessages } = await import('../lib/server/chat');
  const { conversationMessages } = await import('../lib/server/business');
  const { researchNotes } = await import('../lib/server/research');
  const { aiUsageReport, pauseOpenaiForQuota } = await import('../lib/server/ai-usage');
  const { db, now, save, resetDbForTests } = await import('../lib/server/db');
  const { createSourceTrace, preferredDomains } = await import('../lib/server/preferred-sources');
  const { safeFetch } = await import('../lib/server/safe-fetch');
  const { decodeHtml } = await import('../lib/server/html');
  const scenarios = JSON.parse(
    readFileSync('scripts/fixtures/source-priority-scenarios.json', 'utf8'),
  ) as { id: string; question: string; importRealPage?: string }[];
  const write = (file: string, data: unknown) =>
    writeFileSync(join(root, file), JSON.stringify(data, null, 2));
  const report: {
    testedAt: string;
    settings: AppSettings;
    initialPreferredDomains: string[];
    scenarios: Record<string, unknown>[];
    originalUnchanged?: boolean;
  } = {
    testedAt: now(),
    settings,
    initialPreferredDomains: preferredDomains((await createSourceTrace())),
    scenarios: [],
  };
  write('environment.json', {
    ...report,
    originalSnapshot: before,
    sandbox,
    realApis: true,
    actualOrdersEnabled: false,
  });
  console.log(
    JSON.stringify({
      phase: 'ready',
      root,
      preferredDomains: report.initialPreferredDomains.length,
      responseModel: settings.responseModel,
    }),
  );
  for (const scenario of scenarios) {
    const startedAt = now();
    const owner = `source-priority-live-${scenario.id}`;
    let importedPage: Record<string, unknown> | undefined;
    try {
      if (scenario.importRealPage) {
        const response = await safeFetch(scenario.importRealPage, {
          timeoutMs: 15000,
          maxBytes: 2000000,
          maxRedirects: 3,
        });
        if (response.status !== 200) throw Error(`Import page HTTP ${response.status}`);
        const html = decodeHtml(response.body, response.headers.get('content-type'));
        const $ = cheerio.load(html);
        $('script,style,noscript,nav,header,footer').remove();
        const content = ($('main').text() || $('body').text()).replace(/\s+/g, ' ').trim();
        const source: Source = {
          id: 'live-import-real-page',
          name: '実API検証用：取得した実製品資料',
          kind: 'text',
          url: scenario.importRealPage,
          enabled: true,
          trust: 'internal',
          visibility: 'internal',
          syncIntervalHours: 0,
          config: {},
          lastSyncedAt: now(),
          lastError: null,
          recordCount: 1,
          createdAt: now(),
        };
        (await save('sources', source));
        (await save(
          'documents',
          {
            id: 'live-import-real-document',
            sourceId: source.id,
            title: '取得した実ページの本文（検証DBのみ）',
            content,
            url: response.url,
            createdAt: now(),
          },
          { source_id: source.id, content },
        ));
        importedPage = {
          url: response.url,
          status: response.status,
          contentHash: createHash('sha256').update(html).digest('hex'),
          importedAt: now(),
        };
        write('imported-page.json', importedPage);
        writeFileSync(join(root, 'imported-page.html'), html);
      }
      const reply = await answerChat(scenario.question, owner);
      const messages = (await conversationMessages(reply.conversationId)) as StoredChatMessage[];
      const stored = messages.find((m) => m.id === reply.message.id)!;
      const notes = (await researchNotes(reply.conversationId));
      const calls = (await aiUsageReport({ conversationId: reply.conversationId, limit: 500 }));
      const trace = stored.sourceTrace!;
      const scopes = trace.stages.map((s) => s.scope);
      const firstNetwork = trace.stages.find((s) => s.scope !== 'registered_data');
      const checks = {
        actualOpenaiReply:
          reply.message.responseProvider === 'openai' &&
          calls.items.some(
            (c) => c.provider === 'openai' && c.purpose === 'response' && c.outcome === 'accepted',
          ),
        traceStoredWithAnswer: !!trace && !!stored.replyToId,
        searchMetadataRecorded: trace.stages
          .filter(
            (s) =>
              s.scope !== 'registered_data' && s.scope !== 'past_sources' && s.status === 'done',
          )
          .every((s) => !!s.searches?.length),
        allPreferredSitesInFirstSearch: scenario.importRealPage
          ? !firstNetwork
          : firstNetwork?.scope === 'preferred_sites' &&
            report.initialPreferredDomains.every((d) => firstNetwork.domains.includes(d)),
        externalOnlyAfterPreferred:
          !scopes.includes('public_web') ||
          (scopes.indexOf('preferred_sites') >= 0 &&
            scopes.indexOf('preferred_sites') < scopes.indexOf('public_web')),
        privateTraceExcludedFromPublic: !JSON.stringify([
          reply,
          (await currentMessages(reply.conversationId)),
        ]).includes('sourceTrace'),
        noAutomaticProcurementApproval: notes.every((n) =>
          (n.offers || []).every(
            (o) => !o.approved && o.availableQuantity === null && o.confirmedAt === null,
          ),
        ),
      };
      const record = {
        ...scenario,
        startedAt,
        completedAt: now(),
        conversationId: reply.conversationId,
        answerId: stored.id,
        response: reply.message.content,
        responseProvider: reply.message.responseProvider,
        checks,
        importedPage,
        procurementAssessment: notes.flatMap((n) =>
          (n.offers || []).map((o) => ({
            title: o.title,
            url: o.url,
            discoveryBasis: o.discoveryBasis,
            assessment:
              o.discoveryBasis === 'registered_listing'
                ? '登録参照先で商品掲載を確認。発注窓口・数量・納期・取引条件は担当者確認'
                : '購入・見積窓口を確認。発注可否・数量・納期・取引条件は担当者確認',
          })),
        ),
        sourceTrace: trace,
        notes,
        messages,
        aiCalls: calls,
      };
      report.scenarios.push(record);
      write(`${scenario.id}.json`, record);
      console.log(
        JSON.stringify({
          id: scenario.id,
          provider: reply.message.responseProvider,
          checks,
          origins: [...new Set(trace.observations.map((o) => o.origin))],
          candidateCount: notes.reduce((n, r) => n + (r.offers?.length || 0), 0),
        }),
      );
    } catch (error) {
      const row = (await db()
        .prepare('SELECT id FROM conversations WHERE owner_id=? ORDER BY rowid DESC LIMIT 1')
        .get(owner)) as { id: string } | undefined;
      const record = {
        ...scenario,
        startedAt,
        completedAt: now(),
        error: error instanceof Error ? error.message : String(error),
        conversationId: row?.id,
        notes: row ? (await researchNotes(row.id)) : [],
        aiCalls: row ? (await aiUsageReport({ conversationId: row.id, limit: 500 })) : undefined,
      };
      report.scenarios.push(record);
      write(`${scenario.id}.json`, record);
      console.log(JSON.stringify({ id: scenario.id, error: record.error }));
    }
    write('results.json', report);
    // Record quota errors honestly; later requests may still verify deterministic fallback.
    pauseOpenaiForQuota(false);
  }
  const originalAfter = new Database(originalFile, { readonly: true });
  report.originalUnchanged = JSON.stringify(snapshot(originalAfter)) === JSON.stringify(before);
  originalAfter.close();
  write('results.json', report);
  const rows = report.scenarios.map((r) => ({
    id: r.id,
    conversationId: r.conversationId,
    responseProvider: r.responseProvider,
    checks: r.checks,
    error: r.error,
  }));
  write('summary.json', { ...report, scenarios: rows });
  const markdown = [
    '# 登録情報優先検索：実APIの会話記録',
    '',
    `実施日時：${report.testedAt}`,
    `OpenAI回答モデル：${settings.responseModel}`,
    `優先参照ドメイン：${report.initialPreferredDomains.length}件`,
    '',
    ...report.scenarios.flatMap((r) => [
      `## ${r.id}`,
      '',
      `質問：${r.question}`,
      '',
      `回答：${r.response || r.error}`,
      '',
      `会話ID：${r.conversationId || '未生成'}`,
      '',
      `検証：${JSON.stringify(r.checks || {})}`,
      '',
      `根拠・検索経路・API利用記録：同名のJSONファイル`,
      '',
    ]),
  ].join('\n');
  writeFileSync(join(root, 'transcript.md'), markdown);
  console.log(
    JSON.stringify({
      phase: 'complete',
      root,
      scenarios: report.scenarios.length,
      originalUnchanged: report.originalUnchanged,
    }),
  );
  (await resetDbForTests());
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
