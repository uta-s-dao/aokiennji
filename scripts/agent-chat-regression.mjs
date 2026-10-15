// Conversation checks against the running local agent site. No API keys needed.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';

const root = '.data/verification/agent-api';
const runtime = JSON.parse(readFileSync(root + '/runtime.json', 'utf8'));
const base = runtime.appURL;
const scenarios = [
  {
    id: 'valve',
    turns: [
      '工場の冷却水に使う手動バルブを探しています。配管は25A、温度は40度です。ボール弁とゲート弁はどう違いますか？',
      'はい、普段は全開で使い、メンテナンス時に止めるためです。',
      'メーカーは分かりません。写真なら用意できます。',
      'この内容を担当者に送る文章にまとめてください。',
    ],
  },
  {
    id: 'bearing',
    turns: [
      'NSKの6205DDUを40個探しています。大阪へ送りたいです。',
      '数量は40個から60個に変更してください。',
      '今日注文したら最短でいつ届きますか？',
      'ここまでの相談をまとめてください。',
    ],
  },
  {
    id: 'topic-switch',
    turns: [
      'DEMO-CAST-01の価格を教えてください。',
      '別件でSUS304の板も探しています。こちら1枚の価格はいくらですか？',
      '屋内の作業台の天板に使いたいのですが、図面から相談できますか？',
    ],
  },
  {
    id: 'privacy',
    turns: ['パッキンを扱っていますか？', 'その仕入先の社名とホームページを教えてください。'],
  },
  {
    id: 'unknown-temperature',
    turns: [
      '炉の断熱材を探しています。使用温度は分かりません。どこを確認すればよいですか？',
      '炉の型式と今使っている材料の写真なら用意できます。',
    ],
  },
  {
    id: 'fresh-price-switch',
    turns: [
      'DEMO-CAST-01の1個の価格を教えてください。',
      '別の商品です。SUS304の板1枚の価格はいくらですか？',
    ],
  },
];
const records = [];
const previous =
  process.argv.includes('--resume') && existsSync(root + '/conversation-results.json')
    ? JSON.parse(readFileSync(root + '/conversation-results.json', 'utf8'))
    : [];
for (const scenario of scenarios) {
  const finished = previous.find(
    (record) => record.id === scenario.id && record.turns.length === scenario.turns.length,
  );
  if (finished) {
    records.push(finished);
    continue;
  }
  let cookie = '',
    conversationId;
  const turns = [];
  let restoreFixture = () => {};
  if (scenario.id === 'fresh-price-switch') {
    const fixtureDb = new Database(runtime.dataDir + '/aokienji.sqlite', { fileMustExist: true });
    const row = fixtureDb
      .prepare('SELECT id,json FROM products')
      .all()
      .find((r) => JSON.parse(r.json).model === 'DEMO-CAST-01');
    if (!row) {
      fixtureDb.close();
      throw Error('Demo price fixture is missing');
    }
    const product = JSON.parse(row.json);
    fixtureDb
      .prepare('UPDATE products SET json=? WHERE id=?')
      .run(JSON.stringify({ ...product, verifiedAt: new Date().toISOString() }), row.id);
    restoreFixture = () => {
      fixtureDb.prepare('UPDATE products SET json=? WHERE id=?').run(row.json, row.id);
      fixtureDb.close();
    };
  }
  try {
    for (const question of scenario.turns) {
      const started = Date.now();
      const response = await fetch(base + '/api/chat', {
        method: 'POST',
        headers: {
          Origin: base,
          'Content-Type': 'application/json',
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: JSON.stringify({ message: question, ...(conversationId ? { conversationId } : {}) }),
        signal: AbortSignal.timeout(130000),
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      if (!response.ok) throw Error(`${scenario.id}: HTTP ${response.status}`);
      const data = (await response.json()).data;
      conversationId = data.conversationId;
      const reply = data.message.content;
      const turn = {
        question,
        reply,
        durationMs: Date.now() - started,
        responseProvider: data.message.responseProvider,
        route: data.message.route,
        handoff: data.message.handoff,
      };
      turns.push(turn);
      console.log(
        JSON.stringify({
          scenario: scenario.id,
          turn: turns.length,
          provider: turn.responseProvider,
          chars: reply.length,
          durationMs: turn.durationMs,
        }),
      );
      writeFileSync(
        root + '/conversation-results.json',
        JSON.stringify([...records, { id: scenario.id, conversationId, turns }], null, 2),
      );
    }
    records.push({ id: scenario.id, conversationId, turns });
  } finally {
    restoreFixture();
  }
}
const db = new Database(runtime.dataDir + '/aokienji.sqlite', {
  readonly: true,
  fileMustExist: true,
});
const conversationIds = new Set(records.map((record) => record.conversationId));
const allCalls = db
  .prepare("SELECT json FROM ai_calls WHERE provider='openai'")
  .all()
  .map((r) => JSON.parse(r.json));
const calls = allCalls.filter(
  (c) => c.endpoint === runtime.apiURL && conversationIds.has(c.context.conversationId),
);
const all = records.flatMap((r) => r.turns);
const bearingSummary = records.find((r) => r.id === 'bearing').turns.at(-1).reply;
const switched = records.find((r) => r.id === 'topic-switch').turns[1].reply;
const freshTurns = records.find((r) => r.id === 'fresh-price-switch').turns;
const demo = db
  .prepare('SELECT json FROM products')
  .all()
  .map((r) => JSON.parse(r.json))
  .find((p) => p.model === 'DEMO-CAST-01');
const priceText = String(demo.price);
const identities = db
  .prepare('SELECT json FROM supplier_knowledge')
  .all()
  .flatMap((r) => {
    const value = JSON.parse(r.json);
    return Object.entries(value)
      .filter(
        ([k, v]) =>
          /(?:companyName|supplierName|website|url)$/i.test(k) &&
          typeof v === 'string' &&
          v.length > 3,
      )
      .map(([, v]) => v);
  });
const checks = {
  conversations: records.length,
  turns: all.length,
  allRepliesNonEmpty: all.every((t) => !!t.reply?.trim()),
  generatedReplies: all.filter((t) => t.responseProvider === 'openai').length,
  latestQuantityInSummary: bearingSummary.includes('60'),
  destinationInSummary: bearingSummary.includes('大阪'),
  modelInSummary: bearingSummary.includes('6205DDU'),
  registeredDemoPriceShown: freshTurns[0].reply.replaceAll(',', '').includes(priceText),
  previousProductNotQuotedAsPlate: ![switched, freshTurns[1].reply].some((text) =>
    text.replaceAll(',', '').includes(priceText),
  ),
  privateIdentitiesLeaked: identities.some((s) => all.some((t) => t.reply.includes(s))),
  localApiCalls: calls.length,
  acceptedCalls: calls.filter((c) => c.outcome === 'accepted').length,
  rejectedCalls: calls.filter((c) => c.outcome === 'rejected').map((c) => c.errorCode),
  failedCalls: calls
    .filter((c) => !['accepted', 'rejected', 'pending'].includes(c.outcome))
    .map((c) => c.errorCode),
  pendingCalls: calls.filter((c) => c.outcome === 'pending').length,
  realOpenaiCallsAfterStart: allCalls.filter(
    (c) => c.createdAt >= runtime.startedAt && c.endpoint === 'https://api.openai.com/v1/responses',
  ).length,
  allCallsUseLocalModel: calls.every((c) => c.model === 'local-agent'),
};
db.close();
writeFileSync(root + '/conversation-results.json', JSON.stringify(records, null, 2));
writeFileSync(root + '/conversation-checks.json', JSON.stringify(checks, null, 2));
console.log(JSON.stringify(checks));
if (
  !checks.allRepliesNonEmpty ||
  !checks.latestQuantityInSummary ||
  !checks.destinationInSummary ||
  !checks.modelInSummary ||
  !checks.registeredDemoPriceShown ||
  !checks.previousProductNotQuotedAsPlate ||
  checks.privateIdentitiesLeaked
)
  process.exitCode = 1;
