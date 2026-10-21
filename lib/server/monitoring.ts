import { db, audit, lockResource, getSettings } from './db';
import { aiProviderStatuses } from './ai-setup';
import { ApiError } from './auth';
import { budgetPeriod } from './ai-budget';
import { billingEnabled, entitlement, MICRO_YEN } from './billing-config';
import { receiptConfig } from './receipt-notifications';
import {
  DEFAULT_MONITORING,
  monitoringSettings,
  type MonitoringSettings,
  type HealthSnapshot,
  type MonitorReport,
  type CheckState,
} from '../monitoring';

export async function getMonitoringSettings(): Promise<MonitoringSettings> {
  const row = await db().prepare('SELECT json FROM monitoring_settings WHERE id=1').get();
  return monitoringSettings.parse(row?.json || DEFAULT_MONITORING);
}
export async function saveMonitoringSettings(input: MonitoringSettings, actor: string) {
  const value = monitoringSettings.parse(input);
  return db().transaction(async () => {
    await lockResource('monitoring-settings');
    const old = await getMonitoringSettings();
    if (value.revision !== old.revision)
      throw new ApiError(
        409,
        'monitoring_conflict',
        '設定が変更されています。再読み込みしてください。',
      );
    const next = { ...value, revision: old.revision + 1 };
    await db()
      .prepare(
        `INSERT INTO monitoring_settings(id,json) VALUES(1,?::text::jsonb)
      ON CONFLICT(id) DO UPDATE SET json=excluded.json`,
      )
      .run(JSON.stringify(next));
    await audit(
      'monitoring.settings_updated',
      'monitoring-settings',
      `外部監視設定を更新（版${next.revision}、変更項目：${Object.keys(value)
        .filter(
          (k) =>
            k !== 'revision' &&
            value[k as keyof MonitoringSettings] !== old[k as keyof MonitoringSettings],
        )
        .join('・')}）`,
      actor,
    );
    return next;
  })();
}

// Read-only probes: no paid API call, email, or maintenance job is started here.
export async function operationsHealth(): Promise<HealthSnapshot> {
  const settings = await getMonitoringSettings();
  const config = receiptConfig();
  const failures = await db()
    .prepare(
      `SELECT count(*)::int AS count FROM receipt_notifications
    WHERE status='review' OR (status='pending' AND attempts>0)
    OR (status='sending' AND retry_at<now())
    OR delivery_status IN ('failed','bounced','suppressed','complained')`,
    )
    .get();
  const budgetFailures = await db()
    .prepare(
      `SELECT count(*)::int AS count FROM budget_notifications
    WHERE status='review' OR (status IN ('pending','sending') AND attempts>0)`,
    )
    .get();
  const verifiedTransport = await db()
    .prepare('SELECT domain_id,domain_name,status FROM receipt_notification_transport WHERE id=1')
    .get();
  const budgetMailFailure =
    budgetFailures.count > 0 &&
    config.key &&
    process.env.BUDGET_ALERT_FROM &&
    process.env.BUDGET_ALERT_TO;
  const notifications: CheckState = budgetMailFailure
    ? 'failure'
    : !config.enabled
      ? 'disabled'
      : !config.ready || failures.count || budgetFailures.count
        ? 'failure'
        : verifiedTransport?.domain_id === config.domainId &&
            verifiedTransport?.domain_name === config.from.split('@')[1]?.toLowerCase()
          ? verifiedTransport.status === 'verified'
            ? 'ok'
            : 'failure'
          : 'unknown';
  const policy = await db().prepare('SELECT * FROM ai_budget_policy WHERE id=1').get();
  const budget = await db()
    .prepare('SELECT * FROM ai_budgets WHERE period=?')
    .get(budgetPeriod().month);
  const account = await db().prepare('SELECT json FROM billing_account WHERE id=1').get();
  const limit = Math.min(
    Number(policy?.limit_microyen ?? 3000 * MICRO_YEN),
    entitlement(account?.json || {}) * MICRO_YEN,
  );
  const budgetStatus: CheckState = policy?.paused
    ? 'disabled'
    : (billingEnabled() && entitlement(account?.json || {}) <= 0) ||
        limit <= 0 ||
        (budget && Number(budget.spent_microyen) + Number(budget.reserved_microyen) >= limit)
      ? 'failure'
      : 'ok';
  const latest = await db()
    .prepare(
      `SELECT DISTINCT ON(job) job,status,started_at,finished_at
    FROM job_runs ORDER BY job,started_at DESC,id DESC`,
    )
    .all();
  const stale = (row: any, milliseconds: number) =>
    !row ||
    Date.now() -
      Date.parse(row.status === 'running' ? row.started_at : row.finished_at || row.started_at) >
      milliseconds;
  const failed = (row: any) => row && ['failed', 'interrupted'].includes(row.status);
  const scheduled = await db()
    .prepare(
      `SELECT job,max(started_at) AS last_at FROM job_runs
    WHERE slot LIKE 'scheduled:%' GROUP BY job`,
    )
    .all();
  const jobs: CheckState =
    process.env.JOBS_ENABLED !== 'true'
      ? 'disabled'
      : ['sync', 'notifications', 'cleanup'].some((job) => {
            const row = latest.find((r) => r.job === job);
            const tick = scheduled.find((r) => r.job === job);
            const interval =
              job === 'cleanup'
                ? 86400000 + settings.jobStaleMinutes * 60000
                : settings.jobStaleMinutes * 60000;
            return (
              failed(row) ||
              (row?.status === 'running' && stale(row, settings.jobStaleMinutes * 60000)) ||
              !tick ||
              Date.now() - Date.parse(tick.last_at) > interval
            );
          })
        ? 'failure'
        : 'ok';
  const backup = latest.find((r) => r.job === 'backup');
  const backupStatus: CheckState =
    settings.backupStaleHours === 0
      ? 'disabled'
      : failed(backup) || stale(backup, settings.backupStaleHours * 3600000)
        ? 'failure'
        : backup?.status === 'success'
          ? 'ok'
          : 'unknown';
  return {
    version: 1,
    settings,
    checks: { database: 'ok', notifications, budget: budgetStatus, jobs, backup: backupStatus },
  };
}

export async function recordMonitorReport(report: MonitorReport) {
  if (
    Date.parse(report.checkedAt) > Date.now() + 300000 ||
    report.events.some((e) => Date.parse(e.occurredAt) > Date.now() + 300000)
  )
    throw new ApiError(400, 'invalid_time', '日時を確認してください。');
  await db().transaction(async () => {
    await lockResource('monitor-report');
    for (const event of report.events) {
      const old = (await db().prepare('SELECT json FROM monitor_events WHERE id=?').get(event.id))
        ?.json;
      if (
        old &&
        ['incidentId', 'category', 'transition', 'occurredAt'].some(
          (key) => old[key] !== event[key as keyof typeof event],
        )
      )
        throw new ApiError(409, 'monitor_event_conflict', '履歴が一致しません。');
      if (
        old &&
        (old.attempts > event.attempts ||
          old.status === 'accepted' ||
          (old.status === 'review' && event.status === 'pending'))
      )
        continue;
      await db()
        .prepare(
          `INSERT INTO monitor_events(id,occurred_at,json) VALUES(?,?,?::text::jsonb)
        ON CONFLICT(id) DO UPDATE SET json=excluded.json`,
        )
        .run(event.id, event.occurredAt, JSON.stringify(event));
    }
    const { events: _events, ...heartbeat } = report;
    await db()
      .prepare(
        `INSERT INTO monitor_heartbeat(id,json) VALUES(1,?::text::jsonb)
      ON CONFLICT(id) DO UPDATE SET received_at=now(),json=excluded.json
      WHERE (monitor_heartbeat.json->>'checkedAt')::timestamptz <= (excluded.json->>'checkedAt')::timestamptz`,
      )
      .run(JSON.stringify(heartbeat));
  })();
}
export async function monitoringAdminReport() {
  const snapshot = await operationsHealth();
  const heartbeat = await db()
    .prepare('SELECT received_at,json FROM monitor_heartbeat WHERE id=1')
    .get();
  const events = await db()
    .prepare('SELECT json FROM monitor_events ORDER BY occurred_at DESC,id DESC LIMIT 100')
    .all();
  const settings = await getSettings();
  const policy = await db().prepare('SELECT * FROM ai_budget_policy WHERE id=1').get();
  const budget = await db()
    .prepare('SELECT * FROM ai_budgets WHERE period=?')
    .get(budgetPeriod().month);
  const account = await db().prepare('SELECT json FROM billing_account WHERE id=1').get();
  return {
    ...snapshot,
    monitorSecretConfigured: (process.env.MONITOR_SECRET || '').length >= 32,
    usage: {
      period: budgetPeriod().month,
      limitYen: Math.min(
        Number(policy?.limit_microyen ?? 3000 * MICRO_YEN) / MICRO_YEN,
        entitlement(account?.json || {}),
      ),
      spentYen: Number(budget?.spent_microyen || 0) / MICRO_YEN,
      reservedYen: Number(budget?.reserved_microyen || 0) / MICRO_YEN,
      paused: !!policy?.paused,
      chatEnabled: settings.flags.chat,
      researchEnabled: settings.flags.aiResearch,
      providers: await aiProviderStatuses(),
    },
    heartbeat: heartbeat
      ? {
          receivedAt: heartbeat.received_at,
          ...heartbeat.json,
          stale: Date.now() - Date.parse(heartbeat.received_at) > 5 * 60000,
        }
      : null,
    events: events.map((r) => r.json) as import('../monitoring').MonitorEvent[],
  };
}
export type MonitoringAdminReport = Awaited<ReturnType<typeof monitoringAdminReport>>;
