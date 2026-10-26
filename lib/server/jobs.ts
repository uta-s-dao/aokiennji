import type { Source } from '../contracts';
import { db, list, uid } from './db';
import { syncSource } from './ingestion';
import { enrichDueProductMetadata } from './product-metadata';
import { refreshIndexedSupplierCatalog } from './supplier-catalog';
import { deliverReceiptNotifications } from './receipt-notifications';

export const WEB_JOBS = ['sync', 'notifications', 'cleanup'] as const;
export type WebJob = (typeof WEB_JOBS)[number];
export type Job = WebJob | 'backup' | 'restore';
export type JobOutcome = {
  status: 'success' | 'failed' | 'deferred';
  detail: Record<string, unknown>;
};

async function failureNotification(id: string) {
  // One alert per continuous incident; a successful run starts a new incident window.
  const existing = await db()
    .prepare(
      `SELECT 1 FROM receipt_notifications n
    JOIN job_runs previous ON previous.id=n.job_run_id JOIN job_runs current ON current.id=?
    WHERE previous.job=current.job AND previous.started_at<=current.started_at
    AND previous.started_at>COALESCE((SELECT max(started_at) FROM job_runs
      WHERE job=current.job AND status='success'),'-infinity'::timestamptz) LIMIT 1`,
    )
    .get(id);
  if (existing) return;
  await db()
    .prepare(
      `INSERT INTO receipt_notifications(id,job_run_id) VALUES(?,?)
    ON CONFLICT(job_run_id) DO NOTHING`,
    )
    .run(uid(), id);
}
// The lock is held by PostgreSQL, shared by every instance and every job entry point.
// It is released on transaction end or connection loss; no expiring lease permits overlap.
export async function runJob(job: Job, slot: string, work: () => Promise<JobOutcome>) {
  const locked = await db().exclusiveJob(async () => {
    await db().transaction(async () => {
      // Acquiring the guard proves that no prior guarded DB session is still running.
      const abandoned = await db()
        .prepare(
          `UPDATE job_runs SET status='interrupted',finished_at=now(),
        detail='{"reason":"execution_interrupted"}' WHERE status='running' RETURNING id`,
        )
        .all();
      for (const row of abandoned) await failureNotification(row.id);
    })();
    const id = uid();
    const inserted = await db()
      .prepare(
        `INSERT INTO job_runs(id,job,slot,status) VALUES(?,?,?,'running')
      ON CONFLICT(job,slot) DO NOTHING RETURNING id`,
      )
      .get(id, job, slot);
    if (!inserted) return { skipped: 'already_executed' as const };
    let outcome: JobOutcome;
    try {
      outcome = await work();
    } catch {
      outcome = { status: 'failed', detail: { reason: 'execution_failed' } };
    }
    await db().transaction(async () => {
      await db()
        .prepare('UPDATE job_runs SET status=?,finished_at=now(),detail=?::text::jsonb WHERE id=?')
        .run(outcome.status, JSON.stringify(outcome.detail), id);
      if (outcome.status === 'failed') await failureNotification(id);
    })();
    return { id, ...outcome };
  });
  return locked.acquired ? locked.value : { skipped: 'already_running' as const };
}
async function syncDueSource(): Promise<JobOutcome> {
  // One metadata item and one source per invocation; neither queue starves the other.
  const enriched = await enrichDueProductMetadata();
  // Oldest source attempts go first, including failures.
  const attempts = await db()
    .prepare(
      `SELECT source_id,max(json::jsonb->>'createdAt') AS attempted
    FROM source_runs GROUP BY source_id`,
    )
    .all();
  const attempted = new Map(attempts.map((r) => [r.source_id, r.attempted as string]));
  const sources = (await list<Source>('sources'))
    .filter(
      (s) =>
        s.enabled &&
        ['website', 'json_api', 'csv_url'].includes(s.kind) &&
        s.syncIntervalHours > 0 &&
        (!s.lastSyncedAt ||
          Date.now() - Date.parse(s.lastSyncedAt) >= s.syncIntervalHours * 3600000),
    )
    .sort(
      (a, b) =>
        (attempted.get(a.id) || '').localeCompare(attempted.get(b.id) || '') ||
        a.id.localeCompare(b.id),
    );
  if (!sources[0]) {
    const catalog = await refreshIndexedSupplierCatalog();
    return {status:catalog.status==='failed'?'failed' as const:enriched.status==='deferred'?'deferred' as const:'success' as const,detail:{...catalog.detail,processed:catalog.detail.processed+enriched.detail.processed,metadataProcessed:enriched.detail.processed}};
  }
  const result = await syncSource(sources[0].id);
  return {
    status: result.errors.length ? 'failed' : enriched.status==='deferred'?'deferred':'success',
    detail: {
      processed: 1,
      remaining: sources.length - 1,
      metadataProcessed: enriched.detail.processed,
      imported: result.imported,
      updated: result.updated,
      documents: result.documents,
      errors: result.errors.length,
    },
  };
}
async function cleanup(): Promise<JobOutcome> {
  return db().transaction(async () => {
    // Only explicit technical expiry. Never infer retention for customer/business records.
    const timestamp = Date.now();
    const sessions = await db().prepare('DELETE FROM sessions WHERE expires_at < ?').run(timestamp);
    const previews = await db()
      .prepare('DELETE FROM import_previews WHERE expires_at < ?')
      .run(timestamp);
    const limits = await db().prepare('DELETE FROM rate_limits WHERE reset_at < ?').run(timestamp);
    return {
      status: 'success' as const,
      detail: {
        sessions: sessions.changes,
        previews: previews.changes,
        rateLimits: limits.changes,
      },
    };
  })();
}
async function notifications(): Promise<JobOutcome> {
  const result = await deliverReceiptNotifications();
  if (result.reason)
    return {
      status:
        result.reason === 'disabled' || result.reason === 'setup_required' ? 'deferred' : 'failed',
      detail: result,
    };
  const pending = await db()
    .prepare(
      `SELECT count(*)::int AS count FROM receipt_notifications
    WHERE (status='review' OR (status='pending' AND attempts>0)) AND job_run_id IS NULL`,
    )
    .get();
  return {
    status: pending.count ? 'failed' : 'success',
    detail: { ...result, attention: pending.count },
  };
}
export async function runWebJob(job: WebJob, slot = `manual:${uid()}`) {
  return runJob(job, slot, { sync: syncDueSource, cleanup, notifications }[job]);
}
export async function runScheduledJobs(timestamp = Date.now()) {
  const results = [];
  // UTC slots deduplicate repeated scheduler deliveries. Deferred/failed slots aren't retried
  // immediately; next slot applies the notification provider's own persistent backoff.
  for (const job of WEB_JOBS) {
    const interval = job === 'cleanup' ? 86400000 : 300000;
    results.push({
      job,
      ...(await runWebJob(job, `scheduled:${Math.floor(timestamp / interval)}`)),
    });
  }
  return results;
}
export async function jobReport() {
  const runs = await db()
    .prepare(
      `SELECT id,job,status,started_at,finished_at,detail FROM job_runs
    ORDER BY started_at DESC,id LIMIT 100`,
    )
    .all();
  const alerts = await db()
    .prepare(
      `SELECT n.job_run_id,n.status,n.attempts,n.delivery_status,n.last_error
    FROM receipt_notifications n JOIN (SELECT id FROM job_runs ORDER BY started_at DESC,id LIMIT 100) j
    ON j.id=n.job_run_id`,
    )
    .all();
  return {
    runs,
    alerts,
    config: {
      cronConfigured: (process.env.JOB_CRON_SECRET || '').length >= 32,
      schedulerEnabled: process.env.JOBS_ENABLED === 'true',
      alertRecipientConfigured: !!process.env.JOB_ALERT_TO,
      emailEnabled: process.env.EMAIL_DELIVERY_MODE === 'live',
    },
  };
}
export type JobReport = Awaited<ReturnType<typeof jobReport>>;
