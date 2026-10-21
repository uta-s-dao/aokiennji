import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  DEFAULT_MONITORING,
  type MonitorEvent,
  type MonitorReport,
  type HealthSnapshot,
} from '../lib/monitoring';
import {
  runMonitor,
  resendSender,
  type MonitorOptions,
  type Sender,
} from '../scripts/monitor-core';

let directory: string, site: Server, receiver: Server, options: MonitorOptions, sender: Sender;
let health: HealthSnapshot,
  healthStatus: number,
  adminStatus: number,
  reports: MonitorReport[],
  received: MonitorEvent[];
let sendFailure: boolean, transportAttempts: string[];
let timestamp: number;
const secret = 'external-test-secret-more-than-32-characters';
async function listen(server: Server, port = 0) {
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as { port: number }).port;
}
async function close(server: Server) {
  if (!server.listening) return;
  const done = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections();
  await done;
}
beforeEach(async () => {
  timestamp = Date.now();
  directory = mkdtempSync(join(tmpdir(), 'uta12-monitor-'));
  reports = [];
  received = [];
  transportAttempts = [];
  sendFailure = false;
  healthStatus = 200;
  adminStatus = 200;
  health = {
    version: 1,
    settings: {
      ...DEFAULT_MONITORING,
      recipient: 'ops@example.org',
      failureThreshold: 2,
      recoveryThreshold: 2,
    },
    checks: { database: 'ok', notifications: 'ok', budget: 'ok', jobs: 'ok', backup: 'disabled' },
  };
  site = createServer(async (req, res) => {
    if (req.url?.startsWith('/api/monitor/')) {
      if (req.headers.authorization !== `Bearer ${secret}`) {
        res.writeHead(401).end();
        return;
      }
      if (req.url === '/api/monitor/health') {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(healthStatus);
        res.end(
          JSON.stringify(
            healthStatus === 200 ? { data: health } : { error: { code: 'database_unavailable' } },
          ),
        );
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      reports.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: { recorded: true } }));
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.writeHead(req.url === '/admin' ? adminStatus : 200).end('<html>synthetic Aoki site</html>');
  });
  options = {
    origin: `http://127.0.0.1:${await listen(site)}`,
    secret,
    statePath: join(directory, 'state.sqlite'),
    allowLoopback: true,
    timeoutMs: 1000,
  };
  receiver = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const event = JSON.parse(Buffer.concat(chunks).toString());
    transportAttempts.push(req.headers['idempotency-key'] as string);
    if (sendFailure) res.writeHead(503).end();
    else {
      received.push(event);
      res.writeHead(200).end();
    }
  });
  const receiverOrigin = `http://127.0.0.1:${await listen(receiver)}`;
  sender = {
    fingerprint: 'synthetic-mail-account',
    async send(event) {
      const response = await fetch(receiverOrigin, {
        method: 'POST',
        headers: { 'Idempotency-Key': event.id },
        body: JSON.stringify(event),
      });
      if (!response.ok) throw new Error('Synthetic transport unavailable');
    },
  };
});
afterEach(async () => {
  await Promise.all([close(site), close(receiver)]);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
});
function tick() {
  timestamp += 60001;
  return runMonitor(options, sender, timestamp);
}
function rows() {
  const state = new Database(options.statePath);
  try {
    return state.prepare('SELECT * FROM events ORDER BY occurred_at,rowid').all() as any[];
  } finally {
    state.close();
  }
}
it('sends an outage while the whole target server is stopped, suppresses duplicates across restarts and backfills recovery', async () => {
  await tick();
  const port = (site.address() as { port: number }).port;
  await close(site);
  await tick();
  expect(received).toHaveLength(0);
  const failed = await tick();
  expect(failed).toMatchObject({ synced: false });
  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({ category: 'site', transition: 'down' });
  for (let i = 0; i < 4; i++) await tick();
  expect(received).toHaveLength(1);
  await listen(site, port);
  await tick();
  expect(received).toHaveLength(1);
  await tick();
  expect(received.map((e) => e.transition)).toEqual(['down', 'up']);
  expect(received[0].incidentId).toBe(received[1].incidentId);
  expect(
    reports
      .flatMap((r) => r.events)
      .filter((e) => e.category === 'site')
      .map((e) => e.transition),
  ).toEqual(['down', 'up']);
  expect(rows().every((e) => e.dirty === 0 && e.status === 'accepted')).toBe(true);
});
it('distinguishes DB failure and recovery from public/admin availability and classifies other failures separately', async () => {
  await tick();
  healthStatus = 503;
  await tick();
  await tick();
  expect(received.map((e) => e.category)).toEqual(['database']);
  healthStatus = 200;
  health.checks.budget = 'failure';
  health.checks.jobs = 'failure';
  health.checks.notifications = 'failure';
  await tick();
  await tick();
  expect(
    received
      .filter((e) => e.transition === 'down')
      .map((e) => e.category)
      .sort(),
  ).toEqual(['budget', 'database', 'jobs', 'notifications']);
  expect(received.filter((e) => e.transition === 'up').map((e) => e.category)).toEqual([
    'database',
  ]);
});
it('detects admin-only outage, ignores isolated failures and does not infer recovery from unknown or disabled checks', async () => {
  await tick();
  adminStatus = 503;
  await tick();
  adminStatus = 200;
  await tick();
  expect(received).toHaveLength(0);
  health.checks.backup = 'failure';
  await tick();
  await tick();
  health.checks.backup = 'disabled';
  await tick();
  await tick();
  health.checks.backup = 'unknown';
  await tick();
  await tick();
  expect(received.map((e) => e.transition)).toEqual(['down']);
  health.checks.backup = 'ok';
  await tick();
  await tick();
  expect(received.map((e) => e.transition)).toEqual(['down', 'up']);
});
it('persists uncertain sends, retries the same key/body in order and stops automatic sends after 23 hours', async () => {
  await tick();
  sendFailure = true;
  health.checks.jobs = 'failure';
  await tick();
  await tick();
  const first = rows()[0];
  health.checks.jobs = 'ok';
  await tick();
  await tick();
  expect(rows().filter((e) => e.transition === 'up')[0].attempts).toBe(0);
  sendFailure = false;
  timestamp += 10 * 60000;
  await tick();
  expect(received.map((e) => e.transition)).toEqual(['down', 'up']);
  expect(new Set(transportAttempts.slice(0, -1)).size).toBe(1);
  expect(received[0].id).toBe(first.id);
  sendFailure = true;
  health.checks.jobs = 'failure';
  await tick();
  await tick();
  const uncertain = rows().at(-1);
  timestamp += 24 * 3600000;
  sendFailure = false;
  await tick();
  expect(rows().find((e) => e.id === uncertain.id)?.status).toBe('review');
  expect(received).toHaveLength(2);
});
it('retains unsent events without mail configuration and freezes changed recipient or sender after an attempted send', async () => {
  await runMonitor(options, null, timestamp);
  health.checks.jobs = 'failure';
  await runMonitor(options, null, (timestamp += 60001));
  await runMonitor(options, null, (timestamp += 60001));
  expect(rows()[0]).toMatchObject({ attempts: 0, status: 'pending' });
  sendFailure = true;
  await tick();
  health.settings.recipient = 'replacement@example.org';
  await tick();
  expect(rows()[0].status).toBe('review');
  expect(received).toHaveLength(0);
});
it('uses explicit bootstrap settings for first-boot downtime and serializes simultaneous monitor processes', async () => {
  await close(site);
  options.bootstrapRecipient = 'bootstrap@example.org';
  const guard = new Database(options.statePath + '.lock');
  guard.exec('BEGIN IMMEDIATE');
  try {
    expect(await tick()).toEqual({ skipped: 'already_running' });
  } finally {
    guard.exec('ROLLBACK');
    guard.close();
  }
  await tick();
  await tick();
  await tick();
  expect(received).toHaveLength(1);
  expect(received[0].category).toBe('site');
});
it('refuses insecure, credential-bearing or cross-site reused state before sending secrets', async () => {
  await expect(runMonitor({ ...options, origin: 'http://example.org' }, sender)).rejects.toThrow(
    'HTTPS',
  );
  await expect(
    runMonitor({ ...options, origin: 'https://user:password@example.org' }, sender),
  ).rejects.toThrow('HTTPS');
  await tick();
  await expect(
    runMonitor({ ...options, origin: 'https://other.example.org' }, sender),
  ).rejects.toThrow('different origin');
});
it('verifies the mail domain, uses stable provider keys and rejects unverified or unsuccessful sends', async () => {
  const domainId = '28fd30fb-1bad-461b-a257-33279bf8cd8a';
  const event: MonitorEvent = {
    id: 'e42d77ac-dea8-48ed-b689-c48491f51486',
    incidentId: domainId,
    category: 'site',
    transition: 'down',
    occurredAt: new Date().toISOString(),
    status: 'pending',
    attempts: 1,
  };
  const remote = vi
    .fn()
    .mockImplementation(async (url: string) =>
      Response.json(
        url.includes('/domains/')
          ? {
              id: domainId,
              name: 'example.org',
              status: 'verified',
              capabilities: { sending: 'enabled' },
            }
          : { id: '2cff81ca-2638-4c49-8723-8f06dc0eab07' },
      ),
    );
  vi.stubGlobal('fetch', remote);
  const mailer = resendSender({ key: 'synthetic-key', from: 'monitor@example.org', domainId });
  await mailer.send(event, 'ops@example.org', 'https://example.org');
  await mailer.send(event, 'ops@example.org', 'https://example.org');
  const emails = remote.mock.calls.filter((c) => c[0].endsWith('/emails'));
  expect(emails[0][1].headers['Idempotency-Key']).toBe(emails[1][1].headers['Idempotency-Key']);
  expect(emails[0][1].body).toBe(emails[1][1].body);
  expect(emails[0][1].redirect).toBe('error');
  expect(emails[0][1].body).not.toContain('synthetic-key');
  remote.mockResolvedValue(Response.json({ status: 'unverified' }));
  await expect(mailer.send(event, 'ops@example.org', 'https://example.org')).rejects.toThrow(
    'not verified',
  );
});
