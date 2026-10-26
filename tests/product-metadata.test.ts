import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { Product, Source } from '../lib/contracts';
import { DEFAULT_SETTINGS } from '../lib/contracts';
import { byId, db, list, now, save, putSettings } from '../lib/server/db';
import {
  prepareProductMetadata,
  enrichDueProductMetadata,
  productCandidates,
} from '../lib/server/product-metadata';
import { salesModel } from '../lib/server/sales-model';
import { publicProduct, publicProducts } from '../lib/server/business';
import { previewUpload, commitPreview } from '../lib/server/ingestion';
vi.mock('../lib/server/sales-model', () => ({ salesModel: vi.fn() }));
const model = vi.mocked(salesModel);
const source: Source = {
  id: 'metadata-source',
  name: '商品台帳',
  kind: 'csv',
  url: '',
  enabled: true,
  trust: 'internal',
  visibility: 'internal',
  syncIntervalHours: 0,
  config: {},
  lastSyncedAt: null,
  lastError: null,
  recordCount: 0,
  createdAt: now(),
};
const product: Product = {
  id: 'metadata-product',
  name: '炉扉固定部品',
  model: 'PART-01',
  manufacturer: '登録メーカー',
  category: '炉内部材',
  description: '扉を固定する部品。',
  specifications: '材質 SUS316、厚さ 3mm',
  image: '',
  availability: 'needs_review',
  price: null,
  stock: null,
  leadTime: '',
  sourceId: source.id,
  supplierId: null,
  approved: false,
  visibility: 'public',
  verifiedAt: null,
  isDemo: false,
  createdAt: now(),
  updatedAt: now(),
};
beforeEach(async () => {
  model.mockReset();
  vi.stubEnv('OPENAI_API_KEY', 'synthetic');
  await save('sources', source);
  await putSettings({ ...DEFAULT_SETTINGS, responseProvider: 'local' });
});
afterEach(() => vi.unstubAllEnvs());
const ai = () => ({
  aliases: ['固定金具', 'PART-999', '在庫あり'],
  relatedTerms: ['工業炉', '扉金具'],
  attributes: [
    { kind: 'material', value: 'SUS316', field: 'specifications', quote: '材質 SUS316' },
    { kind: 'material', value: 'PTFE', field: 'specifications', quote: '材質 PTFE' },
  ],
});
async function seed() {
  const p = prepareProductMetadata(product);
  await save('products', p, { source_id: source.id, supplier_id: null, model_key: 'PART01' });
  return p;
}
it('creates search metadata without using an API and retains it if only stock changes', async () => {
  const p = prepareProductMetadata(product);
  expect(p.searchMetadata).toMatchObject({ status: 'pending', normalizedModel: 'PART01' });
  expect(model).not.toHaveBeenCalled();
  const edit = prepareProductMetadata({ ...p, stock: 8 }, p);
  expect(edit.searchMetadata).toEqual(p.searchMetadata);
  const revised = prepareProductMetadata({ ...p, specifications: '材質 SUS304' }, p);
  expect(revised.searchMetadata?.inputHash).not.toBe(p.searchMetadata?.inputHash);
  expect(revised.searchMetadata?.status).toBe('pending');
});
it('enriches only supported attributes, saves proposed terms separately, and preserves raw fields', async () => {
  await seed();
  model.mockResolvedValue(ai());
  expect(await enrichDueProductMetadata()).toMatchObject({
    status: 'success',
    detail: { processed: 1 },
  });
  const p = (await byId<Product>('products', product.id))!;
  expect(p.searchMetadata).toMatchObject({
    status: 'ready',
    aliases: ['固定金具'],
    attributes: [{ value: 'SUS316' }],
  });
  expect(p.searchMetadata?.attributes).toHaveLength(1);
  expect(p).toMatchObject({
    specifications: product.specifications,
    stock: null,
    price: null,
    approved: false,
  });
  expect((await publicProduct(p))?.searchMetadata).toBeUndefined();
  expect(await enrichDueProductMetadata()).toMatchObject({ detail: { processed: 0 } });
  expect(model).toHaveBeenCalledOnce();
});
it('finds candidates from customer descriptions without treating suggested aliases as exact identity', async () => {
  await seed();
  model.mockResolvedValue(ai());
  await enrichDueProductMetadata();
  const options = await productCandidates('工業炉の扉に使う固定金具を探している');
  expect(options[0]).toMatchObject({ reason: 'related', product: { model: 'PART-01' } });
  expect(options[0].product.searchMetadata).toBeUndefined();
  expect((await publicProducts('固定金具'))[0].id).toBe(product.id);
  expect((await publicProducts('固定金具'))[0].searchMetadata).toBeUndefined();
  expect((await productCandidates('PART-01'))[0].reason).toBe('exact');
});
it('keeps registrations and deterministic search usable after an API error, with delayed retry', async () => {
  await seed();
  model.mockRejectedValue(Error('quota'));
  expect(await enrichDueProductMetadata()).toMatchObject({ status: 'deferred' });
  expect(await byId('products', product.id)).toMatchObject({
    name: product.name,
    searchMetadata: { status: 'failed' },
  });
  expect((await productCandidates('SUS316'))[0].product.id).toBe(product.id);
  await enrichDueProductMetadata();
  expect(model).toHaveBeenCalledOnce();
});
it('does not overwrite metadata generated for newer edits while an older call was running', async () => {
  const old = await seed();
  model.mockImplementation(async () => {
    const updated = prepareProductMetadata({ ...old, model: 'PART-02' }, old);
    await save('products', updated, {
      source_id: source.id,
      supplier_id: null,
      model_key: 'PART02',
    });
    return ai();
  });
  expect(await enrichDueProductMetadata()).toMatchObject({ detail: { metadataUpdated: 0 } });
  expect(await byId('products', product.id)).toMatchObject({
    model: 'PART-02',
    searchMetadata: { status: 'pending' },
  });
});
it('creates metadata through CSV registration, without waiting for OpenAI', async () => {
  const preview = await previewUpload(
    source.id,
    'products.csv',
    Buffer.from('商品名,型番,説明,仕様\n固定部品,PART-CSV,扉に使う部品,SUS316\n'),
  );
  await commitPreview(
    preview.previewId,
    { name: '商品名', model: '型番', description: '説明', specifications: '仕様' },
    false,
  );
  expect(
    (await list<Product>('products')).find((p) => p.model === 'PART-CSV')?.searchMetadata?.status,
  ).toBe('pending');
  expect(model).not.toHaveBeenCalled();
});

it('covers manual registration and administrator-only metadata rebuild through the real API handler', async () => {
  const { NextRequest, NextResponse } = await import('next/server');
  const { setSession } = await import('../lib/server/auth');
  const { POST } = await import('../app/api/[...path]/route');
  vi.stubEnv('SESSION_SECRET', 'metadata-test-session-secret-at-least-32-characters');
  const res = NextResponse.json({});
  await setSession(res, 'admin');
  const cookie = res.cookies
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const request = (path: string[], body?: unknown, authenticated = true) =>
    POST(
      new NextRequest(`http://localhost/api/${path.join('/')}`, {
        method: 'POST',
        headers: {
          origin: 'http://localhost',
          ...(authenticated ? { cookie } : {}),
          'content-type': 'application/json',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      { params: Promise.resolve({ path }) },
    );
  const created = await request(['admin', 'products'], { ...product, id: undefined });
  expect(created.status).toBe(200);
  const payload = await created.json();
  const item = payload.data || payload;
  expect(item.searchMetadata.status).toBe('pending');
  expect(model).not.toHaveBeenCalled();
  const denied = await request(['admin', 'products', item.id, 'search-metadata'], undefined, false);
  expect(denied.status).toBe(401);
  const queued = await request(['admin', 'products', item.id, 'search-metadata']);
  expect(queued.status).toBe(200);
  expect((await byId<Product>('products', item.id))?.searchMetadata?.status).toBe('pending');
});

it('removes metadata-derived candidates when a product is made private or its source is disabled', async () => {
  await seed();
  model.mockResolvedValue(ai());
  await enrichDueProductMetadata();
  let p = (await byId<Product>('products', product.id))!;
  await save(
    'products',
    { ...p, visibility: 'internal' },
    { source_id: source.id, supplier_id: null, model_key: 'PART01' },
  );
  expect(await productCandidates('固定金具')).toEqual([]);
  await save('products', p, { source_id: source.id, supplier_id: null, model_key: 'PART01' });
  await save('sources', { ...source, enabled: false });
  expect(await productCandidates('固定金具')).toEqual([]);
});
