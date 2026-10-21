import { z } from 'zod';
import { db, uid, lockResource, audit } from './db';
import { ApiError } from './auth';

const SAFE_WINDOW_HOURS = 23; // Resend retains keys 24h; leave a safety margin.
const MAX_ATTEMPTS = 12;
const email = z.string().email().max(254);
export function receiptConfig() {
  const from = process.env.RESEND_FROM || '';
  const to = process.env.INQUIRY_NOTIFICATION_TO || '';
  const domainId = process.env.RESEND_DOMAIN_ID || '';
  const key = process.env.RESEND_API_KEY || '';
  let origin = '';
  try {
    const url = new URL(process.env.APP_ORIGIN || '');
    if (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
    )
      if (!url.username && !url.password && url.pathname === '/' && !url.search && !url.hash)
        origin = url.origin;
  } catch {}
  const enabled = process.env.EMAIL_DELIVERY_MODE === 'live';
  const ready =
    enabled &&
    !!key &&
    !!origin &&
    email.safeParse(from).success &&
    email.safeParse(to).success &&
    z.string().uuid().safeParse(domainId).success;
  return { from, to, domainId, key, origin, enabled, ready };
}

// Caller must hold the receipt's transaction. FK + unique constraints are the final guard.
export async function queueReceiptNotification(kind: 'inquiry' | 'quote', recordId: string) {
  await lockResource(`receipt-notification:${kind}:${recordId}`);
  await db()
    .prepare(
      `INSERT INTO receipt_notifications(id,inquiry_id,quote_id)
    VALUES(?,?,?) ON CONFLICT DO NOTHING`,
    )
    .run(uid(), kind === 'inquiry' ? recordId : null, kind === 'quote' ? recordId : null);
}

async function verifyDomain(config: ReturnType<typeof receiptConfig>) {
  let status = 'unavailable';
  let name: string | null = null;
  try {
    const response = await fetch(`https://api.resend.com/domains/${config.domainId}`, {
      headers: { Authorization: `Bearer ${config.key}` },
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) {
      const domain = await response.json();
      name = typeof domain.name === 'string' ? domain.name.toLowerCase() : null;
      status =
        domain.id === config.domainId &&
        domain.status === 'verified' &&
        domain.capabilities?.sending === 'enabled' &&
        name === config.from.split('@')[1].toLowerCase()
          ? 'verified'
          : 'unverified';
    }
  } catch {}
  await db()
    .prepare(
      `INSERT INTO receipt_notification_transport(id,domain_id,domain_name,status)
    VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET domain_id=excluded.domain_id,
    domain_name=excluded.domain_name,status=excluded.status,checked_at=now()`,
    )
    .run(config.domainId, name, status);
  return status === 'verified';
}

const deliveryRanks: Record<string, number> = {
  'email.sent': 1,
  'email.delivery_delayed': 2,
  'email.delivered': 3,
  'email.failed': 4,
  'email.suppressed': 5,
  'email.bounced': 6,
  'email.complained': 7,
};
async function applyDelivery(emailId: string) {
  const events = await db()
    .prepare('SELECT kind,occurred_at FROM receipt_notification_events WHERE email_id=?')
    .all(emailId);
  const event = events.sort(
    (a, b) => (deliveryRanks[b.kind] || 0) - (deliveryRanks[a.kind] || 0),
  )[0];
  if (!event || !deliveryRanks[event.kind]) return;
  await db()
    .prepare(
      `UPDATE receipt_notifications SET delivery_status=?,delivery_rank=?,delivery_at=?
    WHERE email_id=? AND delivery_rank<?`,
    )
    .run(
      event.kind.slice(6),
      deliveryRanks[event.kind],
      event.occurred_at,
      emailId,
      deliveryRanks[event.kind],
    );
}

export async function recordReceiptWebhook(eventId: string, input: unknown) {
  const event = z
    .object({
      type: z.string().max(100),
      created_at: z.string().datetime({ offset: true }),
      data: z.object({ email_id: z.string().uuid() }),
    })
    .safeParse(input);
  if (!event.success || !deliveryRanks[event.data.type]) return { ignored: true };
  const { type, data, created_at } = event.data;
  await db().transaction(async () => {
    // Also serializes send-finalization against webhooks arriving before the API response.
    await lockResource(`receipt-email:${data.email_id}`);
    await db()
      .prepare(
        `INSERT INTO receipt_notification_events(id,email_id,kind,occurred_at)
      VALUES(?,?,?,?) ON CONFLICT DO NOTHING`,
      )
      .run(eventId, data.email_id, type, created_at);
    await applyDelivery(data.email_id);
  })();
  return { received: true };
}

async function claim(baseConfig: ReturnType<typeof receiptConfig>) {
  return db().transaction(async () => {
    const row = await db()
      .prepare(
        `SELECT * FROM receipt_notifications
      WHERE status IN ('pending','sending') AND (retry_at IS NULL OR retry_at<=now())
      AND (job_run_id IS NULL OR ?)
      ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,
      )
      .get(email.safeParse(process.env.JOB_ALERT_TO || '').success);
    if (!row) return null;
    const config = row.job_run_id ? { ...baseConfig, to: process.env.JOB_ALERT_TO! } : baseConfig;
    // Database time, not a worker's clock, defines the deduplication deadline.
    const expired = await db()
      .prepare(
        `SELECT 1 FROM receipt_notifications WHERE id=?
      AND first_attempt_at <= now() - interval '${SAFE_WINDOW_HOURS} hours'`,
      )
      .get(row.id);
    if (expired || row.attempts >= MAX_ATTEMPTS) {
      await db()
        .prepare(
          `UPDATE receipt_notifications SET status='review',last_error=?,retry_at=NULL WHERE id=?`,
        )
        .run(expired ? 'deduplication_window_expired' : 'attempt_limit', row.id);
      return { skipped: true } as const;
    }
    const tab = row.job_run_id ? 'jobs' : row.inquiry_id ? 'conversations' : 'quotes';
    const recordId = row.job_run_id || row.inquiry_id || row.quote_id;
    const payload = row.payload || {
      from: config.from,
      to: [config.to],
      subject: row.job_run_id
        ? 'アオキエンジ：定期処理の確認が必要です'
        : `アオキエンジ：${row.inquiry_id ? 'お問い合わせ' : '見積依頼'}の受付`,
      text: row.job_run_id
        ? `定期処理が失敗または中断しました。実行番号：${recordId}\n管理画面で確認してください（ログインが必要です）。\n${config.origin}/admin?tab=jobs`
        : `新しい受付があります。\n受付番号：${recordId}\n\n管理画面で内容をご確認ください（ログインが必要です）。\n${config.origin}/admin?tab=${tab}\n\nこの通知は社内向けです。正式見積の発行・お客様へのメール送信を示すものではありません。`,
    };
    // Preserve the exact payload throughout retries. Changes need human reconciliation.
    if (payload.from !== config.from || payload.to?.length !== 1 || payload.to[0] !== config.to) {
      await db()
        .prepare(
          `UPDATE receipt_notifications SET status='review',last_error='configuration_changed',retry_at=NULL WHERE id=?`,
        )
        .run(row.id);
      return { skipped: true } as const;
    }
    const lease = uid();
    await db()
      .prepare(
        `UPDATE receipt_notification_attempts SET outcome='unknown',finished_at=now()
      WHERE notification_id=? AND finished_at IS NULL`,
      )
      .run(row.id);
    await db()
      .prepare(
        `UPDATE receipt_notifications SET status='sending',attempts=attempts+1,
      first_attempt_at=COALESCE(first_attempt_at,now()),retry_at=now()+interval '2 minutes',
      lease_token=?,payload=?::text::jsonb,last_error=NULL WHERE id=?`,
      )
      .run(lease, JSON.stringify(payload), row.id);
    await db()
      .prepare('INSERT INTO receipt_notification_attempts(id,notification_id) VALUES(?,?)')
      .run(lease, row.id);
    return { ...row, payload, lease, skipped: false };
  })();
}

export async function deliverReceiptNotifications() {
  const config = receiptConfig();
  if (!config.ready)
    return { configured: false, sent: 0, reason: config.enabled ? 'setup_required' : 'disabled' };
  if (!(await verifyDomain(config)))
    return { configured: true, sent: 0, reason: 'domain_not_verified' };
  let sent = 0;
  // Keep each invocation bounded; the UTA-11 scheduler calls this endpoint again.
  for (let n = 0; n < 3; n++) {
    const row = await claim(config);
    if (!row) break;
    if (row.skipped) continue;
    let httpStatus: number | null = null;
    let emailId: string | null = null;
    let permanent = false;
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: `Bearer ${config.key}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': `aoki-receipt-${row.id}`,
        },
        // JSONB reorders object keys. Serialize fields in a fixed order so even
        // the request bytes stay identical between first send and DB reload.
        body: JSON.stringify({
          from: row.payload.from,
          to: row.payload.to,
          subject: row.payload.subject,
          text: row.payload.text,
        }),
      });
      httpStatus = response.status;
      if (response.ok) {
        const result = await response.json();
        if (z.string().uuid().safeParse(result.id).success) emailId = result.id;
      } else if (response.status === 409) {
        const result = await response.json();
        permanent = result.name === 'invalid_idempotent_request';
      } else
        permanent =
          response.status >= 400 &&
          response.status < 500 &&
          ![408, 425, 429].includes(response.status);
    } catch {} // Timeout/lost response may still mean accepted: keep the same key.
    await db().transaction(async () => {
      if (emailId) await lockResource(`receipt-email:${emailId}`);
      const current = await db()
        .prepare('SELECT * FROM receipt_notifications WHERE id=? FOR UPDATE')
        .get(row.id);
      await db()
        .prepare(
          `UPDATE receipt_notification_attempts SET finished_at=now(),outcome=?,http_status=? WHERE id=?`,
        )
        .run(emailId ? 'accepted' : permanent ? 'rejected' : 'unknown', httpStatus, row.lease);
      // A newer worker may own the lease. Its result must not be overwritten by an old failure.
      if (current.lease_token !== row.lease || current.status !== 'sending') return;
      if (emailId) {
        await db()
          .prepare(
            `UPDATE receipt_notifications SET status='sent',email_id=?,sent_at=now(),
          retry_at=NULL,last_error=NULL,lease_token=NULL WHERE id=?`,
          )
          .run(emailId, row.id);
        await applyDelivery(emailId);
        sent++;
      } else {
        const retrySeconds = Math.min(3600, 60 * 2 ** Math.min(current.attempts - 1, 6));
        await db()
          .prepare(
            `UPDATE receipt_notifications SET status=?,last_error=?,lease_token=NULL,
          retry_at=CASE WHEN ? THEN NULL ELSE now() + (? * interval '1 second') END WHERE id=?`,
          )
          .run(
            permanent ? 'review' : 'pending',
            permanent ? 'provider_rejected' : 'send_unconfirmed',
            permanent,
            retrySeconds,
            row.id,
          );
      }
    })();
    // Avoid hammering a throttled/unavailable provider in this batch.
    if (!emailId) break;
  }
  return { configured: true, sent };
}

export async function retryReceiptNotification(id: string, actor: string) {
  await db().transaction(async () => {
    const row = await db()
      .prepare('SELECT * FROM receipt_notifications WHERE id=? FOR UPDATE')
      .get(id);
    if (!row) throw new ApiError(404, 'not_found', '通知が見つかりません。');
    if (row.status !== 'pending')
      throw new ApiError(
        409,
        'review_required',
        '送信済み・処理中・要確認の通知は再送できません。',
      );
    await db().prepare('UPDATE receipt_notifications SET retry_at=now() WHERE id=?').run(id);
    await audit('notification.retry_requested', id, `管理者 ${actor} が再試行を予約しました`);
  })();
}

export async function receiptNotificationReport() {
  const config = receiptConfig();
  const transport = await db()
    .prepare(
      'SELECT domain_id,domain_name,status,checked_at FROM receipt_notification_transport WHERE id=1 AND domain_id=?',
    )
    .get(config.domainId);
  const items = await db()
    .prepare(
      `SELECT id,inquiry_id,quote_id,job_run_id,created_at,status,attempts,first_attempt_at,
    retry_at,email_id,sent_at,last_error,delivery_status,delivery_at,
    payload->>'from' AS sender,payload->'to' AS recipients
    FROM receipt_notifications ORDER BY created_at DESC,id LIMIT 100`,
    )
    .all();
  const attempts = await db()
    .prepare(
      `SELECT a.* FROM receipt_notification_attempts a
    JOIN (SELECT id FROM receipt_notifications ORDER BY created_at DESC,id LIMIT 100) n ON n.id=a.notification_id
    ORDER BY a.started_at DESC LIMIT 1200`,
    )
    .all();
  return {
    config: {
      enabled: config.enabled,
      ready: config.ready,
      from: config.from,
      to: config.to,
      domainId: config.domainId,
      webhookConfigured: !!process.env.RESEND_WEBHOOK_SECRET,
      domain: transport || null,
    },
    items,
    attempts,
  };
}

export type ReceiptNotificationReport = Awaited<ReturnType<typeof receiptNotificationReport>>;
