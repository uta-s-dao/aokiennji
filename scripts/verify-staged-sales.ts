import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ChatResponse, Quote, StoredChatMessage } from '../lib/contracts';
import type {
  SourceVerificationReport,
  SourceVerificationScenario,
} from '../lib/source-verification';

// Real model + real registered URLs in a disposable copy. Never email, issue
// a quote or order from a verification run.
async function main() {
  if (!process.env.OPENAI_API_KEY || process.env.LOCAL_AGENT_API_URL)
    throw Error('Real OpenAI credentials required');
  const root = resolve('.data/verification/staged-sales-2026-10-18', String(Date.now()));
  const sandbox = join(root, 'sandbox');
  mkdirSync(sandbox, { recursive: true });
  const originalPath = resolve(process.env.DATA_DIR || '.data', 'aokienji.sqlite');
  const original = new Database(originalPath, { readonly: true });
  const tables = [
    'settings',
    'sources',
    'products',
    'documents',
    'supplier_knowledge',
    'conversations',
    'messages',
    'quotes',
    'orders',
  ];
  const snapshot = (d: Database.Database) =>
    createHash('sha256')
      .update(
        JSON.stringify(tables.map((t) => d.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())),
      )
      .digest('hex');
  const before = snapshot(original);
  await original.backup(join(sandbox, 'aokienji.sqlite'));
  original.close();
  const isolated = new Database(join(sandbox, 'aokienji.sqlite'));
  isolated.exec(
    'DELETE FROM messages; DELETE FROM conversations; DELETE FROM research_notes; DELETE FROM ai_calls; DELETE FROM sessions; DELETE FROM quotes; DELETE FROM orders;',
  );
  isolated.close();
  process.env.DATA_DIR = sandbox;
  process.env.ALLOW_LIVE_ORDERS = 'false';
  const { answerChat, currentMessages } = await import('../lib/server/chat');
  const { createQuote, conversationMessages } = await import('../lib/server/business');
  const { getSettings, putSettings, resetDbForTests } = await import('../lib/server/db');
  const { aiAnswerReport } = await import('../lib/server/ai-answer-history');
  const { aiUsageReport } = await import('../lib/server/ai-usage');
  const { researchNotes } = await import('../lib/server/research');
  const { createSourceTrace, preferredDomains } = await import('../lib/server/preferred-sources');
  const settings = {
    ...getSettings(),
    responseProvider: 'openai' as const,
    responseModel: 'gpt-4.1',
    flags: {
      ...getSettings().flags,
      webSearch: true,
      quoteRequests: true,
      autoQuote: false,
      orders: false,
      autoOrder: false,
    },
  };
  putSettings(settings);
  const report: SourceVerificationReport = {
    testedAt: new Date().toISOString(),
    initialPreferredDomains: preferredDomains(createSourceTrace()),
    responseModel: 'gpt-4.1',
    scenarios: [],
  };
  const fixtures = [
    {
      id: 'staged-bearing',
      label: '仕様からベアリングを選ぶ',
      opening:
        'コンベヤ用のベアリングが欲しいです。型番は分かりません。内径20mm・外径47mm・幅14mmの深溝玉軸受で、両側金属シールドのものを4個、大阪府です。条件を満たす型番を在庫がないものも含めて探してください。',
      detail:
        '内径20mm、外径47mm、幅14mm、両側金属シールドの深溝玉軸受です。メーカー指定はありません。4個です。',
    },
    {
      id: 'staged-cart',
      label: '台車の複数候補を比較する',
      opening:
        '工場で使う手押し台車を探しています。耐荷重300kg以上、荷台の幅600mm以下のものを2台、東京都です。条件に合う型番を在庫あり・なし両方探したいです。',
      detail:
        '手押し台車で、耐荷重300kg以上、荷台幅600mm以下が条件です。メーカー指定やハンドルの指定はありません。2台です。',
    },
  ];
  for (const fixture of fixtures) {
    const startedAt = new Date().toISOString();
    const owner = fixture.id;
    let current: ChatResponse | undefined, quote: Quote | undefined;
    const errors: { round: number; message: string }[] = [];
    const stageHistory: string[] = [];
    const questions: string[] = [];
    const send = async (message: string) => {
      questions.push(message);
      current = await answerChat(message, owner, current?.conversationId);
      stageHistory.push(current.message.salesState?.stage || 'legacy');
      console.log(
        JSON.stringify({
          scenario: fixture.id,
          turn: questions.length,
          stage: stageHistory.at(-1),
          content: current.message.content,
          handoff: current.message.handoff,
        }),
      );
    };
    try {
      await send(fixture.opening);
      for (let turn = 0; turn < 9; turn++) {
        const reply = current!.message;
        const stage = reply.salesState?.stage;
        if (stage === 'requirements') {
          if (questions.filter((q) => q === fixture.detail).length >= 2) break;
          await send(fixture.detail);
        } else if (stage === 'requirements_confirmation')
          await send('はい、この条件で探してください。');
        else if (stage === 'candidates') {
          const index = reply.selection?.candidates.findIndex((c) => c.fit === 'matches') ?? -1;
          if (index < 0) break;
          await send(`${index + 1}番の型番をお願いします。`);
        } else if (stage === 'quote_offer') await send('はい、この型番で見積をお願いします。');
        else if (stage === 'contact') {
          quote = createQuote(
            {
              name: '検証用のお客様',
              company: '架空の検証会社',
              email: 'stage-test@example.invalid',
              message: reply.handoffDraft || '',
              consent: true,
              quantity: reply.requestedQuantity || 1,
              conversationId: current!.conversationId,
            },
            owner,
          );
          await send('見積依頼フォームを送信しました。次の流れを教えてください。');
        } else break;
      }
    } catch (e) {
      errors.push({ round: questions.length, message: e instanceof Error ? e.message : 'failed' });
    }
    if (!current) throw Error('No response');
    const messages = conversationMessages(current.conversationId) as StoredChatMessage[];
    const answers = aiAnswerReport({
      conversationId: current.conversationId,
      limit: 100,
    }).items.toReversed();
    const last = answers.at(-1)!;
    const found = messages.find((m) => m.role === 'assistant' && m.selection);
    const sourceTrace = found?.sourceTrace || last.sourceTrace!;
    const calls = aiUsageReport({ conversationId: current.conversationId, limit: 100 });
    const checks = {
      stageOrder:
        JSON.stringify(stageHistory) ===
        JSON.stringify([
          'requirements_confirmation',
          'candidates',
          'quote_offer',
          'contact',
          'review',
        ]),
      candidateFound: !!found?.selection?.candidates.some((c) => c.fit === 'matches'),
      noPrematureQuoteForm: messages
        .filter((m) => m.role === 'assistant' && m.salesState?.stage !== 'contact')
        .every((m) => !m.handoff),
      draftCreated: quote?.status === 'requested',
      noQuoteIssued: quote?.status !== 'issued',
      noPrivateSourceInPublicReply: !JSON.stringify(
        currentMessages(current.conversationId),
      ).includes('sourceTrace'),
      gpt41Used: calls.items.some((c) => c.model === 'gpt-4.1' && c.outcome === 'accepted'),
      noExecutionErrors: errors.length === 0,
    };
    const scenario: SourceVerificationScenario = {
      id: fixture.id,
      question: fixture.opening,
      response: last.content,
      responseProvider: last.responseProvider || undefined,
      startedAt,
      completedAt: last.createdAt,
      conversationId: current.conversationId,
      answerId: last.id,
      sourceTrace,
      aiCalls: calls,
      checks,
      notes: researchNotes(current.conversationId),
      messages,
      answers,
      procurementAssessment: [],
      simulation: {
        kind: 'customer_simulation',
        label: fixture.label,
        questionAgent: '固定シナリオによる実API・段階遷移の検証',
        customerGoal: '条件ごとの候補比較から青木確認待ちの見積依頼まで進む',
        turnCount: questions.length,
        customerProfile: { persona: fixture.label, privateFacts: {} },
        questionTurns: questions.map((message, i) => ({
          round: i + 1,
          message,
          intent: stageHistory[i],
        })),
        configuration: {
          decisionProvider: settings.decisionProvider,
          searchProvider: settings.searchProvider,
          responseModel: 'gpt-4.1',
          demoMode: process.env.DEMO_MODE !== 'false',
        },
        errors,
        review: {
          verdict: Object.values(checks).every(Boolean) ? 'pass' : 'needs_review',
          summary: '実際の検索結果と段階遷移を検証。顧客メール・会社への通知は送信していません。',
          findings: [],
        },
        ...(quote
          ? {
              quoteOutcome: {
                requestId: quote.id,
                status: quote.status,
                lineName: quote.lines[0]?.name || '',
                quantity: quote.lines[0]?.quantity || 1,
                issued: false,
                ordered: false,
                blockers: [
                  '青木さんの内容確認',
                  '販売価格・送料・納期の確定',
                  'メール送信連携の設定',
                ],
              },
            }
          : {}),
      },
    };
    report.scenarios.push(scenario);
    writeFileSync(join(root, `${fixture.id}.json`), JSON.stringify(scenario, null, 2));
  }
  const after = new Database(originalPath, { readonly: true });
  const originalUnchanged = snapshot(after) === before;
  after.close();
  const output = { ...report, originalUnchanged };
  const json = JSON.stringify(output, null, 2) + '\n';
  for (const [key, value] of Object.entries(process.env))
    if (
      /API_KEY|PASSWORD|SESSION_SECRET/.test(key) &&
      value &&
      value.length > 12 &&
      json.includes(value)
    )
      throw Error('Credential leak');
  writeFileSync('docs/research/staged-sales-live-2026-10-18.json', json);
  writeFileSync(join(root, 'results.json'), json);
  console.log(
    JSON.stringify({
      root,
      originalUnchanged,
      scenarios: report.scenarios.map((s) => ({ id: s.id, checks: s.checks })),
    }),
  );
  resetDbForTests();
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : 'verification_failed');
  process.exitCode = 1;
});
