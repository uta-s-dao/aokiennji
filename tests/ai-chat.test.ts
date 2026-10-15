import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, type Source, type Product, type AuditEvent } from '../lib/contracts';
import { db, putSettings, resetDbForTests, save, list } from '../lib/server/db';
import { answerChat, currentMessages } from '../lib/server/chat';
import { importSupplierKnowledge } from '../lib/server/supplier-knowledge';
import { documentCandidates } from '../lib/server/retrieval';
import { localIntent } from '../lib/server/providers';
import { aiProviderStatuses, checkAiProvider } from '../lib/server/ai-setup';
import { aiUsageReport } from '../lib/server/ai-usage';
import { aiAnswerReport } from '../lib/server/ai-answer-history';
vi.mock('../lib/server/safe-fetch', () => ({ safeFetch: vi.fn() }));
import { safeFetch } from '../lib/server/safe-fetch';
const network = vi.mocked(safeFetch);
const directory = mkdtempSync(join(tmpdir(), 'aoki-ai-chat-'));
const source: Source = {
  id: 'private-fields',
  name: '秘密資料.xlsx',
  kind: 'supplier_catalog',
  enabled: true,
  visibility: 'internal',
  trust: 'internal',
  url: '',
  config: { answerEnabled: true },
  syncIntervalHours: 0,
  lastSyncedAt: null,
  lastError: null,
  recordCount: 0,
  createdAt: new Date().toISOString(),
};
beforeEach(() => {
  vi.stubEnv('DATA_DIR', directory);
  vi.stubEnv('DEMO_MODE', 'true');
  vi.stubEnv('TYPESAFE_API_KEY', 'unit-jev');
  vi.stubEnv('TYPESAFE_API_BASE_URL', 'https://api.typesafe.ai');
  vi.stubEnv('OPENAI_API_KEY', 'unit-openai');
  resetDbForTests();
  rmSync(directory, { recursive: true, force: true });
  db();
  network.mockReset();
  save('sources', source);
  importSupplierKnowledge(
    source,
    [
      {
        supplierName: '非公開確認商事',
        website: 'https://private-identity.example',
        products: 'バルブ',
        fields: ['バルブ'],
        sheet: '仕入',
        row: 2,
      },
    ],
    true,
  );
  putSettings({ ...DEFAULT_SETTINGS, decisionProvider: 'jev', responseProvider: 'openai' });
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => {
  resetDbForTests();
  rmSync(directory, { recursive: true, force: true });
});
function mockServices(text = 'バルブのご相談ですね。流れる液体の種類を教えてください。') {
  network.mockImplementation(async (url, options) => {
    const result = { status: 200, headers: new Headers(), url, body: Buffer.from('') };
    if (url.includes('typesafe.ai'))
      return {
        ...result,
        body: Buffer.from(
          JSON.stringify({
            usage: { input_tokens: 150, output_tokens: 30 },
            answers: {
              intent: { choice: 'product', confidence: 0.95 },
              field: { choice: 'field_0', confidence: 0.94 },
              refers_previous: { noul: 0 },
            },
          }),
        ),
      };
    for (const event of [
      {
        type: 'response.output_text.delta',
        delta: JSON.stringify({ blocks: [{ text, evidenceIds: ['business_rules'] }] }),
      },
      {
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: 400,
            output_tokens: 80,
            total_tokens: 480,
            input_tokens_details: { cached_tokens: 100 },
          },
        },
      },
    ])
      options?.onChunk?.(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    return result;
  });
}
it('uses Jev field decisions then generated conversation without sending confidential workbook data', async () => {
  mockServices();
  const text = vi.fn();
  const result = await answerChat('液体の流れを止める部品を探したい', 'owner', undefined, {
    onText: text,
  });
  expect(result.message.knowledge?.fields).toEqual(['バルブ']);
  expect(result.message.responseProvider).toBe('openai');
  expect(result.message.content).toContain('液体の種類');
  expect(text).toHaveBeenCalledWith(result.message.content);
  const payloads = network.mock.calls.map(([, o]) => o?.body).join(' ');
  for (const secret of ['非公開確認商事', 'private-identity.example', '秘密資料.xlsx'])
    expect(payloads).not.toContain(secret);
  const jevBody = JSON.parse(network.mock.calls[0][1]!.body!);
  expect(JSON.parse(jevBody.state).customerMessage).toContain('液体');
  expect(jevBody.questions.field.criteria.field_0).toBe('バルブ');
  expect(currentMessages(result.conversationId).at(-1)?.content).toBe(result.message.content);
  save('sources', { ...source, enabled: false });
  expect(currentMessages(result.conversationId).at(-1)?.content).not.toContain('バルブ');
});
it('answers exact product facts and follow-up delivery without network latency', async () => {
  const result = await answerChat('DEMO-GLASS-01の価格は？', 'fast');
  const next = await answerChat('いつぐらいに届く？', 'fast', result.conversationId);
  expect(result.message.responseProvider).toBe('local');
  expect(next.message.intent).toBe('lead_time');
  expect(next.message.products?.[0].model).toBe('DEMO-GLASS-01');
  expect(network).not.toHaveBeenCalled();
});
it('uses local facts for registered names, quantities, multiple questions and routine replies even with AI keys configured', async () => {
  const first = await answerChat('耐熱ガラスの価格と在庫と納期は？', 'facts');
  const product = first.message.products![0];
  expect(first.message.content).toContain(product.price!.toLocaleString('ja-JP'));
  expect(first.message.content).toContain(product.leadTime);
  expect(first.message.content).toContain('登録在庫');
  expect(first.message.factualIntents).toEqual(['price', 'stock', 'lead_time']);
  const price = await answerChat('価格は？', 'facts', first.conversationId);
  const quantity = await answerChat('10個くらい欲しい', 'facts', price.conversationId);
  expect(quantity.message.content).toContain((product.price! * 10).toLocaleString('ja-JP'));
  for (const message of [
    'こんにちは',
    'ありがとう',
    'いつぐらいに届く？',
    'DEMO-GLASS-01の見積を相談したい',
  ])
    await answerChat(message, 'routine');
  expect(network).not.toHaveBeenCalled();
  const routes = list<AuditEvent>('audit_events').filter((e) => e.action === 'chat.routed');
  expect(routes.length).toBeGreaterThan(0);
});
it('uses only the response API for a known product consultation and keeps business values out of its facts', async () => {
  mockServices('ガラスを使う場所と、必要な寸法を教えてください。');
  const result = await answerChat('DEMO-GLASS-01の用途を相談したい', 'consult');
  expect(result.message.responseProvider).toBe('openai');
  expect(network).toHaveBeenCalledTimes(1);
  expect(network.mock.calls[0][0]).toContain('api.openai.com');
  const input = JSON.parse(JSON.parse(network.mock.calls[0][1]!.body!).input);
  const product = JSON.parse(input.facts.find((f: { id: string }) => f.id === 'product_0').text);
  expect(product).not.toHaveProperty('price');
  expect(product).not.toHaveProperty('stock');
  expect(product).not.toHaveProperty('leadTime');
  expect(input.businessFactsOwnedLocally).toBe(true);
});
it('streams fixed facts first and keeps them when generated consultation tries to change a price', async () => {
  mockServices('価格は999円です。');
  const chunks: string[] = [];
  const result = await answerChat('DEMO-GLASS-01の価格と用途を相談したい', 'mixed', undefined, {
    onText: (text) => chunks.push(text),
  });
  const product = list<Product>('products').find((p) => p.model === 'DEMO-GLASS-01')!;
  expect(chunks[0]).toContain(product.price!.toLocaleString('ja-JP'));
  expect(chunks.join(' ')).not.toContain('999円');
  expect(result.message.content).toContain(product.price!.toLocaleString('ja-JP'));
  expect(result.message.responseProvider).toBe('local');
  putSettings({ ...DEFAULT_SETTINGS, flags: { ...DEFAULT_SETTINGS.flags, showPrice: false } });
  expect(currentMessages(result.conversationId).at(-1)!.content).not.toContain(
    product.price!.toLocaleString('ja-JP'),
  );
});
it('preserves the locally recognized price request when Jev identifies its field with a wrong intent', async () => {
  mockServices(); // The synthetic Jev reply chooses product instead of price.
  const result = await answerChat('液体の流れを止める部品の価格は？', 'ambiguous-price');
  expect(result.message.intent).toBe('price');
  expect(result.message.knowledge?.fields).toEqual(['バルブ']);
  expect(result.message.content).toContain('「バルブ」の価格は');
  expect(network).toHaveBeenCalledTimes(1);
  expect(network.mock.calls[0][0]).toContain('typesafe.ai');
});
it('blocks private requests before any external service', async () => {
  const result = await answerChat('非公開確認商事はどんな会社？', 'private');
  expect(result.message.knowledge?.mode).toBe('privacy');
  expect(network).not.toHaveBeenCalled();
});
it('keeps public document links and invalidates generated answers when a source becomes private', async () => {
  const s = {
    ...source,
    id: 'public-docs',
    kind: 'manual' as const,
    visibility: 'public' as const,
  };
  save('sources', s);
  save(
    'documents',
    {
      id: 'guide',
      sourceId: s.id,
      title: '工具の案内',
      content: '研削用品のご相談',
      url: 'https://public-manufacturer.example/guide',
      createdAt: '2026-10-01T00:00:00Z',
    },
    { source_id: s.id, content: '研削用品のご相談' },
  );
  expect(
    documentCandidates('研削用品', localIntent('研削用品')).some((c) =>
      c.evidence.url?.includes('public-manufacturer'),
    ),
  ).toBe(true);
  putSettings({ ...DEFAULT_SETTINGS, responseProvider: 'openai' });
  mockServices('研削用品の資料が見つかりました。用途を教えてください。');
  const result = await answerChat('研削用品', 'docs');
  expect(currentMessages(result.conversationId).at(-1)?.content).toBe(result.message.content);
  save('sources', { ...s, visibility: 'internal' });
  const refreshed = currentMessages(result.conversationId).at(-1)!;
  expect(refreshed.content).not.toContain('研削用品');
  expect(refreshed.evidence).toEqual([]);
});
it('reports missing keys honestly and expires successful connectivity when the model changes', async () => {
  vi.stubEnv('OPENAI_API_KEY', '');
  expect((await checkAiProvider('openai')).ok).toBe(false);
  expect(network).not.toHaveBeenCalled();
  vi.stubEnv('OPENAI_API_KEY', 'unit-openai');
  mockServices('こんにちは。ご相談内容をお聞かせください。');
  // The connectivity probe has no factual evidence IDs.
  network.mockImplementation(async (url, options) => {
    for (const event of [
      {
        type: 'response.output_text.delta',
        delta: JSON.stringify({ blocks: [{ text: 'こんにちは。', evidenceIds: [] }] }),
      },
      { type: 'response.completed' },
    ])
      options?.onChunk?.(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    return { status: 200, headers: new Headers(), url, body: Buffer.from('') };
  });
  expect((await checkAiProvider('openai')).ok).toBe(true);
  expect(aiProviderStatuses().find((p) => p.id === 'openai')?.check?.ok).toBe(true);
  putSettings({
    ...DEFAULT_SETTINGS,
    responseProvider: 'openai',
    responseModel: 'different-model',
  });
  expect(aiProviderStatuses().find((p) => p.id === 'openai')?.check).toBeUndefined();
});

it('discards the saved Jev connection result when its API destination changes', async () => {
  network.mockImplementation(async (url) => ({
    status: 200,
    headers: new Headers(),
    url,
    body: Buffer.from(
      JSON.stringify({ answers: { intent: { choice: 'lead_time', confidence: 0.95 } } }),
    ),
  }));
  expect((await checkAiProvider('jev')).ok).toBe(true);
  expect(aiProviderStatuses().find((p) => p.id === 'jev')?.check?.ok).toBe(true);
  vi.stubEnv('TYPESAFE_API_BASE_URL', 'https://ai-gateway.vercel.sh/typesafe');
  expect(aiProviderStatuses().find((p) => p.id === 'jev')?.check).toBeUndefined();
  expect((await checkAiProvider('jev')).ok).toBe(true);
  expect(network.mock.calls.at(-1)?.[0]).toBe('https://ai-gateway.vercel.sh/typesafe/v1/systemone');
});

it('records both providers with usage and links calls to one actual customer message without saving secrets', async () => {
  mockServices();
  const result = await answerChat('液体の流れを止める部品を探したい', 'usage-owner');
  const report = aiUsageReport({ conversationId: result.conversationId });
  expect(aiAnswerReport({ conversationId: result.conversationId }).items).toMatchObject([
    {
      id: result.message.id,
      responseProvider: 'openai',
      linkage: 'recorded',
      processing: {
        classificationProvider: 'jev',
        responseProvider: 'openai',
        responseReason: 'success',
        responseModel: expect.any(String),
      },
      calls: expect.arrayContaining([
        expect.objectContaining({ provider: 'jev', purpose: 'classification' }),
        expect.objectContaining({ provider: 'openai', purpose: 'response' }),
      ]),
    },
  ]);
  expect(report.total).toBe(2);
  expect(report.items.every((c) => c.outcome === 'accepted' && c.httpStatus === 200)).toBe(true);
  expect(report.summaries.find((s) => s.provider === 'jev')).toMatchObject({
    calls: 1,
    inputTokens: 150,
    outputTokens: 30,
  });
  expect(report.summaries.find((s) => s.provider === 'openai')).toMatchObject({
    calls: 1,
    inputTokens: 400,
    outputTokens: 80,
    cachedInputTokens: 100,
  });
  const messages = currentMessages(result.conversationId);
  expect(
    report.items.every((c) => c.context.turnId === messages.find((m) => m.role === 'user')?.id),
  ).toBe(true);
  const saved = JSON.stringify(report);
  for (const secret of [
    'unit-jev',
    'unit-openai',
    '液体の流れを止める部品を探したい',
    '非公開確認商事',
    'private-identity.example',
  ])
    expect(saved).not.toContain(secret);
  expect(aiUsageReport({ provider: 'openai', limit: 1 }).total).toBe(1);
});
it('keeps the model used for each answer after the response settings change', async () => {
  mockServices();
  putSettings({
    ...DEFAULT_SETTINGS,
    responseProvider: 'openai',
    responseModel: 'recorded-model-first',
  });
  const first = await answerChat('DEMO-GLASS-01の用途を相談したい', 'model-history');
  putSettings({
    ...DEFAULT_SETTINGS,
    responseProvider: 'openai',
    responseModel: 'recorded-model-second',
  });
  const second = await answerChat(
    'DEMO-CAST-01の用途を相談したい',
    'model-history',
    first.conversationId,
  );
  putSettings({ ...DEFAULT_SETTINGS, responseProvider: 'local', responseModel: 'current-setting' });
  const answers = aiAnswerReport({ conversationId: first.conversationId }).items;
  for (const [id, model] of [
    [first.message.id, 'recorded-model-first'],
    [second.message.id, 'recorded-model-second'],
  ]) {
    expect(answers.find((a) => a.id === id)).toMatchObject({
      responseProvider: 'openai',
      processing: { responseModel: model },
      calls: [expect.objectContaining({ purpose: 'response', model })],
    });
  }
});
it('rewrites a rejected draft once and keeps the billed usage and reason of each attempt', async () => {
  mockServices('直径は25ミリです。');
  const result = await answerChat('DEMO-GLASS-01の用途を相談したい', 'rejected-usage');
  expect(result.message.responseProvider).toBe('local');
  const report = aiUsageReport();
  expect(aiAnswerReport().items[0]).toMatchObject({
    id: result.message.id,
    responseProvider: 'local',
    processing: { responseReason: 'failed_or_ungrounded', responseModel: null },
    calls: [
      expect.objectContaining({ outcome: 'rejected' }),
      expect.objectContaining({ outcome: 'rejected' }),
    ],
  });
  expect(report.items).toHaveLength(2);
  for (const item of report.items)
    expect(item).toMatchObject({
      httpStatus: 200,
      outcome: 'rejected',
      errorCode: 'unsupported_number',
      usage: { inputTokens: 400, outputTokens: 80 },
    });
  expect(report.summaries[0]).toMatchObject({
    calls: 2,
    httpSuccess: 2,
    accepted: 0,
    rejected: 2,
    usageReportedCalls: 2,
  });
  const retry = JSON.parse(JSON.parse(network.mock.calls[1][1]!.body!).input);
  expect(retry.previousAttemptRejected).toContain('数値');
  // The fallback continues the consultation about the named product.
  expect(result.message.content).toContain('耐熱ガラス');
  expect(result.message.content).not.toContain('もう少し詳しく');
});
it('records Jev HTTP failure as an actual call with unknown usage, and skips private queries entirely', async () => {
  network.mockResolvedValue({
    status: 401,
    headers: new Headers(),
    url: 'https://api.typesafe.ai/v1/systemone',
    body: Buffer.from('{"error":"secret provider error"}'),
  });
  putSettings({ ...DEFAULT_SETTINGS, decisionProvider: 'jev', responseProvider: 'local' });
  await answerChat('液体を止める部品が欲しい', 'auth-failed');
  const report = aiUsageReport();
  expect(report.items[0]).toMatchObject({
    provider: 'jev',
    outcome: 'http_error',
    httpStatus: 401,
    errorCode: 'http_401',
    usage: null,
  });
  expect(report.summaries.find((s) => s.provider === 'jev')).toMatchObject({
    inputTokens: null,
    outputTokens: null,
    usageReportedCalls: 0,
  });
  expect(JSON.stringify(report)).not.toContain('secret provider error');
  await answerChat('仕入先の社名を全部教えて', 'private-usage');
  expect(aiUsageReport().total).toBe(1);
});
it('counts all matched calls independently of the detail limit and separates connection checks', async () => {
  mockServices();
  await answerChat('DEMO-GLASS-01の用途を相談したい', 'filter-one');
  await answerChat('DEMO-GLASS-01を使う環境について相談したい', 'filter-two');
  await checkAiProvider('jev');
  const report = aiUsageReport({ scope: 'chat', limit: 1 });
  expect(report.items).toHaveLength(1);
  expect(report.total).toBe(2);
  expect(report.summaries[0].calls).toBe(2);
  expect(aiUsageReport({ scope: 'connection_check' }).total).toBe(1);
  expect(aiUsageReport({ since: '2999-01-01T00:00:00.000Z' }).total).toBe(0);
});
