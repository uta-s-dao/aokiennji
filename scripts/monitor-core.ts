// Node-only. Never import the web database, Next.js, or the site's mail queue here.
import Database from 'better-sqlite3';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  CHECKS,
  CHECK_LABELS,
  DEFAULT_MONITORING,
  healthSnapshot,
  monitoringSettings,
  type Check,
  type CheckState,
  type MonitorEvent,
  type MonitoringSettings,
  type MonitorReport,
} from '../lib/monitoring';

type Store = InstanceType<typeof Database>;
export type MonitorOptions = {
  origin: string;
  secret: string;
  statePath: string;
  bootstrapRecipient?: string;
  allowLoopback?: boolean;
  timeoutMs?: number;
};
export type Sender = {
  fingerprint: string;
  send: (event: MonitorEvent, recipient: string, origin: string) => Promise<void>;
};
const email = z.string().email().max(254);
function originOnly(value: string, allowLoopback = false) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' &&
      !(
        allowLoopback &&
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      ))
  )
    throw new Error(
      'Expected an HTTPS origin (loopback HTTP requires explicit test configuration)',
    );
  return url.origin;
}
async function boundedBody(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('Response too large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}
export function resendSender(config: { key: string; from: string; domainId: string }): Sender {
  const from = email.parse(config.from);
  const domainId = z.string().uuid().parse(config.domainId);
  if (!config.key) throw new Error('Missing monitor mail credentials');
  return {
    // A changed sender/account never reuses a frozen message with the same idempotency key.
    fingerprint: createHash('sha256').update(`${from}\0${domainId}\0${config.key}`).digest('hex'),
    async send(event, recipient, origin) {
      email.parse(recipient);
      const auth = { Authorization: `Bearer ${config.key}` };
      const domainResponse = await fetch(`https://api.resend.com/domains/${domainId}`, {
        headers: auth,
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
      if (!domainResponse.ok) throw new Error('Monitor sender verification unavailable');
      const domain = JSON.parse(await boundedBody(domainResponse, 16384));
      if (
        domain.id !== domainId ||
        domain.status !== 'verified' ||
        domain.capabilities?.sending !== 'enabled' ||
        domain.name?.toLowerCase() !== from.split('@')[1].toLowerCase()
      )
        throw new Error('Monitor sender not verified');
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers: {
          ...auth,
          'Content-Type': 'application/json',
          'Idempotency-Key': `aoki-monitor-${event.id}`,
        },
        body: JSON.stringify({
          from,
          to: [recipient],
          subject: `アオキエンジ：${CHECK_LABELS[event.category]} ${event.transition === 'down' ? '障害' : '復旧'}`,
          text: `${CHECK_LABELS[event.category]}：${event.transition === 'down' ? '障害を検知しました' : '復旧を確認しました'}。\n発生日時：${event.occurredAt}\n障害番号：${event.incidentId}\n${origin}/admin?tab=monitoring\nサイト停止中は運用手順に従ってサービス側で確認してください。`,
        }),
      });
      if (
        !response.ok ||
        !z
          .string()
          .uuid()
          .safeParse(JSON.parse(await boundedBody(response, 16384)).id).success
      )
        throw new Error('Monitor mail not confirmed');
    },
  };
}

function openState(path: string) {
  if (!isAbsolute(path)) throw new Error('Monitor state path must be absolute');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const state = new Database(path);
  chmodSync(path, 0o600);
  state.pragma('journal_mode = WAL');
  state.exec(`
    CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS checks(category TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0,
      successes INTEGER NOT NULL DEFAULT 0,incident_id TEXT);
    CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,incident_id TEXT NOT NULL,category TEXT NOT NULL,
      transition TEXT NOT NULL,occurred_at TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,first_attempt INTEGER,retry_at INTEGER NOT NULL DEFAULT 0,
      recipient TEXT,transport TEXT,dirty INTEGER NOT NULL DEFAULT 1);
  `);
  return state;
}
function meta(state: Store, key: string) {
  return (
    state.prepare('SELECT value FROM metadata WHERE key=?').get(key) as
      { value: string } | undefined
  )?.value;
}
function setMeta(state: Store, key: string, value: string) {
  state
    .prepare('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, value);
}
function eventValue(row: any): MonitorEvent {
  return {
    id: row.id,
    incidentId: row.incident_id,
    category: row.category,
    transition: row.transition,
    occurredAt: row.occurred_at,
    status: row.status,
    attempts: row.attempts,
  };
}
function observe(
  state: Store,
  checks: Record<Check, CheckState>,
  settings: MonitoringSettings,
  now: number,
) {
  state.transaction(() => {
    for (const category of CHECKS) {
      state.prepare('INSERT INTO checks(category) VALUES(?) ON CONFLICT DO NOTHING').run(category);
      const old = state.prepare('SELECT * FROM checks WHERE category=?').get(category) as any;
      const status = checks[category];
      // Unknown/disabled is never evidence of recovery; it also breaks consecutive observations.
      const failures = status === 'failure' ? old.failures + 1 : 0;
      const successes = status === 'ok' ? old.successes + 1 : 0;
      let incidentId = old.incident_id;
      let transition: 'down' | 'up' | null = null;
      if (!incidentId && failures >= settings.failureThreshold) {
        incidentId = randomUUID();
        transition = 'down';
      } else if (incidentId && successes >= settings.recoveryThreshold) transition = 'up';
      if (transition)
        state
          .prepare(
            `INSERT INTO events(id,incident_id,category,transition,occurred_at)
        VALUES(?,?,?,?,?)`,
          )
          .run(randomUUID(), incidentId, category, transition, new Date(now).toISOString());
      state
        .prepare('UPDATE checks SET failures=?,successes=?,incident_id=? WHERE category=?')
        .run(
          Math.min(failures, 10),
          Math.min(successes, 10),
          transition === 'up' ? null : incidentId,
          category,
        );
    }
  })();
}
async function probe(options: MonitorOptions) {
  const request = (path: string, authenticated = false) =>
    fetch(`${options.origin}${path}`, {
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs || 10000),
      headers: authenticated ? { Authorization: `Bearer ${options.secret}` } : {},
    });
  const [site, admin, health] = await Promise.allSettled([
    request('/').then(async (r) => {
      if (!r.ok || !r.headers.get('content-type')?.includes('text/html'))
        throw new Error('Site unavailable');
      // Cancel HTML bodies: HTTP status and content type are the availability probe.
      await r.body?.cancel();
    }),
    request('/admin').then(async (r) => {
      if (!r.ok || !r.headers.get('content-type')?.includes('text/html'))
        throw new Error('Admin unavailable');
      await r.body?.cancel();
    }),
    request('/api/monitor/health', true).then(async (r) => ({
      status: r.status,
      body: JSON.parse(await boundedBody(r, 65536)),
    })),
  ]);
  const siteDown = site.status === 'rejected' || admin.status === 'rejected';
  const checks: Record<Check, CheckState> = {
    site: siteDown ? 'failure' : 'ok',
    database: 'unknown',
    notifications: 'unknown',
    budget: 'unknown',
    jobs: 'unknown',
    backup: 'unknown',
    monitor: siteDown ? 'unknown' : 'failure',
  };
  if (health.status === 'fulfilled') {
    const parsed = healthSnapshot.safeParse(health.value.body?.data);
    if (health.value.status === 200 && parsed.success) {
      Object.assign(checks, parsed.data.checks, { monitor: 'ok' });
      return { checks, settings: parsed.data.settings };
    }
    if (health.value.status === 503 && health.value.body?.error?.code === 'database_unavailable') {
      checks.database = 'failure';
      checks.monitor = 'ok';
    }
    // Explicit authentication/protocol errors remain distinguishable from a site outage.
    if ([401, 403].includes(health.value.status)) checks.monitor = 'failure';
  }
  return { checks, settings: null };
}
async function deliver(
  state: Store,
  settings: MonitoringSettings,
  sender: Sender | null,
  now: number,
) {
  let transport: MonitorReport['transport'] = !sender
    ? 'disabled'
    : !settings.recipient
      ? 'setup_required'
      : 'ready';
  const events = state
    .prepare("SELECT * FROM events WHERE status='pending' ORDER BY occurred_at,rowid LIMIT 100")
    .all() as any[];
  let attempts = 0;
  for (const row of events) {
    if (row.transition === 'up') {
      const down = state
        .prepare("SELECT status FROM events WHERE incident_id=? AND transition='down'")
        .get(row.incident_id) as any;
      if (down?.status === 'pending') continue;
      if (down?.status === 'review') {
        state.prepare("UPDATE events SET status='review',dirty=1 WHERE id=?").run(row.id);
        continue;
      }
    }
    if (
      row.first_attempt !== null &&
      (now - row.first_attempt >= 23 * 3600000 ||
        row.attempts >= 12 ||
        (sender && row.transport !== sender.fingerprint) ||
        row.recipient !== settings.recipient)
    ) {
      state.prepare("UPDATE events SET status='review',dirty=1 WHERE id=?").run(row.id);
      continue;
    }
    if (!sender || !settings.recipient || row.retry_at > now || attempts >= 5) continue;
    attempts++;
    // Freeze target and provider identity before any network request, including uncertain sends.
    state
      .prepare(
        `UPDATE events SET recipient=COALESCE(recipient,?),transport=COALESCE(transport,?),
      first_attempt=COALESCE(first_attempt,?),attempts=attempts+1,retry_at=?,dirty=1 WHERE id=?`,
      )
      .run(
        settings.recipient,
        sender.fingerprint,
        now,
        now + Math.min(3600000, 60000 * 2 ** row.attempts),
        row.id,
      );
    try {
      await sender.send(eventValue(row), settings.recipient, meta(state, 'origin')!);
      state.prepare("UPDATE events SET status='accepted',dirty=1 WHERE id=?").run(row.id);
    } catch {
      transport = 'failure';
    }
  }
  if (
    sender &&
    events.some((row) => row.first_attempt !== null && row.attempts > 0 && row.retry_at > now)
  )
    transport = 'failure';
  return transport;
}

// One local lock DB guards the full run; state commits use a separate DB. The OS releases
// the guard on process death, while the committed outbox/idempotency keys survive.
export async function runMonitor(input: MonitorOptions, sender: Sender | null, now = Date.now()) {
  const options = { ...input, origin: originOnly(input.origin, input.allowLoopback) };
  if (options.secret.length < 32)
    throw new Error('Monitor secret must have at least 32 characters');
  if (options.bootstrapRecipient) email.parse(options.bootstrapRecipient);
  if (!isAbsolute(options.statePath)) throw new Error('Monitor state path must be absolute');
  mkdirSync(dirname(options.statePath), { recursive: true, mode: 0o700 });
  const guard = new Database(`${options.statePath}.lock`, { timeout: 0 });
  chmodSync(`${options.statePath}.lock`, 0o600);
  let state: Store | undefined;
  try {
    try {
      guard.exec('BEGIN IMMEDIATE');
    } catch (e) {
      if ((e as { code?: string }).code === 'SQLITE_BUSY')
        return { skipped: 'already_running' as const };
      throw e;
    }
    state = openState(options.statePath);
    if (meta(state, 'origin') && meta(state, 'origin') !== options.origin)
      throw new Error('A monitor state directory cannot be reused for a different origin');
    setMeta(state, 'origin', options.origin);
    const observed = await probe(options);
    const cached = meta(state, 'settings');
    const settings =
      observed.settings ||
      (cached
        ? monitoringSettings.parse(JSON.parse(cached))
        : { ...DEFAULT_MONITORING, recipient: options.bootstrapRecipient || '' });
    if (observed.settings) setMeta(state, 'settings', JSON.stringify(settings));
    observe(state, observed.checks, settings, now);
    const transport = await deliver(state, settings, sender, now);
    const dirty = state
      .prepare('SELECT * FROM events WHERE dirty=1 ORDER BY occurred_at,rowid LIMIT 100')
      .all();
    const report: MonitorReport = {
      checkedAt: new Date(now).toISOString(),
      configRevision: settings.revision,
      transport,
      events: dirty.map(eventValue),
    };
    let synced = false;
    try {
      const response = await fetch(`${options.origin}/api/monitor/report`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(options.timeoutMs || 10000),
        headers: { Authorization: `Bearer ${options.secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(report),
      });
      const body = JSON.parse(await boundedBody(response, 16384));
      if (response.ok && body?.data?.recorded === true) {
        state.transaction(() => {
          for (const row of dirty as any[])
            state!.prepare('UPDATE events SET dirty=0 WHERE id=?').run(row.id);
        })();
        synced = true;
      }
    } catch {
      /* Site outage cannot stop local alert delivery. Backfill after recovery. */
    }
    return {
      checks: observed.checks,
      transport,
      synced,
      pending: (
        state.prepare("SELECT count(*) AS count FROM events WHERE status='pending'").get() as any
      ).count,
      review: (
        state.prepare("SELECT count(*) AS count FROM events WHERE status='review'").get() as any
      ).count,
    };
  } finally {
    state?.close();
    if (guard.inTransaction) guard.exec('ROLLBACK');
    guard.close();
  }
}
