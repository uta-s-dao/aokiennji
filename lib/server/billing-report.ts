import { db, lockResource } from './db';
import { ensureCurrentBudget, queueBudgetAlerts } from './ai-budget';
import { billingEnabled, billingReady, entitlement, MICRO_YEN, plans } from './billing-config';
import { pricingPolicy } from './ai-pricing';
import type { BillingReport } from '../billing';

export async function billingReport(): Promise<BillingReport> {
  return db().transaction(async () => {
    await lockResource('ai-budget-policy');
    const { row, policy, account, period, limit } = await ensureCurrentBudget();
    await queueBudgetAlerts(period.month, policy.revision);
    const spentYen = Number(row.spent_microyen) / MICRO_YEN;
    const reservedYen = Number(row.reserved_microyen) / MICRO_YEN;
    const limitYen = limit / MICRO_YEN;
    const elapsed = Date.now() - Date.parse(period.start);
    const expired = billingEnabled() && entitlement(account) <= 0;
    const stopReason = policy.paused
      ? '管理者が一時停止中'
      : expired
        ? 'お支払いの確認待ち・契約期間外'
        : spentYen + reservedYen >= limitYen
          ? 'API利用枠に到達'
          : null;
    const reservations = await db()
      .prepare(
        'SELECT * FROM ai_reservations WHERE period=? ORDER BY created_at DESC,id DESC LIMIT 100',
      )
      .all(period.month);
    return {
      period: period.month,
      periodStart: period.start,
      periodEnd: period.end,
      revision: policy.revision,
      limitYen,
      spentYen,
      reservedYen,
      remainingYen: Math.max(0, limitYen - spentYen - reservedYen),
      forecastYen:
        elapsed >= 86400_000
          ? Math.ceil(
              (spentYen / elapsed) * (Date.parse(period.end) - Date.parse(period.start)) +
                reservedYen,
            )
          : null,
      paused: policy.paused,
      stopped: !!stopReason,
      stopReason,
      editableMaxYen: entitlement(account),
      billing: {
        enabled: billingEnabled(),
        ready: billingReady(),
        testMode: !process.env.STRIPE_SECRET_KEY?.startsWith('sk_live_'),
        status: account.status || '未契約',
        paidPlan: account.paidPlan || null,
        paidUntil: account.paidUntil || null,
        hasSubscription:
          !!account.subscriptionId &&
          !['canceled', 'incomplete_expired'].includes(account.status || ''),
      },
      plans: plans().map(({ priceId: _priceId, ...plan }) => plan),
      pricing: pricingPolicy(),
      notificationsConfigured: !!(
        process.env.RESEND_API_KEY &&
        process.env.BUDGET_ALERT_FROM &&
        process.env.BUDGET_ALERT_TO &&
        (process.env.BUDGET_CRON_SECRET || '').length >= 32
      ),
      notifications: await db()
        .prepare(
          'SELECT id,kind,message,status,created_at FROM budget_notifications ORDER BY created_at DESC LIMIT 30',
        )
        .all(),
      history: await db()
        .prepare('SELECT * FROM billing_history ORDER BY created_at DESC,id DESC LIMIT 50')
        .all(),
      reservations: reservations.map((r) => ({
        id: r.id,
        provider: r.detail.quote?.provider || 'legacy',
        model: r.detail.quote?.model || '',
        createdAt: r.created_at,
        reservedYen: Number(r.reserved_microyen) / MICRO_YEN,
        settledYen: r.settled_microyen === null ? null : Number(r.settled_microyen) / MICRO_YEN,
        holdReason: r.hold_reason,
        detail: r.detail,
      })),
    };
  })();
}
