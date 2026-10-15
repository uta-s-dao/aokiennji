import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resetDbForTests } from '../lib/server/db';
import { aiUsageReport, pauseOpenaiForQuota } from '../lib/server/ai-usage';
import { overview } from '../lib/server/business';
import { DEFAULT_SETTINGS } from '../lib/contracts';
vi.mock('../lib/server/safe-fetch', () => ({ safeFetch: vi.fn() }));
import { safeFetch } from '../lib/server/safe-fetch';
import {
  completedBlocks,
  generateGroundedReply,
  validateReplyBlock,
  type ReplyContext,
} from '../lib/server/ai-responses';

const network = vi.mocked(safeFetch);
const testDirectory = mkdtempSync(join(tmpdir(), 'aoki-response-usage-'));
const context: ReplyContext = {
  question: '配管の液体を止める部品を相談したい',
  history: [],
  canonical: 'バルブの分野についてご相談いただけます。個別の対応可否は担当者が確認します。',
  facts: [{ id: 'scope', text: '取扱分野：バルブ。個別製品は担当者が確認します。' }],
  confirmedProduct: false,
  settings: { ...DEFAULT_SETTINGS, responseProvider: 'openai' },
  privateText: (text) => /秘密商事/.test(text),
};
const paragraph = {
  text: 'バルブのご相談ですね。配管に流れる液体の種類を教えていただけますか？',
  evidenceIds: ['scope'],
};
const response = {
  status: 200,
  headers: new Headers(),
  body: Buffer.from(''),
  url: 'https://api.openai.com/v1/responses',
};
function sse(event: unknown) {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}
function mockReply(block: unknown, finish = true) {
  network.mockImplementation(async (_url, options) => {
    options?.onChunk?.(
      sse({ type: 'response.output_text.delta', delta: JSON.stringify({ blocks: [block] }) }),
    );
    if (finish) options?.onChunk?.(sse({ type: 'response.completed' }));
    return response;
  });
}
beforeEach(() => {
  vi.stubEnv('DATA_DIR', testDirectory);
  resetDbForTests();
  network.mockReset();
  vi.stubEnv('OPENAI_API_KEY', 'unit-only');
});
afterEach(() => {
  resetDbForTests();
  vi.unstubAllEnvs();
});
afterAll(() => rmSync(testDirectory, { recursive: true, force: true }));

describe('grounded AI response and streaming', () => {
  it('distinguishes incomplete HTTP 200 generation from validation rejection and retains reported usage', async () => {
    network.mockImplementation(async (_url, options) => {
      options?.onResponse?.(200, new Headers());
      options?.onChunk?.(
        sse({
          type: 'response.incomplete',
          response: { usage: { input_tokens: 50, output_tokens: 9 } },
        }),
      );
      return response;
    });
    const result = await generateGroundedReply(context, {
      usageContext: { scope: 'standalone', turnId: 'incomplete-test' },
    });
    expect(result.provider).toBe('local');
    expect(aiUsageReport({ turnId: 'incomplete-test' }).items[0]).toMatchObject({
      httpStatus: 200,
      outcome: 'network_error',
      errorCode: 'generation_failed',
      usage: { inputTokens: 50, outputTokens: 9 },
    });
  });
  it('emits a validated paragraph before completion, with split UTF-8 SSE chunks', async () => {
    const onText = vi.fn();
    network.mockImplementation(async (_url, options) => {
      const event = sse({
        type: 'response.output_text.delta',
        delta: `{"blocks":[${JSON.stringify(paragraph)}`,
      });
      for (let i = 0; i < event.length; i += 7) options?.onChunk?.(event.slice(i, i + 7));
      expect(onText).toHaveBeenCalledWith(paragraph.text);
      options?.onChunk?.(sse({ type: 'response.output_text.delta', delta: ']}' }));
      options?.onChunk?.(sse({ type: 'response.completed' }));
      return response;
    });
    expect(await generateGroundedReply(context, { onText })).toMatchObject({
      provider: 'openai',
      content: paragraph.text,
    });
    const [url, options] = network.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(options?.timeoutMs).toBe(8000);
    const body = JSON.parse(options!.body!);
    expect(body).toMatchObject({
      store: false,
      stream: true,
      text: { format: { type: 'json_schema', strict: true } },
    });
    expect(JSON.parse(body.input).facts).toEqual(context.facts);
  });
  it.each([
    { text: '価格は999円です。', evidenceIds: ['scope'] },
    { text: '秘密商事から納品します。', evidenceIds: ['scope'] },
    { text: 'バルブを販売しています。', evidenceIds: ['scope'] },
    { text: '注文が完了しました。', evidenceIds: ['scope'] },
    { text: '英語でのご相談も可能です。', evidenceIds: [] },
  ])('does not stream an invalid claim: $text', async (block) => {
    mockReply(block);
    const onText = vi.fn();
    expect(await generateGroundedReply(context, { onText })).toMatchObject({
      provider: 'local',
      content: context.canonical,
    });
    expect(onText.mock.calls.flat()).not.toContain(block.text);
  });
  it('drops a citation of a missing fact but keeps the checked text', () => {
    expect(
      validateReplyBlock(
        { text: 'ご相談いただけます。', evidenceIds: ['invented', 'scope'] },
        context,
      ),
    ).toEqual({ text: 'ご相談いただけます。', evidenceIds: ['scope'] });
  });
  it('drops supplement paragraphs that only restate the fixed answer', async () => {
    const canonical = '送料はお届け先と数量によって変わるため、お見積りで確定してご案内します。';
    network.mockImplementation(async (_url, options) => {
      options?.onChunk?.(
        sse({
          type: 'response.output_text.delta',
          delta: JSON.stringify({
            blocks: [
              {
                text: '送料はお届け先と数量によって変わるため、お見積りで確定します。',
                evidenceIds: [],
              },
              {
                text: 'お届け先の都道府県を教えていただければ、担当者が確認します。',
                evidenceIds: [],
              },
            ],
          }),
        }),
      );
      options?.onChunk?.(sse({ type: 'response.completed' }));
      return response;
    });
    const result = await generateGroundedReply({ ...context, canonical, mode: 'supplement' });
    expect(result.content).toBe('お届け先の都道府県を教えていただければ、担当者が確認します。');
  });
  it('drops sentences that paraphrase the fixed text and keeps what is new', async () => {
    const canonical =
      'お見積りの回答時期は、品目と確認する内容によって異なるため、このチャットではお約束できません。';
    mockReply({
      text: '見積依頼の返事は、品目や内容の確認によって異なり、このチャットで具体的な時間はお約束できません。出荷の目安は、在庫品かメーカー取り寄せかで変わります。',
      evidenceIds: [],
    });
    const result = await generateGroundedReply({ ...context, canonical, mode: 'supplement' });
    expect(result.content).toBe('出荷の目安は、在庫品かメーカー取り寄せかで変わります。');
  });
  it('rejects internal names, "御社" for ourselves and urgency the customer did not express', async () => {
    for (const text of [
      '受付時間はfactsに明示がないため、ご確認ください。',
      '御社では加工も承っています。',
      'お急ぎのご注文に間に合うかも含めて確認します。',
    ]) {
      mockReply({ text, evidenceIds: [] });
      expect((await generateGroundedReply(context)).provider).toBe('local');
    }
  });
  it('stops calling OpenAI for a while after the account runs out of credits', async () => {
    network.mockImplementation(async (_url, options) => {
      options?.onResponse?.(200, new Headers());
      options?.onChunk?.(
        sse({
          type: 'error',
          error: { type: 'insufficient_quota', code: 'credit_balance_exhausted' },
        }),
      );
      return response;
    });
    try {
      const first = await generateGroundedReply(context, {
        usageContext: { scope: 'standalone', turnId: 'quota-pause-test' },
      });
      expect(first).toMatchObject({ provider: 'local', reason: 'failed_or_ungrounded' });
      const second = await generateGroundedReply(context);
      expect(second).toMatchObject({ provider: 'local', reason: 'insufficient_quota' });
      expect(network).toHaveBeenCalledTimes(1);
      expect(aiUsageReport({ turnId: 'quota-pause-test' }).items[0]).toMatchObject({
        outcome: 'http_error',
        errorCode: 'insufficient_quota',
      });
      expect(overview().openaiQuotaExhaustedAt).toBeTruthy();
    } finally {
      pauseOpenaiForQuota(false);
    }
  });
  it('rejects hidden values even if a caller accidentally includes them among facts', async () => {
    mockReply({ text: '価格は100円です。', evidenceIds: ['scope'] });
    const result = await generateGroundedReply({
      ...context,
      confirmedProduct: true,
      facts: [{ id: 'scope', text: '100円' }],
      settings: { ...context.settings, flags: { ...context.settings.flags, showPrice: false } },
    });
    expect(result.provider).toBe('local');
  });
  it('falls back on missing credentials, provider errors and incomplete generation', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    expect((await generateGroundedReply(context)).reason).toBe('missing_key');
    expect(network).not.toHaveBeenCalled();
    vi.stubEnv('OPENAI_API_KEY', 'unit-only');
    network.mockRejectedValue(new Error('upstream error with secrets'));
    expect((await generateGroundedReply(context)).content).toBe(context.canonical);
    mockReply(paragraph, false);
    expect((await generateGroundedReply(context)).provider).toBe('local');
  });
  it('supports Gemini generation with the same grounding checks', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'unit-only');
    network.mockResolvedValue({
      ...response,
      body: Buffer.from(
        JSON.stringify({
          usageMetadata: {
            promptTokenCount: 100,
            candidatesTokenCount: 20,
            thoughtsTokenCount: 5,
            totalTokenCount: 125,
            cachedContentTokenCount: 30,
          },
          candidates: [{ content: { parts: [{ text: JSON.stringify({ blocks: [paragraph] }) }] } }],
        }),
      ),
    });
    const result = await generateGroundedReply({
      ...context,
      settings: { ...context.settings, responseProvider: 'gemini' },
    });
    expect(result.provider).toBe('gemini');
    expect(network.mock.calls[0][1]?.headers?.['x-goog-api-key']).toBe('unit-only');
    expect(aiUsageReport({ provider: 'gemini' }).items[0]).toMatchObject({
      purpose: 'response',
      model: 'gemini-2.5-flash',
      outcome: 'accepted',
      httpStatus: 200,
      usage: {
        inputTokens: 100,
        outputTokens: 25,
        totalTokens: 125,
        cachedInputTokens: 30,
        reasoningTokens: 5,
      },
    });
    expect(JSON.stringify(aiUsageReport({ provider: 'gemini' }))).not.toContain('unit-only');
  });
  it('parses braces in strings and never emits incomplete JSON blocks', () => {
    expect(completedBlocks('{"blocks":[{"text":"unfinished')).toEqual([]);
    const block = { text: '例は { "abc" } です。', evidenceIds: [] };
    expect(completedBlocks(`{"blocks":[${JSON.stringify(block)}, {"text":`)).toEqual([block]);
  });
  it('rewrites a rejected draft once with the reason, unless time has run out', async () => {
    const drafts = [{ text: '耐熱温度は500度です。', evidenceIds: ['scope'] }, paragraph];
    network.mockImplementation(async (_url, options) => {
      const block = drafts.shift() || paragraph;
      options?.onChunk?.(
        sse({ type: 'response.output_text.delta', delta: JSON.stringify({ blocks: [block] }) }),
      );
      options?.onChunk?.(sse({ type: 'response.completed' }));
      return response;
    });
    expect(await generateGroundedReply(context)).toMatchObject({
      provider: 'openai',
      reason: 'success_after_retry',
      content: paragraph.text,
    });
    const retry = JSON.parse(JSON.parse(network.mock.calls[1][1]!.body!).input);
    expect(retry.previousAttemptRejected).toContain('数値');
    network.mockReset();
    mockReply({ text: '耐熱温度は500度です。', evidenceIds: ['scope'] });
    const late = await generateGroundedReply(
      { ...context, fallback: '条件をもとに担当者が確認します。' },
      { retryUntil: Date.now() - 1 },
    );
    expect(late).toMatchObject({ provider: 'local', content: '条件をもとに担当者が確認します。' });
    expect(network).toHaveBeenCalledTimes(1);
  });
});

describe('reply validation', () => {
  const said: ReplyContext = {
    ...context,
    question:
      '工場の冷却水で、配管は25A、温度は40度です。予算は1万円です。2割引にしてもらえますか？',
    businessFactsOwnedLocally: true,
  };
  it.each([
    '25Aで40度の冷却水でしたら、ボール弁が一般的な候補です。',
    '送料が無料かどうかは、お届け先と数量をもとに担当者が確認します。',
    '2割引のご希望は承りました。割引の可否は担当者がお見積りの際に確認します。',
    'ご予算1万円とのこと、承知しました。',
    '確認したい点は2つです。材質はSUS304かどうかも教えてください。',
    '取り扱っているかどうかは担当者が確認します。',
    '納期の確約はできかねますが、担当者が確認します。',
    'ご注文はまだ完了していません。',
  ])('accepts a hedged or customer-sourced statement: %s', (text) => {
    expect(() => validateReplyBlock({ text, evidenceIds: [] }, said)).not.toThrow();
  });
  it.each([
    ['送料は無料です。', 'business_fact_owned_locally'],
    ['3割引いたします。', 'business_fact_owned_locally'],
    ['価格は1万円です。', 'business_fact_owned_locally'],
    ['通常3営業日で発送します。', 'business_fact_owned_locally'],
    ['在庫を確保しました。', 'unsupported_commitment'],
    ['来週金曜には間に合います。', 'unsupported_commitment'],
    ['ご注文が確定しました。', 'unsupported_commitment'],
    ['バルブを取り扱っています。', 'unapproved_sale'],
    ['耐熱温度は500度です。', 'unsupported_number'],
    // The customer named these amounts, but they must not become the offer.
    ['はい、価格は1万円です。', 'business_fact_owned_locally'],
    ['2割引になります。', 'business_fact_owned_locally'],
  ])('rejects a commitment or an invented value: %s', (text, code) => {
    expect(() => validateReplyBlock({ text, evidenceIds: [] }, said)).toThrow(code);
  });
});
