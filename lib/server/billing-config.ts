import { ApiError } from './auth';
import { PLAN_IDS, type BillingPlan, type PlanId } from '../billing';

export const MICRO_YEN = 1_000_000;
export function billingEnabled() {
  return process.env.BILLING_REQUIRED === 'true' || !!process.env.STRIPE_SECRET_KEY;
}
export function plans(): (BillingPlan & { priceId: string })[] {
  return PLAN_IDS.map((id, i) => {
    const prefix = `BILLING_${id.toUpperCase()}`;
    const raw = process.env[`${prefix}_API_LIMIT_JPY`];
    const limit = raw ? Number(raw) : null;
    const apiLimitYen =
      limit !== null && Number.isSafeInteger(limit) && limit > 0 && limit < [5000, 10000, 20000][i]
        ? limit
        : null;
    const priceId = process.env[`${prefix}_PRICE_ID`] || '';
    return {
      id,
      name: ['ベーシック', 'スタンダード', 'プラス'][i],
      monthlyYen: [5000, 10000, 20000][i],
      apiLimitYen,
      priceId,
      configured: /^price_[A-Za-z0-9]+$/.test(priceId) && apiLimitYen !== null,
    };
  });
}
export function billingReady() {
  const key = process.env.STRIPE_SECRET_KEY || '';
  return (
    /^sk_(test|live)_/.test(key) &&
    !!process.env.STRIPE_WEBHOOK_SECRET &&
    /^cus_[A-Za-z0-9]+$/.test(process.env.STRIPE_CUSTOMER_ID || '') &&
    !!process.env.STRIPE_PORTAL_CONFIGURATION_ID &&
    plans().every((p) => p.configured) &&
    (key.startsWith('sk_test_') || process.env.BILLING_LIVE_ENABLED === 'true')
  );
}
export function requireBillingReady() {
  if (!billingReady())
    throw new ApiError(
      503,
      'billing_setup_required',
      'お支払い設定の準備中です。運用担当者へご連絡ください。',
    );
}
export interface BillingAccount {
  customerId?: string;
  subscriptionId?: string;
  checkoutId?: string;
  checkoutUrl?: string;
  checkoutPlan?: PlanId;
  checkoutExpires?: number;
  generation?: number;
  checkoutAttempt?: string;
  checkoutAttemptAt?: number;
  status?: string;
  paidPlan?: PlanId;
  paidUntil?: string;
  paidInvoice?: string;
  paidLimitYen?: number;
}
export function entitlement(account: BillingAccount, time = Date.now()) {
  if (!billingEnabled()) return 100_000;
  if (
    !account.paidPlan ||
    !account.paidUntil ||
    Date.parse(account.paidUntil) <= time ||
    !['active', 'past_due'].includes(account.status || '')
  )
    return 0;
  const plan = plans().find((p) => p.id === account.paidPlan);
  // Configuration changes never silently increase an already-paid entitlement.
  return Math.min(plan?.apiLimitYen || 0, account.paidLimitYen || 0);
}
