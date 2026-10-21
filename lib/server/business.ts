import { queueReceiptNotification } from './receipt-notifications';
import { asyncMap, asyncEvery } from '@/lib/async-arrays';
import type {
  AppSettings,
  Product,
  Source,
  Supplier,
  Quote,
  QuoteLine,
  Order,
  Inquiry,
  Conversation,
  ChatMessage,
  AuditEvent,
  Overview,
} from '../contracts';
import {
  db,
  lockResource,
  list,
  byId,
  save,
  uid,
  now,
  normalize,
  getSettings,
  demoMode,
  audit,
} from './db';
import { ApiError } from './auth';
import { dispatchSupplierOrder } from './providers';
import { openaiQuotaAlert } from './ai-usage';
import { rememberDispatchedOrder } from './procurement-memory';

export async function requireFlag(name: keyof AppSettings['flags']) {
  if (!(await getSettings()).flags[name])
    throw new ApiError(403, 'feature_disabled', 'この機能は現在利用できません。');
}
export async function validProduct(p: Product) {
  if (!p.approved || p.visibility !== 'public' || (!demoMode() && p.isDemo)) return false;
  const source = p.sourceId ? await byId<Source>('sources', p.sourceId) : undefined;
  if (!source?.enabled || source.trust === 'discovery') return false;
  if (source.trust === 'approved_supplier' || p.availability === 'orderable') {
    const supplier = p.supplierId ? await byId<Supplier>('suppliers', p.supplierId) : undefined;
    if (!supplier?.approved || !supplier.enabled) return false;
  }
  const age = p.verifiedAt ? Date.now() - Date.parse(p.verifiedAt) : Infinity;
  return Number.isFinite(age) && age >= 0 && age <= (await getSettings()).freshnessHours * 3600000;
}
export async function publicProduct(p: Product): Promise<Product | null> {
  if (p.visibility !== 'public' || (!demoMode() && p.isDemo)) return null;
  const valid = await validProduct(p),
    flags = (await getSettings()).flags;
  const source = p.sourceId ? await byId<Source>('sources', p.sourceId) : undefined;
  const evidence =
    valid && source
      ? [
          {
            title: source.visibility === 'public' ? source.name : '社内確認済み情報',
            ...(source.visibility === 'public' && source.url ? { url: source.url } : {}),
            excerpt: '登録された取扱情報',
            retrievedAt: p.verifiedAt!,
            sourceId: source.id,
            visibility: 'public' as const,
            trust: source.trust,
          },
        ]
      : [];
  return {
    ...p,
    availability: valid ? p.availability : 'needs_review',
    approved: valid,
    price: valid && flags.showPrice ? p.price : null,
    stock: valid && flags.showStock ? p.stock : null,
    leadTime: valid && flags.showLeadTime ? p.leadTime : '',
    sourceId: null,
    supplierId: null,
    evidence,
  };
}
export async function publicProducts(q = '', category = '') {
  const terms = normalize(q);
  return (await asyncMap(await list<Product>('products'), publicProduct))
    .filter((p): p is Product => !!p)
    .filter(
      (p) =>
        (!category || p.category === category) &&
        (!terms ||
          normalize(
            `${p.name} ${p.model} ${p.manufacturer} ${p.description} ${p.specifications}`,
          ).includes(terms)),
    );
}
export async function getPublicProduct(id: string) {
  const p = await byId<Product>('products', id);
  const value = p && (await publicProduct(p));
  if (!value) throw new ApiError(404, 'not_found', '商品が見つかりません。');
  return value;
}
export function validateSettings(s: AppSettings) {
  if ((s.flags.autoQuote || s.flags.orders) && !s.flags.quoteRequests)
    throw new ApiError(400, 'invalid_flags', '自動見積・注文には見積受付が必要です。');
  if (s.flags.autoOrder && !s.flags.orders)
    throw new ApiError(400, 'invalid_flags', '自動注文には注文機能が必要です。');
  if (s.freshnessHours < 1 || s.freshnessHours > 8760 || s.maxAutoOrderAmount < 0)
    throw new ApiError(400, 'invalid_settings', '設定値を確認してください。');
}
export function amount(lines: QuoteLine[], shipping: number, taxRate: number) {
  if (
    ![0, 8, 10].includes(taxRate) ||
    !Number.isSafeInteger(shipping) ||
    shipping < 0 ||
    lines.length < 1 ||
    lines.length > 100
  )
    throw new ApiError(400, 'invalid_amount', '明細、送料、税率を確認してください。');
  let sum = 0;
  for (const l of lines) {
    if (
      !l.name.trim() ||
      !Number.isSafeInteger(l.quantity) ||
      l.quantity < 1 ||
      l.quantity > 100000 ||
      !Number.isSafeInteger(l.unitPrice) ||
      l.unitPrice < 0
    )
      throw new ApiError(400, 'invalid_amount', '数量または単価が不正です。');
    sum += l.quantity * l.unitPrice;
  }
  if (!Number.isSafeInteger(sum) || !Number.isSafeInteger(sum + shipping))
    throw new ApiError(400, 'invalid_amount', '金額が上限を超えています。');
  const subtotal = sum,
    tax = Math.floor(((sum + shipping) * taxRate) / 100);
  if (!Number.isSafeInteger(subtotal + shipping + tax))
    throw new ApiError(400, 'invalid_amount', '金額が上限を超えています');
  return { subtotal, tax, total: subtotal + shipping + tax };
}
export function customerQuote(q: Quote): Quote {
  const { conversationId: _conversation, ...shown } = q;
  return { ...shown, notes: '' };
}
// The chat is marked as passed to the staff, keeping its owner.
export async function handOff(conversation: Conversation) {
  await db()
    .prepare(
      `UPDATE conversations SET json=jsonb_set(jsonb_set(json::jsonb,'{status}','"handed_off"'::jsonb),'{updatedAt}',to_jsonb(?::text))::text WHERE id=?`,
    )
    .run(now(), conversation.id);
}
export async function createQuote(
  input: {
    name: string;
    company: string;
    email: string;
    message: string;
    consent: boolean;
    productId?: string;
    quantity: number;
    conversationId?: string;
  },
  owner: string | null,
) {
  return await db().transaction(async () => {
    await requireFlag('quoteRequests');
    if (!input.consent) throw new ApiError(400, 'consent_required', '同意が必要です。');
    // The staff opens the chat and its research notes from the quote request.
    const conversation = input.conversationId
      ? await verifyConversation(input.conversationId, owner)
      : undefined;
    const salesState = conversation
      ? (await conversationMessages(conversation.id))
          .toReversed()
          .find((m) => m.role === 'assistant' && m.salesState)?.salesState
      : undefined;
    if (salesState && salesState.stage !== 'contact')
      throw new ApiError(
        409,
        'sales_stage_required',
        '型番の選択と見積希望の確認を終えてから依頼してください。',
      );
    let lines: QuoteLine[] = [];
    const status: Quote['status'] = 'requested';
    if (input.productId) {
      const raw = await byId<Product>('products', input.productId);
      if (!raw || raw.visibility !== 'public' || (!demoMode() && raw.isDemo))
        throw new ApiError(404, 'not_found', '商品が見つかりません。');
      const p = (await publicProduct(raw))!;
      // Registered prices seed a draft; every formal quote needs Aoki's review.
      const unitPrice = (await validProduct(raw)) && p.price !== null ? p.price : 0;
      lines = [{ productId: raw.id, name: raw.name, quantity: input.quantity, unitPrice }];
    } else
      lines = [
        {
          productId: null,
          name: conversation
            ? salesState?.selectedModel ||
              (await conversationMessages(conversation.id)).at(-1)?.sourcing?.model ||
              '商品選定・製作のご相談（仕様は相談内容参照）'
            : '相談内容を確認後に明細を作成',
          quantity: input.quantity,
          unitPrice: 0,
        },
      ];
    const t = now();
    const calc = amount(lines, 0, 10);
    const q: Quote = {
      id: uid(),
      token: crypto.randomUUID() + crypto.randomUUID().replaceAll('-', ''),
      ...(conversation ? { conversationId: conversation.id } : {}),
      name: input.name,
      company: input.company,
      email: input.email,
      message: input.message,
      lines,
      shipping: 0,
      taxRate: 10,
      ...calc,
      status,
      expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
      notes: '',
      createdAt: t,
      updatedAt: t,
      isDemo: demoMode(),
    };
    await save('quotes', q, { token: q.token });
    await queueReceiptNotification('quote', q.id);
    if (conversation) await handOff(conversation);
    await audit('quote.created', q.id, '見積依頼を受け付けました');
    return customerQuote(q);
  })();
}
export async function getQuoteByToken(token: string) {
  const row = (await db().prepare('SELECT json FROM quotes WHERE token=?').get(token)) as
    { json: string } | undefined;
  if (!row) throw new ApiError(404, 'not_found', '見積が見つかりません。');
  return JSON.parse(row.json) as Quote;
}
export async function updateQuote(id: string, input: Partial<Quote> & { aokiReviewed?: boolean }) {
  return await db().transaction(async () => {
    await lockResource(`quote:${id}`);
    const q = await byId<Quote>('quotes', id);
    if (!q) throw new ApiError(404, 'not_found', '見積が見つかりません。');
    if (
      q.status === 'accepted' ||
      q.status === 'cancelled' ||
      (q.status === 'issued' && input.status !== 'cancelled')
    )
      throw new ApiError(409, 'invalid_state', '確定済みの見積は変更できません。');
    if (input.status && !['requested', 'draft', 'issued', 'cancelled'].includes(input.status))
      throw new ApiError(400, 'invalid_state', '見積状態が不正です。');
    if (input.status === 'issued' && input.aokiReviewed !== true)
      throw new ApiError(400, 'review_required', '正式見積は青木さんの確認後に発行してください。');
    if (
      input.status === 'issued' &&
      q.status !== 'draft' &&
      q.status !== 'issued' &&
      !(q.status === 'requested' && input.lines)
    )
      throw new ApiError(409, 'invalid_state', '明細を確定してから発行してください。');
    const lines = input.lines ?? q.lines,
      shipping = input.shipping ?? q.shipping,
      taxRate = input.taxRate ?? q.taxRate,
      expiresAt = input.expiresAt ?? q.expiresAt;
    if (!Number.isFinite(Date.parse(expiresAt)))
      throw new ApiError(400, 'invalid_date', '期限が不正です。');
    if (input.status === 'issued' && Date.parse(expiresAt) <= Date.now())
      throw new ApiError(400, 'expired', '期限切れの見積は発行できません。');
    const calc = amount(lines, shipping, taxRate);
    const next: Quote = {
      ...q,
      lines,
      shipping,
      taxRate,
      ...calc,
      expiresAt,
      notes: input.notes ?? q.notes,
      status: input.status ?? q.status,
      ...(input.status === 'issued' ? { reviewedAt: now(), reviewedBy: '青木' as const } : {}),
      updatedAt: now(),
    };
    await save('quotes', next, { token: next.token });
    await audit('quote.updated', id, `見積状態: ${next.status}`);
    return next;
  })();
}
export async function verifyConversation(id: string, owner: string | null) {
  const row = (await db().prepare('SELECT owner_id,json FROM conversations WHERE id=?').get(id)) as
    { owner_id: string; json: string } | undefined;
  if (!row) throw new ApiError(404, 'not_found', '会話が見つかりません。');
  if (!owner || row.owner_id !== owner)
    throw new ApiError(403, 'forbidden', 'この会話にはアクセスできません。');
  return JSON.parse(row.json) as Conversation;
}
export async function conversationMessages(id: string) {
  return (
    (await db()
      .prepare('SELECT json FROM messages WHERE conversation_id=? ORDER BY sequence')
      .all(id)) as {
      json: string;
    }[]
  )
    .map((row) => JSON.parse(row.json) as ChatMessage)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
export async function acceptQuote(token: string, confirmed: boolean, key: string) {
  await requireFlag('orders');
  if (!confirmed || !key || key.length > 128)
    throw new ApiError(400, 'confirmation_required', '見積内容を確認してください。');
  const database = db();
  return await database.transaction(async () => {
    await lockResource(`quote-token:${token}`);
    let q = await getQuoteByToken(token);
    await lockResource(`quote:${q.id}`);
    q = await getQuoteByToken(token);
    if (q.status !== 'issued' && q.status !== 'accepted')
      throw new ApiError(409, 'invalid_state', 'この見積は注文できません。');
    if (Date.parse(q.expiresAt) <= Date.now())
      throw new ApiError(409, 'expired', '見積の有効期限が切れています。');
    const existing = (await database
      .prepare('SELECT json,idempotency_key FROM orders WHERE quote_id=?')
      .get(q.id)) as { json: string; idempotency_key: string } | undefined;
    if (existing) {
      if (existing.idempotency_key !== key)
        throw new ApiError(409, 'already_accepted', 'この見積はすでに注文済みです。');
      return JSON.parse(existing.json) as Order;
    }
    if (q.lines.some((l) => l.unitPrice === 0))
      throw new ApiError(409, 'unpriced', '見積金額が確定していません。');
    const supplierIds = (
      await asyncMap(q.lines, async (l) =>
        l.productId ? (await byId<Product>('products', l.productId))?.supplierId : null,
      )
    ).filter(Boolean);
    const supplierId =
      supplierIds.length === q.lines.length && supplierIds.every((x) => x === supplierIds[0])
        ? supplierIds[0]!
        : null;
    const t = now();
    const order: Order = {
      id: uid(),
      quoteId: q.id,
      supplierId,
      status: 'pending_approval',
      total: q.total,
      isDemo: demoMode() || q.isDemo,
      externalId: null,
      lastError: null,
      createdAt: t,
      updatedAt: t,
    };
    await save('orders', order, { quote_id: q.id, idempotency_key: key });
    await save('quotes', { ...q, status: 'accepted', updatedAt: t }, { token: q.token });
    await audit('order.requested', order.id, '注文依頼を受け付けました');
    return order;
  })();
}
export async function approveOrder(id: string) {
  return await db().transaction(async () => {
    await lockResource(`order:${id}`);
    await requireFlag('orders');
    const o = await byId<Order>('orders', id);
    if (!o) throw new ApiError(404, 'not_found', '注文が見つかりません。');
    if (o.status !== 'pending_approval')
      throw new ApiError(409, 'invalid_state', 'この注文は承認できません。');
    const q = await byId<Quote>('quotes', o.quoteId);
    if (!q || q.status !== 'accepted' || Date.parse(q.expiresAt) <= Date.now())
      throw new ApiError(409, 'expired', '有効な見積がありません。');
    const next = { ...o, status: 'approved' as const, updatedAt: now() };
    await save('orders', next, {
      quote_id: o.quoteId,
      idempotency_key: (
        (await db().prepare('SELECT idempotency_key FROM orders WHERE id=?').get(id)) as {
          idempotency_key: string;
        }
      ).idempotency_key,
    });
    await audit('order.approved', id, '注文を承認しました');
    return next;
  })();
}
export async function dispatchOrder(id: string) {
  await requireFlag('orders');
  const o = await byId<Order>('orders', id);
  if (!o) throw new ApiError(404, 'not_found', '注文が見つかりません。');
  if (o.status !== 'approved' && o.status !== 'failed')
    throw new ApiError(409, 'invalid_state', 'この注文は送信できません。');
  const q = await byId<Quote>('quotes', o.quoteId);
  if (!q || q.status !== 'accepted' || Date.parse(q.expiresAt) <= Date.now())
    throw new ApiError(409, 'expired', '有効な見積がありません。');
  const key = (
    (await db().prepare('SELECT idempotency_key FROM orders WHERE id=?').get(id)) as {
      idempotency_key: string;
    }
  ).idempotency_key;
  if (demoMode() || o.isDemo) {
    const next = {
      ...o,
      status: 'simulated' as const,
      externalId: null,
      lastError: null,
      updatedAt: now(),
    };
    await db().transaction(async () => {
      await lockResource(`order:${id}`);
      const current = await byId<Order>('orders', id);
      if (!current || !['approved', 'failed'].includes(current.status))
        throw new ApiError(409, 'invalid_state', 'この注文は送信済み、または送信中です。');
      await save('orders', next, { quote_id: o.quoteId, idempotency_key: key });
      await rememberDispatchedOrder(next);
    })();
    await audit('order.simulated', id, 'デモ送信を記録しました');
    return next;
  }
  if (process.env.ALLOW_LIVE_ORDERS !== 'true')
    throw new ApiError(403, 'live_orders_disabled', '実発注はサーバーで許可されていません。');
  const supplier = o.supplierId ? await byId<Supplier>('suppliers', o.supplierId) : undefined;
  if (
    !supplier ||
    !supplier.enabled ||
    !supplier.approved ||
    !supplier.orderEndpoint ||
    !supplier.authEnv ||
    !process.env[supplier.authEnv]
  )
    throw new ApiError(503, 'supplier_unavailable', '仕入先連携が未設定です。');
  if (
    !(await asyncEvery(q.lines, async (l) => {
      const p = l.productId ? await byId<Product>('products', l.productId) : undefined;
      return (
        p &&
        (await validProduct(p)) &&
        ['available', 'orderable'].includes(p.availability) &&
        p.supplierId === supplier.id
      );
    }))
  )
    throw new ApiError(409, 'product_needs_review', '商品の販売条件を再確認してください。');
  const inFlight = { ...o, status: 'needs_reconciliation' as const, updatedAt: now() };
  await db().transaction(async () => {
    await lockResource(`order:${id}`);
    const current = await byId<Order>('orders', id);
    if (!current || !['approved', 'failed'].includes(current.status))
      throw new ApiError(409, 'invalid_state', 'この注文は送信済み、または送信中です。');
    await save('orders', inFlight, { quote_id: o.quoteId, idempotency_key: key });
  })();
  try {
    const result = await dispatchSupplierOrder(inFlight, q, supplier);
    const next = {
      ...inFlight,
      status: result.status,
      externalId: result.externalId || null,
      lastError: result.message || null,
      updatedAt: now(),
    };
    await db().transaction(async () => {
      await save('orders', next, { quote_id: o.quoteId, idempotency_key: key });
      await rememberDispatchedOrder(next);
    })();
    await audit('order.dispatched', id, `送信結果: ${next.status}`);
    return next;
  } catch (e) {
    const next = {
      ...inFlight,
      lastError: e instanceof Error ? e.message : '送信結果が不明です',
      updatedAt: now(),
    };
    await save('orders', next, { quote_id: o.quoteId, idempotency_key: key });
    await audit('order.reconciliation', id, '送信結果の確認が必要です');
    return next;
  }
}
export async function overview(): Promise<Overview> {
  const count = async (table: string) =>
    Number(((await db().prepare(`SELECT count(*) n FROM ${table}`).get()) as { n: number }).n);
  const inquiries = await list<Inquiry>('inquiries'),
    orders = await list<Order>('orders');
  const quota = await openaiQuotaAlert();
  return {
    products: await count('products'),
    sources: await count('sources'),
    conversations: await count('conversations'),
    inquiries: inquiries.length,
    quotes: await count('quotes'),
    orders: orders.length,
    pendingInquiries: inquiries.filter((x) => x.status === 'new').length,
    pendingOrders: orders.filter((x) => x.status === 'pending_approval').length,
    recentEvents: (await list<AuditEvent>('audit_events'))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 10),
    demoMode: demoMode(),
    ...(quota ? { openaiQuotaExhaustedAt: quota } : {}),
  };
}
