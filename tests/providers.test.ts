import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resetDbForTests } from '../lib/server/db';
import { DEFAULT_SETTINGS, type Source } from '../lib/contracts';
vi.mock('../lib/server/safe-fetch', () => ({ safeFetch: vi.fn() }));
import { safeFetch } from '../lib/server/safe-fetch';
import { classifyQuery, searchWeb } from '../lib/server/providers';
import { fetchSource } from '../lib/server/connectors';
import { aiUsageReport } from '../lib/server/ai-usage';
const mock = vi.mocked(safeFetch);
const testDirectory = mkdtempSync(join(tmpdir(), 'aoki-provider-usage-'));
function reply(json: unknown) {
  mock.mockResolvedValue({
    status: 200,
    headers: new Headers(),
    body: Buffer.from(JSON.stringify(json)),
    url: 'https://supplier.example/catalog',
  });
}
beforeEach(() => {
  vi.stubEnv('DATA_DIR', testDirectory);
  resetDbForTests();
  mock.mockReset();
  vi.stubEnv('TYPESAFE_API_BASE_URL', 'https://api.typesafe.ai');
});
afterEach(() => {
  resetDbForTests();
  vi.unstubAllEnvs();
});
afterAll(() => rmSync(testDirectory, { recursive: true, force: true }));
describe('provider contracts', () => {
  it('uses the Vercel TypeSafe-compatible endpoint and records its actual destination', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'unit-gateway-only');
    vi.stubEnv('TYPESAFE_API_BASE_URL', 'https://ai-gateway.vercel.sh/typesafe/');
    reply({
      usage: { input_tokens: 272, output_tokens: 22 },
      answers: { intent: { choice: 'stock', confidence: 0.94 } },
    });
    const result = await classifyQuery('ABC-123ありますか', {
      ...DEFAULT_SETTINGS,
      decisionProvider: 'jev',
    });
    expect(result.provider).toBe('jev');
    expect(mock.mock.calls[0][0]).toBe('https://ai-gateway.vercel.sh/typesafe/v1/systemone');
    expect(mock.mock.calls[0][1]?.headers?.Authorization).toBe('Bearer unit-gateway-only');
    const [call] = aiUsageReport().items;
    expect(call.endpoint).toBe('https://ai-gateway.vercel.sh/typesafe/v1/systemone');
    expect(call.outcome).toBe('accepted');
    expect(call.usage?.totalTokens).toBe(294);
    expect(JSON.stringify(call)).not.toContain('unit-gateway-only');
  });
  it('does not send a Jev credential to an unsupported base URL', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'unit-gateway-only');
    vi.stubEnv('TYPESAFE_API_BASE_URL', 'https://unrelated.example');
    const result = await classifyQuery('ABC-123ありますか', {
      ...DEFAULT_SETTINGS,
      decisionProvider: 'jev',
    });
    expect(result.provider).toBe('local');
    expect(mock).not.toHaveBeenCalled();
  });
  it('sends typed Jev Choice and accepts only known high-confidence decisions', async () => {
    process.env.TYPESAFE_API_KEY = 'unit-test-only';
    reply({ answers: { intent: { choice: 'stock', confidence: 0.94 } } });
    const result = await classifyQuery('ABC-123ありますか', {
      ...DEFAULT_SETTINGS,
      decisionProvider: 'jev',
    });
    expect(result.provider).toBe('jev');
    const request = JSON.parse(mock.mock.calls[0][1]!.body!);
    expect(request.questions.intent.type).toBe('choice');
    expect(request.model).toBe('jev-latest');
    reply({ answers: { intent: { choice: 'buy_without_confirmation', confidence: 1 } } });
    expect(
      (await classifyQuery('ABC-123', { ...DEFAULT_SETTINGS, decisionProvider: 'jev' })).provider,
    ).toBe('local');
    delete process.env.TYPESAFE_API_KEY;
  });
  it('validates Gemini identifiers against the actual query', async () => {
    process.env.GEMINI_API_KEY = 'unit-test-only';
    reply({
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  intent: 'price',
                  confidence: 0.9,
                  model: 'INVENTED-999',
                  terms: ['INVENTED-999'],
                }),
              },
            ],
          },
        },
      ],
    });
    const result = await classifyQuery('ABC-123の価格', {
      ...DEFAULT_SETTINGS,
      decisionProvider: 'gemini',
    });
    expect(result.provider).toBe('gemini');
    expect(result.model).toBe('ABC-123');
    expect(result.terms).not.toContain('INVENTED-999');
    expect(aiUsageReport({ provider: 'gemini' }).items[0]).toMatchObject({
      provider: 'gemini',
      purpose: 'classification',
      outcome: 'accepted',
      httpStatus: 200,
      model: 'gemini-2.5-flash',
      usage: null,
    });
    delete process.env.GEMINI_API_KEY;
  });
  it('passes bounded conversation context to Gemini while rejecting invented identifiers', async () => {
    process.env.GEMINI_API_KEY = 'unit-test-only';
    reply({
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  intent: 'lead_time',
                  confidence: 0.9,
                  referencesPrevious: true,
                  model: 'NOT-IN-LATEST-1',
                }),
              },
            ],
          },
        },
      ],
    });
    const history = [{ role: 'assistant' as const, content: 'ABC-123を取り扱っています。' }];
    const result = await classifyQuery(
      'いつぐらいに届く？',
      { ...DEFAULT_SETTINGS, decisionProvider: 'gemini' },
      history,
    );
    expect(result.intent).toBe('lead_time');
    expect(result.referencesPrevious).toBe(true);
    expect(result.model).toBeUndefined();
    const request = JSON.parse(mock.mock.calls[0][1]!.body!);
    expect(JSON.parse(request.contents[0].parts[0].text).conversation).toEqual(history);
    delete process.env.GEMINI_API_KEY;
  });
  it.each(['exa', 'tavily'] as const)(
    'retrieves %s discovery evidence and filters result domains',
    async (searchProvider) => {
      process.env.EXA_API_KEY = 'unit-test-only';
      process.env.TAVILY_API_KEY = 'unit-test-only';
      reply({
        results: [
          {
            title: '部品',
            url: 'https://supplier.example/p',
            highlights: ['ABC-123'],
            content: 'ABC-123',
          },
          { title: '他社', url: 'https://untrusted.example/p' },
        ],
      });
      const result = await searchWeb(
        'ABC-123',
        {
          ...DEFAULT_SETTINGS,
          flags: { ...DEFAULT_SETTINGS.flags, webSearch: true },
          searchProvider,
        },
        ['supplier.example'],
      );
      expect(result).toHaveLength(1);
      expect(result[0].trust).toBe('discovery');
      delete process.env.EXA_API_KEY;
      delete process.env.TAVILY_API_KEY;
    },
  );
  it('fetches configurable JSON arrays and sends only the specified source token', async () => {
    process.env.SOURCE_TEST_TOKEN = 'test-token-only';
    reply({ data: { items: [{ name: '部品', model: 'ABC-123', price: 100 }] } });
    const source = {
      id: 'test',
      name: '仕入先',
      kind: 'json_api',
      enabled: true,
      url: 'https://supplier.example/catalog',
      config: { authEnv: 'SOURCE_TEST_TOKEN', itemsPath: 'data.items' },
    } as Source;
    const parsed = await fetchSource(source);
    expect(parsed.rows[0].model).toBe('ABC-123');
    expect(mock.mock.calls[0][1]!.headers!.Authorization).toBe('Bearer test-token-only');
    delete process.env.SOURCE_TEST_TOKEN;
  });
});
