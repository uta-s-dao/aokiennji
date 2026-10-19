import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ChatMessage, Order, Product, Quote, ResearchNote, Supplier } from '../contracts';
import type {
  ProcurementCase,
  ProcurementContext,
  ProcurementEvent,
  ProcurementHistory,
} from '../procurement-memory';
import { ApiError } from './auth';
import { byId, db, demoMode, now, save, uid } from './db';
import { modelIdentity } from './product-model';

type Resolved = {
  key: string;
  model: string;
  supplierKey: string;
  supplierName: string;
  url: string;
  quantity: number | null;
  isDemo: boolean;
  canStart: boolean;
  snapshot: ProcurementCase['snapshot'];
};
function urlKey(url: string) {
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new ApiError(400, 'invalid_source', '調達先URLを確認してください');
  parsed.hash = '';
  return parsed.href;
}
function resolve(context: ProcurementContext): Resolved {
  if (context.kind === 'offer') {
    const row = db()
      .prepare('SELECT json FROM research_notes WHERE id=? AND conversation_id=?')
      .get(context.noteId, context.conversationId) as { json: string } | undefined;
    const note: ResearchNote | undefined = row && JSON.parse(row.json);
    const offer = note?.offers?.find((o) => o.id === context.offerId);
    if (!note || !offer) throw new ApiError(404, 'not_found', '調達候補が見つかりません');
    const messages = (
      db()
        .prepare('SELECT json FROM messages WHERE conversation_id=? ORDER BY rowid DESC')
        .all(context.conversationId) as { json: string }[]
    ).map((r) => JSON.parse(r.json) as ChatMessage);
    const quantity = messages.find(
      (m) =>
        m.role === 'assistant' &&
        modelIdentity(m.sourcing?.model || '') === modelIdentity(offer.model) &&
        Number.isSafeInteger(m.requestedQuantity) &&
        (m.requestedQuantity || 0) > 0,
    )?.requestedQuantity;
    const url = urlKey(offer.url);
    return {
      key: `offer:${note.id}:${offer.id}`,
      model: offer.model,
      supplierKey: url,
      supplierName: offer.title || new URL(url).hostname,
      url,
      quantity: quantity || null,
      isDemo: demoMode(),
      canStart: true,
      snapshot: { offer, findings: note.findings.filter((f) => f.url === offer.url) },
    };
  }
  const order = byId<Order>('orders', context.orderId);
  const quote = order && byId<Quote>('quotes', order.quoteId);
  const line = quote?.lines[context.line];
  const key = `order:${context.orderId}:${context.line}`;
  const archived = cases('context_key=?', key)[0];
  if (order && line && archived)
    return {
      key,
      model: archived.model,
      supplierKey: archived.supplierKey,
      supplierName: archived.supplierName,
      url: archived.url,
      quantity: archived.quantity,
      isDemo: demoMode() || archived.isDemo,
      canStart: false,
      snapshot: archived.snapshot,
    };
  const product = line?.productId ? byId<Product>('products', line.productId) : undefined;
  if (
    !order ||
    !line ||
    !product?.model ||
    !order.supplierId ||
    product.supplierId !== order.supplierId
  )
    throw new ApiError(404, 'not_found', '型番と仕入先を確認できる注文明細がありません');
  const supplier = byId<Supplier>('suppliers', order.supplierId);
  return {
    key,
    model: product.model,
    supplierKey: `supplier:${order.supplierId}`,
    supplierName: supplier?.name || order.supplierId,
    url: '',
    quantity: line.quantity,
    isDemo: demoMode() || order.isDemo || !!quote?.isDemo,
    // Order send confirmation must come from the dispatch flow, never this form.
    canStart: false,
    snapshot: { productId: product.id },
  };
}
function cases(where: string, ...args: string[]) {
  return (
    db()
      .prepare(`SELECT json FROM procurement_cases WHERE ${where} ORDER BY rowid DESC`)
      .all(...args) as { json: string }[]
  )
    .map((r) => JSON.parse(r.json) as ProcurementCase)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
function events(key: string) {
  return (
    db()
      .prepare(
        'SELECT json FROM procurement_events WHERE context_key=? ORDER BY rowid DESC LIMIT 100',
      )
      .all(key) as { json: string }[]
  ).map((r) => JSON.parse(r.json) as ProcurementEvent);
}
function storeCase(value: ProcurementCase) {
  save('procurement_cases', value, {
    context_key: value.contextKey,
    model_key: modelIdentity(value.model),
  });
}
function append(key: string, event: ProcurementEvent) {
  db()
    .prepare('INSERT INTO procurement_events(id,context_key,case_id,json) VALUES(?,?,?,?)')
    .run(event.id, key, event.caseId, JSON.stringify(event));
}
function history(source: Resolved): ProcurementHistory {
  const same = cases('model_key=?', modelIdentity(source.model)).filter(
    (c) => c.supplierKey === source.supplierKey && !c.isDemo && c.status !== 'void',
  );
  return {
    model: source.model,
    supplierName: source.supplierName,
    suggestedQuantity: source.quantity,
    isDemo: source.isDemo,
    canStart: source.canStart,
    cases: cases('context_key=?', source.key),
    events: events(source.key),
    summary: {
      completed: same.filter((c) => c.status === 'received').length,
      unavailable: same.filter((c) => c.status === 'unavailable').length,
      delayed: same.filter((c) => c.delayed).length,
      lastReceivedAt: same.find((c) => c.status === 'received')?.updatedAt || null,
    },
  };
}
export function procurementHistory(context: ProcurementContext) {
  return history(resolve(context));
}
const outcomeSchema = z
  .object({
    eventId: z.uuid(),
    caseId: z.uuid().optional(),
    action: z.enum([
      'ordered',
      'received',
      'unavailable',
      'delayed',
      'cancelled',
      'returned',
      'void',
    ]),
    quantity: z.number().int().positive().max(1000000000).optional(),
    receivedQuantity: z.number().int().positive().max(1000000000).optional(),
    note: z.string().max(1000).default(''),
  })
  .strict();

export function recordProcurementOutcome(context: ProcurementContext, input: unknown) {
  const change = outcomeSchema.parse(input);
  return db().transaction(() => {
    const source = resolve(context);
    const previous = db()
      .prepare('SELECT context_key,json FROM procurement_events WHERE id=?')
      .get(change.eventId) as { context_key: string; json: string } | undefined;
    if (previous) {
      const event = JSON.parse(previous.json) as ProcurementEvent;
      if (
        previous.context_key !== source.key ||
        JSON.stringify(event.snapshot) !== JSON.stringify(change)
      )
        throw new ApiError(409, 'conflict', '記録IDが別の操作で使用されています');
      return history(source);
    }
    const existing = cases('context_key=?', source.key);
    let item = existing.find((c) => c.id === change.caseId);
    const active = (c: ProcurementCase) => ['ordered', 'partial'].includes(c.status);
    if (!change.caseId && ['ordered', 'unavailable'].includes(change.action)) {
      if (!source.canStart)
        throw new ApiError(409, 'invalid_state', 'アプリの発注送信後に入荷結果を記録できます');
      if (existing.some((c) => c.isDemo === source.isDemo && active(c)))
        throw new ApiError(409, 'invalid_state', '進行中の発注に結果を記録してください');
      const quantity = change.quantity ?? source.quantity;
      if (!quantity || !Number.isSafeInteger(quantity) || quantity > 1000000000)
        throw new ApiError(400, 'quantity_required', '発注・確認した必要数量を入力してください');
      item = {
        id: uid(),
        contextKey: source.key,
        model: source.model,
        supplierKey: source.supplierKey,
        supplierName: source.supplierName,
        url: source.url,
        quantity,
        receivedQuantity: 0,
        status: change.action === 'ordered' ? 'ordered' : 'unavailable',
        delayed: false,
        isDemo: source.isDemo,
        origin: 'staff',
        createdAt: now(),
        updatedAt: now(),
        snapshot: source.snapshot,
      };
    } else {
      if (!item) throw new ApiError(404, 'not_found', '記録対象の発注が見つかりません');
      if (item.isDemo !== source.isDemo)
        throw new ApiError(409, 'invalid_state', 'デモと実運用の記録は分けてください');
      if (change.action === 'void' && item.status !== 'void') item.status = 'void';
      else if (change.action === 'returned' && ['received', 'partial'].includes(item.status))
        item.status = 'returned';
      else if (active(item)) {
        if (change.action === 'received') {
          const received = change.receivedQuantity;
          if (!received || received < item.receivedQuantity || received > item.quantity)
            throw new ApiError(
              400,
              'invalid_quantity',
              '累計入荷数は現在の入荷数以上・発注数以下で入力してください',
            );
          item.receivedQuantity = received;
          item.status = received === item.quantity ? 'received' : 'partial';
        } else if (change.action === 'delayed') item.delayed = true;
        else if (change.action === 'cancelled') item.status = 'cancelled';
        else if (change.action === 'unavailable' && item.receivedQuantity === 0)
          item.status = 'unavailable';
        else throw new ApiError(409, 'invalid_state', 'この状態では指定の結果を記録できません');
      } else
        throw new ApiError(
          409,
          'invalid_state',
          '完了した記録は変更できません。誤記録は取り消せます',
        );
      item.updatedAt = now();
    }
    storeCase(item);
    append(source.key, {
      id: change.eventId,
      caseId: item.id,
      action: change.action,
      createdAt: now(),
      source: 'staff',
      isDemo: item.isDemo,
      note: change.note,
      snapshot: change,
    });
    return history(source);
  })();
}

// Immutable staff confirmation evidence, distinct from purchase/receipt outcomes.
export function rememberProcurementConfirmation(context: ProcurementContext) {
  const source = resolve(context);
  if (!source.snapshot.offer?.approved) return;
  const { confirmedAt: _date, ...conditions } = source.snapshot.offer;
  const id = `confirmation:${createHash('sha256')
    .update(JSON.stringify([source.key, source.isDemo, conditions]))
    .digest('hex')}`;
  if (db().prepare('SELECT id FROM procurement_events WHERE id=?').get(id)) return;
  append(source.key, {
    id,
    caseId: null,
    action: 'conditions_confirmed',
    createdAt: now(),
    source: 'staff',
    isDemo: source.isDemo,
    note: '',
    snapshot: source.snapshot,
  });
}

// A sent order is an attempt, not proof of stock, allocation, or receipt.
export function rememberDispatchedOrder(order: Order) {
  if (!['dispatched', 'simulated'].includes(order.status)) return;
  const quote = byId<Quote>('quotes', order.quoteId);
  quote?.lines.forEach((_, line) => {
    let source: Resolved;
    try {
      source = resolve({ kind: 'order', orderId: order.id, line });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return;
      throw error;
    }
    const id = `sent:${order.id}:${line}`;
    if (db().prepare('SELECT id FROM procurement_events WHERE id=?').get(id)) return;
    const isDemo = source.isDemo || order.status === 'simulated';
    const item: ProcurementCase = {
      id: uid(),
      contextKey: source.key,
      model: source.model,
      supplierKey: source.supplierKey,
      supplierName: source.supplierName,
      url: '',
      quantity: source.quantity!,
      receivedQuantity: 0,
      status: 'ordered',
      delayed: false,
      isDemo,
      origin: 'app_order',
      createdAt: now(),
      updatedAt: now(),
      snapshot: source.snapshot,
    };
    storeCase(item);
    append(source.key, {
      id,
      caseId: item.id,
      action: 'order_sent',
      createdAt: now(),
      source: 'app_order',
      isDemo,
      note: '',
      snapshot: { orderId: order.id, externalId: order.externalId, line, quantity: item.quantity },
    });
  });
}

export function successfulProcurementSources(model: string): { url: string; title: string }[] {
  const seen = new Set<string>();
  return cases('model_key=?', modelIdentity(model))
    .flatMap((c) => {
      if (c.isDemo || c.status !== 'received' || !c.url || seen.has(c.url)) return [];
      seen.add(c.url);
      return [{ url: c.url, title: c.supplierName }];
    })
    .slice(0, 2);
}
