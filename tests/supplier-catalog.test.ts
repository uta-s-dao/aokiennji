import { beforeEach, expect, it, vi } from 'vitest';
import {
  catalogEntries,
  catalogNameKey,
  catalogAllowed,
  catalogRobots,
  crawlSupplierCatalog,
  lookupProductName,
} from '../lib/server/supplier-catalog';
import { createSourceTrace } from '../lib/server/preferred-sources';
import { DEFAULT_SETTINGS, type Source, type SupplierKnowledge } from '../lib/contracts';
import { list, now, putSettings, save } from '../lib/server/db';
import { answerChat, currentMessages } from '../lib/server/chat';
import { safeFetch } from '../lib/server/safe-fetch';
import { salesModel } from '../lib/server/sales-model';
import { searchWeb } from '../lib/server/providers';
vi.mock('../lib/server/safe-fetch', () => ({ safeFetch: vi.fn() }));
vi.mock('../lib/server/sales-model', () => ({ salesModel: vi.fn() }));
vi.mock('../lib/server/providers', async (original) => ({
  ...(await original<typeof import('../lib/server/providers')>()),
  searchWeb: vi.fn(),
}));
const network = vi.mocked(safeFetch),
  model = vi.mocked(salesModel),
  search = vi.mocked(searchWeb);
const name = 'ナフロン® PTFE打抜きガスケット';
const page = `<title>製品紹介</title><main><table><tr><th>TOMBO No.</th><th>製品名</th></tr>
<tr><td>9007</td><td>${name}</td></tr>
<tr><td>9007-LC</td><td>ナフロン® PTFE低クリープガスケット</td></tr>
<tr><td>9007-SC</td><td>ナフロン® PTFE特殊カーボン入り打抜きガスケット</td></tr></table></main>`;
const source: Source = {
  id: 'catalog-source',
  name: '社内仕入先資料',
  kind: 'supplier_catalog',
  url: '',
  enabled: true,
  trust: 'internal',
  visibility: 'internal',
  syncIntervalHours: 0,
  config: { answerEnabled: true },
  lastSyncedAt: null,
  lastError: null,
  recordCount: 1,
  createdAt: now(),
};
const settings = {
  ...DEFAULT_SETTINGS,
  responseProvider: 'local' as const,
  searchProvider: 'exa' as const,
  flags: { ...DEFAULT_SETTINGS.flags, webSearch: false, aiResearch: false },
};
beforeEach(async () => {
  vi.stubEnv('OPENAI_API_KEY', 'synthetic');
  network.mockReset();
  model.mockReset();
  search.mockReset();
  search.mockResolvedValue([]);
  await putSettings(settings);
  await save('sources', source);
  await save(
    'supplier_knowledge',
    {
      id: 'catalog-supplier',
      sourceId: source.id,
      supplierName: '非公開会社',
      website: 'https://catalog.example/home/',
      products: 'パッキン等',
      fields: ['パッキン'],
      approved: true,
      importedAt: now(),
      sheet: '一覧',
      row: 1,
    } satisfies SupplierKnowledge,
    { source_id: source.id },
  );
  network.mockImplementation(async (url) => ({
    status: 200,
    url,
    headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
    body: Buffer.from(
      url.endsWith('/robots.txt')
        ? 'User-agent: *\nDisallow: /private/'
        : url.endsWith('/home/')
          ? '<a href="/products/">製品紹介</a><a href="https://outside.example/products/">外部</a><a href="/private/products/">商品</a>'
          : url.endsWith('/products/')
            ? '<a href="/products/gasket/">お取り扱い製品一覧</a>'
            : page,
    ),
  }));
});
const site = async () =>
  (await createSourceTrace()).preferredSites.find((s) => s.domain === 'catalog.example')!;
const lookup = async (q = name, web = false) =>
  lookupProductName(q, {
    trace: await createSourceTrace(),
    settings: { ...settings, flags: { ...settings.flags, webSearch: web } },
    context: { scope: 'chat' },
  });
function interpretation(designation: string) {
  return {
    model: '',
    manufacturer: '',
    designation,
    designationKind: 'product_name',
    newSubject: true,
    confirmingGuidance: false,
    quantity: 0,
    quantityEvidence: '',
    quantityUnit: '',
    quantityWithdrawn: false,
    purpose: '',
    shape: '',
    dimensions: '',
    quotePreference: 'unchanged',
    handoffPreference: 'unchanged',
    requestedInformation: 'other',
    identityUnavailable: false,
    identityUnavailableEvidence: '',
    next: 'none',
    known: [],
  };
}
it('keeps each product and model in the same table row, ignoring trademark and whitespace differences', () => {
  const entries = catalogEntries(page);
  expect(entries).toHaveLength(3);
  for (const q of [name, 'ナフロン PTFE打抜きガスケット', 'ナフロン®　ＰＴＦＥ 打抜きガスケット']) {
    expect(entries.filter((e) => catalogNameKey(e.name) === catalogNameKey(q))).toEqual([
      { name, model: '9007' },
    ]);
  }
  expect(entries.find((e) => e.model === '9007-LC')?.name).toContain('低クリープ');
  expect(catalogEntries('<h1>ガスケット</h1><p>9007 ナフロン PTFE</p>')).toEqual([]);
});
it('extracts structured Product records and does not attach an offer or adjacent product model', () => {
  expect(
    catalogEntries(
      '<script type="application/ld+json">{"@graph":[{"@type":"Product","name":"試験製品","mpn":"9007-LC"},{"@type":"Offer","name":"別価格","sku":"9007"}]}</script>',
    ),
  ).toEqual([{ name: '試験製品', model: '9007-LC' }]);
});
it('crawls registered product links with depth/page limits and never follows external or disallowed links', async () => {
  const result = await crawlSupplierCatalog(await site());
  expect(result.documents.flatMap((d) => d.supplierCatalog.entries)).toContainEqual({
    name,
    model: '9007',
  });
  expect(network.mock.calls.every(([url]) => new URL(url).hostname === 'catalog.example')).toBe(
    true,
  );
  expect(network.mock.calls.some(([url]) => url.includes('/private/'))).toBe(false);
  expect((await list('products')).some((p: any) => p.model === '9007')).toBe(false);
  network.mockClear();
  const limited = await crawlSupplierCatalog(await site(), { maxPages: 1 });
  expect(limited.documents).toHaveLength(1);
  expect(limited.limited).toBe(true);
});
it('uses indexed listings without external requests when web search is disabled', async () => {
  await crawlSupplierCatalog(await site());
  network.mockClear();
  expect(await lookup('ナフロン PTFE 打抜きガスケット')).toMatchObject({
    status: 'identified',
    matches: [{ name, model: '9007' }],
  });
  expect(await lookup('ナフロン PTFE低クリープガスケット')).toMatchObject({
    matches: [{ model: '9007-LC' }],
  });
  expect(network).not.toHaveBeenCalled();
  expect(search).not.toHaveBeenCalled();
});
it('distinguishes unsearched, successful limited no-match, and retrieval failure', async () => {
  expect((await lookup()).status).toBe('not_searched');
  expect(network).not.toHaveBeenCalled();
  expect((await lookup('存在しないガスケット', true)).status).toBe('not_found');
  network.mockRejectedValue(Error('timeout'));
  expect((await lookup('別のガスケット', true)).status).toBe('failed');
});
it('still crawls relevant registered sites if the search provider fails', async () => {
  search.mockRejectedValue(Error('provider timeout'));
  expect(await lookup(name, true)).toMatchObject({
    status: 'identified',
    matches: [{ model: '9007' }],
  });
});
it('does not use disabled, unapproved, expired or removed listing records', async () => {
  await crawlSupplierCatalog(await site());
  const docs = await list<any>('documents');
  const listing = docs.find((d) => d.supplierCatalog?.entries.length);
  await save(
    'documents',
    { ...listing, createdAt: new Date(Date.now() - 8 * 86400000).toISOString() },
    { source_id: source.id, content: listing.content },
  );
  expect((await lookup()).status).toBe('not_searched');
  await save('documents', listing, { source_id: source.id, content: listing.content });
  await save('sources', { ...source, config: { answerEnabled: false } });
  expect((await lookup()).status).toBe('not_searched');
  await save('sources', source);
  await save(
    'supplier_knowledge',
    {
      id: 'catalog-supplier',
      sourceId: source.id,
      website: 'https://catalog.example/home/',
      approved: false,
    },
    { source_id: source.id },
  );
  expect((await lookup()).status).toBe('not_searched');
});
it('replaces obsolete entries after a successful refresh', async () => {
  await crawlSupplierCatalog(await site());
  network.mockImplementation(async (url) => ({
    status: 200,
    url,
    headers: new Headers(),
    body: Buffer.from(url.endsWith('/robots.txt') ? '' : '<main>掲載終了</main>'),
  }));
  await crawlSupplierCatalog(await site(), {
    seedUrls: ['https://catalog.example/products/gasket/'],
  });
  expect((await lookup()).status).toBe('not_searched');
});
it('honors robots wildcard, terminal and longest-match allow rules, including specific agents', () => {
  const rules = catalogRobots(
    'User-agent: *\nDisallow: /products/*\nAllow: /products/public/\nDisallow: /*?*',
  );
  expect(catalogAllowed('https://catalog.example/products/private/', rules)).toBe(false);
  expect(catalogAllowed('https://catalog.example/products/public/a', rules)).toBe(true);
  expect(catalogAllowed('https://catalog.example/?x=1', rules)).toBe(false);
  const specific = catalogRobots('User-agent: *\nAllow: /\nUser-agent: undici\nDisallow: /');
  expect(catalogAllowed('https://catalog.example/', specific)).toBe(false);
});
it('answers the real product-name entry and restores it without exposing supplier identities or claiming stock', async () => {
  await crawlSupplierCatalog(await site());
  network.mockClear();
  model.mockResolvedValueOnce(interpretation('ナフロン PTFE打抜きガスケット'));
  const answer = await answerChat('ナフロン PTFE打抜きガスケット', 'catalog-customer');
  expect(answer.message.productNameLookup).toMatchObject({
    status: 'identified',
    matches: [{ model: '9007' }],
  });
  expect(answer.message.content).toContain('掲載型番：9007');
  expect(answer.message.content).toContain('販売・調達可否と現在庫は未確認');
  expect(answer.message.content).not.toMatch(/9007-LC|catalog.example|非公開会社/);
  expect(answer.message.inquiryState?.model).toBeUndefined();
  expect((await currentMessages(answer.conversationId)).at(-1)?.content).toContain(
    '掲載型番：9007',
  );
  await save('sources', { ...source, enabled: false });
  expect((await currentMessages(answer.conversationId)).at(-1)?.content).not.toContain(
    '掲載型番：9007',
  );
  expect(network).not.toHaveBeenCalled();
});

it('refreshes only previously indexed sites through the existing sync job after one day', async () => {
  const { runWebJob } = await import('../lib/server/jobs');
  expect(await runWebJob('sync', 'catalog-empty')).toMatchObject({
    status: 'success',
    detail: { processed: 0 },
  });
  expect(network).not.toHaveBeenCalled();
  await crawlSupplierCatalog(await site());
  network.mockClear();
  expect(await runWebJob('sync', 'catalog-fresh')).toMatchObject({
    status: 'success',
    detail: { processed: 0 },
  });
  expect(network).not.toHaveBeenCalled();
  for (const d of await list<any>('documents'))
    if (d.supplierCatalog)
      await save(
        'documents',
        { ...d, createdAt: new Date(Date.now() - 2 * 86400000).toISOString() },
        { source_id: d.sourceId, content: d.content },
      );
  expect(await runWebJob('sync', 'catalog-due')).toMatchObject({
    status: 'success',
    detail: { processed: 1 },
  });
  expect(network).toHaveBeenCalled();
  expect((await lookup()).status).toBe('identified');
});

it('keeps listing indexes out of generic document and model evidence', async () => {
  const { registeredModelRecords } = await import('../lib/server/preferred-sources');
  const { documentCandidates } = await import('../lib/server/retrieval');
  const { localIntent } = await import('../lib/server/providers');
  await crawlSupplierCatalog(await site());
  expect(await registeredModelRecords('9007')).toEqual([]);
  expect(
    (await documentCandidates(name, localIntent(name))).some((d) =>
      d.evidence.id?.startsWith('supplier-page-'),
    ),
  ).toBe(false);
});

it('reverse matches an indexed exact model and TOMBO prefix without confusing suffix variants', async () => {
  await crawlSupplierCatalog(await site());
  const trace = await createSourceTrace();
  for (const query of ['9007', 'TOMBO No.9007']) {
    const r = await lookupProductName(query, { trace, settings, context: { scope: 'chat' } });
    expect(r.status).toBe('identified');
    expect(r.matches.map((e) => e.model)).toEqual(['9007']);
  }
});

it('uses an explicit model label even if the interpreter classifies its value as an unknown name', async () => {
  await crawlSupplierCatalog(await site());
  model.mockResolvedValueOnce({
    ...interpretation('型番9007'),
    designationKind: 'unknown',
    manufacturer: 'ニチアス',
    model: '',
  });
  const result = await answerChat('ニチアスの型番9007は何の製品ですか？', 'explicit-model');
  expect(result.message.productNameLookup?.matches).toEqual([{ name, model: '9007' }]);
  expect((await currentMessages(result.conversationId)).at(-1)?.productNameLookup?.matches).toEqual(
    [{ name, model: '9007' }],
  );
});

it('keeps the grounded explanation on history reload and drops it when its supporting document is removed', async () => {
  await crawlSupplierCatalog(await site());
  const quote = 'この製品はPTFEを打ち抜いたガスケットで、配管の接合面を密封するための製品です。';
  await save(
    'documents',
    {
      id: 'technical-detail',
      sourceId: source.id,
      url: 'https://catalog.example/detail/9007',
      detailOf: 'https://catalog.example/home/',
      title: name,
      content: quote,
      createdAt: now(),
      supplierCatalog: { version: 1, entries: [{ name, model: '9007' }] },
    },
    { source_id: source.id, content: quote },
  );
  model.mockResolvedValueOnce(interpretation(name));
  model.mockResolvedValueOnce({ passages: [{ source: 0, quote }] });
  const answer = await answerChat(`${name}の用途と特徴を教えてください`, 'restored-explanation');
  expect(answer.message.content).toContain(quote);
  const restored = (await currentMessages(answer.conversationId)).at(-1)!;
  expect(restored.content).toBe(answer.message.content);
  expect(model).toHaveBeenCalledTimes(2);
  const { db } = await import('../lib/server/db');
  await db().prepare('DELETE FROM documents WHERE id=?').run('technical-detail');
  expect((await currentMessages(answer.conversationId)).at(-1)!.content).not.toContain(quote);
});

it('continues to public technical search when the registered origin is unavailable', async () => {
  await crawlSupplierCatalog(await site());
  const quote =
    'ナフロン® PTFE打抜きガスケットはPTFE製のガスケットで、薬品を扱う配管の接合部に使用します。';
  network.mockImplementation(async (url) => {
    if (url.startsWith('https://catalog.example/')) throw Error('registered_site_unavailable');
    return {
      status: 200,
      url,
      headers: new Headers({ 'content-type': 'text/html' }),
      body: Buffer.from(
        url.endsWith('/robots.txt')
          ? 'User-agent: *\nAllow: /'
          : `<title>${name}</title><main><h1>${name}</h1><p>TOMBO No.9007 ${quote}</p></main>`,
      ),
    };
  });
  search.mockResolvedValue([
    {
      title: name,
      url: 'https://technical.example/products/9007',
      retrievedAt: now(),
      trust: 'discovery',
      excerpt: '',
      visibility: 'public',
    },
  ]);
  model.mockResolvedValue({ passages: [{ source: 0, quote }] });
  const { explainProduct } = await import('../lib/server/product-explanation');
  const trace = await createSourceTrace();
  const reply = await explainProduct({
    question: '蒸気配管の使用温度と圧力の適用範囲は？',
    lookup: { status: 'identified', matches: [{ name, model: '9007' }] },
    settings: { ...settings, flags: { ...settings.flags, webSearch: true } },
    trace,
    context: { scope: 'chat' },
  });
  expect(search.mock.calls[0][0]).toContain('使用圧力');
  expect(reply).toContain(quote);
  expect(trace.observations.some((o) => o.reason === 'registered_site_unavailable')).toBe(true);
  const detail = (
    await list<{ url: string; detailOf?: string; content: string }>('documents')
  ).find((d) => d.url === 'https://technical.example/products/9007');
  expect(detail?.detailOf).toContain('catalog.example');
  expect(detail?.content).toContain(quote);
});

it('uses public search for a recognized product even when no matching document was cached', async () => {
  network.mockRejectedValue(Error('unavailable'));
  const { explainProduct } = await import('../lib/server/product-explanation');
  await explainProduct({
    question: '特徴は？',
    lookup: { status: 'identified', matches: [{ name, model: '9007' }] },
    settings: { ...settings, flags: { ...settings.flags, webSearch: true } },
    trace: await createSourceTrace(),
    context: { scope: 'chat' },
  });
  expect(search).toHaveBeenCalledOnce();
});

it('changes the registered revision immediately for document edits, deletions and source revocation', async () => {
  const { db } = await import('../lib/server/db');
  const initial = (await createSourceTrace()).registeredRevision;
  const doc = {
    id: 'revision-proof',
    sourceId: source.id,
    title: name,
    content: 'first',
    url: 'https://catalog.example/revision',
    createdAt: now(),
  };
  await save('documents', doc, { source_id: source.id, content: doc.content });
  const created = (await createSourceTrace()).registeredRevision;
  expect(created).not.toBe(initial);
  await save(
    'documents',
    { ...doc, content: 'changed' },
    { source_id: source.id, content: 'changed' },
  );
  expect((await createSourceTrace()).registeredRevision).not.toBe(created);
  await db().prepare('DELETE FROM documents WHERE id=?').run(doc.id);
  expect((await createSourceTrace()).registeredRevision).toBe(initial);
  await save('sources', { ...source, enabled: false });
  expect((await createSourceTrace()).registeredRevision).not.toBe(initial);
});

it('loads catalog documents once for an entire history restoration', async () => {
  await crawlSupplierCatalog(await site());
  model.mockResolvedValueOnce(interpretation(name));
  const first = await answerChat(name, 'batched-restore');
  model.mockResolvedValueOnce({ ...interpretation(''), model: '', designation: '' });
  await answerChat(
    '型番はそのまま、いまの条件をまとめてください。',
    'batched-restore',
    first.conversationId,
  );
  const { database } = await import('../lib/server/database');
  const spy = vi.spyOn(database, 'prepare');
  try {
    await currentMessages(first.conversationId);
    expect(spy.mock.calls.filter(([query]) => query === 'SELECT json FROM documents')).toHaveLength(
      1,
    );
    expect(
      spy.mock.calls.filter(([query]) => query === 'SELECT json FROM sources WHERE id=?'),
    ).toHaveLength(0);
  } finally {
    spy.mockRestore();
  }
});

it('excludes robots-blocked detail sites from the alternative search instead of returning to them', async () => {
  await crawlSupplierCatalog(await site());
  network.mockImplementation(async (url) => ({
    status: url.includes('blocked.example') ? 403 : 200,
    url,
    headers: new Headers({ 'content-type': 'text/html' }),
    body: Buffer.from(
      url.endsWith('/robots.txt')
        ? 'User-agent: *\nAllow: /'
        : page.replace(
            `<td>${name}</td>`,
            `<td><a href="https://blocked.example/product">${name}</a></td>`,
          ),
    ),
  }));
  const { explainProduct } = await import('../lib/server/product-explanation');
  await explainProduct({
    question: '材質と特徴は？',
    lookup: { status: 'identified', matches: [{ name, model: '9007' }] },
    settings: { ...settings, flags: { ...settings.flags, webSearch: true } },
    trace: await createSourceTrace(),
    context: { scope: 'chat' },
  });
  expect(search.mock.calls[0][3]?.excludedDomains).toContain('blocked.example');
});
