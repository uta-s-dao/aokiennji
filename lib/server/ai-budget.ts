import { db, lockResource } from './db';
import { ApiError } from './auth';

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
