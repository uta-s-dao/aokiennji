import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Order, Quote, ResearchNote } from '../lib/contracts';
import type { ProcurementContext } from '../lib/procurement-memory';
import { byId, db, now, resetDbForTests, save } from '../lib/server/db';
import { updateProcurementOffer } from '../lib/server/sourcing-estimate';
import {
  procurementHistory,
  recordProcurementOutcome,
  rememberDispatchedOrder,
  successfulProcurementSources,
} from '../lib/server/procurement-memory';

const directory = mkdtempSync(join(tmpdir(), 'aoki-procurement-memory-'));
let context: ProcurementContext;
let note: ResearchNote;
beforeEach(async () => {
  vi.stubEnv('DATA_DIR', directory);
  vi.stubEnv('DEMO_MODE', 'false');
  (await resetDbForTests());
  rmSync(directory, { recursive: true, force: true });
  db();
  context = { kind: 'offer', conversationId: 'conversation', noteId: 'note', offerId: 'offer' };
  const time = now();
  note = {
    id: 'note',
    conversationId: 'conversation',
    turnId: 'turn',
    subject: 'B-300-SCI',
    status: 'done',
    createdAt: time,
    completedAt: time,
    aspects: ['stock'],
    summary: '',
    decidedBy: 'local',
    sourcing: { model: 'B-300-SCI', status: 'candidate', checkedAt: time },
    findings: [
      {
        aspect: 'stock',
        value: '掲載数量20個',
        note: '当時のページ抜粋',
        url: 'https://supplier.example/item',
        title: '販売元',
        source: 'other',
        check: 'matched',
        relevance: 1,
      },
    ],
    offers: [
      {
        id: 'offer',
        model: 'B-300-SCI',
        title: '販売元',
        url: 'https://supplier.example/item',
        price: 1100,
        taxIncluded: true,
        purchaseTaxRate: 10,
        packQuantity: 1,
        availableQuantity: 20,
        procurementShippingNet: 0,
        customerShippingNet: 800,
        destination: '大阪',
        deliveryMinDays: 2,
        deliveryMaxDays: 3,
        approved: false,
        checkedAt: time,
        confirmedAt: null,
      },
    ],
  };
  (await save('conversations', { id: 'conversation' }, { owner_id: 'owner' }));
  (await saveNote());
  (await save(
    'messages',
    { id: 'message', role: 'assistant', sourcing: note.sourcing, requestedQuantity: 10 },
    { conversation_id: 'conversation' },
  ));
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  (await resetDbForTests());
  rmSync(directory, { recursive: true, force: true });
});
async function saveNote() {
  (await save('research_notes', note, {
    conversation_id: note.conversationId,
    created_at: note.createdAt,
  }));
}
async function outcome(action: string, extra: Record<string, unknown> = {}) {
  return (await recordProcurementOutcome(context, { eventId: randomUUID(), action, ...extra }));
}
async function ordered() {
  return (await outcome('ordered')).cases[0];
}

it('prefills requested quantity, never the supplier stock, and records no outcome on read', async () => {
  expect((await procurementHistory(context))).toMatchObject({
    suggestedQuantity: 10,
    cases: [],
    events: [],
    summary: { completed: 0 },
  });
  expect((await ordered()).quantity).toBe(10);
});
it('automatically retains unique confirmed conditions without claiming a purchase', async () => {
  const input = { ...note.offers![0], approved: true };
  (await updateProcurementOffer('conversation', 'note', 'offer', input));
  (await updateProcurementOffer('conversation', 'note', 'offer', input));
  const h = (await procurementHistory(context));
  expect(h.events).toHaveLength(1);
  expect(h.events[0]).toMatchObject({
    action: 'conditions_confirmed',
    snapshot: { offer: { availableQuantity: 20 }, findings: [{ note: '当時のページ抜粋' }] },
  });
  expect(h.cases).toHaveLength(0);
  expect(h.summary.completed).toBe(0);
  expect((await successfulProcurementSources('B-300-SCI'))).toEqual([]);
});
it('retains original page evidence after later edits and restart', async () => {
  const item = (await ordered());
  note.findings[0].note = '後で変わったページ';
  note.offers![0].availableQuantity = 0;
  (await saveNote());
  (await resetDbForTests());
  const h = (await procurementHistory(context));
  expect(h.cases[0].snapshot.findings![0].note).toBe('当時のページ抜粋');
  expect(h.cases[0].snapshot.offer!.availableQuantity).toBe(20);
  expect(h.cases[0].id).toBe(item.id);
});
it('counts one completed purchase after cumulative partial receipts, with idempotent retries', async () => {
  const item = (await ordered());
  const change = {
    eventId: randomUUID(),
    caseId: item.id,
    action: 'received',
    receivedQuantity: 4,
  };
  (await recordProcurementOutcome(context, change));
  (await recordProcurementOutcome(context, change));
  expect((await procurementHistory(context))).toMatchObject({
    cases: [{ status: 'partial', receivedQuantity: 4 }],
    summary: { completed: 0 },
  });
  const h = (await outcome('received', { caseId: item.id, receivedQuantity: 10 }));
  expect(h.summary.completed).toBe(1);
  expect(h.events).toHaveLength(3);
  expect((await successfulProcurementSources('b 300 sci'))).toEqual([
    { url: 'https://supplier.example/item', title: '販売元' },
  ]);
  expect((await successfulProcurementSources('B-300-SCI-2'))).toEqual([]);
});
it('rejects decreasing, excess, or missing receipt counts and duplicate active attempts', async () => {
  const item = (await ordered());
  (await outcome('received', { caseId: item.id, receivedQuantity: 4 }));
  for (const receivedQuantity of [undefined, 0, 3, 11])
    await expect(async () => (await outcome('received', { caseId: item.id, receivedQuantity }))).rejects.toThrow();
  await expect(async () => (await outcome('ordered'))).rejects.toThrow('進行中');
  await expect(async () => (await outcome('unavailable', { caseId: item.id }))).rejects.toThrow();
  expect((await procurementHistory(context)).events).toHaveLength(2);
});
it('requires quantity when conversation has no matching model quantity', async () => {
  (await db().prepare('DELETE FROM messages').run());
  expect((await procurementHistory(context)).suggestedQuantity).toBeNull();
  await expect(async () => (await outcome('ordered'))).rejects.toThrow('必要数量');
  await expect(async () => (await outcome('ordered', { quantity: 0 }))).rejects.toThrow();
  expect((await outcome('ordered', { quantity: 2 })).cases[0].quantity).toBe(2);
});
it('isolates model and supplier history and allows new attempts after an unsuccessful purchase', async () => {
  (await outcome('unavailable'));
  expect((await procurementHistory(context)).summary.unavailable).toBe(1);
  note.offers![0].url = 'https://other.example/item';
  (await saveNote());
  expect((await procurementHistory(context)).summary.unavailable).toBe(0);
  const item = (await ordered());
  (await outcome('cancelled', { caseId: item.id }));
  expect((await procurementHistory(context)).summary.completed).toBe(0);
});
it('records delay separately and excludes returned or void purchases from future source reuse', async () => {
  const item = (await ordered());
  (await outcome('delayed', { caseId: item.id }));
  (await outcome('received', { caseId: item.id, receivedQuantity: 10 }));
  expect((await procurementHistory(context)).summary).toMatchObject({ completed: 1, delayed: 1 });
  (await outcome('returned', { caseId: item.id }));
  expect((await successfulProcurementSources('B-300-SCI'))).toEqual([]);
  (await outcome('void', { caseId: item.id }));
  expect((await procurementHistory(context)).summary).toMatchObject({ completed: 0, delayed: 0 });
  expect((await procurementHistory(context)).events).toHaveLength(5);
});
it('never treats demo receipts as real evidence or permits switching their mode', async () => {
  vi.stubEnv('DEMO_MODE', 'true');
  const item = (await ordered());
  (await outcome('received', { caseId: item.id, receivedQuantity: 10 }));
  expect((await procurementHistory(context)).summary.completed).toBe(0);
  expect((await successfulProcurementSources('B-300-SCI'))).toEqual([]);
  vi.stubEnv('DEMO_MODE', 'false');
  await expect(async () => (await outcome('returned', { caseId: item.id }))).rejects.toThrow('デモ');
  // An unfinished demo attempt must not prevent a separate real purchase.
  vi.stubEnv('DEMO_MODE', 'true');
  const demoActive = (await ordered());
  expect(demoActive.isDemo).toBe(true);
  vi.stubEnv('DEMO_MODE', 'false');
  expect((await ordered()).isDemo).toBe(false);
});
it('rejects cross-context records and event ID reuse with different content', async () => {
  const change = { eventId: randomUUID(), action: 'ordered' };
  (await recordProcurementOutcome(context, change));
  await expect(async () => (await recordProcurementOutcome(context, { ...change, quantity: 1 }))).rejects.toThrow('記録ID');
  await expect(async () =>
    (await recordProcurementOutcome({ ...context, noteId: 'missing' } as ProcurementContext, change)),
  ).rejects.toThrow('調達候補');
  await expect(async () => (await outcome('received', { caseId: randomUUID(), receivedQuantity: 10 }))).rejects.toThrow('発注');
});
it('does not change source approval or available quantities after a successful receipt', async () => {
  const item = (await ordered());
  (await outcome('received', { caseId: item.id, receivedQuantity: 10 }));
  const row = (await db().prepare('SELECT json FROM research_notes WHERE id=?').get('note')) as {
    json: string;
  };
  expect(JSON.parse(row.json).offers[0]).toMatchObject({
    approved: false,
    availableQuantity: 20,
    confirmedAt: null,
  });
});
it.each(['dispatched', 'simulated', 'needs_reconciliation'] as const)(
  'records %s transport status without inventing receipt',
  async (status) => {
    const time = now();
    (await save('products', { id: 'product', model: 'ITEM-1', supplierId: 'supplier' }));
    (await save('suppliers', { id: 'supplier', name: '登録先' }));
    const quote = {
      id: 'quote',
      token: 'token',
      lines: [{ productId: 'product', quantity: 3 }],
      isDemo: false,
    } as Quote;
    (await save('quotes', quote, { token: quote.token }));
    const order = {
      id: 'order',
      quoteId: 'quote',
      supplierId: 'supplier',
      status,
      isDemo: false,
      externalId: 'receipt',
      updatedAt: time,
    } as Order;
    (await save('orders', order, { quote_id: quote.id, idempotency_key: 'key' }));
    (await db().transaction(async () => {
      (await rememberDispatchedOrder(order));
      (await rememberDispatchedOrder(order));
    })());
    const orderContext: ProcurementContext = { kind: 'order', orderId: order.id, line: 0 };
    const h = (await procurementHistory(orderContext));
    expect(h.canStart).toBe(false);
    expect(h.summary.completed).toBe(0);
    if (status === 'needs_reconciliation') expect(h.cases).toHaveLength(0);
    else {
      expect(h.events).toHaveLength(1);
      expect(h.cases[0]).toMatchObject({
        status: 'ordered',
        receivedQuantity: 0,
        url: '',
        isDemo: status === 'simulated',
      });
      if (status === 'dispatched') {
        // Catalogue edits/deletion must not erase the identity of a sent line.
        (await db().prepare('DELETE FROM products WHERE id=?').run('product'));
        expect((await procurementHistory(orderContext)).model).toBe('ITEM-1');
        const received = (await recordProcurementOutcome(orderContext, {
          eventId: randomUUID(),
          action: 'received',
          caseId: h.cases[0].id,
          receivedQuantity: 3,
        }));
        expect(received.summary.completed).toBe(1);
        expect((await successfulProcurementSources('ITEM-1'))).toEqual([]);
      }
    }
    await expect(async () =>
      (await recordProcurementOutcome(orderContext, { eventId: randomUUID(), action: 'ordered' })),
    ).rejects.toThrow();
    expect((await byId<Order>('orders', order.id))?.status).toBe(status);
  },
);
