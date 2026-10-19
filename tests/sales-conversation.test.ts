import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_SETTINGS,
  type ChatResponse,
  type Source,
  type StoredChatMessage,
} from '../lib/contracts';
import { db, now, putSettings, resetDbForTests, save } from '../lib/server/db';
import { answerChat, currentMessages } from '../lib/server/chat';
import { createQuote, conversationMessages } from '../lib/server/business';
vi.mock('../lib/server/sales-model', () => ({ salesModel: vi.fn() }));
vi.mock('../lib/server/sales-intake', () => ({ missingSalesConditions: vi.fn() }));
vi.mock('../lib/server/safe-fetch', () => ({ safeFetch: vi.fn() }));
vi.mock('../lib/server/providers', async (original) => ({
  ...(await original<object>()),
  searchWeb: vi.fn(),
}));
import { salesModel } from '../lib/server/sales-model';
import { missingSalesConditions } from '../lib/server/sales-intake';
import { safeFetch } from '../lib/server/safe-fetch';
import { searchWeb } from '../lib/server/providers';
import type { salesTurnSchema } from '../lib/server/sales-turn';
import type { z } from 'zod';
const model = vi.mocked(salesModel),
  network = vi.mocked(safeFetch),
  search = vi.mocked(searchWeb);
const directory = mkdtempSync(join(tmpdir(), 'aoki-sales-stage-'));
const requirements = ['耐荷重300kg以上', '荷台幅600mm以下'];
const source: Source = {
  id: 'preferred',
  name: '非公開登録先',
  kind: 'website',
  url: 'https://private-shop.example/',
  enabled: true,
  visibility: 'internal',
  trust: 'internal',
  config: {},
  syncIntervalHours: 0,
  lastSyncedAt: null,
  lastError: null,
  recordCount: 0,
  createdAt: now(),
};
const question =
  '台車が欲しいです。耐荷重300kg以上、荷台幅600mm以下で、2台、大阪府です。条件を満たす型番を全部探してください。';
beforeEach(() => {
  resetDbForTests();
  rmSync(directory, { recursive: true, force: true });
  vi.stubEnv('DATA_DIR', directory);
  vi.stubEnv('DEMO_MODE', 'true');
  db();
  putSettings({
    ...DEFAULT_SETTINGS,
    responseProvider: 'openai',
    responseModel: 'gpt-4.1',
    searchProvider: 'exa',
    flags: { ...DEFAULT_SETTINGS.flags, webSearch: true },
  });
  save('sources', source);
  model.mockReset();
  vi.mocked(missingSalesConditions).mockReset().mockResolvedValue([]);
  network.mockReset();
  search.mockReset();
  model.mockImplementation(async (input) =>
    input.purpose === 'classification'
      ? {
          product: '台車',
          requirements: requirements.map((text) => ({ text, quote: text })),
          ready: true,
          question: '',
        }
      : {
          candidates: ['CART-100', 'CART-200', 'CART-300', 'CART-400', 'CART-500'].map(
            (model, page) => ({
              model,
              page,
              checks: [
                {
                  requirement: 0,
                  result: page === 4 ? 'mismatch' : 'matches',
                  quote: '耐荷重300kg',
                },
                {
                  requirement: 1,
                  result: page === 3 ? 'unknown' : 'matches',
                  quote: page === 3 ? '' : '幅600mm',
                },
              ],
            }),
          ),
        },
  );
  search.mockResolvedValue(
    ['在庫あり', '在庫なし', '', '在庫あり', '在庫あり'].map((stock, i) => ({
      title: `CART-${i + 1}00`,
      url: `https://private-shop.example/${i}`,
      excerpt: stock,
      retrievedAt: now(),
      visibility: 'internal',
      trust: 'internal',
    })),
  );
  network.mockImplementation(async (url) => {
    const i = Number(url.split('/').at(-1));
    return {
      status: 200,
      headers: new Headers(),
      url,
      body: Buffer.from(
        `<main><h1>CART-${i + 1}00</h1><p>耐荷重300kg</p><p>幅600mm</p><p>${['在庫あり', '在庫なし', '', '在庫あり', '在庫あり'][i]}</p></main>`,
      ),
    };
  });
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => {
  resetDbForTests();
  rmSync(directory, { recursive: true, force: true });
});
const turn = (message: string, prior?: ChatResponse) =>
  answerChat(message, 'stage-owner', prior?.conversationId);
async function candidates() {
  return turn('はい、この条件で探してください', await turn(question));
}
function naturalTurn(patch: Partial<z.infer<typeof salesTurnSchema>>) {
  const impl = model.getMockImplementation()!;
  model.mockImplementation(async (input) => {
    if ((input.data as { mode?: string }).mode === 'sales_turn')
      return {
        searchConsent: 'none',
        quoteConsent: 'none',
        requirementsChanged: false,
        pause: false,
        candidateIndex: null,
        moreCandidates: false,
        question: 'none',
        ...patch,
      };
    return impl(input);
  });
}

it('completes only one stage per reply and requires selection and quote consent before showing the form', async () => {
  const intake = await turn(question);
  expect(intake.message.salesState?.stage).toBe('requirements_confirmation');
  expect(intake.message.handoff).toBeUndefined();
  expect(search).not.toHaveBeenCalled();
  const found = await turn('はい、この条件で探してください', intake);
  expect(() =>
    createQuote(
      {
        name: '早すぎる依頼',
        company: '',
        email: 'test@example.invalid',
        message: '見積依頼',
        consent: true,
        quantity: 2,
        conversationId: found.conversationId,
      },
      'stage-owner',
    ),
  ).toThrow('型番の選択');
  expect(found.message.salesState?.stage).toBe('candidates');
  expect(found.message.selection?.candidates).toHaveLength(4);
  expect(found.message.content).toContain('CART-100');
  expect(found.message.content).toContain('CART-200');
  expect(found.message.content).toContain('掲載上は在庫あり');
  expect(found.message.content).toContain('掲載上は欠品');
  expect(found.message.content).toContain('在庫表示を確認できず');
  expect(found.message.content).not.toContain('CART-500');
  expect(found.message.handoff).toBeUndefined();
  expect(search.mock.calls[0][2]).toEqual(['private-shop.example']);
  expect(search).toHaveBeenCalledTimes(1);
  const ambiguous = await turn('見積をお願いします', found);
  expect(ambiguous.message.salesState?.stage).toBe('candidates');
  expect(ambiguous.message.handoff).toBeUndefined();
  const chosen = await turn('1番で見積をお願いします', ambiguous);
  expect(chosen.message.salesState?.stage).toBe('quote_offer');
  expect(chosen.message.handoff).toBeUndefined();
  const consent = await turn('はい、お願いします', chosen);
  expect(consent.message.salesState?.stage).toBe('contact');
  expect(consent.message.handoff).toBe('quote');
  expect(consent.message.content).toContain('青木');
  expect(consent.message.content).toContain('2台');
  expect(consent.message.handoffDraft).toContain('CART-100');
  expect(consent.message.requestedQuantity).toBe(2);
  expect(consent.message.requestedDestination).toBe('大阪府');
  expect(consent.message.handoffDraft).not.toContain('private-shop.example');
  createQuote(
    {
      name: '検証',
      company: '',
      email: 'test@example.invalid',
      message: consent.message.handoffDraft!,
      consent: true,
      quantity: 2,
      conversationId: consent.conversationId,
    },
    'stage-owner',
  );
  const review = await turn('見積依頼を送信しました', consent);
  expect(review.message.salesState?.stage).toBe('review');
  expect(review.message.content).not.toMatch(/送信しました|送信済み/);
  expect(review.message.content).toContain('青木の確認後');
  const stored = conversationMessages(review.conversationId) as StoredChatMessage[];
  expect(stored.find((m) => m.selection)?.sourceTrace?.stages.map((s) => s.scope)).toEqual([
    'registered_data',
    'preferred_sites',
  ]);
  expect(JSON.stringify(currentMessages(review.conversationId))).not.toMatch(
    /private-shop|非公開登録先|sourceTrace/,
  );
});
it('keeps unknown specifications separate and does not accept them as satisfying all requirements', async () => {
  const found = await candidates();
  const chosen = await turn('4番でお願いします', found);
  expect(chosen.message.salesState?.stage).toBe('candidates');
  expect(chosen.message.content).toContain('裏付けがまだ');
  expect(chosen.message.handoff).toBeUndefined();
});
it('lets an out-of-stock candidate proceed to a quote inquiry and respects refusal', async () => {
  const found = await candidates();
  const chosen = await turn('2番でお願いします', found);
  expect(chosen.message.salesState?.stage).toBe('quote_offer');
  expect(chosen.message.content).toContain('欠品');
  const refused = await turn('まだ見積は不要です', chosen);
  expect(refused.message.salesState?.stage).toBe('candidates');
  expect(refused.message.handoff).toBeUndefined();
});
it('reopens requirement confirmation after corrections without searching or retaining a selected model', async () => {
  const chosen = await turn('1番でお願いします', await candidates());
  const changed = await turn('条件を変更して、耐荷重300kg以上のままで探し直したいです', chosen);
  expect(changed.message.salesState?.stage).toBe('requirements_confirmation');
  expect(changed.message.salesState?.selectedModel).toBeUndefined();
  expect(changed.message.selection).toBeUndefined();
  expect(search).toHaveBeenCalledTimes(1);
});
it('reapplies visibility flags to saved selection replies and invalidates results when registered sources change', async () => {
  const found = await candidates();
  putSettings({
    ...DEFAULT_SETTINGS,
    responseModel: 'gpt-4.1',
    flags: { ...DEFAULT_SETTINGS.flags, showStock: false, showLeadTime: false },
  });
  expect(JSON.stringify(currentMessages(found.conversationId))).not.toMatch(
    /in_stock|out_of_stock|掲載上は在庫あり|掲載上は欠品/,
  );
  save('sources', { ...source, enabled: false });
  const next = await turn('1番でお願いします', found);
  expect(next.message.salesState?.stage).toBe('requirements_confirmation');
  expect(next.message.selection).toBeUndefined();
});
it('stays at intake after API failure instead of skipping to a quote', async () => {
  model.mockRejectedValue(Error('timeout'));
  const failed = await turn(question);
  expect(failed.message.salesState?.stage).toBe('requirements');
  expect(failed.message.handoff).toBeUndefined();
  expect(search).not.toHaveBeenCalled();
});

it('remembers quote consent while collecting a missing quantity on the next turn', async () => {
  const intake = await turn(question.replace('2台、', ''));
  const found = await turn('はい、この条件で探してください', intake);
  const chosen = await turn('1番でお願いします', found);
  const awaiting = await turn('はい、見積をお願いします', chosen);
  expect(awaiting.message.salesState?.stage).toBe('quote_offer');
  expect(awaiting.message.salesState?.quoteConsent).toBe(true);
  expect(awaiting.message.content).toContain('数量');
  expect(awaiting.message.handoff).toBeUndefined();
  const complete = await turn('2台です', awaiting);
  expect(complete.message.salesState?.stage).toBe('contact');
  expect(complete.message.handoff).toBe('quote');
});

it('uses the actual SKU for page stock even when AI prefixes a manufacturer', async () => {
  const impl = model.getMockImplementation()!;
  model.mockImplementation(async (input) => {
    const data = (await impl(input)) as { candidates?: { model: string }[] };
    if (data.candidates)
      data.candidates.forEach((c) => {
        c.model = `ACME ${c.model}`;
      });
    return data;
  });
  const found = await candidates();
  expect(found.message.selection?.candidates[0]).toMatchObject({
    model: 'CART-100',
    sourcing: { availability: { stock: 'in_stock' } },
  });
  const chosen = await turn('CART-100でお願いします', found);
  expect(chosen.message.salesState?.stage).toBe('quote_offer');
});

it('accepts a quote request with an attached delivery question without treating the question as refusal', async () => {
  const chosen = await turn('1番でお願いします', await candidates());
  naturalTurn({ quoteConsent: 'yes', question: 'dispatch_arrival' });
  const next = await turn(
    'ありがとうございます。見積をお願いします。最短当日出荷なら明日届きますか？',
    chosen,
  );
  expect(next.message.salesState?.stage).toBe('contact');
  expect(next.message.content).toContain('翌日の到着は確定しません');
  expect(next.message.handoff).toBe('quote');
});

it('does not interpret a warning about compatibility as declining the requested quote', async () => {
  const chosen = await turn('1番でお願いします', await candidates());
  naturalTurn({ quoteConsent: 'yes', question: 'specification' });
  const next = await turn(
    '現物に適合しない場合があることは承知の上で、見積をお願いしたいです。',
    chosen,
  );
  expect(next.message.salesState?.stage).toBe('contact');
  expect(next.message.content).toContain('適合は確定しません');
});

it('honors a pause without restarting requirement confirmation or opening a form', async () => {
  const found = await candidates();
  naturalTurn({ pause: true });
  const next = await turn(
    '条件の変更はできませんので、今回は保留にします。ありがとうございました。',
    found,
  );
  expect(next.message.salesState?.stage).toBe('candidates');
  expect(next.message.content).toContain('保留にします');
  expect(next.message.content).not.toContain('よろしいですか');
  expect(next.message.handoff).toBeUndefined();
  expect(search).toHaveBeenCalledTimes(1);
});

it('removes non-restrictions from required specifications instead of holding every candidate', async () => {
  const impl = model.getMockImplementation()!;
  model.mockImplementation(async (input) => {
    const data = (await impl(input)) as { requirements?: { text: string; quote: string }[] };
    if (data.requirements)
      data.requirements.push({ text: 'メーカー指定なし', quote: 'メーカー指定なし' });
    return data;
  });
  const intake = await turn(question + 'メーカー指定なしです。');
  expect(intake.message.salesState?.requirements).not.toContain('メーカー指定なし');
  const found = await turn('はい、この条件で探してください', intake);
  expect((await turn('1番でお願いします', found)).message.salesState?.stage).toBe('quote_offer');
});

it('preserves explicitly required manufacturer and full model when intake puts them outside the conditions array', async () => {
  model.mockResolvedValueOnce({
    product: '台車',
    manufacturer: 'TRUSCO',
    model: 'CART-100',
    requirements: requirements.map((text) => ({ text, quote: text })),
    ready: true,
    question: '',
  });
  const intake = await turn(question + 'メーカーはTRUSCO、型番はCART-100です。');
  expect(intake.message.salesState?.requirements).toEqual(
    expect.arrayContaining(['TRUSCO', 'CART-100']),
  );
});

it('reconfirms added specifications even when the same message also agrees to search', async () => {
  const intake = await turn(question);
  const impl = model.getMockImplementation()!;
  model.mockImplementation(async (input) => {
    if ((input.data as { mode?: string }).mode === 'sales_turn')
      return {
        searchConsent: 'yes',
        quoteConsent: 'none',
        requirementsChanged: true,
        pause: false,
        candidateIndex: null,
        moreCandidates: false,
        question: 'none',
      };
    return {
      product: '台車',
      manufacturer: '',
      model: '',
      requirements: [
        { text: requirements[0], quote: requirements[0] },
        { text: '荷台幅550mm以下', quote: '幅は550mm以下' },
      ],
      ready: true,
      question: '',
    };
  });
  const next = await turn('はい、ただ幅は550mm以下が必須です。', intake);
  expect(next.message.salesState?.stage).toBe('requirements_confirmation');
  expect(next.message.salesState?.requirements).toContain('荷台幅550mm以下');
  expect(search).not.toHaveBeenCalled();
});

it('checks missing structural requirements before confirming the search', async () => {
  vi.mocked(missingSalesConditions).mockResolvedValue([
    { text: '入力にはないメーカー・構造などの説明', quote: '手押し台車' },
  ]);
  const intake = await turn(question.replace('台車が', '手押し台車が'));
  expect(intake.message.salesState?.requirements).toContain('手押し台車');
  expect(intake.message.salesState?.requirements.join('')).not.toContain('入力にはない');
  expect(intake.message.salesState?.query).toContain('手押し台車');
  expect(search).not.toHaveBeenCalled();
});

it('keeps the requirements stage open when the completeness check fails', async () => {
  vi.mocked(missingSalesConditions).mockResolvedValue(undefined);
  const intake = await turn(question);
  expect(intake.message.salesState?.stage).toBe('requirements');
  expect(intake.message.handoff).toBeUndefined();
  expect(search).not.toHaveBeenCalled();
});

it('expands after checking registered sites when one candidate is insufficient for comparison', async () => {
  const evidence = Array.from({ length: 3 }, (_, i) => ({
    title: `CART-${i + 1}00`,
    url: `https://outside.example/${i}`,
    excerpt: '商品掲載',
    retrievedAt: now(),
    visibility: 'public' as const,
    trust: 'discovery' as const,
  }));
  search
    .mockResolvedValueOnce([{ ...evidence[0], url: 'https://private-shop.example/0' }])
    .mockResolvedValueOnce(evidence);
  const found = await candidates();
  expect(search).toHaveBeenCalledTimes(2);
  expect(search.mock.calls.map((c) => c[2])).toEqual([['private-shop.example'], []]);
  expect(found.message.selection?.candidates.some((c) => c.model === 'CART-200')).toBe(true);
});

it('keeps consent while asking for a missing destination and normalizes the prefecture', async () => {
  const intake = await turn(question.replace('大阪府です。', ''));
  const found = await turn('はい、この条件で探してください', intake);
  const chosen = await turn('1番でお願いします', found);
  const awaiting = await turn('はい、見積をお願いします', chosen);
  expect(awaiting.message.salesState?.stage).toBe('quote_offer');
  expect(awaiting.message.content).toContain('都道府県');
  expect(awaiting.message.handoff).toBeUndefined();
  const complete = await turn('配送先は福岡県です', awaiting);
  expect(complete.message.salesState?.stage).toBe('contact');
  expect(complete.message.requestedDestination).toBe('福岡県');
});
