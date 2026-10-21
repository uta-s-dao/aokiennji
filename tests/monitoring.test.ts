import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { setSession, clearAdmin } from '../lib/server/auth';
import { db, getSettings, list, resetDbForTests, save, uid } from '../lib/server/db';
import { PUT as apiPut } from '../app/api/[...path]/route';
import { database } from '../lib/server/database';
import { DEFAULT_MONITORING, type MonitorReport } from '../lib/monitoring';
import { monitoringAdmin, monitoringHealth, monitoringIngest } from '../lib/server/monitoring-http';
import {
  getMonitoringSettings,
  operationsHealth,
  recordMonitorReport,
  saveMonitoringSettings,
} from '../lib/server/monitoring';
import { ensureCurrentBudget } from '../lib/server/ai-budget';

const secret = 'uta12-monitor-secret-more-than-32-characters';
const origin = 'http://localhost:3000';
beforeEach(() => {
  vi.stubEnv('MONITOR_SECRET', secret);
  vi.stubEnv('APP_ORIGIN', origin);
  vi.stubEnv('SESSION_SECRET', 'uta12-session-secret-more-than-32-characters');
  vi.stubEnv('EMAIL_DELIVERY_MODE', 'disabled');
  vi.stubEnv('JOBS_ENABLED', 'false');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
function request(
  path: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return new NextRequest(`${origin}${path}`, {
    method,
    headers: { origin, ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
async function admin(method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  const response = NextResponse.json({});
  await setSession(response, 'admin');
  const req = request('/api/admin/monitoring', method, body, headers);
  req.cookies.set('aoki_admin', response.cookies.get('aoki_admin')!.value);
  return req;
}
it('rejects anonymous and non-admin changes, wrong origins, unknown fields and invalid limits', async () => {
  expect(
    (await monitoringAdmin(request('/api/admin/monitoring', 'PUT', DEFAULT_MONITORING))).status,
  ).toBe(401);
  const response = NextResponse.json({});
  await setSession(response, 'anon');
  const anon = request('/api/admin/monitoring', 'PUT', DEFAULT_MONITORING);
  anon.cookies.set('aoki_admin', response.cookies.get('aoki_anon')!.value);
  expect((await monitoringAdmin(anon)).status).toBe(401);
  expect(
    (
      await monitoringAdmin(
        await admin('PUT', DEFAULT_MONITORING, { origin: 'https://evil.example' }),
      )
    ).status,
  ).toBe(403);
  for (const body of [
    { ...DEFAULT_MONITORING, failureThreshold: 0 },
    { ...DEFAULT_MONITORING, recipient: 'not-an-email' },
    { ...DEFAULT_MONITORING, secret: 'must-not-be-saved' },
  ])
    expect((await monitoringAdmin(await admin('PUT', body))).status).toBe(400);
  expect(await getMonitoringSettings()).toEqual(DEFAULT_MONITORING);
});
it('persists settings across connections, audits them and rejects stale concurrent updates', async () => {
  const req = await admin('PUT', { ...DEFAULT_MONITORING, recipient: 'operations@example.org' });
  const second = await admin('PUT', { ...DEFAULT_MONITORING, recipient: 'other@example.org' });
  const results = await Promise.all([monitoringAdmin(req), monitoringAdmin(second)]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  await resetDbForTests();
  const saved = await getMonitoringSettings();
  expect(saved.revision).toBe(1);
  expect(['operations@example.org', 'other@example.org']).toContain(saved.recipient);
  const history = await list<any>('audit_events');
  expect(history.filter((r) => r.action === 'monitoring.settings_updated')).toHaveLength(1);
  expect(JSON.stringify(history)).not.toContain(saved.recipient);
  expect(JSON.stringify(await (await monitoringAdmin(await admin())).json())).not.toContain(secret);
  const logout = NextResponse.json({});
  await clearAdmin(req, logout);
  expect((await monitoringAdmin(req)).status).toBe(401);
});
it('rolls back a sensitive configuration change if its audit cannot be recorded', async () => {
  const original = database.prepare.bind(database);
  vi.spyOn(database, 'prepare').mockImplementation((query: string) => {
    if (query.startsWith('INSERT INTO audit_events'))
      throw new Error('Synthetic audit write failure');
    return original(query);
  });
  await expect(
    saveMonitoringSettings(
      { ...DEFAULT_MONITORING, recipient: 'ops@example.org' },
      'synthetic-admin',
    ),
  ).rejects.toThrow('audit');
  expect(await getMonitoringSettings()).toEqual(DEFAULT_MONITORING);
});
it('denies browser database roles access to monitoring configuration and notification metadata', async () => {
  for (const role of ['anon', 'authenticated']) {
    for (const table of ['monitoring_settings', 'monitor_heartbeat', 'monitor_events']) {
      await expect(
        db().transaction(async () => {
          await db().exec(`SET LOCAL ROLE ${role}`);
          await db().prepare(`SELECT * FROM app_private.${table}`).all();
        })(),
      ).rejects.toMatchObject({ code: '42501' });
    }
  }
});
it('keeps general settings unchanged when audit persistence fails and records the authenticated actor on success', async () => {
  const originalSettings = await getSettings();
  const changed = { ...originalSettings, welcomeMessage: 'synthetic audit transaction check' };
  const req = await admin('PUT', changed);
  const prepare = database.prepare.bind(database);
  const spy = vi.spyOn(database, 'prepare').mockImplementation((query: string) => {
    if (query.startsWith('INSERT INTO audit_events'))
      throw new Error('Synthetic audit write failure');
    return prepare(query);
  });
  const context = { params: Promise.resolve({ path: ['admin', 'settings'] }) };
  expect((await apiPut(req, context)).status).toBe(500);
  spy.mockRestore();
  expect(await getSettings()).toEqual(originalSettings);
  expect((await apiPut(await admin('PUT', changed), context)).status).toBe(200);
  const entries = await list<any>('audit_events');
  expect(entries.find((e) => e.action === 'settings.updated')).toMatchObject({
    actorId: expect.any(String),
  });
});
it('authenticates machine probes before opening the database and ignores query secrets and admin cookies', async () => {
  const prepare = vi.spyOn(database, 'prepare');
  expect((await monitoringHealth(request('/api/monitor/health'))).status).toBe(401);
  expect((await monitoringHealth(request('/api/monitor/health?secret=' + secret))).status).toBe(
    401,
  );
  expect(
    (
      await monitoringHealth(
        request('/api/monitor/health', 'GET', undefined, { authorization: 'Bearer wrong' }),
      )
    ).status,
  ).toBe(401);
  expect(prepare).not.toHaveBeenCalled();
  vi.stubEnv('MONITOR_SECRET', 'short');
  expect(
    (
      await monitoringHealth(
        request('/api/monitor/health', 'GET', undefined, { authorization: 'Bearer short' }),
      )
    ).status,
  ).toBe(401);
});
it('returns a sanitized DB failure to the independent monitor without leaking exception details', async () => {
  vi.spyOn(database, 'prepare').mockImplementation(() => {
    throw new Error('secret-database-password');
  });
  const res = await monitoringHealth(
    request('/api/monitor/health', 'GET', undefined, { authorization: `Bearer ${secret}` }),
  );
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ error: { code: 'database_unavailable' } });
});
it('distinguishes budget exhaustion, deliberate stops, notification failure and stale jobs/backups without external calls', async () => {
  const remote = vi.fn();
  vi.stubGlobal('fetch', remote);
  try {
    expect((await operationsHealth()).checks).toEqual({
      database: 'ok',
      notifications: 'disabled',
      budget: 'ok',
      jobs: 'disabled',
      backup: 'disabled',
    });
    const state = await ensureCurrentBudget();
    await db()
      .prepare('UPDATE ai_budgets SET spent_microyen=limit_microyen WHERE period=?')
      .run(state.period.month);
    expect((await operationsHealth()).checks.budget).toBe('failure');
    await db().prepare('UPDATE ai_budget_policy SET paused=true').run();
    expect((await operationsHealth()).checks.budget).toBe('disabled');
    vi.stubEnv('EMAIL_DELIVERY_MODE', 'live');
    expect((await operationsHealth()).checks.notifications).toBe('failure');
    vi.stubEnv('RESEND_API_KEY', 'fake');
    vi.stubEnv('RESEND_DOMAIN_ID', uid());
    vi.stubEnv('RESEND_FROM', 'alerts@example.org');
    vi.stubEnv('INQUIRY_NOTIFICATION_TO', 'staff@example.org');
    expect((await operationsHealth()).checks.notifications).toBe('unknown');
    await db()
      .prepare(
        "INSERT INTO receipt_notification_transport(id,domain_id,domain_name,status) VALUES(1,?,'example.org','verified')",
      )
      .run(process.env.RESEND_DOMAIN_ID!);
    expect((await operationsHealth()).checks.notifications).toBe('ok');
    await save('inquiries', { id: 'failed-mail' });
    await db()
      .prepare(
        "INSERT INTO receipt_notifications(id,inquiry_id,status) VALUES(?,'failed-mail','review')",
      )
      .run(uid());
    expect((await operationsHealth()).checks.notifications).toBe('failure');
    vi.stubEnv('JOBS_ENABLED', 'true');
    expect((await operationsHealth()).checks.jobs).toBe('failure');
    for (const job of ['sync', 'notifications', 'cleanup'])
      await db()
        .prepare(
          "INSERT INTO job_runs(id,job,slot,status,finished_at) VALUES(?,?,'scheduled:fixture','success',now())",
        )
        .run(uid(), job);
    expect((await operationsHealth()).checks.jobs).toBe('ok');
    await db()
      .prepare(
        "UPDATE job_runs SET started_at=now()-interval '2 days',finished_at=now()-interval '2 days' WHERE job='sync'",
      )
      .run();
    expect((await operationsHealth()).checks.jobs).toBe('failure');
    expect(
      (await monitoringAdmin(await admin('PUT', { ...DEFAULT_MONITORING, backupStaleHours: 24 })))
        .status,
    ).toBe(200);
    expect((await operationsHealth()).checks.backup).toBe('failure');
    await db()
      .prepare(
        "INSERT INTO job_runs(id,job,slot,status,finished_at) VALUES(?,'backup','fixture','success',now())",
      )
      .run(uid());
    expect((await operationsHealth()).checks.backup).toBe('ok');
    // Budget mail has its own transport settings; disabling receipts must not hide its failures.
    vi.stubEnv('EMAIL_DELIVERY_MODE', 'disabled');
    vi.stubEnv('BUDGET_ALERT_FROM', 'budget@example.org');
    vi.stubEnv('BUDGET_ALERT_TO', 'ops@example.org');
    await db()
      .prepare(
        "INSERT INTO budget_notifications(id,period,kind,message,status,attempts) VALUES(?,'2026-10','fixture','synthetic','pending',1)",
      )
      .run(uid());
    expect((await operationsHealth()).checks.notifications).toBe('failure');
    expect(remote).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
function report(): MonitorReport {
  return {
    checkedAt: new Date().toISOString(),
    configRevision: 0,
    transport: 'ready',
    events: [
      {
        id: uid(),
        incidentId: uid(),
        category: 'database',
        transition: 'down',
        occurredAt: new Date().toISOString(),
        status: 'accepted',
        attempts: 1,
      },
    ],
  };
}
it('backfills outage history idempotently, prevents regressions and refuses changed event identities atomically', async () => {
  const r = report();
  const auth = { authorization: `Bearer ${secret}` };
  expect((await monitoringIngest(request('/api/monitor/report', 'POST', r))).status).toBe(401);
  expect((await monitoringIngest(request('/api/monitor/report', 'POST', r, auth))).status).toBe(
    200,
  );
  await recordMonitorReport(r);
  await recordMonitorReport({
    ...r,
    events: r.events.map((e) => ({ ...e, status: 'pending', attempts: 0 })),
  });
  const data = (await (await monitoringAdmin(await admin())).json()).data;
  expect(data.events).toEqual(r.events);
  const invalid = { ...r, events: r.events.map((e) => ({ ...e, category: 'site' })) };
  expect(
    (await monitoringIngest(request('/api/monitor/report', 'POST', invalid, auth))).status,
  ).toBe(409);
  expect(
    (
      await monitoringIngest(
        request(
          '/api/monitor/report',
          'POST',
          { ...r, events: [{ ...r.events[0], rawException: 'secret' }] },
          auth,
        ),
      )
    ).status,
  ).toBe(400);
});
