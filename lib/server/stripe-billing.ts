import Stripe from 'stripe';
import { db, lockResource, uid } from './db';
import { ApiError } from './auth';
import { budgetState, billingHistory, ensureCurrentBudget } from './ai-budget';
import { plans, requireBillingReady, MICRO_YEN, type BillingAccount } from './billing-config';
import type { PlanId } from '../billing';

export function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (
    !key ||
    !/^sk_(test|live)_/.test(key) ||
    (key.startsWith('sk_live_') && process.env.BILLING_LIVE_ENABLED !== 'true')
  )
    throw new ApiError(503, 'billing_setup_required', '決済設定の準備中です。');
  // SDK-pinned API version. Never silently retry a non-idempotent mutation.
  return new Stripe(key, { maxNetworkRetries: 0, timeout: 15_000 });
}
function returnUrl() {
  const raw = process.env.APP_ORIGIN;
  if (!raw) throw new ApiError(503, 'billing_setup_required', 'サイトURLが未設定です。');
  const url = new URL(raw);
  if (
    url.origin !== raw ||
    (url.protocol !== 'https:' &&
      !(
        process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_') &&
        ['localhost', '127.0.0.1'].includes(url.hostname)
      ))
  )
    throw new ApiError(503, 'billing_setup_required', 'サイトURLを確認してください。');
  return `${url.origin}/admin?tab=billing`;
}
function objectId(value: unknown): string | undefined {
  return typeof value === 'string'
    ? value
    : value && typeof value === 'object' && 'id' in value
      ? String(value.id)
      : undefined;
}
async function saveAccount(account: BillingAccount) {
  await db()
    .prepare('UPDATE billing_account SET json=?::text::jsonb WHERE id=1')
    .run(JSON.stringify(account));
}
async function validatePrices(stripe: Stripe) {
  const configured = plans();
  if (new Set(configured.map((p) => p.priceId)).size !== configured.length)
    throw new ApiError(503, 'billing_price_invalid', 'プランの価格設定が重複しています。');
  for (const plan of configured) {
    const price = await stripe.prices.retrieve(plan.priceId);
    if (
      !price.active ||
      price.currency !== 'jpy' ||
      price.unit_amount !== plan.monthlyYen ||
      price.recurring?.interval !== 'month' ||
      price.recurring.interval_count !== 1 ||
      price.recurring.usage_type !== 'licensed' ||
      price.tax_behavior !== 'inclusive' ||
      price.billing_scheme !== 'per_unit' ||
      price.livemode !== process.env.STRIPE_SECRET_KEY?.startsWith('sk_live_')
    )
      throw new ApiError(
        503,
        'billing_price_invalid',
        '月額料金・税込価格・環境の設定を確認してください。',
      );
  }
}
export async function checkout(planId: PlanId, actor: string) {
  requireBillingReady();
  const stripe = stripeClient();
  const plan = plans().find((p) => p.id === planId)!;
  const customer = process.env.STRIPE_CUSTOMER_ID!;
  await validatePrices(stripe);
  const customerRecord = await stripe.customers.retrieve(customer);
  if (
    customerRecord.deleted ||
    customerRecord.livemode !== process.env.STRIPE_SECRET_KEY?.startsWith('sk_live_')
  )
    throw new ApiError(503, 'billing_customer_invalid', '契約先の設定を確認してください。');
  // Commit the operation identity BEFORE contacting Stripe. Unknown outcomes use
  // the same idempotency key; after Stripe's retention window require reconciliation.
  await db().transaction(async () => {
    await lockResource('billing-operations');
    const { account } = await budgetState();
    if (account.customerId && account.customerId !== customer)
      throw new ApiError(409, 'billing_customer_conflict', '既存契約の顧客設定と一致しません。');
    if (
      account.subscriptionId &&
      !['canceled', 'incomplete_expired'].includes(account.status || '')
    )
      throw new ApiError(
        409,
        'subscription_exists',
        '既存契約は「契約・支払いを管理」から変更してください。',
      );
    if (account.checkoutId && (account.checkoutExpires || 0) <= Date.now()) {
      const old = await stripe.checkout.sessions.retrieve(account.checkoutId);
      if (old.status !== 'expired')
        throw new ApiError(
          409,
          'checkout_pending',
          '決済結果を確認中です。しばらくして再読み込みしてください。',
        );
      delete account.checkoutAttempt;
      delete account.checkoutAttemptAt;
      delete account.checkoutId;
      delete account.checkoutUrl;
      delete account.checkoutPlan;
    }
    if (account.checkoutAttempt && account.checkoutPlan !== planId)
      throw new ApiError(
        409,
        'checkout_pending',
        '申込中のプランがあります。現在の申込完了または期限切れをお待ちください。',
      );
    account.customerId = customer;
    account.checkoutPlan = planId;
    if (!account.checkoutAttempt) {
      account.checkoutAttempt = uid();
      account.checkoutAttemptAt = Date.now();
    }
    await saveAccount(account);
  })();
  return db().transaction(async () => {
    await lockResource('billing-operations');
    const { account } = await budgetState();
    if (account.checkoutUrl && (account.checkoutExpires || 0) > Date.now())
      return { url: account.checkoutUrl };
    if (Date.now() - (account.checkoutAttemptAt || 0) >= 23 * 3600_000)
      throw new ApiError(
        409,
        'checkout_review',
        '申込結果が未確認です。運用担当者による確認が必要です。',
      );
    const existing = await stripe.subscriptions.list({ customer, status: 'all', limit: 100 });
    if (
      existing.has_more ||
      existing.data.some((s) => !['canceled', 'incomplete_expired'].includes(s.status))
    )
      throw new ApiError(
        409,
        'subscription_exists',
        '既存契約を確認してください。重複した契約は作成できません。',
      );
    const session = await stripe.checkout.sessions.create(
      {
        mode: 'subscription',
        customer,
        allowed_payment_method_types: ['card'],
        line_items: [{ price: plan.priceId, quantity: 1 }],
        success_url: `${returnUrl()}&payment=processing`,
        cancel_url: returnUrl(),
        client_reference_id: account.checkoutAttempt,
        subscription_data: { metadata: { app: 'aokiennji' } },
        expires_at: Math.floor((account.checkoutAttemptAt! + 35 * 60_000) / 1000),
      },
      { idempotencyKey: `aoki-checkout-${account.checkoutAttempt}` },
    );
    if (!session.url) throw new Error('Checkout URL missing');
    account.checkoutId = session.id;
    account.checkoutUrl = session.url;
    account.checkoutExpires = session.expires_at * 1000;
    await saveAccount(account);
    await billingHistory('checkout.created', actor, { plan: planId, session: session.id });
    return { url: session.url };
  })();
}
export async function portal(actor: string) {
  requireBillingReady();
  const stripe = stripeClient();
  const { account } = await budgetState();
  if (
    !account.customerId ||
    account.customerId !== process.env.STRIPE_CUSTOMER_ID ||
    !account.subscriptionId
  )
    throw new ApiError(409, 'subscription_missing', '契約の確認が必要です。');
  await validatePrices(stripe);
  const configuration = await stripe.billingPortal.configurations.retrieve(
    process.env.STRIPE_PORTAL_CONFIGURATION_ID!,
    { expand: ['features.subscription_update.products'] },
  );
  const update = configuration.features.subscription_update;
  const allowedPrices = plans()
    .map((p) => p.priceId)
    .sort();
  const portalPrices = (update.products || []).flatMap((p) => p.prices).sort();
  if (
    !configuration.active ||
    !update.enabled ||
    update.proration_behavior !== 'always_invoice' ||
    update.billing_cycle_anchor === 'now' ||
    update.default_allowed_updates.some((k) => k !== 'price') ||
    !update.default_allowed_updates.includes('price') ||
    JSON.stringify(allowedPrices) !== JSON.stringify(portalPrices) ||
    !update.schedule_at_period_end.conditions.some((c) => c.type === 'decreasing_item_amount') ||
    configuration.features.subscription_cancel.mode !== 'at_period_end'
  )
    throw new ApiError(
      503,
      'portal_configuration',
      '契約変更画面の料金・日割り・解約設定を確認してください。',
    );
  const session = await stripe.billingPortal.sessions.create({
    customer: account.customerId,
    configuration: configuration.id,
    return_url: returnUrl(),
  });
  await billingHistory('portal.opened', actor, {});
  return { url: session.url };
}
const relevantEvents = new Set([
  'checkout.session.completed',
  'invoice.paid',
  'invoice.payment_failed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.created',
]);
export async function processStripeEvent(event: Stripe.Event) {
  if (event.livemode !== process.env.STRIPE_SECRET_KEY?.startsWith('sk_live_'))
    throw new ApiError(400, 'stripe_mode_mismatch', '決済環境が一致しません。');
  if (!relevantEvents.has(event.type)) return;
  const object = event.data.object as unknown as Record<string, unknown>;
  if (objectId(object.customer) !== process.env.STRIPE_CUSTOMER_ID) return;
  const stripe = stripeClient();
  await db().transaction(async () => {
    await lockResource('billing-operations');
    if (await db().prepare('SELECT id FROM billing_events WHERE id=?').get(event.id)) return;
    const { account } = await budgetState();
    const customer = process.env.STRIPE_CUSTOMER_ID!;
    if (account.customerId && account.customerId !== customer)
      throw new Error('Configured customer differs from account');
    const subscriptions = await stripe.subscriptions.list({ customer, status: 'all', limit: 100 });
    if (subscriptions.has_more) throw new Error('Subscription list requires review');
    const active = subscriptions.data.filter(
      (s) => !['canceled', 'incomplete_expired'].includes(s.status),
    );
    if (active.length > 1) throw new Error('Multiple subscriptions require review');
    const selected = active[0] || subscriptions.data.find((s) => s.id === account.subscriptionId);
    if (selected) {
      // Always retrieve authoritative current state, regardless of webhook arrival order.
      const sub = await stripe.subscriptions.retrieve(selected.id, { expand: ['latest_invoice'] });
      if (objectId(sub.customer) !== customer) throw new Error('Subscription customer mismatch');
      const before = {
        plan: account.paidPlan,
        status: account.status,
        paidUntil: account.paidUntil,
      };
      account.customerId = customer;
      account.subscriptionId = sub.id;
      account.status = sub.status;
      // The subscription now owns payment state. Clearing the completed Checkout
      // also permits a new application after a later cancellation.
      delete account.checkoutId;
      delete account.checkoutUrl;
      delete account.checkoutPlan;
      delete account.checkoutExpires;
      delete account.checkoutAttempt;
      delete account.checkoutAttemptAt;
      const item = sub.items.data[0];
      const plan = plans().find((p) => p.configured && p.priceId === item?.price.id);
      const invoice = typeof sub.latest_invoice === 'object' ? sub.latest_invoice : null;
      const invoiceSubscription = objectId(invoice?.parent?.subscription_details?.subscription);
      const paidLine = invoice?.lines.data.find(
        (l) =>
          l.pricing?.price_details?.price === item?.price.id &&
          l.amount > 0 &&
          l.period.end === item.current_period_end,
      );
      const valid =
        sub.status === 'active' &&
        !sub.pause_collection &&
        !sub.pending_update &&
        sub.items.data.length === 1 &&
        item.quantity === 1 &&
        plan &&
        item.price.currency === 'jpy' &&
        item.price.unit_amount === plan.monthlyYen &&
        item.price.tax_behavior === 'inclusive' &&
        item.price.recurring?.interval === 'month' &&
        item.price.recurring.interval_count === 1 &&
        invoice?.status === 'paid' &&
        invoice.amount_paid > 0 &&
        invoice.currency === 'jpy' &&
        objectId(invoice.customer) === customer &&
        invoiceSubscription === sub.id &&
        !invoice.lines.has_more &&
        paidLine;
      await lockResource('ai-budget-policy');
      const previousPolicy = await db()
        .prepare('SELECT limit_microyen FROM ai_budget_policy WHERE id=1')
        .get();
      if (valid && plan && invoice) {
        const changed = account.paidPlan !== plan.id || account.paidInvoice !== invoice.id;
        account.paidPlan = plan.id;
        account.paidUntil = new Date(item.current_period_end * 1000).toISOString();
        account.paidLimitYen = changed
          ? plan.apiLimitYen!
          : Math.min(account.paidLimitYen || 0, plan.apiLimitYen!);
        account.paidInvoice = invoice.id;
        if (changed)
          await db()
            .prepare('UPDATE ai_budget_policy SET limit_microyen=?,revision=revision+1 WHERE id=1')
            .run(plan.apiLimitYen! * MICRO_YEN);
      } else if (!['active', 'past_due'].includes(sub.status) || sub.pause_collection) {
        delete account.paidPlan;
        delete account.paidUntil;
        delete account.paidLimitYen;
      }
      await saveAccount(account);
      const currentBudget = await ensureCurrentBudget();
      await billingHistory('subscription.reconciled', 'stripe', {
        event: event.id,
        before: { ...before, limitYen: Number(previousPolicy.limit_microyen) / MICRO_YEN },
        after: {
          plan: account.paidPlan || null,
          status: account.status,
          paidUntil: account.paidUntil || null,
          limitYen: currentBudget.limit / MICRO_YEN,
        },
        paymentConfirmed: !!valid,
      });
    }
    await db().prepare('INSERT INTO billing_events(id,kind) VALUES(?,?)').run(event.id, event.type);
  })();
}
