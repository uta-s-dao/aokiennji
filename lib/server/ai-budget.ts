import { db, lockResource } from './db';
import { ApiError } from './auth';
import { billingEnabled, entitlement, MICRO_YEN, type BillingAccount } from './billing-config';
import { actualCost, quoteCall, type CostUsage, type PriceQuote } from './ai-pricing';

export function budgetPeriod(time = new Date()) {
  const month = new Date(time.getTime() + 9 * 3600_000).toISOString().slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  return {
    month,
    start: new Date(Date.UTC(y, m - 1, 1) - 9 * 3600_000).toISOString(),
    end: new Date(Date.UTC(y, m, 1) - 9 * 3600_000).toISOString(),
  };
}
export async function budgetState() {
  await db().prepare('INSERT INTO ai_budget_policy(id) VALUES(1) ON CONFLICT DO NOTHING').run();
  await db().prepare('INSERT INTO billing_account(id) VALUES(1) ON CONFLICT DO NOTHING').run();
  const policy = await db().prepare('SELECT * FROM ai_budget_policy WHERE id=1').get();
  const account: BillingAccount = (
    await db().prepare('SELECT json FROM billing_account WHERE id=1').get()
  ).json;
  return { policy, account };
}
export async function billingHistory(kind: string, actor: string, detail: Record<string, unknown>) {
  const { uid } = await import('./db');
  await db()
    .prepare('INSERT INTO billing_history(id,kind,actor,detail) VALUES(?,?,?,?::text::jsonb)')
    .run(uid(), kind, actor, JSON.stringify(detail));
}
export async function ensureCurrentBudget() {
  const { policy, account } = await budgetState();
  const period = budgetPeriod();
  const limit = Math.min(Number(policy.limit_microyen), entitlement(account) * MICRO_YEN);
  await db()
    .prepare('INSERT INTO ai_budgets(period,limit_microyen) VALUES(?,?) ON CONFLICT DO NOTHING')
    .run(period.month, limit);
  // Expiration/downgrade is enforced even when no webhook or admin visit arrives.
  await db()
    .prepare('UPDATE ai_budgets SET limit_microyen=? WHERE period=?')
    .run(limit, period.month);
  const row = await db().prepare('SELECT * FROM ai_budgets WHERE period=?').get(period.month);
  return { policy, account, period, row, limit };
}
export async function queueBudgetAlerts(period: string, revision: number) {
  const row = await db().prepare('SELECT * FROM ai_budgets WHERE period=?').get(period);
  if (!row || Number(row.limit_microyen) <= 0) return;
  const used = Number(row.spent_microyen) + Number(row.reserved_microyen);
  const limit = Number(row.limit_microyen);
  const current = budgetPeriod();
  const elapsed = Date.now() - Date.parse(current.start);
  const forecast =
    period === current.month && elapsed >= 86400_000
      ? (Number(row.spent_microyen) / elapsed) *
          (Date.parse(current.end) - Date.parse(current.start)) +
        Number(row.reserved_microyen)
      : 0;
  for (const [kind, condition, text] of [
    ['80', used >= limit * 0.8, 'API利用枠の80％に達しました。'],
    ['90', used >= limit * 0.9, 'API利用枠の90％に達しました。'],
    ['100', used >= limit, 'API利用枠に達したため、新しい有料処理を停止します。'],
    ['forecast', forecast > limit, '現在の利用ペースでは、月末までにAPI利用枠へ達する見込みです。'],
  ] as const) {
    if (condition)
      await db()
        .prepare(
          'INSERT INTO budget_notifications(id,period,kind,message) VALUES(?,?,?,?) ON CONFLICT DO NOTHING',
        )
        .run(
          `${period}:${revision}:${kind}`,
          period,
          kind,
          `${text} ${period}：使用・予約 ${Math.ceil(used / MICRO_YEN)}円 / 上限 ${limit / MICRO_YEN}円。管理画面でプラン変更をご検討ください。`,
        );
  }
}

export async function startPaidCall(id: string, provider: string, model: string, body: string) {
  const quote = quoteCall(provider, model, body);
  const error = await db().transaction(async () => {
    await lockResource('ai-budget-policy');
    if (await db().prepare('SELECT id FROM ai_reservations WHERE id=?').get(id))
      throw new ApiError(409, 'reservation_reused', '実行済みの利用枠は再利用できません。');
    const state = await ensureCurrentBudget();
    if (state.policy.paused) return '有料APIを一時停止しています。担当者へご相談ください。';
    if (billingEnabled() && entitlement(state.account) <= 0)
      return 'お支払いの確認が必要です。担当者へご相談ください。';
    if (
      Number(state.row.spent_microyen) + Number(state.row.reserved_microyen) + quote.reserved >
      state.limit
    ) {
      await queueBudgetAlerts(state.period.month, state.policy.revision);
      await db()
        .prepare(
          'INSERT INTO budget_notifications(id,period,kind,message) VALUES(?,?,?,?) ON CONFLICT DO NOTHING',
        )
        .run(
          `${state.period.month}:${state.policy.revision}:insufficient`,
          state.period.month,
          'insufficient',
          '次の有料API処理に必要な利用枠が不足しています。管理画面でプラン変更をご検討ください。',
        );
      return 'AI利用枠が不足しています。登録情報の案内・担当者への相談をご利用ください。';
    }
    // Each actual network attempt gets a fresh random id; a settled id is never reused.
    await reserveAiCost(id, state.period.month, quote.reserved, state.limit);
    await db()
      .prepare('UPDATE ai_reservations SET detail=?::text::jsonb WHERE id=?')
      .run(JSON.stringify({ quote }), id);
    await queueBudgetAlerts(state.period.month, state.policy.revision);
    return null;
  })();
  if (error) throw new ApiError(429, 'budget_exceeded', error);
  return quote;
}
export async function finishPaidCall(
  id: string,
  quote: PriceQuote,
  usage: CostUsage | null,
  tools: number | null,
  httpSuccess: boolean,
  uncertain = false,
) {
  const actual = uncertain ? null : actualCost(quote, usage, tools, httpSuccess);
  await db().transaction(async () => {
    await lockResource('ai-budget-policy');
    const old = await db().prepare('SELECT * FROM ai_reservations WHERE id=? FOR UPDATE').get(id);
    if (!old || old.settled_microyen !== null) return;
    await db()
      .prepare(
        'UPDATE ai_reservations SET detail=detail || ?::text::jsonb,hold_reason=? WHERE id=?',
      )
      .run(
        JSON.stringify({ usage, toolCalls: tools, httpSuccess }),
        actual === null ? '使用量・処理完了・単価の精算根拠を確認できないため予約を維持' : null,
        id,
      );
    if (
      !quote.fixedUsd &&
      ((usage &&
        (usage.inputTokens > quote.inputBound || usage.outputTokens > quote.outputBound)) ||
        (tools !== null && tools > quote.toolBound))
    ) {
      await db().prepare('UPDATE ai_budget_policy SET paused=true,revision=revision+1').run();
      await billingHistory('pricing.bound_exceeded', 'system', { reservationId: id });
    }
    if (actual !== null) await settleAiCost(id, actual);
    const { policy } = await budgetState();
    await queueBudgetAlerts(old.period, policy.revision);
  })();
}
export async function updateBudget(
  limitYen: number,
  paused: boolean,
  revision: number,
  actor: string,
) {
  if (!Number.isSafeInteger(limitYen) || limitYen < 0 || limitYen > 100_000)
    throw new ApiError(400, 'invalid_budget', '上限額を確認してください。');
  return db().transaction(async () => {
    await lockResource('ai-budget-policy');
    const { policy, account } = await budgetState();
    if (revision !== policy.revision)
      throw new ApiError(
        409,
        'budget_conflict',
        '設定が変更されています。再読み込みしてください。',
      );
    if (limitYen > entitlement(account))
      throw new ApiError(403, 'plan_limit', '支払済みプランの利用枠を超える設定はできません。');
    await db()
      .prepare(
        'UPDATE ai_budget_policy SET limit_microyen=?,paused=?,revision=revision+1 WHERE id=1',
      )
      .run(limitYen * MICRO_YEN, paused);
    await billingHistory('budget.updated', actor, {
      before: { limitYen: Number(policy.limit_microyen) / MICRO_YEN, paused: policy.paused },
      after: { limitYen, paused },
    });
    const state = await ensureCurrentBudget();
    await queueBudgetAlerts(state.period.month, state.policy.revision);
  })();
}

// Money is an integer number of micro-yen. UTA-9 supplies provider prices and
// the admin policy; this module supplies shared, atomic reservation/settlement.
function money(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid micro-yen amount');
}
export async function reserveAiCost(id: string, period: string, estimated: number, limit: number) {
  money(estimated);
  money(limit);
  if (!/^\d{4}-\d{2}$/.test(period)) throw new Error('Invalid billing period');
  return await db().transaction(async () => {
    await lockResource(`ai-reservation:${id}`);
    const previous = await db().prepare('SELECT * FROM ai_reservations WHERE id=?').get(id);
    if (previous) {
      if (previous.period !== period || Number(previous.reserved_microyen) !== estimated)
        throw new ApiError(409, 'reservation_conflict', '利用枠の予約内容が一致しません。');
      return;
    }
    await db()
      .prepare('INSERT INTO ai_budgets(period,limit_microyen) VALUES(?,?) ON CONFLICT DO NOTHING')
      .run(period, limit);
    const row = await db()
      .prepare(
        `UPDATE ai_budgets SET reserved_microyen=reserved_microyen+?
      WHERE period=? AND spent_microyen+reserved_microyen+?<=limit_microyen RETURNING period`,
      )
      .get(estimated, period, estimated);
    if (!row)
      throw new ApiError(429, 'budget_exceeded', 'AI利用枠に達しました。担当者へご相談ください。');
    await db()
      .prepare('INSERT INTO ai_reservations(id,period,reserved_microyen) VALUES(?,?,?)')
      .run(id, period, estimated);
  })();
}
export async function settleAiCost(id: string, actual: number) {
  money(actual);
  return await db().transaction(async () => {
    const row = await db().prepare('SELECT * FROM ai_reservations WHERE id=? FOR UPDATE').get(id);
    if (!row) throw new Error('Unknown AI cost reservation');
    if (row.settled_microyen !== null) {
      if (Number(row.settled_microyen) !== actual)
        throw new ApiError(409, 'settlement_conflict', '精算済みの利用額が一致しません。');
      return;
    }
    await db()
      .prepare(
        'UPDATE ai_budgets SET reserved_microyen=reserved_microyen-?,spent_microyen=spent_microyen+? WHERE period=?',
      )
      .run(row.reserved_microyen, actual, row.period);
    await db().prepare('UPDATE ai_reservations SET settled_microyen=? WHERE id=?').run(actual, id);
  })();
}
