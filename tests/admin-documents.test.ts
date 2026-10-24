import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  type AdminDocumentInput,
  type Order,
  type Quote,
} from '../lib/contracts';
import { byId, db, list, putSettings } from '../lib/server/db';
import { createAdminOrder, createAdminQuote, updateQuote } from '../lib/server/business';
import { adminDocumentSchema, adminOrderSchema } from '../lib/server/validation';
import { once } from '../lib/server/idempotency';

const input = (): AdminDocumentInput => ({
  name: '担当者登録テスト',
  company: '検証会社',
  email: 'staff-entry@example.invalid',
  message: '電話で受けたご依頼',
  notes: '社内メモ',
  lines: [{ productId: null, name: '手入力の商品', quantity: 3, unitPrice: 1234 }],
  shipping: 500,
  taxRate: 10,
  expiresAt: new Date(Date.now() + 86400000).toISOString(),
});
beforeEach(async () => {
  vi.stubEnv('DEMO_MODE', 'true');
  await putSettings({ ...DEFAULT_SETTINGS, flags: { ...DEFAULT_SETTINGS.flags, orders: true } });
});

describe('staff document entry', () => {
  it('creates a draft with server-calculated amounts, no review or receipt notification', async () => {
    const quote = await createAdminQuote(input());
    expect(quote).toMatchObject({ status: 'draft', subtotal: 3702, tax: 420, total: 4622 });
    expect(quote.reviewedAt).toBeUndefined();
    expect(await byId<Quote>('quotes', quote.id)).toEqual(quote);
    const row = await db().prepare('SELECT count(*) AS n FROM receipt_notifications').get();
    expect(Number(row.n)).toBe(0);
    await expect(updateQuote(quote.id, { status: 'issued' })).rejects.toThrow('青木');
  });
  it('creates an accepted reviewed quote and a pending order without dispatching', async () => {
    const order = await createAdminOrder({
      ...input(),
      aokiReviewed: true,
      customerConfirmed: true,
    });
    expect(order).toMatchObject({ status: 'pending_approval', total: 4622, externalId: null });
    expect(await byId<Quote>('quotes', order.quoteId)).toMatchObject({
      status: 'accepted',
      reviewedBy: '青木',
      total: 4622,
    });
  });
  it('keeps a selected product linked to its supplier and rejects deleted selections', async () => {
    const data = input();
    data.lines[0].productId = 'demo-1';
    const order = await createAdminOrder({ ...data, aokiReviewed: true, customerConfirmed: true });
    expect(order.supplierId).toBe('demo-supplier');
    const quote = await byId<Quote>('quotes', order.quoteId);
    expect(quote?.lines[0].productId).toBe('demo-1');
    data.lines[0].productId = 'missing-product';
    await expect(createAdminQuote(data)).rejects.toThrow('商品が見つかりません');
  });
  it('rolls back both records for unpriced or expired orders and rejects missing confirmation', async () => {
    const quotes = (await list<Quote>('quotes')).length;
    const orders = (await list<Order>('orders')).length;
    for (const patch of [
      { aokiReviewed: false },
      { customerConfirmed: false },
      { expiresAt: '2000-01-01T00:00:00.000Z' },
      { lines: [{ productId: null, name: '未確定', quantity: 1, unitPrice: 0 }] },
    ]) {
      await expect(
        createAdminOrder({ ...input(), aokiReviewed: true, customerConfirmed: true, ...patch }),
      ).rejects.toThrow();
    }
    expect(await list<Quote>('quotes')).toHaveLength(quotes);
    expect(await list<Order>('orders')).toHaveLength(orders);
  });
  it('allows staff drafts while public requests are off, but respects the order flag', async () => {
    await putSettings({
      ...DEFAULT_SETTINGS,
      flags: { ...DEFAULT_SETTINGS.flags, quoteRequests: false, orders: false },
    });
    await expect(createAdminQuote(input())).resolves.toMatchObject({ status: 'draft' });
    await expect(
      createAdminOrder({ ...input(), aokiReviewed: true, customerConfirmed: true }),
    ).rejects.toThrow('利用できません');
  });
  it('keeps an order retry idempotent and rejects changing the payload under the same key', async () => {
    const data = { ...input(), aokiReviewed: true, customerConfirmed: true };
    const key = crypto.randomUUID();
    const count = (await list<Order>('orders')).length;
    const create = () => once('admin:order', key, data, () => createAdminOrder(data));
    const [first, second] = await Promise.all([create(), create()]);
    expect(first.id).toBe(second.id);
    expect(await list<Order>('orders')).toHaveLength(count + 1);
    await expect(
      once('admin:order', key, { ...data, name: '別のお客様' }, () => createAdminOrder(data)),
    ).rejects.toThrow('異なる内容');
  });
  it('validates contact details, amounts and confirmation on the server', () => {
    expect(adminDocumentSchema.safeParse(input()).success).toBe(true);
    expect(adminDocumentSchema.safeParse({ ...input(), email: 'invalid' }).success).toBe(false);
    expect(adminDocumentSchema.safeParse({ ...input(), shipping: -1 }).success).toBe(false);
    expect(adminOrderSchema.safeParse(input()).success).toBe(false);
    expect(
      adminOrderSchema.safeParse({ ...input(), aokiReviewed: true, customerConfirmed: true })
        .success,
    ).toBe(true);
  });
});
