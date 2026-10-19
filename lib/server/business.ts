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
import { db, list, byId, save, uid, now, normalize, getSettings, demoMode, audit } from './db';
import { ApiError } from './auth';
import { dispatchSupplierOrder } from './providers';
import { openaiQuotaAlert } from './ai-usage';
import { rememberDispatchedOrder } from './procurement-memory';

export function requireFlag(name: keyof AppSettings['flags']) {
  if (!getSettings().flags[name])
    throw new ApiError(403, 'feature_disabled', 'この機能は現在利用できません。');
}
export function validProduct(p: Product) {
  if (!p.approved || p.visibility !== 'public' || (!demoMode() && p.isDemo)) return false;
  const source = p.sourceId ? byId<Source>('sources', p.sourceId) : undefined;
  if (!source?.enabled || source.trust === 'discovery') return false;
  if (source.trust === 'approved_supplier' || p.availability === 'orderable') {
    const supplier = p.supplierId ? byId<Supplier>('suppliers', p.supplierId) : undefined;
    if (!supplier?.approved || !supplier.enabled) return false;
  }
  const age = p.verifiedAt ? Date.now() - Date.parse(p.verifiedAt) : Infinity;
  return Number.isFinite(age) && age >= 0 && age <= getSettings().freshnessHours * 3600000;
}
export function publicProduct(p: Product): Product | null {
  if (p.visibility !== 'public' || (!demoMode() && p.isDemo)) return null;
  const valid = validProduct(p),
    flags = getSettings().flags;
  const source = p.sourceId ? byId<Source>('sources', p.sourceId) : undefined;
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
export function publicProducts(q = '', category = '') {
  const terms = normalize(q);
  return list<Product>('products')
    .map(publicProduct)
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
export function getPublicProduct(id: string) {
  const p = byId<Product>('products', id);
  const value = p && publicProduct(p);
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
export function handOff(conversation: Conversation) {
  const row = db().prepare('SELECT owner_id FROM conversations WHERE id=?').get(conversation.id) as
    { owner_id: string } | undefined;
  if (!row) return;
  save(
    'conversations',
    { ...conversation, status: 'handed_off', updatedAt: now() },
    { owner_id: row.owner_id },
  );
}
export function createQuote(
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
  requireFlag('quoteRequests');
  if (!input.consent) throw new ApiError(400, 'consent_required', '同意が必要です。');
  // The staff opens the chat and its research notes from the quote request.
  const conversation = input.conversationId
    ? verifyConversation(input.conversationId, owner)
    : undefined;
  const salesState = conversation
    ? conversationMessages(conversation.id)
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
    const raw = byId<Product>('products', input.productId);
    if (!raw || raw.visibility !== 'public' || (!demoMode() && raw.isDemo))
      throw new ApiError(404, 'not_found', '商品が見つかりません。');
    const p = publicProduct(raw)!;
    // Registered prices seed a draft; every formal quote needs Aoki's review.
    const unitPrice = validProduct(raw) && p.price !== null ? p.price : 0;
    lines = [{ productId: raw.id, name: raw.name, quantity: input.quantity, unitPrice }];
  } else
    lines = [
      {
        productId: null,
        name: conversation
          ? salesState?.selectedModel ||
            conversationMessages(conversation.id).at(-1)?.sourcing?.model ||
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
  save('quotes', q, { token: q.token });
  if (conversation) handOff(conversation);
  audit('quote.created', q.id, '見積依頼を受け付けました');
  return customerQuote(q);
}
export function getQuoteByToken(token: string) {
  const row = db().prepare('SELECT json FROM quotes WHERE token=?').get(token) as
    { json: string } | undefined;
  if (!row) throw new ApiError(404, 'not_found', '見積が見つかりません。');
  return JSON.parse(row.json) as Quote;
}
export function updateQuote(id: string, input: Partial<Quote> & { aokiReviewed?: boolean }) {
  const q = byId<Quote>('quotes', id);
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
  save('quotes', next, { token: next.token });
  audit('quote.updated', id, `見積状態: ${next.status}`);
  return next;
}
export function verifyConversation(id: string, owner: string | null) {
  const row = db().prepare('SELECT owner_id,json FROM conversations WHERE id=?').get(id) as
    { owner_id: string; json: string } | undefined;
  if (!row) throw new ApiError(404, 'not_found', '会話が見つかりません。');
  if (!owner || row.owner_id !== owner)
    throw new ApiError(403, 'forbidden', 'この会話にはアクセスできません。');
  return JSON.parse(row.json) as Conversation;
}
export function conversationMessages(id: string) {
  return (
    db().prepare('SELECT json FROM messages WHERE conversation_id=? ORDER BY rowid').all(id) as {
      json: string;
    }[]
  )
    .map((row) => JSON.parse(row.json) as ChatMessage)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
export function acceptQuote(token: string, confirmed: boolean, key: string) {
  requireFlag('orders');
  if (!confirmed || !key || key.length > 128)
    throw new ApiError(400, 'confirmation_required', '見積内容を確認してください。');
  const database = db();
  return database.transaction(() => {
    const q = getQuoteByToken(token);
    if (q.status !== 'issued' && q.status !== 'accepted')
      throw new ApiError(409, 'invalid_state', 'この見積は注文できません。');
    if (Date.parse(q.expiresAt) <= Date.now())
      throw new ApiError(409, 'expired', '見積の有効期限が切れています。');
    const existing = database
      .prepare('SELECT json,idempotency_key FROM orders WHERE quote_id=?')
      .get(q.id) as { json: string; idempotency_key: string } | undefined;
    if (existing) {
      if (existing.idempotency_key !== key)
        throw new ApiError(409, 'already_accepted', 'この見積はすでに注文済みです。');
      return JSON.parse(existing.json) as Order;
    }
    if (q.lines.some((l) => l.unitPrice === 0))
      throw new ApiError(409, 'unpriced', '見積金額が確定していません。');
    const supplierIds = q.lines
      .map((l) => (l.productId ? byId<Product>('products', l.productId)?.supplierId : null))
      .filter(Boolean);
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
    save('orders', order, { quote_id: q.id, idempotency_key: key });
    save('quotes', { ...q, status: 'accepted', updatedAt: t }, { token: q.token });
    audit('order.requested', order.id, '注文依頼を受け付けました');
    return order;
  })();
}
export function approveOrder(id: string) {
  requireFlag('orders');
  const o = byId<Order>('orders', id);
  if (!o) throw new ApiError(404, 'not_found', '注文が見つかりません。');
  if (o.status !== 'pending_approval')
    throw new ApiError(409, 'invalid_state', 'この注文は承認できません。');
  const q = byId<Quote>('quotes', o.quoteId);
  if (!q || q.status !== 'accepted' || Date.parse(q.expiresAt) <= Date.now())
    throw new ApiError(409, 'expired', '有効な見積がありません。');
  const next = { ...o, status: 'approved' as const, updatedAt: now() };
  save('orders', next, {
    quote_id: o.quoteId,
    idempotency_key: (
      db().prepare('SELECT idempotency_key FROM orders WHERE id=?').get(id) as {
        idempotency_key: string;
      }
    ).idempotency_key,
  });
  audit('order.approved', id, '注文を承認しました');
  return next;
}
export async function dispatchOrder(id: string) {
  requireFlag('orders');
  const o = byId<Order>('orders', id);
  if (!o) throw new ApiError(404, 'not_found', '注文が見つかりません。');
  if (o.status !== 'approved' && o.status !== 'failed')
    throw new ApiError(409, 'invalid_state', 'この注文は送信できません。');
  const q = byId<Quote>('quotes', o.quoteId);
  if (!q || q.status !== 'accepted' || Date.parse(q.expiresAt) <= Date.now())
    throw new ApiError(409, 'expired', '有効な見積がありません。');
  const key = (
    db().prepare('SELECT idempotency_key FROM orders WHERE id=?').get(id) as {
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
    db().transaction(() => {
      save('orders', next, { quote_id: o.quoteId, idempotency_key: key });
      rememberDispatchedOrder(next);
    })();
    audit('order.simulated', id, 'デモ送信を記録しました');
    return next;
  }
  if (process.env.ALLOW_LIVE_ORDERS !== 'true')
    throw new ApiError(403, 'live_orders_disabled', '実発注はサーバーで許可されていません。');
  const supplier = o.supplierId ? byId<Supplier>('suppliers', o.supplierId) : undefined;
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
    !q.lines.every((l) => {
      const p = l.productId ? byId<Product>('products', l.productId) : undefined;
      return (
        p &&
        validProduct(p) &&
        ['available', 'orderable'].includes(p.availability) &&
        p.supplierId === supplier.id
      );
    })
  )
    throw new ApiError(409, 'product_needs_review', '商品の販売条件を再確認してください。');
  const inFlight = { ...o, status: 'needs_reconciliation' as const, updatedAt: now() };
  save('orders', inFlight, { quote_id: o.quoteId, idempotency_key: key });
  try {
    const result = await dispatchSupplierOrder(inFlight, q, supplier);
    const next = {
      ...inFlight,
      status: result.status,
      externalId: result.externalId || null,
      lastError: result.message || null,
      updatedAt: now(),
    };
    db().transaction(() => {
      save('orders', next, { quote_id: o.quoteId, idempotency_key: key });
      rememberDispatchedOrder(next);
    })();
    audit('order.dispatched', id, `送信結果: ${next.status}`);
    return next;
  } catch (e) {
    const next = {
      ...inFlight,
      lastError: e instanceof Error ? e.message : '送信結果が不明です',
      updatedAt: now(),
    };
    save('orders', next, { quote_id: o.quoteId, idempotency_key: key });
    audit('order.reconciliation', id, '送信結果の確認が必要です');
    return next;
  }
}
export function overview(): Overview {
  const count = (table: string) =>
    Number((db().prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n);
  const inquiries = list<Inquiry>('inquiries'),
    orders = list<Order>('orders');
  const quota = openaiQuotaAlert();
  return {
    products: count('products'),
    sources: count('sources'),
    conversations: count('conversations'),
    inquiries: inquiries.length,
    quotes: count('quotes'),
    orders: orders.length,
    pendingInquiries: inquiries.filter((x) => x.status === 'new').length,
    pendingOrders: orders.filter((x) => x.status === 'pending_approval').length,
    recentEvents: list<AuditEvent>('audit_events')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 10),
    demoMode: demoMode(),
    ...(quota ? { openaiQuotaExhaustedAt: quota } : {}),
  };
}
