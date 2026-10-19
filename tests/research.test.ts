import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, type Source } from '../lib/contracts';
import { db, putSettings, resetDbForTests, save } from '../lib/server/db';
import { aiUsageReport } from '../lib/server/ai-usage';
import { importSupplierKnowledge } from '../lib/server/supplier-knowledge';
import { answerChat } from '../lib/server/chat';
vi.mock('../lib/server/safe-fetch', () => ({ safeFetch: vi.fn() }));
import { safeFetch } from '../lib/server/safe-fetch';
import {
  checkOnPage,
  destinationIn,
  itemOnPage,
  researchForStaff,
  researchNotes,
  statedQuantities,
  valueOnPage,
  type ResearchRequest,
} from '../lib/server/research';

const network = vi.mocked(safeFetch);
const directory = mkdtempSync(join(tmpdir(), 'aoki-research-'));
const retailer = 'https://shop.example.jp/item/kitz-25a';
const supplierSite = 'https://www.valve-supplier.example/catalog/25a';
const source: Source = {
  id: 'private-fields',
  name: '仕入先一覧.xlsx',
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
const request: ResearchRequest = {
  conversationId: 'c1',
  turnId: 't1',
  message: 'KITZの青銅ゲートバルブ10K、ねじ込み25Aを6個。価格と納期を知りたいです。',
  customerTexts: ['KITZの青銅ゲートバルブ10K、ねじ込み25Aを6個。価格と納期を知りたいです。'],
  subject: 'KITZ 青銅ゲートバルブ 10K ねじ込み 25A',
  fields: ['バルブ'],
  quantity: '6個',
  local: { research: true, aspects: ['price', 'lead_time'] },
};
const json = (body: unknown, url = '') => ({
  status: 200,
  headers: new Headers({ 'content-type': 'application/json' }),
  url,
  body: Buffer.from(JSON.stringify(body)),
});
function searchResult(urls: string[], findings: unknown[]) {
  return {
    usage: { input_tokens: 8800, output_tokens: 300 },
    output: [
      {
        type: 'web_search_call',
        action: { type: 'search', sources: urls.map((url) => ({ url })) },
      },
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            annotations: [],
            text: JSON.stringify({
              matched_item: 'KITZ FH 25A',
              summary: '通販で価格と出荷目安を確認。',
              findings,
            }),
          },
        ],
      },
    ],
  };
}
function mockWeb(options: { wanted?: number } = {}) {
  network.mockImplementation(async (url, init) => {
    if (url.includes('typesafe')) {
      const body = JSON.parse(init!.body!);
      const answers = Object.fromEntries(
        Object.keys(body.questions).map((id) => [
          id,
          {
            noul:
              id === 'wanted'
                ? (options.wanted ?? 0.92)
                : id === 'stock' || id === 'shipping'
                  ? 0.1
                  : 0.88,
          },
        ]),
      );
      return json({ usage: { input_tokens: 900, output_tokens: 6 }, answers }, url);
    }
    if (url === 'https://api.openai.com/v1/responses') {
      const body = JSON.parse(init!.body!);
      const supplier = !!body.tools[0].filters;
      return json(
        supplier
          ? searchResult(
              [supplierSite],
              [
                {
                  aspect: 'lead_time',
                  value: '受注後5営業日',
                  note: '',
                  title: '25A',
                  url: supplierSite,
                  source: 'other',
                },
              ],
            )
          : searchResult(
              [retailer, 'https://blocked.example/item'],
              [
                {
                  aspect: 'price',
                  value: '¥18,700(税込) / ¥17,000(税抜)',
                  note: '型式FH',
                  title: 'KITZ 25A',
                  // Written as a Markdown link with a tracking parameter.
                  url: `([shop.example.jp](${retailer}?utm_source=openai))`,
                  source: 'retailer',
                },
                {
                  aspect: 'stock',
                  value: '在庫数 7',
                  note: '',
                  title: 'KITZ 25A',
                  url: retailer,
                  source: 'retailer',
                },
                {
                  aspect: 'lead_time',
                  value: '2～3日で出荷',
                  note: '',
                  title: '架空の別ページ',
                  url: 'https://invented.example/x',
                  source: 'retailer',
                },
                {
                  aspect: 'lead_time',
                  value: '当日出荷',
                  note: '',
                  title: '自動取得を断るサイト',
                  url: 'https://blocked.example/item',
                  source: 'retailer',
                },
                {
                  aspect: 'price',
                  value: '通販サイトに掲載あり',
                  note: '',
                  title: '値のない記載',
                  url: retailer,
                  source: 'retailer',
                },
              ],
            ),
        url,
      );
    }
    if (url.includes('blocked.example'))
      return { status: 403, headers: new Headers(), url, body: Buffer.from('') };
    const page =
      url === retailer
        ? '<html><body><h1>KITZ 青銅ゲートバルブ 10K 25A</h1><p>¥18,700 (税込) / ¥17,000 (税抜)</p><p>在庫数 17</p></body></html>'
        : '<html><body><p>25A ゲートバルブ 受注後5営業日で出荷</p></body></html>';
    return {
      status: 200,
      headers: new Headers({ 'content-type': 'text/html' }),
      url,
      body: Buffer.from(page),
    };
  });
}
beforeEach(() => {
  vi.stubEnv('DATA_DIR', directory);
  vi.stubEnv('DEMO_MODE', 'true');
  vi.stubEnv('OPENAI_API_KEY', 'unit-openai');
  vi.stubEnv('TYPESAFE_API_KEY', 'unit-jev');
  vi.stubEnv('TYPESAFE_API_BASE_URL', 'https://api.typesafe.ai');
  resetDbForTests();
  rmSync(directory, { recursive: true, force: true });
  db();
  network.mockReset();
  save('sources', source);
  importSupplierKnowledge(
    source,
    [
      {
        supplierName: '非公開バルブ商事',
        website: 'https://www.valve-supplier.example/',
        products: 'バルブ',
        fields: [],
        sheet: '仕入',
        row: 2,
      },
    ],
    true,
  );
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => {
  resetDbForTests();
  rmSync(directory, { recursive: true, force: true });
});

it('keeps only values found on the page as written', () => {
  const page = 'KITZ 25A 販売価格 ¥18,700 (税込) / ¥17,000 (税抜) 在庫数 17 出荷目安：2～3日';
  expect(valueOnPage('¥18,700(税込) / ¥17,000(税抜)', page)).toBe(true);
  expect(valueOnPage('通常2〜3日で出荷', page)).toBe(true);
  expect(valueOnPage('在庫数 7', page)).toBe(false);
  expect(valueOnPage('¥19,800(税込)', page)).toBe(false);
});

it('finds the destination the customer named', () => {
  expect(destinationIn(['大阪の工場に届けたい'])).toBe('大阪');
  expect(destinationIn(['福岡県です', '名古屋の倉庫に変更します'])).toBe('愛知');
  expect(destinationIn(['急ぎです'])).toBeUndefined();
});

it('lets Jev decide, searches the web and supplier sites, and checks each value', async () => {
  mockWeb();
  await researchForStaff(request, { scope: 'chat', conversationId: 'c1', turnId: 't1' });
  const [note] = researchNotes('c1');
  expect(note).toMatchObject({ status: 'done', decidedBy: 'jev', aspects: ['price', 'lead_time'] });
  // The invented URL is dropped; the misread stock is kept but unverified.
  expect(note.findings.map((f) => f.url)).not.toContain('https://invented.example/x');
  const price = note.findings.find((f) => f.aspect === 'price')!;
  expect(price).toMatchObject({
    check: 'matched',
    relevance: 0.88,
    source: 'retailer',
    url: retailer,
  });
  expect(note.findings.find((f) => f.aspect === 'stock')).toMatchObject({ check: 'mismatch' });
  expect(note.findings.find((f) => f.url.includes('blocked'))).toMatchObject({
    check: 'unreachable',
  });
  // A line that states no amount, period or stock is not kept.
  expect(note.findings.map((f) => f.value)).not.toContain('通販サイトに掲載あり');
  expect(note.findings.find((f) => f.url === supplierSite)).toMatchObject({
    source: 'supplier',
    supplierName: '非公開バルブ商事',
    check: 'matched',
  });
  const searches = network.mock.calls.filter(
    ([url]) => url === 'https://api.openai.com/v1/responses',
  );
  expect(searches).toHaveLength(2);
  // Registered sites now complete before the public search starts.
  expect(JSON.parse(searches[0][1]!.body!).tools[0].filters.allowed_domains).toEqual([
    'valve-supplier.example',
  ]);
  expect(JSON.parse(searches[1][1]!.body!).tools[0].filters).toBeUndefined();
  const report = aiUsageReport({ conversationId: 'c1' });
  expect(report.items.filter((c) => c.purpose === 'research')).toHaveLength(2);
  expect(report.items.filter((c) => c.purpose === 'research_decision')).toHaveLength(2);
  expect(JSON.stringify(report)).not.toContain('KITZの青銅');
});

it('does not research when Jev judges it unnecessary, and does not repeat the same research', async () => {
  mockWeb({ wanted: 0.2 });
  await researchForStaff(request, { scope: 'chat', conversationId: 'c1' });
  expect(researchNotes('c1')).toHaveLength(0);
  mockWeb();
  await researchForStaff(request, { scope: 'chat', conversationId: 'c1' });
  await researchForStaff(request, { scope: 'chat', conversationId: 'c1' });
  expect(researchNotes('c1')).toHaveLength(1);
});

it('schedules research after a reply only when the feature is on and the item is not a demo record', async () => {
  const deferred: (() => Promise<void>)[] = [];
  const defer = (work: () => Promise<void>) => void deferred.push(work);
  await answerChat('KITZのバルブ25Aを6個、価格と納期を教えてください', 'off', undefined, { defer });
  expect(deferred).toHaveLength(0);
  putSettings({ ...DEFAULT_SETTINGS, flags: { ...DEFAULT_SETTINGS.flags, aiResearch: true } });
  await answerChat('DEMO-GLASS-01の価格は？', 'demo', undefined, { defer });
  await answerChat('仕入先のHPを教えて', 'private', undefined, { defer });
  expect(deferred).toHaveLength(0);
  const reply = await answerChat(
    'KITZのバルブ25Aを6個、価格と納期を教えてください',
    'on',
    undefined,
    {
      defer,
    },
  );
  expect(deferred).toHaveLength(1);
  mockWeb();
  await deferred[0]();
  const [note] = researchNotes(reply.conversationId);
  expect(note.status).toBe('done');
  // The customer's reply never shows the staff research.
  expect(reply.message.content).not.toContain('18,700');
});

it('treats a growing description of the same item as one research topic', async () => {
  mockWeb();
  await researchForStaff(request, { scope: 'chat', conversationId: 'c1' });
  await researchForStaff(
    {
      ...request,
      message: '急ぎでお願いします。',
      customerTexts: [...request.customerTexts, '急ぎでお願いします。'],
      subject: `${request.subject} 急ぎでお願いします。`,
    },
    { scope: 'chat', conversationId: 'c1' },
  );
  expect(researchNotes('c1')).toHaveLength(1);
  // A new destination adds a lookup.
  await researchForStaff(
    { ...request, destination: '大阪', subject: `${request.subject} 大阪の工場へ` },
    { scope: 'chat', conversationId: 'c1' },
  );
  expect(researchNotes('c1')).toHaveLength(2);
});

it('takes the destination, not the origin, and quantities as written', () => {
  expect(destinationIn(['北九州から帯広までだと輸送に何日かかりますか？'])).toBeUndefined();
  expect(destinationIn(['納品先は北海道帯広市です', '北九州から帯広まで何日？'])).toBe('北海道');
  expect(statedQuantities(['1本いくらくらいですか？', '三ツ星B60を4本、予備で2本'])).toBe(
    '4本、2本',
  );
  expect(statedQuantities(['1枚あたりの価格は？'])).toBeUndefined();
});

it('rates how far the page supports a value and flags another variant', () => {
  const page =
    'NEWSTAGE SUS316 平織 8メッシュ 線径0.6mm 目開き 2.58mm 開口率 66.0% 翌日出荷 ¥1,950';
  expect(checkOnPage('目開き2.58mm・開口率66.0%', page)).toBe('matched');
  expect(checkOnPage('¥1,950', page)).toBe('matched');
  // A short word on the page alone does not show it is said of this item.
  expect(checkOnPage('翌日', page)).toBe('partial');
  expect(checkOnPage('開口率66.0%・目開き3.1mm', page)).toBe('partial');
  expect(checkOnPage('2～3日で出荷', page)).toBe('mismatch');
  expect(itemOnPage('NSK 6305ZZC3 6個', 'NSK 6305ZZ 単列深溝玉軸受')).toBe(false);
  expect(itemOnPage('NSK 6305ZZC3 6個', 'NSK 6305ZZC3 単列深溝玉軸受')).toBe(true);
});
