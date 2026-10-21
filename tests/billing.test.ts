import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '../lib/server/db';
import { budgetState, updateBudget } from '../lib/server/ai-budget';
import { billingReport } from '../lib/server/billing-report';
import { checkout, portal, processStripeEvent, stripeClient } from '../lib/server/stripe-billing';
import { billingRequest, stripeWebhook, budgetCron } from '../lib/server/billing-http';
import { setSession } from '../lib/server/auth';

const remote = vi.hoisted(() => ({
  price: vi.fn(),
  customer: vi.fn(),
  list: vi.fn(),
  subscription: vi.fn(),
  createCheckout: vi.fn(),
  getCheckout: vi.fn(),
  config: vi.fn(),
  createPortal: vi.fn(),
}));
vi.mock('stripe', async (original) => {
  const Real = (await original<{ default: typeof Stripe }>()).default;
  const actual = new Real('sk_test_signature_only');
  return {
    default: class {
      webhooks = actual.webhooks;
      prices = { retrieve: remote.price };
      customers = { retrieve: remote.customer };
      subscriptions = { list: remote.list, retrieve: remote.subscription };
      checkout = { sessions: { create: remote.createCheckout, retrieve: remote.getCheckout } };
      billingPortal = {
        configurations: { retrieve: remote.config },
        sessions: { create: remote.createPortal },
      };
    },
  };
});
const customer = 'cus_test';
const priceIds = ['price_basic', 'price_standard', 'price_plus'];
const deadline = () => Math.floor(Date.now() / 1000) + 20 * 86400;
function subscription(plan = 0, paid = true) {
  const end = deadline();
  return {
    id: 'sub_test',
    customer,
    status: 'active',
    pending_update: null,
    pause_collection: null,
    items: {
      data: [
        {
          id: 'si_one',
          quantity: 1,
          current_period_end: end,
          price: {
            id: priceIds[plan],
            currency: 'jpy',
            unit_amount: [5000, 10000, 20000][plan],
            tax_behavior: 'inclusive',
            recurring: { interval: 'month', interval_count: 1 },
          },
        },
      ],
    },
    latest_invoice: {
      id: `in_${plan}`,
      status: paid ? 'paid' : 'open',
      amount_paid: paid ? [5000, 10000, 20000][plan] : 0,
      currency: 'jpy',
      customer,
      parent: { subscription_details: { subscription: 'sub_test' } },
      lines: {
        has_more: false,
        data: [
          {
            pricing: { price_details: { price: priceIds[plan] } },
            amount: [5000, 10000, 20000][plan],
            period: { end },
          },
        ],
      },
    },
  };
}
function event(id = 'evt_one', type = 'invoice.paid', cust = customer): Stripe.Event {
  return {
    id,
    type,
    livemode: false,
    data: { object: { id: 'in_test', customer: cust } },
  } as unknown as Stripe.Event;
}
beforeEach(async () => {
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_fixture');
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_fixture');
  vi.stubEnv('STRIPE_CUSTOMER_ID', customer);
  vi.stubEnv('STRIPE_PORTAL_CONFIGURATION_ID', 'bpc_test');
  vi.stubEnv('APP_ORIGIN', 'http://localhost:3000');
  vi.stubEnv('SESSION_SECRET', 'billing-tests-secret-more-than-thirty-two-characters');
  ['BASIC', 'STANDARD', 'PLUS'].forEach((name, i) => {
    vi.stubEnv(`BILLING_${name}_PRICE_ID`, priceIds[i]);
    vi.stubEnv(`BILLING_${name}_API_LIMIT_JPY`, String([3000, 6000, 12000][i]));
  });
  Object.values(remote).forEach((mock) => mock.mockReset());
  remote.price.mockImplementation(async (id: string) => ({
    id,
    active: true,
    currency: 'jpy',
    unit_amount: [5000, 10000, 20000][priceIds.indexOf(id)],
    recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
    tax_behavior: 'inclusive',
    billing_scheme: 'per_unit',
    livemode: false,
  }));
  remote.customer.mockResolvedValue({ id: customer, livemode: false });
  remote.list.mockResolvedValue({ data: [], has_more: false });
  remote.createCheckout.mockResolvedValue({
    id: 'cs_one',
    url: 'https://checkout.stripe.com/test',
    expires_at: Math.floor(Date.now() / 1000) + 2100,
  });
  remote.config.mockResolvedValue({
    id: 'bpc_test',
    active: true,
    features: {
      subscription_update: {
        enabled: true,
        default_allowed_updates: ['price'],
        billing_cycle_anchor: 'unchanged',
        proration_behavior: 'always_invoice',
        products: [{ prices: priceIds }],
        schedule_at_period_end: { conditions: [{ type: 'decreasing_item_amount' }] },
      },
      subscription_cancel: { mode: 'at_period_end' },
    },
  });
  remote.createPortal.mockResolvedValue({ url: 'https://billing.stripe.com/test' });
  await budgetState();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
function useSubscription(value = subscription()) {
  remote.list.mockResolvedValue({
    data: [{ id: value.id, status: value.status }],
    has_more: false,
  });
  remote.subscription.mockResolvedValue(value);
}
it('creates one card-only checkout for concurrent clicks and never grants budget on redirect', async () => {
  const replies = await Promise.all(Array.from({ length: 6 }, () => checkout('basic', 'admin')));
  expect(remote.createCheckout).toHaveBeenCalledTimes(1);
  expect(replies.every((r) => r.url === 'https://checkout.stripe.com/test')).toBe(true);
  expect(remote.createCheckout.mock.calls[0][0]).toMatchObject({
    allowed_payment_method_types: ['card'],
    customer,
    mode: 'subscription',
    line_items: [{ price: 'price_basic', quantity: 1 }],
  });
  expect((await billingReport()).limitYen).toBe(0);
  await expect(checkout('plus', 'admin')).rejects.toMatchObject({ status: 409 });
});
it('reuses the persisted idempotency key after a timeout', async () => {
  remote.createCheckout.mockRejectedValueOnce(new Error('timeout'));
  await expect(checkout('basic', 'admin')).rejects.toThrow('timeout');
  await checkout('basic', 'admin');
  expect(remote.createCheckout.mock.calls[0][1].idempotencyKey).toBe(
    remote.createCheckout.mock.calls[1][1].idempotencyKey,
  );
  expect(remote.createCheckout.mock.calls[0][0]).toEqual(remote.createCheckout.mock.calls[1][0]);
});
it('refuses to recreate an unknown checkout after the Stripe idempotency window', async () => {
  await db()
    .prepare('UPDATE billing_account SET json=?::text::jsonb WHERE id=1')
    .run(
      JSON.stringify({
        customerId: customer,
        checkoutPlan: 'basic',
        checkoutAttempt: 'old',
        checkoutAttemptAt: Date.now() - 24 * 3600_000,
      }),
    );
  await expect(checkout('basic', 'admin')).rejects.toMatchObject({ code: 'checkout_review' });
  expect(remote.createCheckout).not.toHaveBeenCalled();
});
it('rejects altered prices, existing subscriptions, and unsafe portal settings', async () => {
  remote.price.mockResolvedValueOnce({ active: true, unit_amount: 1 });
  await expect(checkout('basic', 'admin')).rejects.toMatchObject({ code: 'billing_price_invalid' });
  useSubscription();
  await expect(checkout('basic', 'admin')).rejects.toMatchObject({ code: 'subscription_exists' });
  await processStripeEvent(event());
  remote.config.mockResolvedValueOnce({
    active: true,
    features: {
      subscription_update: { enabled: true, proration_behavior: 'none' },
    },
  });
  await expect(portal('admin')).rejects.toMatchObject({ code: 'portal_configuration' });
  expect(remote.createPortal).not.toHaveBeenCalled();
});
it('requests the expanded product list before opening the configured portal', async () => {
  useSubscription();
  await processStripeEvent(event());
  await expect(portal('admin')).resolves.toEqual({ url: 'https://billing.stripe.com/test' });
  expect(remote.config).toHaveBeenCalledWith('bpc_test', {
    expand: ['features.subscription_update.products'],
  });
});
it('grants a paid plan once and retains month usage when upgrading', async () => {
  useSubscription();
  await Promise.all(Array.from({ length: 8 }, () => processStripeEvent(event())));
  expect((await billingReport()).limitYen).toBe(3000);
  expect(await db().prepare('SELECT id FROM billing_events').all()).toHaveLength(1);
  await db().prepare('UPDATE ai_budgets SET spent_microyen=1000000000').run();
  useSubscription(subscription(1));
  await processStripeEvent(event('evt_upgrade'));
  expect(await billingReport()).toMatchObject({ limitYen: 6000, spentYen: 1000 });
  await expect(updateBudget(6001, false, 2, 'company')).rejects.toMatchObject({ status: 403 });
});
it('does not grant an unpaid upgrade and ignores out-of-order old events', async () => {
  useSubscription();
  await processStripeEvent(event());
  useSubscription(subscription(2, false));
  await processStripeEvent(event('evt_failed', 'invoice.payment_failed'));
  expect((await billingReport()).limitYen).toBe(3000);
  useSubscription(subscription(2, true));
  await processStripeEvent(event('evt_paid'));
  await processStripeEvent(event('evt_old_failed', 'invoice.payment_failed'));
  expect((await billingReport()).limitYen).toBe(12000);
});

it('does not increase an already-paid entitlement just because operator configuration changed', async () => {
  useSubscription();
  await processStripeEvent(event());
  vi.stubEnv('BILLING_BASIC_API_LIMIT_JPY', '4000');
  await processStripeEvent(event('evt_same_invoice'));
  expect(await billingReport()).toMatchObject({ limitYen: 3000, editableMaxYen: 3000 });
});
it('revokes cancellation even when a late paid event arrives', async () => {
  useSubscription();
  await processStripeEvent(event());
  const canceled = { ...subscription(), status: 'canceled' };
  useSubscription(canceled);
  await processStripeEvent(event('evt_deleted', 'customer.subscription.deleted'));
  await processStripeEvent(event('evt_old'));
  expect((await billingReport()).limitYen).toBe(0);
  expect((await billingReport()).billing.hasSubscription).toBe(false);
  await expect(checkout('basic', 'admin')).resolves.toMatchObject({
    url: 'https://checkout.stripe.com/test',
  });
});

it('preserves spent amounts when a paid downgrade becomes effective', async () => {
  useSubscription(subscription(2));
  await processStripeEvent(event());
  await db().prepare('UPDATE ai_budgets SET spent_microyen=8000000000').run();
  useSubscription(subscription(0));
  await processStripeEvent(event('evt_downgrade'));
  expect(await billingReport()).toMatchObject({
    limitYen: 3000,
    spentYen: 8000,
    remainingYen: 0,
    stopped: true,
  });
});
it('rejects another customer, quantity changes, unknown plans and invoice mismatches', async () => {
  useSubscription();
  await processStripeEvent(event('evt_foreign', 'invoice.paid', 'cus_other'));
  expect(remote.subscription).not.toHaveBeenCalled();
  for (const change of [
    (s: ReturnType<typeof subscription>) => {
      s.items.data[0].quantity = 2;
    },
    (s: ReturnType<typeof subscription>) => {
      s.items.data[0].price.id = 'price_unknown';
    },
    (s: ReturnType<typeof subscription>) => {
      s.latest_invoice.parent.subscription_details.subscription = 'sub_other';
    },
    (s: ReturnType<typeof subscription>) => {
      s.latest_invoice.lines.data[0].pricing.price_details.price = 'price_other';
    },
  ]) {
    const s = subscription();
    change(s);
    useSubscription(s);
    await processStripeEvent(event(`evt_invalid_${Math.random()}`));
    expect((await billingReport()).limitYen).toBe(0);
  }
});
it('accepts authentic raw-body signatures and rejects forged or modified webhooks', async () => {
  useSubscription();
  const raw = JSON.stringify(event());
  const signature = stripeClient().webhooks.generateTestHeaderString({
    payload: raw,
    secret: 'whsec_fixture',
  });
  const request = (body: string, header: string) =>
    new NextRequest('http://localhost:3000/api/billing/webhook', {
      method: 'POST',
      body,
      headers: { 'stripe-signature': header },
    });
  expect((await stripeWebhook(request(raw, 'bad'))).status).toBe(400);
  expect((await stripeWebhook(request(raw + ' ', signature))).status).toBe(400);
  const oldSignature = stripeClient().webhooks.generateTestHeaderString({
    payload: raw,
    secret: 'whsec_fixture',
    timestamp: Math.floor(Date.now() / 1000) - 600,
  });
  expect((await stripeWebhook(request(raw, oldSignature))).status).toBe(400);
  expect((await stripeWebhook(request(raw, signature))).status).toBe(200);
  expect((await billingReport()).limitYen).toBe(3000);
});
it('requires admin auth and same-origin writes; cron has independent authentication', async () => {
  const url = 'http://localhost:3000/api/admin/billing';
  expect((await billingRequest(new NextRequest(url))).status).toBe(401);
  const session = NextResponse.json({});
  await setSession(session, 'admin');
  const request = (origin?: string) => {
    const req = new NextRequest(url, {
      method: 'PATCH',
      headers: origin ? { Origin: origin } : {},
      body: JSON.stringify({ limitYen: 0, paused: true, revision: 0 }),
    });
    req.cookies.set('aoki_admin', session.cookies.get('aoki_admin')!.value);
    return req;
  };
  expect((await billingRequest(request('https://evil.example'))).status).toBe(403);
  expect((await billingRequest(request('http://localhost:3000'))).status).toBe(200);
  expect((await budgetCron(new NextRequest(url))).status).toBe(401);
});
