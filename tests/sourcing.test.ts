import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { DEFAULT_SETTINGS } from '../lib/contracts';
import { byId, db, putSettings, resetDbForTests } from '../lib/server/db';
import { answerChat, currentMessages } from '../lib/server/chat';
import { createQuote, verifyConversation } from '../lib/server/business';
import { researchNotes } from '../lib/server/research';
import { exactModelOnPage, visibleProductPrice } from '../lib/server/sourcing';
import { searchWeb } from '../lib/server/providers';
import { pauseOpenaiForQuota } from '../lib/server/ai-usage';
vi.mock('../lib/server/safe-fetch', () => ({ safeFetch: vi.fn() }));
import { safeFetch } from '../lib/server/safe-fetch';

const network = vi.mocked(safeFetch);
const directory = mkdtempSync(join(tmpdir(), 'aoki-sourcing-'));
const settings = {
  ...DEFAULT_SETTINGS,
  searchProvider: 'exa' as const,
  flags: { ...DEFAULT_SETTINGS.flags, webSearch: true },
};
beforeEach(() => {
  vi.stubEnv('DATA_DIR', directory);
  vi.stubEnv('DEMO_MODE', 'true');
  vi.stubEnv('EXA_API_KEY', 'unit-exa');
  vi.stubEnv('TYPESAFE_API_KEY', 'unit-jev');
  vi.stubEnv('TYPESAFE_API_BASE_URL', 'https://api.typesafe.ai');
  vi.stubEnv('OPENAI_API_KEY', 'unit-openai');
  resetDbForTests();
  rmSync(directory, { recursive: true, force: true });
  db();
  putSettings(settings);
  network.mockReset();
  pauseOpenaiForQuota(false);
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => {
  resetDbForTests();
  rmSync(directory, { recursive: true, force: true });
});

function mockSourcing(model = 'B-300-SCI', confidence = 0.96) {
  network.mockImplementation(async (url, options) => {
    const response = { status: 200, headers: new Headers(), url, body: Buffer.from('') };
    if (url.includes('exa.ai')) {
      const body = JSON.parse(options!.body!);
      expect(body.includeDomains).toBeUndefined();
      return {
        ...response,
        body: Buffer.from(
          JSON.stringify({
            results: [
              {
                title: '非公開仕入先の販売ページ',
                url: 'https://supplier.example/item',
                highlights: [`HARIO ${model}`],
              },
            ],
          }),
        ),
      };
    }
    if (url.includes('typesafe.ai'))
      return {
        ...response,
        body: Buffer.from(JSON.stringify({ answers: { p0: { noul: confidence } } })),
      };
    return {
      ...response,
      body: Buffer.from(
        `<html><body><main><h1>HARIO ビーカー ${model}</h1><p>カートに入れる</p></main><script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: 'ビーカー300mL', sku: model, offers: { price: '720', priceCurrency: 'JPY', availability: 'https://schema.org/InStock' } })}</script></body></html>`,
      ),
    };
  });
}

it('sources an unregistered model and keeps procurement prices and suppliers staff-only', async () => {
  mockSourcing();
  const reply = await answerChat('B-300-SCIの価格と納期を教えてください', 'customer');
  expect(reply.message.sourcing).toMatchObject({ model: 'B-300-SCI', status: 'candidate' });
  expect(reply.message.content).toContain('当社でお取り寄せ・お見積りのご相談を承ります');
  expect(reply.message.handoff).toBe('quote');
  expect(reply.message.content).not.toMatch(
    /取扱いを確認できません|720|supplier\.example|非公開仕入先/,
  );
  expect(reply.message.evidence).toEqual([]);
  const [note] = researchNotes(reply.conversationId);
  expect(note.decidedBy).toBe('jev');
  expect(note.findings).toEqual(
    expect.arrayContaining([expect.objectContaining({ aspect: 'price', value: '720円' })]),
  );
  expect(note.findings[0].url).toBe('https://supplier.example/item');
  expect(JSON.stringify(currentMessages(reply.conversationId))).not.toContain('supplier.example');
  const calls = network.mock.calls.length;
  const followup = await answerChat(
    '10個で価格と納期をお願いします',
    'customer',
    reply.conversationId,
  );
  expect(followup.message.sourcing?.model).toBe('B-300-SCI');
  expect(followup.message.content).toContain('伺った数量で');
  expect(followup.message.handoffDraft).toContain('10個');
  expect(network).toHaveBeenCalledTimes(calls);
  expect(researchNotes(reply.conversationId)).toHaveLength(1);
  const quote = createQuote(
    {
      name: '試験担当',
      company: '試験会社',
      email: 'test@example.com',
      consent: true,
      quantity: 10,
      message: followup.message.handoffDraft!,
      conversationId: reply.conversationId,
    },
    'customer',
  );
  expect(quote.status).toBe('requested');
  expect(byId<{ conversationId?: string }>('quotes', quote.id)?.conversationId).toBe(
    reply.conversationId,
  );
  expect(quote.message).toContain('B-300-SCI');
  expect(verifyConversation(reply.conversationId, 'customer').status).toBe('handed_off');
});

it('does not turn a suffix variant or an unrelated Jev result into a procurement candidate', async () => {
  mockSourcing('B-300-SCI-2');
  const mismatch = await answerChat('B-300-SCIはありますか', 'customer');
  expect(mismatch.message.sourcing?.status).toBe('not_found');
  expect(mismatch.message.content).not.toContain('候補を確認できました');
  mockSourcing('B-300-SCI', 0.2);
  const rejected = await answerChat('B-300-SCIはありますか', 'other-customer');
  expect(rejected.message.sourcing?.status).toBe('not_found');
});

it('switches from a registered product to a new model without reusing the old price', async () => {
  mockSourcing();
  const first = await answerChat('DEMO-CAST-01の価格を教えてください', 'customer');
  expect(network).not.toHaveBeenCalled();
  const second = await answerChat(
    '別の商品です。B-300-SCIは取り寄せできますか',
    'customer',
    first.conversationId,
  );
  expect(second.message.sourcing?.status).toBe('candidate');
  expect(second.message.products).toEqual([]);
  expect(second.message.content).not.toContain('8,400');
});

it('records failed research and keeps the quote path without pretending search succeeded', async () => {
  network.mockRejectedValue(Error('network unavailable'));
  const reply = await answerChat('B-300-SCIを10個買いたいです', 'customer');
  expect(reply.message.sourcing?.status).toBe('failed');
  expect(reply.message.content).toContain('自動調査を完了できていません');
  expect(reply.message.content).not.toContain('候補を確認できました');
  expect(reply.message.handoff).toBe('quote');
  expect(researchNotes(reply.conversationId)[0].status).toBe('failed');
});

it('requires exact model boundaries while allowing catalog separators', () => {
  expect(exactModelOnPage('B-300-SCI', '型番 B-300 SCI 300mL')).toBe(true);
  expect(exactModelOnPage('B-300-SCI', '型番 B300SCI')).toBe(true);
  expect(exactModelOnPage('B-300-SCI', '型番 B-300-SCI-2')).toBe(false);
  expect(exactModelOnPage('6205DDU', '型番 6205DDUC3')).toBe(false);
});

it('reads visible reference prices only from the matching main product', () => {
  const matsuyoshi = cheerio.load(`
    <div class="productDetail_main">
      <h1 class="productDetail_headLine">ハリオ B-300-SCI(300ML)</h1>
      <dl class="productDetail_price"><dt>希望小売価格/参考価格</dt>
        <dd><em>¥720</em>(税抜き) [¥792(税込み)]</dd></dl>
    </div>`);
  expect(visibleProductPrice(matsuyoshi, 'B-300-SCI')).toMatchObject({
    amount: 720,
    reference: true,
  });
  expect(visibleProductPrice(matsuyoshi, 'B-300-SCI')?.value).toContain('792円(税込み)');
  const rikanavi = cheerio.load(`
    <div class="p-detailContent">
      <h4><span class="p-detailContent__name">ビーカー Ｂ－３００ ＳＣＩ</span></h4>
      <p class="p-detailContent__price">標準価格：¥<span>720</span>（税抜）</p>
    </div>
    <table><tr><td>B-100-SCI</td><td class="c-tableProduct__price">¥3,180</td></tr></table>`);
  expect(visibleProductPrice(rikanavi, 'B-300-SCI')).toMatchObject({
    amount: 720,
    reference: true,
    value: '標準価格:720円(税抜)',
  });
  expect(visibleProductPrice(rikanavi, 'B-100-SCI')).toBeUndefined();
  expect(visibleProductPrice(matsuyoshi, 'B-300-SCI-2')).toBeUndefined();
});

it('saves visible standard prices for staff without treating them as procurement costs', async () => {
  mockSourcing();
  const implementation = network.getMockImplementation()!;
  network.mockImplementation(async (url, options) => {
    if (url !== 'https://supplier.example/item') return implementation(url, options);
    return {
      status: 200,
      headers: new Headers(),
      url,
      body: Buffer.from(`<div class="p-detailContent">
        <h4><span class="p-detailContent__name">B-300-SCI</span></h4>
        <p class="p-detailContent__price">標準価格：¥720（税抜）</p>
        <button>カートに入れる</button></div>`),
    };
  });
  const reply = await answerChat('B-300-SCIの価格を教えてください', 'customer');
  const [note] = researchNotes(reply.conversationId);
  expect(note.findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ aspect: 'price', value: '標準価格:720円(税抜)' }),
    ]),
  );
  expect(note.offers?.[0]).toMatchObject({ price: null, approved: false });
  expect(reply.message.content).not.toMatch(/720|supplier\.example/);
});

it('uses actual OpenAI search sources and drops invented product URLs', async () => {
  network.mockImplementation(async (url, options) => {
    expect(url).toBe('https://api.openai.com/v1/responses');
    const body = JSON.parse(options!.body!);
    expect(body.tool_choice).toBe('required');
    expect(body.tools[0].type).toBe('web_search');
    return {
      status: 200,
      headers: new Headers(),
      url,
      body: Buffer.from(
        JSON.stringify({
          status: 'completed',
          output: [
            {
              type: 'web_search_call',
              action: { sources: [{ url: 'https://maker.example/product' }] },
            },
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    results: [
                      {
                        title: '実在の検索先',
                        url: 'https://maker.example/product',
                        content: 'B-300 SCI',
                      },
                      {
                        title: '検索で訪問していないページ',
                        url: 'https://maker.example/invented',
                        content: 'B-300 SCI',
                      },
                    ],
                  }),
                },
              ],
            },
          ],
        }),
      ),
    };
  });
  const results = await searchWeb('B-300-SCI', { ...settings, searchProvider: 'openai' }, []);
  expect(results).toHaveLength(1);
  expect(results[0].url).toBe('https://maker.example/product');
});

it('continues through quantity and destination to a complete selling estimate, then recalculates changes', async () => {
  mockSourcing();
  const { updateProcurementOffer } = await import('../lib/server/sourcing-estimate');
  putSettings({
    ...settings,
    sourcingEstimate: {
      ...settings.sourcingEstimate,
      enabled: true,
      markupPercent: 20,
      minimumProfitYen: 0,
      handlingFeeYen: 0,
      extraBusinessDays: 1,
      roundingYen: 10,
    },
  });
  const first = await answerChat('B-300-SCIは取り寄せできますか？', 'estimate-customer');
  const note = researchNotes(first.conversationId)[0];
  expect(note.offers).toHaveLength(1);
  expect(note.offers![0]).toMatchObject({
    price: 720,
    taxIncluded: null,
    packQuantity: null,
    approved: false,
  });
  const offer = note.offers![0];
  updateProcurementOffer(first.conversationId, note.id, offer.id, {
    ...offer,
    price: 1100,
    taxIncluded: true,
    purchaseTaxRate: 10,
    packQuantity: 1,
    availableQuantity: 30,
    customerShippingNet: 800,
    destination: '大阪',
    deliveryMinDays: 2,
    deliveryMaxDays: 3,
    approved: true,
  });
  const second = await answerChat('10個お願いします', 'estimate-customer', first.conversationId);
  expect(second.message.requestedQuantity).toBe(10);
  expect(second.message.estimate).toBeUndefined();
  expect(second.message.content).toContain('お届け先の都道府県');
  const third = await answerChat(
    '大阪です。価格と納期を教えてください',
    'estimate-customer',
    first.conversationId,
  );
  expect(third.message.sourcing?.model).toBe('B-300-SCI');
  expect(third.message.estimate).toMatchObject({
    quantity: 10,
    destination: '大阪',
    unitPrice: 1200,
    shipping: 800,
    total: 14080,
    minBusinessDays: 3,
    maxBusinessDays: 4,
  });
  expect(third.message.content).toContain('合計（税込）：14,080円');
  expect(third.message.handoffDraft).toContain('14,080円');
  expect(third.message.estimateRevision).toBeUndefined();
  expect(JSON.stringify(third)).not.toMatch(/1100|supplier\.example|非公開仕入先|markupPercent/);
  const restored = currentMessages(first.conversationId).find((m) => m.id === third.message.id)!;
  expect(restored.content).toBe(third.message.content);
  expect(restored.estimateRevision).toBeUndefined();
  const fourth = await answerChat(
    '20個ならいくらですか？',
    'estimate-customer',
    first.conversationId,
  );
  expect(fourth.message.estimate).toMatchObject({
    quantity: 20,
    destination: '大阪',
    total: 27280,
  });
  const differentDestination = await answerChat(
    '東京への送料はいくら？',
    'estimate-customer',
    first.conversationId,
  );
  expect(differentDestination.message.estimate).toBeUndefined();
  expect(differentDestination.message.content).toContain('東京への配送条件');
  const nextProduct = await answerChat(
    '別の商品です。B-500-SCIの価格を教えてください',
    'estimate-customer',
    first.conversationId,
  );
  expect(nextProduct.message.requestedQuantity).toBeUndefined();
  expect(nextProduct.message.requestedDestination).toBeUndefined();
  expect(nextProduct.message.estimate).toBeUndefined();
});

it('invalidates restored estimates and their handoff drafts when price permissions or the source change', async () => {
  mockSourcing();
  const { updateProcurementOffer } = await import('../lib/server/sourcing-estimate');
  const activeSettings = {
    ...settings,
    sourcingEstimate: {
      ...settings.sourcingEstimate,
      enabled: true,
      markupPercent: 20,
      minimumProfitYen: 0,
      handlingFeeYen: 0,
      extraBusinessDays: 1,
    },
  };
  putSettings(activeSettings);
  const first = await answerChat('B-300-SCIを10個、大阪まで取り寄せできますか', 'private-estimate');
  const note = researchNotes(first.conversationId)[0],
    offer = note.offers![0];
  updateProcurementOffer(first.conversationId, note.id, offer.id, {
    ...offer,
    price: 1100,
    taxIncluded: true,
    purchaseTaxRate: 10,
    packQuantity: 1,
    availableQuantity: 10,
    customerShippingNet: 800,
    destination: '大阪',
    deliveryMinDays: 2,
    deliveryMaxDays: 3,
    approved: true,
  });
  const priced = await answerChat(
    '価格と納期を教えてください',
    'private-estimate',
    first.conversationId,
  );
  expect(priced.message.estimate?.total).toBe(14080);
  const checkRedacted = () => {
    const restored = currentMessages(first.conversationId).find((m) => m.id === priced.message.id)!;
    expect(restored.estimate).toBeUndefined();
    expect(restored.content).not.toMatch(/14,080|1,200|800円|3～4/);
    expect(restored.handoffDraft).not.toContain('14,080');
  };
  putSettings({ ...activeSettings, flags: { ...activeSettings.flags, showPrice: false } });
  checkRedacted();
  putSettings(activeSettings);
  updateProcurementOffer(first.conversationId, note.id, offer.id, {
    ...offer,
    price: 3000,
    approved: false,
  });
  checkRedacted();
  expect(() => updateProcurementOffer('another-conversation', note.id, offer.id, offer)).toThrow(
    '調達候補が見つかりません',
  );
});
