import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { db, save, uid } from '../lib/server/db';
import { setSession } from '../lib/server/auth';
import { jobReport, runJob, runScheduledJobs, runWebJob } from '../lib/server/jobs';
import { createDatabaseScope } from '../lib/server/database';
import { jobsAdmin, jobsCron } from '../lib/server/jobs-http';
import { deliverReceiptNotifications } from '../lib/server/receipt-notifications';
import * as ingestion from '../lib/server/ingestion';

beforeEach(() => {
  vi.stubEnv('EMAIL_DELIVERY_MODE', 'disabled');
  vi.stubEnv('JOB_CRON_SECRET', 'job-test-secret-longer-than-32-characters');
  vi.stubEnv('JOBS_ENABLED', 'true');
  vi.stubEnv('APP_ORIGIN', 'http://localhost:3000');
  vi.stubEnv('SESSION_SECRET', 'jobs-test-session-secret-longer-than-32-characters');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const success = async () => ({ status: 'success' as const, detail: { processed: 1 } });
function request(path: string, body: unknown = {}, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: 'POST',
    headers: { origin: 'http://localhost:3000', ...headers },
    body: JSON.stringify(body),
  });
}
it('rejects missing, query-string, wrong and short cron secrets without creating runs', async () => {
  expect((await jobsCron(request('/api/jobs/run'))).status).toBe(401);
  expect(
    (await jobsCron(request('/api/jobs/run?secret=' + process.env.JOB_CRON_SECRET))).status,
  ).toBe(401);
  expect(
    (await jobsCron(request('/api/jobs/run', {}, { authorization: 'Bearer wrong' }))).status,
  ).toBe(401);
  vi.stubEnv('JOB_CRON_SECRET', 'short');
  expect(
    (await jobsCron(request('/api/jobs/run', {}, { authorization: 'Bearer short' }))).status,
  ).toBe(401);
  expect((await jobReport()).runs).toHaveLength(0);
});
it('keeps authenticated cron disabled until explicitly enabled', async () => {
  vi.stubEnv('JOBS_ENABLED', 'false');
  expect(
    (
      await jobsCron(
        request('/api/jobs/run', {}, { authorization: `Bearer ${process.env.JOB_CRON_SECRET}` }),
      )
    ).status,
  ).toBe(503);
  expect((await jobReport()).runs).toHaveLength(0);
});
it('deduplicates repeated scheduled slots and reports disabled mail as deferred', async () => {
  const timestamp = Date.now();
  const first = await runScheduledJobs(timestamp);
  expect(first.find((r) => r.job === 'notifications')).toMatchObject({ status: 'deferred' });
  const second = await runScheduledJobs(timestamp);
  expect(second.every((r) => 'skipped' in r && r.skipped === 'already_executed')).toBe(true);
  expect((await jobReport()).runs).toHaveLength(3);
  expect((await jobReport()).alerts).toHaveLength(0);
});
it('excludes simultaneous workers across job kinds without holding business transactions open', async () => {
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((r) => (entered = r)),
    wait = new Promise<void>((r) => (release = r));
  const running = runJob('sync', 'one', async () => {
    entered();
    await wait;
    return success();
  });
  await started;
  const other = createDatabaseScope();
  try {
    expect(await other.run(() => runJob('cleanup', 'two', success))).toEqual({
      skipped: 'already_running',
    });
  } finally {
    await other.close();
  }
  // Independent commits survive a guarded job's failure.
  await save('inquiries', { id: 'kept-after-job-failure', message: 'fixture' });
  release();
  await running;
  expect((await jobReport()).runs).toHaveLength(1);
  expect(
    await db().prepare('SELECT id FROM inquiries WHERE id=?').get('kept-after-job-failure'),
  ).toBeTruthy();
});
it('records sanitized failures, queues one alert per incident, and permits a new alert after recovery', async () => {
  const fail = async () => {
    throw new Error('secret-token-and-customer-details');
  };
  expect(await runJob('sync', 'failed-1', fail)).toMatchObject({ status: 'failed' });
  await runJob('sync', 'failed-2', fail);
  expect((await jobReport()).alerts).toHaveLength(1);
  expect(JSON.stringify(await jobReport())).not.toContain('secret-token');
  await runJob('sync', 'recovered', success);
  await runJob('sync', 'failed-3', fail);
  expect((await jobReport()).alerts).toHaveLength(2);
});
it('recognizes interrupted runs only after acquiring the shared lock', async () => {
  const id = uid();
  await db()
    .prepare("INSERT INTO job_runs(id,job,slot,status) VALUES(?,'backup','abandoned','running')")
    .run(id);
  await runWebJob('cleanup');
  expect((await jobReport()).runs.find((r) => r.id === id)).toMatchObject({
    status: 'interrupted',
  });
  expect((await jobReport()).alerts).toHaveLength(1);
});
it('cleans only expired technical state and leaves business records and deduplication keys intact', async () => {
  const time = Date.now();
  await db()
    .prepare(
      "INSERT INTO sessions(id,kind,expires_at) VALUES('expired','anon',?),('valid','admin',?)",
    )
    .run(time - 1000, time + 3600000);
  await db()
    .prepare("INSERT INTO rate_limits(bucket,count,reset_at) VALUES('expired',1,?),('valid',1,?)")
    .run(time - 1000, time + 3600000);
  await db()
    .prepare(
      "INSERT INTO import_previews(id,source_id,expires_at,json) VALUES('expired','demo-catalog',?,'{}'),('valid','demo-catalog',?,'{}')",
    )
    .run(time - 1000, time + 3600000);
  await save('inquiries', { id: 'business-record', createdAt: '2000-01-01T00:00:00Z' });
  await db()
    .prepare(
      "INSERT INTO request_keys(scope,key,request_hash,response,created_at) VALUES('fixture','old','hash','{}','2000-01-01')",
    )
    .run();
  expect(await runWebJob('cleanup')).toMatchObject({
    status: 'success',
    detail: { sessions: 1, previews: 1, rateLimits: 1 },
  });
  expect(await db().prepare('SELECT id FROM sessions ORDER BY id').all()).toEqual([
    { id: 'valid' },
  ]);
  expect(await db().prepare('SELECT id FROM inquiries').all()).toHaveLength(1);
  expect(await db().prepare('SELECT key FROM request_keys').all()).toHaveLength(1);
});
it('selects only enabled due URL sources and bounds an invocation to one source', async () => {
  const base = {
    name: 'fixture',
    enabled: true,
    kind: 'csv_url',
    syncIntervalHours: 1,
    config: {},
    lastSyncedAt: null,
  };
  for (const s of [
    { ...base, id: 'first' },
    { ...base, id: 'second' },
    { ...base, id: 'disabled', enabled: false },
    { ...base, id: 'manual', kind: 'manual' },
    { ...base, id: 'fresh', lastSyncedAt: new Date().toISOString() },
  ])
    await save('sources', s);
  const sync = vi
    .spyOn(ingestion, 'syncSource')
    .mockResolvedValue({ imported: 2, updated: 0, documents: 0, errors: [], warnings: [] });
  expect(await runWebJob('sync')).toMatchObject({
    status: 'success',
    detail: { processed: 1, remaining: 1 },
  });
  expect(sync).toHaveBeenCalledExactlyOnceWith('first');
});
it('records provider delivery failures without losing receipts', async () => {
  await save('inquiries', { id: 'provider-failure' });
  await db()
    .prepare(
      "INSERT INTO receipt_notifications(id,inquiry_id,status,attempts) VALUES(?,'provider-failure','pending',1)",
    )
    .run(uid());
  vi.stubEnv('EMAIL_DELIVERY_MODE', 'live');
  vi.stubEnv('RESEND_API_KEY', 'fake');
  vi.stubEnv('RESEND_DOMAIN_ID', 'a5712480-10ad-4676-84f2-72ac055379a3');
  vi.stubEnv('RESEND_FROM', 'notify@example.com');
  vi.stubEnv('INQUIRY_NOTIFICATION_TO', 'staff@example.org');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({}, { status: 503 })));
  expect(await runWebJob('notifications')).toMatchObject({ status: 'failed' });
  expect((await jobReport()).alerts).toHaveLength(1);
  expect(await db().prepare('SELECT id FROM inquiries').all()).toHaveLength(1);
});
it('holds operation alerts without an explicit recipient, then sends minimal data to that recipient', async () => {
  const failed = await runJob('backup', 'failed', async () => ({
    status: 'failed',
    detail: { reason: 'fixture' },
  }));
  vi.stubEnv('EMAIL_DELIVERY_MODE', 'live');
  vi.stubEnv('RESEND_API_KEY', 'fake');
  vi.stubEnv('RESEND_DOMAIN_ID', 'a5712480-10ad-4676-84f2-72ac055379a3');
  vi.stubEnv('RESEND_FROM', 'notify@example.com');
  vi.stubEnv('INQUIRY_NOTIFICATION_TO', 'receipt@example.org');
  vi.stubEnv('JOB_ALERT_TO', '');
  const remote = vi.fn().mockImplementation(async (url: string) =>
    Response.json(
      url.includes('/domains/')
        ? {
            id: process.env.RESEND_DOMAIN_ID,
            name: 'example.com',
            status: 'verified',
            capabilities: { sending: 'enabled' },
          }
        : { id: 'f5bbf103-0d0c-44a9-9915-160f3b699883' },
    ),
  );
  vi.stubGlobal('fetch', remote);
  expect((await deliverReceiptNotifications()).sent).toBe(0);
  vi.stubEnv('JOB_ALERT_TO', 'operations@example.org');
  expect((await deliverReceiptNotifications()).sent).toBe(1);
  const send = remote.mock.calls.find((c) => c[0].endsWith('/emails'))!;
  const payload = JSON.parse(send[1].body);
  expect(payload.to).toEqual(['operations@example.org']);
  expect(payload.text).toContain('/admin?tab=jobs');
  if ('id' in failed) expect(payload.text).toContain(failed.id);
  expect(payload.text).not.toContain('execution_failed');
});
it('requires admin session and same-origin changes and rejects backup invocation through the web', async () => {
  expect((await jobsAdmin(new NextRequest('http://localhost:3000/api/admin/jobs'))).status).toBe(
    401,
  );
  const response = NextResponse.json({});
  await setSession(response, 'admin');
  const cookie = response.cookies.get('aoki_admin')!.value;
  const csrf = request('/api/admin/jobs', { job: 'cleanup' }, { origin: 'https://evil.example' });
  csrf.cookies.set('aoki_admin', cookie);
  expect((await jobsAdmin(csrf)).status).toBe(403);
  const invalid = request('/api/admin/jobs', { job: 'backup' });
  invalid.cookies.set('aoki_admin', cookie);
  expect((await jobsAdmin(invalid)).status).toBe(400);
  const valid = request('/api/admin/jobs', { job: 'cleanup' });
  valid.cookies.set('aoki_admin', cookie);
  const result = await jobsAdmin(valid);
  expect(result.status).toBe(200);
  expect(JSON.stringify(await result.json())).not.toContain(process.env.JOB_CRON_SECRET);
});
