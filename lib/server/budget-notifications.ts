import { db, lockResource } from './db';
import { ensureCurrentBudget, queueBudgetAlerts } from './ai-budget';

// Called by the authenticated scheduler. No customer messages or credentials enter the outbox.
export async function deliverBudgetNotifications() {
  await db().transaction(async () => {
    await lockResource('ai-budget-policy');
    const { period, policy } = await ensureCurrentBudget();
    await queueBudgetAlerts(period.month, policy.revision);
  })();
  const key = process.env.RESEND_API_KEY;
  const to = process.env.BUDGET_ALERT_TO;
  const from = process.env.BUDGET_ALERT_FROM;
  if (!key || !to || !from) return { configured: false, sent: 0 };
  let sent = 0;
  for (let i = 0; i < 10; i++) {
    const row = await db().transaction(async () => {
      const candidate = await db()
        .prepare(
          `SELECT * FROM budget_notifications WHERE status IN ('pending','sending')
         AND (retry_at IS NULL OR retry_at<=now())
         ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
        )
        .get();
      if (!candidate) return null;
      // Resend idempotency expires after 24h. Never blindly resend an uncertain charge/message.
      if (
        candidate.first_attempt_at &&
        Date.now() - Date.parse(candidate.first_attempt_at) > 23 * 3600_000
      ) {
        await db()
          .prepare("UPDATE budget_notifications SET status='review' WHERE id=?")
          .run(candidate.id);
        return { review: true };
      }
      await db()
        .prepare(
          `UPDATE budget_notifications SET status='sending',attempts=attempts+1,
         first_attempt_at=COALESCE(first_attempt_at,now()),retry_at=now()+interval '5 minutes' WHERE id=?`,
        )
        .run(candidate.id);
      return candidate;
    })();
    if (!row) break;
    if (row.review) continue;
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': `aoki-budget-${row.id}`,
        },
        body: JSON.stringify({
          from,
          to: [to],
          subject: 'アオキエンジ：API利用枠・プランの確認',
          text: `${row.message}\n\n${process.env.APP_ORIGIN || ''}/admin?tab=billing\n\n金額は安全余裕を含むアプリ内概算です。プラン変更は会社側の承認と支払い確認後に反映されます。`,
        }),
      });
      if (!res.ok) throw new Error('Notification not confirmed');
      const result = await res.json();
      if (typeof result.id !== 'string') throw new Error('Notification not confirmed');
      await db()
        .prepare(
          "UPDATE budget_notifications SET status='sent',sent_at=now(),retry_at=NULL WHERE id=?",
        )
        .run(row.id);
      sent++;
    } catch {
      await db().prepare("UPDATE budget_notifications SET status='pending' WHERE id=?").run(row.id);
    }
  }
  return { configured: true, sent };
}
