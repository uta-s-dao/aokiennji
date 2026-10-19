import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Product, Source, Supplier, Quote } from '../lib/contracts';
import { DEFAULT_SETTINGS } from '../lib/contracts';
import { db, list, byId, save, putSettings, resetDbForTests } from '../lib/server/db';
import {
  amount,
  acceptQuote,
  approveOrder,
  createQuote,
  dispatchOrder,
  getQuoteByToken,
  publicProduct,
  updateQuote,
  validProduct,
  validateSettings,
} from '../lib/server/business';
import { hashPassword, verifyPassword } from '../lib/server/auth';
import { answerChat, currentMessages } from '../lib/server/chat';
import { commitPreview, previewUpload } from '../lib/server/ingestion';
import { procurementHistory } from '../lib/server/procurement-memory';
const directory = mkdtempSync(join(tmpdir(), 'aoki-business-'));
process.env.DATA_DIR = directory;
process.env.DEMO_MODE = 'true';
process.env.ALLOW_LIVE_ORDERS = 'false';
beforeEach(() => {
  resetDbForTests();
  rmSync(directory, { recursive: true, force: true });
  db();
  putSettings(structuredClone(DEFAULT_SETTINGS));
});
afterAll(() => {
  resetDbForTests();
  rmSync(directory, { recursive: true, force: true });
});
const request = {
  name: '検証',
  company: 'テスト',
  email: 'test@example.com',
  message: '見積依頼',
  consent: true,
  quantity: 2,
};

describe('facts and publication', () => {
  it('requires a valid source, approval, freshness and supplier for orderable items', () => {
    const p = list<Product>('products')[0];
    expect(validProduct(p)).toBe(true);
    expect(publicProduct({ ...p, approved: false })?.availability).toBe('needs_review');
    expect(publicProduct({ ...p, verifiedAt: '2000-01-01T00:00:00Z' })?.price).toBeNull();
    expect(
      publicProduct({ ...p, verifiedAt: new Date(Date.now() + 86400000).toISOString() })?.price,
    ).toBeNull();
    expect(validProduct({ ...p, availability: 'orderable', supplierId: null })).toBe(false);
    const s = byId<Source>('sources', p.sourceId!)!;
    save('sources', { ...s, enabled: false });
    expect(publicProduct(p)?.availability).toBe('needs_review');
  });
  it('server hides price, stock and lead time when disabled and hides private products', () => {
    putSettings({
      ...DEFAULT_SETTINGS,
      flags: { ...DEFAULT_SETTINGS.flags, showPrice: false, showStock: false, showLeadTime: false },
    });
    const p = list<Product>('products')[0];
    const visible = publicProduct(p)!;
    expect(visible.price).toBeNull();
    expect(visible.stock).toBeNull();
    expect(visible.leadTime).toBe('');
    expect(visible.supplierId).toBeNull();
    expect(publicProduct({ ...p, visibility: 'internal' })).toBeNull();
  });
  it('rejects contradictory feature flags', () => {
    expect(() =>
      validateSettings({
        ...DEFAULT_SETTINGS,
        flags: { ...DEFAULT_SETTINGS.flags, autoOrder: true, orders: false },
      }),
    ).toThrow();
  });
  it('does not treat similar model numbers as a confirmed match and respects conversation ownership', async () => {
    const res = await answerChat('DEMO-GLASS-019を売っていますか', 'owner-one');
    expect(res.message.products).toHaveLength(0);
    await expect(answerChat('在庫は？', 'owner-two', res.conversationId)).rejects.toThrow(
      'アクセス',
    );
    const valid = await answerChat('DEMO-GLASS-01の価格は？', 'owner-one');
    expect(valid.message.products?.[0].model).toBe('DEMO-GLASS-01');
  });
  it('does not recreate demo products after all products are deleted', () => {
    db().prepare('DELETE FROM products').run();
    resetDbForTests();
    expect(list<Product>('products')).toHaveLength(0);
  });
  it('answers natural delivery, price and stock follow-ups in the same conversation', async () => {
    const first = await answerChat('DEMO-CAST-01を売っていますか', 'follow-up-owner');
    const product = first.message.products![0];
    for (const question of ['いつぐらいに届く？', 'いつ頃届きますか？', '何日かかる？']) {
      const reply = await answerChat(question, 'follow-up-owner', first.conversationId);
      expect(reply.message.intent).toBe('lead_time');
      expect(reply.message.products?.[0].id).toBe(product.id);
      expect(reply.message.content).toContain(product.leadTime);
      expect(reply.message.content).not.toContain('取扱いを確認できません');
      expect(reply.message.presentation).toBe('reply');
    }
    const price = await answerChat('それいくら？', 'follow-up-owner', first.conversationId);
    expect(price.message.content).toContain(product.price!.toLocaleString('ja-JP'));
    const thanks = await answerChat('ありがとう', 'follow-up-owner', first.conversationId);
    expect(thanks.message.content).toContain('どういたしまして');
    const stock = await answerChat('在庫は？', 'follow-up-owner', first.conversationId);
    expect(stock.message.products?.[0].id).toBe(product.id);
    const history = currentMessages(first.conversationId);
    expect(history[0].role).toBe('user');
    expect(history[1].role).toBe('assistant');
  });
  it('asks which product a delivery question refers to when no topic exists', async () => {
    const reply = await answerChat('いつぐらいに届く？', 'no-topic-owner');
    expect(reply.message.content).toContain('どの商品');
    expect(reply.message.content).not.toContain('取扱いを確認できません');
    expect(reply.message.products).toHaveLength(0);
  });
  it('understands an answer to a quantity question and calculates only registered prices', async () => {
    const first = await answerChat('DEMO-GLASS-01の価格は？', 'quantity-owner');
    const product = first.message.products![0];
    const reply = await answerChat('10個くらいほしいです', 'quantity-owner', first.conversationId);
    expect(reply.message.products?.[0].id).toBe(product.id);
    expect(reply.message.requestedQuantity).toBe(10);
    expect(reply.message.content).toContain((product.price! * 10).toLocaleString('ja-JP'));
    expect(reply.message.content).not.toContain('何個ほど');
  });
  it('clarifies multiple candidates and understands an ordinal selection', async () => {
    const original = byId<Product>('products', 'demo-1')!;
    save('products', {
      ...original,
      id: 'glass-second',
      name: '耐熱ガラス別仕様',
      model: 'GLASS-02',
    });
    const first = await answerChat('耐熱ガラスを探している', 'choice-owner');
    expect(first.message.products).toHaveLength(2);
    const followup = await answerChat('いつぐらいに届く？', 'choice-owner', first.conversationId);
    expect(followup.message.content).toContain('どの商品');
    expect(followup.message.presentation).toBe('selection');
    const selected = await answerChat('2番目の商品です', 'choice-owner', first.conversationId);
    expect(selected.message.products).toHaveLength(1);
    expect(selected.message.products![0].id).toBe(first.message.products![1].id);
    expect(selected.message.intent).toBe('lead_time');
  });
  it('does not carry an old product across an unknown new model', async () => {
    const first = await answerChat('DEMO-GLASS-01の価格は？', 'new-topic-owner');
    await answerChat('UNKNOWN-456の納期は？', 'new-topic-owner', first.conversationId);
    const next = await answerChat('在庫は？', 'new-topic-owner', first.conversationId);
    expect(next.message.products).toHaveLength(0);
    expect(next.message.content).toContain('どの商品');
  });
  it('rebuilds factual history after visibility flags or source approval change', async () => {
    const first = await answerChat('DEMO-GLASS-01の価格は？', 'history-owner');
    const product = first.message.products![0];
    const amount = product.price!.toLocaleString('ja-JP');
    expect(first.message.content).toContain(amount);
    putSettings({ ...DEFAULT_SETTINGS, flags: { ...DEFAULT_SETTINGS.flags, showPrice: false } });
    expect(currentMessages(first.conversationId).at(-1)!.content).not.toContain(amount);
    const rawProduct = byId<Product>('products', product.id)!;
    const source = byId<Source>('sources', rawProduct.sourceId!)!;
    save('sources', { ...source, enabled: false });
    const next = await answerChat('いつぐらいに届く？', 'history-owner', first.conversationId);
    expect(next.message.content).not.toContain(product.leadTime);
    expect(next.message.content).toContain('確認する必要');
  });
});
describe('quotes and orders', () => {
  it('persists settings, products, conversations, quotes and orders after reopening the database', async () => {
    putSettings({ ...DEFAULT_SETTINGS, flags: { ...DEFAULT_SETTINGS.flags, orders: true } });
    const product = byId<Product>('products', 'demo-1')!;
    save('products', { ...product, name: '永続化確認用商品' });
    const chat = await answerChat('DEMO-GLASS-01を売っていますか', 'persistent-owner');
    const quote = createQuote(
      { ...request, productId: 'demo-1', conversationId: chat.conversationId },
      'persistent-owner',
    );
    updateQuote(quote.id, {
      status: 'issued',
      aokiReviewed: true,
      lines: [{ productId: 'demo-1', name: '永続化確認用商品', quantity: 2, unitPrice: 2500 }],
    });
    const order = acceptQuote(quote.token, true, 'persistent-key');
    resetDbForTests();
    expect(byId<Product>('products', product.id)?.name).toBe('永続化確認用商品');
    expect(byId('conversations', chat.conversationId)).not.toBeNull();
    expect(getQuoteByToken(quote.token).status).toBe('accepted');
    expect(acceptQuote(quote.token, true, 'persistent-key').id).toBe(order.id);
    expect(list('orders')).toHaveLength(1);
    expect(approveOrder(order.id).status).toBe('approved');
  });
  it('calculates integer tax with shipping and rejects unsafe quantities', () => {
    expect(
      amount([{ productId: null, name: '部品', quantity: 2, unitPrice: 2500 }], 500, 10),
    ).toEqual({ subtotal: 5000, tax: 550, total: 6050 });
    expect(() =>
      amount([{ productId: null, name: '部品', quantity: -1, unitPrice: 1 }], 0, 10),
    ).toThrow();
  });
  it('makes quote issuance immutable and enforces expiry, consent and idempotency', async () => {
    putSettings({ ...DEFAULT_SETTINGS, flags: { ...DEFAULT_SETTINGS.flags, orders: true } });
    const q = createQuote({ ...request, productId: 'demo-1' }, null);
    updateQuote(q.id, {
      status: 'issued',
      aokiReviewed: true,
      lines: [{ productId: 'demo-1', name: '確認用部品', quantity: 2, unitPrice: 2500 }],
      shipping: 500,
    });
    expect(() =>
      updateQuote(q.id, {
        lines: [{ productId: 'demo-1', name: '変更', quantity: 1, unitPrice: 1 }],
      }),
    ).toThrow();
    expect(() => acceptQuote(q.token, false, 'test-key')).toThrow();
    const o = acceptQuote(q.token, true, 'test-key');
    expect(acceptQuote(q.token, true, 'test-key').id).toBe(o.id);
    expect(() => acceptQuote(q.token, true, 'other-key')).toThrow();
    expect(list('orders')).toHaveLength(1);
    expect(() => approveOrder('unknown')).toThrow();
    approveOrder(o.id);
    expect((await dispatchOrder(o.id)).status).toBe('simulated');
    const memory = procurementHistory({ kind: 'order', orderId: o.id, line: 0 });
    expect(memory.events).toHaveLength(1);
    expect(memory.cases[0]).toMatchObject({ quantity: 2, receivedQuantity: 0, isDemo: true });
    expect(memory.summary.completed).toBe(0);
    await expect(dispatchOrder(o.id)).rejects.toThrow();
    expect(getQuoteByToken(q.token).status).toBe('accepted');
  });
  it('requires Aoki review even when automatic quotation was enabled', () => {
    putSettings({ ...DEFAULT_SETTINGS, flags: { ...DEFAULT_SETTINGS.flags, autoQuote: true } });
    const q = createQuote({ ...request, productId: 'demo-1' }, null);
    expect(q.status).toBe('requested');
    expect(() =>
      updateQuote(q.id, {
        status: 'issued',
        lines: [{ productId: 'demo-1', name: '確認用部品', quantity: 2, unitPrice: 2500 }],
      }),
    ).toThrow('青木');
    expect(list<Quote>('quotes').find((item) => item.id === q.id)?.reviewedAt).toBeUndefined();
    expect(createQuote({ ...request, productId: 'demo-5' }, null).status).toBe('requested');
  });
  it('blocks expired quotes and orders when the option is disabled', () => {
    const q = createQuote({ ...request, productId: 'demo-1' }, null);
    updateQuote(q.id, {
      status: 'issued',
      aokiReviewed: true,
      lines: [{ productId: 'demo-1', name: '部品', quantity: 1, unitPrice: 100 }],
    });
    expect(() => acceptQuote(q.token, true, 'test-key')).toThrow('利用');
    putSettings({ ...DEFAULT_SETTINGS, flags: { ...DEFAULT_SETTINGS.flags, orders: true } });
    const raw = byId<Quote>('quotes', q.id)!;
    save('quotes', { ...raw, expiresAt: '2000-01-01T00:00:00Z' }, { token: q.token });
    expect(() => acceptQuote(q.token, true, 'test-key')).toThrow('有効期限');
  });
});
describe('ingestion and login', () => {
  it('keeps identical model numbers from different manufacturers separate', async () => {
    const preview = await previewUpload(
      'demo-catalog',
      'brands.csv',
      Buffer.from('商品名,型番,メーカー\n部品A,SAME-1,メーカーA\n部品B,SAME-1,メーカーB\n'),
    );
    expect(commitPreview(preview.previewId, preview.suggestedMapping, false).imported).toBe(2);
    expect(list<Product>('products').filter((p) => p.model === 'SAME-1')).toHaveLength(2);
  });
  it('returns an actionable parse error for an image-only PDF', async () => {
    const { readFileSync } = await import('node:fs');
    await expect(
      previewUpload('demo-catalog', 'scanned.pdf', readFileSync('tests/fixtures/scanned.pdf')),
    ).rejects.toMatchObject({ status: 400, code: 'parse_failed' });
  });
  it('previews Japanese CSV, maps columns and refuses unconfirmed freshness', async () => {
    const preview = await previewUpload(
      'demo-catalog',
      'test.csv',
      Buffer.from('商品名,型番,販売価格\n試験部品,TEST-01,500\n'),
    );
    expect(preview.suggestedMapping.price).toBe('販売価格');
    const result = commitPreview(preview.previewId, preview.suggestedMapping, true);
    expect(result.imported).toBe(1);
    const p = list<Product>('products').find((p) => p.model === 'TEST-01')!;
    expect(p.approved).toBe(false);
    expect(publicProduct(p)?.price).toBeNull();
    expect(() => commitPreview(preview.previewId, preview.suggestedMapping, true)).toThrow();
  });
  it('verifies the scrypt password without accepting an altered hash', () => {
    const hash = hashPassword('test-only-password');
    expect(verifyPassword('test-only-password', hash)).toBe(true);
    expect(verifyPassword('wrong', hash)).toBe(false);
    expect(verifyPassword('test-only-password', 'broken')).toBe(false);
  });
});
