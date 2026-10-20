import './legacy-sqlite-harness';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { Quote, StoredChatMessage } from '../lib/contracts';
import type {
  SourceVerificationReport,
  SourceVerificationScenario,
} from '../lib/source-verification';

const root = resolve(process.argv[2] || '.data/verification/sales-conversations-2026-10-18');
const args = process.argv.slice(3);
const batch = args.find((a) => a.startsWith('--batch='))?.slice('--batch='.length);
if (batch && !/^[a-z0-9-]+$/.test(batch)) throw Error('Invalid batch name');
const reportName = batch ? `sales-conversations-${batch}` : 'sales-conversations';
if (!root.startsWith(resolve('.data/verification') + sep))
  throw Error('Use a verification directory');
if (!process.env.OPENAI_API_KEY || !process.env.TYPESAFE_API_KEY || process.env.LOCAL_AGENT_API_URL)
  throw Error('Real OpenAI and Jev credentials are required');
const sandbox = join(root, 'sandbox');
const originalFile = resolve(process.env.DATA_DIR || '.data', 'aokienji.sqlite');
mkdirSync(sandbox, { recursive: true });
const tables = [
  'settings',
  'sources',
  'products',
  'documents',
  'supplier_knowledge',
  'conversations',
  'messages',
  'research_notes',
  'ai_calls',
  'quotes',
  'orders',
];
const snapshot = (d: Database.Database) =>
  Object.fromEntries(
    tables.map((t) => [
      t,
      createHash('sha256')
        .update(JSON.stringify(d.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()))
        .digest('hex'),
    ]),
  );
const write = (file: string, data: unknown) =>
  writeFileSync(join(root, file), JSON.stringify(data, null, 2) + '\n');
async function main() {
  const original = new Database(originalFile, { readonly: true });
  const before = existsSync(join(root, 'before.json'))
    ? JSON.parse(readFileSync(join(root, 'before.json'), 'utf8'))
    : snapshot(original);
  if (!existsSync(join(sandbox, 'aokienji.sqlite'))) {
    write('before.json', before);
    await original.backup(join(sandbox, 'aokienji.sqlite'));
    const isolated = new Database(join(sandbox, 'aokienji.sqlite'));
    isolated.exec(
      'DELETE FROM messages; DELETE FROM conversations; DELETE FROM research_notes; DELETE FROM ai_calls; DELETE FROM audit_events; DELETE FROM sessions; DELETE FROM rate_limits; DELETE FROM quotes; DELETE FROM orders;',
    );
    isolated.close();
  }
  original.close();
  process.env.DATA_DIR = sandbox;
  process.env.ALLOW_LIVE_ORDERS = 'false';
  const { answerChat, currentMessages } = await import('../lib/server/chat');
  const { createQuote, conversationMessages } = await import('../lib/server/business');
  const { aiAnswerReport } = await import('../lib/server/ai-answer-history');
  const { researchNotes } = await import('../lib/server/research');
  const { aiUsageReport } = await import('../lib/server/ai-usage');
  const { db, getSettings, resetDbForTests } = await import('../lib/server/db');
  const { createSourceTrace, preferredDomains } = await import('../lib/server/preferred-sources');
  const fixtures = (
    JSON.parse(readFileSync('scripts/fixtures/sales-conversations.json', 'utf8')) as {
      id: string;
      label: string;
      quantity: number;
      destination: string;
      turns: string[];
    }[]
  ).map((fixture) => ({ ...fixture, id: batch ? `${batch}-${fixture.id}` : fixture.id }));
  if (fixtures.length !== 10) throw Error('Ten scenarios required');
  const settings = (await getSettings());
  if (settings.responseProvider !== 'openai' || settings.searchProvider !== 'openai')
    throw Error('Use configured OpenAI providers');
  const report: SourceVerificationReport = {
    testedAt: new Date().toISOString(),
    initialPreferredDomains: preferredDomains((await createSourceTrace())),
    responseModel: settings.responseModel,
    scenarios: [],
  };
  const recheck = (args.find((a) => a.startsWith('--recheck='))?.slice('--recheck='.length) || '')
    .split(',')
    .filter(Boolean);
  if (recheck.some((id) => !fixtures.some((f) => f.id === id)))
    throw Error('Unknown scenario to recheck');
  let next = 0;
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      while (next < fixtures.length) {
        const fixture = fixtures[next++];
        const recordPath = join(root, `${fixture.id}.json`);
        if (existsSync(recordPath) && !recheck.includes(fixture.id)) {
          report.scenarios.push(JSON.parse(readFileSync(recordPath, 'utf8')));
          continue;
        }
        const owner = `sales-simulation-${fixture.id}`;
        if (recheck.includes(fixture.id)) {
          const previous = (await db()
            .prepare('SELECT id FROM conversations WHERE owner_id=?')
            .all(owner)) as { id: string }[];
          for (const { id } of previous)
            (await db().transaction(async () => {
              for (const table of ['messages', 'research_notes', 'ai_calls'])
                (await db().prepare(`DELETE FROM ${table} WHERE conversation_id=?`).run(id));
              (await db()
                .prepare("DELETE FROM quotes WHERE json_extract(json, '$.conversationId')=?")
                .run(id));
              (await db().prepare('DELETE FROM conversations WHERE id=?').run(id));
            })());
          if (existsSync(recordPath)) {
            mkdirSync(join(root, 'previous'), { recursive: true });
            renameSync(recordPath, join(root, 'previous', `${fixture.id}-${Date.now()}.json`));
          }
        }

        // Resume the original session after an interrupted run; do not duplicate accepted turns or quotes.
        let conversationId = (
          (await db()
            .prepare('SELECT id FROM conversations WHERE owner_id=? ORDER BY rowid DESC LIMIT 1')
            .get(owner)) as { id: string } | undefined
        )?.id;
        const startedAt = new Date().toISOString();
        const errors: { round: number; message: string }[] = [];
        let quote: Quote | undefined;
        const existing = (await db().prepare('SELECT json FROM quotes').all()) as { json: string }[];
        quote = existing
          .map((r) => JSON.parse(r.json) as Quote)
          .find((q) => q.conversationId === conversationId);
        for (const [index, message] of fixture.turns.entries()) {
          const count = conversationId
            ? (await conversationMessages(conversationId)).filter((m) => m.role === 'assistant').length
            : 0;
          if (count > index) continue;
          try {
            const work: (() => Promise<void>)[] = [];
            const reply = await answerChat(message, owner, conversationId, {
              defer: (job) => work.push(job),
            });
            conversationId = reply.conversationId;
            for (const job of work) await job();
            console.log(
              JSON.stringify({
                scenario: fixture.id,
                turn: index + 1,
                provider: reply.message.responseProvider,
                sourcing: reply.message.sourcing?.status,
                availability: reply.message.sourcing?.availability,
                handoff: reply.message.handoff,
              }),
            );
            // Simulate the explicit form submission only after the customer requested a quote.
            // No staff approval or prices are fabricated, and no email or supplier order is sent.
            if (index === fixture.turns.length - 2 && reply.message.handoff === 'quote' && !quote) {
              quote = (await createQuote(
                {
                  name: '会話検証のお客様',
                  company: '架空の検証会社',
                  email: 'sales-test@example.invalid',
                  consent: true,
                  quantity: reply.message.requestedQuantity || 1,
                  message: reply.message.handoffDraft || message,
                  conversationId,
                  productId: reply.message.handoffProductId,
                },
                owner,
              ));
            }
          } catch (e) {
            errors.push({
              round: index + 1,
              message: e instanceof Error ? e.message : 'chat_failed',
            });
            console.log(JSON.stringify({ scenario: fixture.id, error: errors.at(-1) }));
            break;
          }
        }
        if (!conversationId) throw Error('No conversation saved');
        const messages = (await conversationMessages(conversationId)) as StoredChatMessage[];
        const answers = (await aiAnswerReport({ conversationId, limit: 500 })).items.toReversed();
        const last = answers.at(-1)!;
        const notes = (await researchNotes(conversationId));
        const publicReplies = messages.filter((m) => m.role === 'assistant');
        const checks = {
          everyTurnAnswered: answers.length === fixture.turns.length,
          noStaffDeflection: publicReplies.every((m) => !/担当者|担当の者/.test(m.content)),
          noUnconfirmedTail: publicReplies.every(
            (m) => !m.content.includes('現時点では必要数量分の在庫・発送日は未確定です'),
          ),
          quoteOffered: publicReplies.some((m) => m.handoff === 'quote'),
          quoteRequestCreated: !!quote,
          quoteQuantityPreserved: quote?.lines[0]?.quantity === fixture.quantity,
          destinationPreserved: publicReplies.at(-2)?.requestedDestination === fixture.destination,
          noAutomaticProcurementApproval: notes.every((n) =>
            (n.offers || []).every((o) => !o.approved && o.confirmedAt === null),
          ),
          publicTraceExcluded: !JSON.stringify((await currentMessages(conversationId))).includes(
            'sourceTrace',
          ),
          noExecutionErrors: errors.length === 0,
        };
        const scenario: SourceVerificationScenario = {
          id: fixture.id,
          question: fixture.turns[0],
          response: last.content,
          responseProvider: last.responseProvider || undefined,
          startedAt,
          completedAt: last.createdAt,
          conversationId,
          answerId: last.id,
          sourceTrace: last.sourceTrace!,
          aiCalls: (await aiUsageReport({ conversationId, limit: 500 })),
          checks,
          notes,
          messages,
          answers,
          procurementAssessment: notes.flatMap((n) =>
            (n.offers || []).map((o) => ({
              title: o.title,
              url: o.url,
              assessment: '掲載情報を取得。仕入条件・当社の販売条件は未承認。',
            })),
          ),
          simulation: {
            kind: 'customer_simulation',
            label: fixture.label,
            questionAgent:
              '過去の相談をもとにした固定の顧客シナリオと見積フォーム送信の検証（自律した顧客・成約率の試験ではありません）',
            customerGoal:
              '必要な部品・仕様を伝え、当社の見積依頼まで進む。正式見積・注文との到達段階を区別する。',
            turnCount: messages.filter((m) => m.role === 'user').length,
            customerProfile: {
              persona: fixture.label,
              privateFacts: { quantity: fixture.quantity, destination: fixture.destination },
            },
            questionTurns: fixture.turns.map((message, index) => ({
              round: index + 1,
              message,
              intent: '購入に向けた相談と見積依頼',
            })),
            configuration: {
              decisionProvider: settings.decisionProvider,
              searchProvider: settings.searchProvider,
              responseModel: settings.responseModel,
              demoMode: process.env.DEMO_MODE !== 'false',
            },
            errors,
            review: {
              verdict: Object.values(checks).every(Boolean) ? 'pass' : 'needs_review',
              summary: '自動照合結果。見積依頼と正式発行・購入は別々に記録。',
              findings: [],
            },
            ...(quote
              ? {
                  quoteOutcome: {
                    requestId: quote.id,
                    status: quote.status,
                    lineName: quote.lines[0]?.name || '',
                    quantity: quote.lines[0]?.quantity || fixture.quantity,
                    issued: quote.status === 'issued',
                    ordered: false,
                    blockers:
                      quote.status !== 'issued'
                        ? [
                            '会社承認済みの販売価格・送料・納期が未設定',
                            '新規調達候補の仕入条件が未承認',
                            '正式見積の自動発行は無効',
                          ]
                        : [],
                  },
                }
              : {}),
          },
        };
        write(`${fixture.id}.json`, scenario);
        report.scenarios.push(scenario);
        write('results.json', report);
      }
    }),
  );
  report.scenarios.sort((a, b) => a.id.localeCompare(b.id));
  const after = new Database(originalFile, { readonly: true });
  const unchanged = JSON.stringify(snapshot(after)) === JSON.stringify(before);
  after.close();
  const serialized = JSON.stringify(report);
  for (const [key, value] of Object.entries(process.env))
    if (
      /(?:API_KEY|PASSWORD|SESSION_SECRET)/.test(key) &&
      value &&
      value.length > 12 &&
      serialized.includes(value)
    )
      throw Error('Credential leak');
  write('results.json', { ...report, originalUnchanged: unchanged });
  const calls = report.scenarios.flatMap((s) => s.aiCalls.items);
  const summary = {
    checkedAt: new Date().toISOString(),
    conversations: report.scenarios.length,
    customerTurns: report.scenarios.reduce((n, s) => n + (s.simulation?.turnCount || 0), 0),
    quoteRequests: report.scenarios.filter((s) => s.simulation?.quoteOutcome).length,
    quotesIssued: report.scenarios.filter((s) => s.simulation?.quoteOutcome?.issued).length,
    orders: 0,
    listedStock: report.scenarios.filter((s) =>
      s.messages?.some(
        (m) => m.sourcing?.availability?.stock && m.sourcing.availability.stock !== 'unknown',
      ),
    ).length,
    listedQuantity: report.scenarios.filter((s) =>
      s.messages?.some((m) => m.sourcing?.availability?.listedQuantity != null),
    ).length,
    listedDispatch: report.scenarios.filter((s) =>
      s.messages?.some((m) => m.sourcing?.availability?.supplierDispatch),
    ).length,
    apiCalls: calls.length,
    providers: Object.fromEntries(
      ['jev', 'openai'].map((p) => [p, calls.filter((c) => c.provider === p).length]),
    ),
    originalUnchanged: unchanged,
    scenarios: report.scenarios.map((s) => ({
      id: s.id,
      label: s.simulation?.label,
      checks: s.checks,
      quote: s.simulation?.quoteOutcome,
      maxReplyCharacters: Math.max(...s.answers!.map((a) => a.content.length)),
      failures: s.aiCalls.items
        .filter((c) => c.outcome !== 'accepted')
        .map((c) => ({ provider: c.provider, code: c.errorCode })),
    })),
  };
  write('summary.json', summary);
  writeFileSync(
    `docs/research/${reportName}-live-2026-10-18.json`,
    JSON.stringify(report, null, 2) + '\n',
  );
  writeFileSync(
    `docs/research/${reportName}-validation-2026-10-18.json`,
    JSON.stringify(summary, null, 2) + '\n',
  );
  writeFileSync(
    join(root, 'transcript.md'),
    report.scenarios
      .map(
        (s) =>
          `## ${s.simulation?.label}\n\n${s.messages!.map((m) => `**${m.role === 'user' ? 'お客様' : 'アオキエンジ'}**\n\n${m.content}`).join('\n\n')}\n\n見積：${s.simulation?.quoteOutcome?.status || '未送信'}`,
      )
      .join('\n\n'),
  );
  (await resetDbForTests());
  console.log(JSON.stringify({ phase: 'complete', ...summary, scenarios: undefined }));
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : 'run_failed');
  process.exitCode = 1;
});
