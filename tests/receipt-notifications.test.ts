import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { Webhook } from 'svix';
import { db, save, uid } from '../lib/server/db';
import { setSession } from '../lib/server/auth';
import { once } from '../lib/server/idempotency';
import { createQuote } from '../lib/server/business';
import { POST } from '../app/api/[...path]/route';
import {
  deliverReceiptNotifications,
  queueReceiptNotification,
  receiptNotificationReport,
  recordReceiptWebhook,
  retryReceiptNotification,
} from '../lib/server/receipt-notifications';
import {
  receiptNotificationAdmin,
  receiptNotificationCron,
  receiptNotificationWebhook,
} from '../lib/server/receipt-notification-http';

const domainId = 'a5712480-10ad-4676-84f2-72ac055379a3';
const emailId = 'f5bbf103-0d0c-44a9-9915-160f3b699883';
const secret = `whsec_${Buffer.from('a-notification-test-signature-secret').toString('base64')}`;
const remote = vi.fn();
function json(value: unknown, status = 200) {
  return Response.json(value, { status });
}
function domain() {
  return json({
    id: domainId,
    name: 'example.com',
    status: 'verified',
    capabilities: { sending: 'enabled' },
  });
}
function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: 'POST',
    headers: { origin: 'http://localhost:3000', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
async function enqueue(id = uid()) {
  await db().transaction(async () => {
    await save('inquiries', {
      id,
      name: '秘密の氏名',
      email: 'private@example.net',
      message: '秘密の相談本文',
    });
    await queueReceiptNotification('inquiry', id);
  })();
  return await db().prepare('SELECT * FROM receipt_notifications WHERE inquiry_id=?').get(id);
}
function webhook(
  kind = 'email.delivered',
  id = 'msg_test',
  timestamp = new Date(),
  signedBody?: string,
) {
  const raw = JSON.stringify({
    type: kind,
    created_at: new Date().toISOString(),
    data: { email_id: emailId, to: ['private@example.net'] },
  });
  return new NextRequest('http://localhost:3000/api/notifications/webhook', {
    method: 'POST',
    body: raw,
    headers: {
      'svix-id': id,
      'svix-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
      'svix-signature': new Webhook(secret).sign(id, timestamp, signedBody || raw),
    },
  });
}
async function session(kind: 'admin' | 'anon' = 'admin') {
  const response = NextResponse.json({});
  const actor = await setSession(response, kind);
  return {
    actor,
    cookie: response.cookies.get(kind === 'admin' ? 'aoki_admin' : 'aoki_anon')!.value,
  };
}
beforeEach(() => {
  vi.stubEnv('SESSION_SECRET', 'receipt-notification-test-secret-over-32-characters');
  vi.stubEnv('APP_ORIGIN', 'http://localhost:3000');
  vi.stubEnv('EMAIL_DELIVERY_MODE', 'live');
  vi.stubEnv('RESEND_API_KEY', 're_fake_test_only');
  vi.stubEnv('RESEND_FROM', 'notifications@example.com');
  vi.stubEnv('INQUIRY_NOTIFICATION_TO', 'staff@example.org');
  vi.stubEnv('RESEND_DOMAIN_ID', domainId);
  vi.stubEnv('RESEND_WEBHOOK_SECRET', secret);
  vi.stubEnv('NOTIFICATION_CRON_SECRET', 'cron-test-only-more-than-32-characters');
  remote.mockReset();
  remote.mockImplementation(async (url: string) =>
    url.includes('/domains/') ? domain() : json({ id: emailId }),
  );
  vi.stubGlobal('fetch', remote);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('atomically commits one inquiry and one notification for simultaneous request retries', async () => {
  const input = {
    name: '検証用',
    company: '架空会社',
    email: 'customer@example.net',
    message: '相談の検証です',
    consent: true,
  };
  const replies = await Promise.all(
    Array.from({ length: 6 }, () =>
      POST(post('/api/inquiries', input, { 'idempotency-key': 'same-receipt' }), {
        params: Promise.resolve({ path: ['inquiries'] }),
      }),
    ),
  );
  expect(replies.map((r) => r.status)).toEqual(Array(6).fill(201));
  const row = await db().prepare('SELECT * FROM receipt_notifications').all();
  expect(row).toHaveLength(1);
  expect(
    await db().prepare('SELECT id FROM inquiries WHERE id=?').get(row[0].inquiry_id),
  ).toBeTruthy();
  expect(remote).not.toHaveBeenCalled();
});
it('rolls back the receipt, notification and idempotency key together', async () => {
  await expect(
    once('rollback-notification', 'one', {}, async () => {
      await save('inquiries', { id: 'rollback' });
      await queueReceiptNotification('inquiry', 'rollback');
      throw new Error('abort after queue');
    }),
  ).rejects.toThrow('abort after queue');
  expect(await db().prepare('SELECT id FROM inquiries WHERE id=?').get('rollback')).toBeUndefined();
  expect(await db().prepare('SELECT id FROM receipt_notifications').all()).toHaveLength(0);
  expect(
    await db().prepare('SELECT key FROM request_keys WHERE scope=?').get('rollback-notification'),
  ).toBeUndefined();
});
it('queues quote receipts, but quote creation does not send mail', async () => {
  await createQuote(
    {
      name: '検証',
      company: '架空',
      email: 'test@example.net',
      message: '依頼',
      consent: true,
      quantity: 1,
    },
    null,
  );
  expect(
    await db().prepare('SELECT * FROM receipt_notifications WHERE quote_id IS NOT NULL').all(),
  ).toHaveLength(1);
  expect(remote).not.toHaveBeenCalled();
});
it('enforces a unique event and refuses dangling events outside receipt transactions', async () => {
  const row = await enqueue();
  await db().transaction(async () => {
    await queueReceiptNotification('inquiry', row.inquiry_id);
  })();
  expect(await db().prepare('SELECT * FROM receipt_notifications').all()).toHaveLength(1);
  await expect(queueReceiptNotification('inquiry', row.inquiry_id)).rejects.toThrow('transaction');
});
it('sends only minimum receipt metadata to the configured staff recipient', async () => {
  const row = await enqueue();
  expect((await deliverReceiptNotifications()).sent).toBe(1);
  const calls = remote.mock.calls.filter((c) => c[0].endsWith('/emails'));
  expect(calls).toHaveLength(1);
  const payload = JSON.parse(calls[0][1].body);
  expect(payload.to).toEqual(['staff@example.org']);
  expect(payload.text).toContain('/admin?tab=conversations');
  expect(payload.text).toContain(row.inquiry_id);
  expect(JSON.stringify(payload)).not.toMatch(/秘密|private@example/);
  const saved = await db().prepare('SELECT * FROM receipt_notifications WHERE id=?').get(row.id);
  expect(saved).toMatchObject({
    status: 'sent',
    delivery_status: 'unknown',
    attempts: 1,
    email_id: emailId,
  });
  await deliverReceiptNotifications();
  expect(remote.mock.calls.filter((c) => c[0].endsWith('/emails'))).toHaveLength(1);
});
it('keeps the receipt after provider failure and retries with identical payload and key', async () => {
  const row = await enqueue();
  let calls = 0;
  remote.mockImplementation(async (url: string) =>
    url.includes('/domains/') ? domain() : ++calls === 1 ? json({}, 503) : json({ id: emailId }),
  );
  expect((await deliverReceiptNotifications()).sent).toBe(0);
  expect(
    await db().prepare('SELECT id FROM inquiries WHERE id=?').get(row.inquiry_id),
  ).toBeTruthy();
  expect(
    await db().prepare('SELECT * FROM receipt_notifications WHERE id=?').get(row.id),
  ).toMatchObject({ status: 'pending', attempts: 1 });
  // Backoff prevents a second attempt on a repeated scheduler call.
  await deliverReceiptNotifications();
  expect(calls).toBe(1);
  await retryReceiptNotification(row.id, 'test-admin');
  await deliverReceiptNotifications();
  const sends = remote.mock.calls.filter((c) => c[0].endsWith('/emails'));
  expect(sends).toHaveLength(2);
  expect(sends[0][1].body).toBe(sends[1][1].body);
  expect(sends[0][1].headers['Idempotency-Key']).toBe(sends[1][1].headers['Idempotency-Key']);
  const report = await receiptNotificationReport();
  expect(report.attempts.map((a) => a.outcome).sort()).toEqual(['accepted', 'unknown']);
});
it('recovers an abandoned sending lease using the same notification key', async () => {
  const row = await enqueue();
  remote.mockImplementation(async (url: string) => {
    if (url.includes('/domains/')) return domain();
    throw new Error('timeout after provider acceptance');
  });
  await deliverReceiptNotifications();
  const first = remote.mock.calls.find((c) => c[0].endsWith('/emails'))![1];
  await db()
    .prepare(
      "UPDATE receipt_notifications SET status='sending',retry_at=now()-interval '1 second' WHERE id=?",
    )
    .run(row.id);
  remote.mockImplementation(async (url: string) =>
    url.includes('/domains/') ? domain() : json({ id: emailId }),
  );
  await deliverReceiptNotifications();
  expect(remote.mock.calls.filter((c) => c[0].endsWith('/emails'))[1][1].headers).toEqual(
    first.headers,
  );
});
it('does not double-send when workers run concurrently', async () => {
  await enqueue();
  await Promise.all(Array.from({ length: 5 }, () => deliverReceiptNotifications()));
  expect(remote.mock.calls.filter((c) => c[0].endsWith('/emails'))).toHaveLength(1);
});
it.each(['pending', 'sending'])(
  'blocks %s retries after the provider retention period, including manual retries',
  async (status) => {
    const row = await enqueue();
    await db()
      .prepare(
        `UPDATE receipt_notifications SET status=?,attempts=1,first_attempt_at=now()-interval '25 hours' WHERE id=?`,
      )
      .run(status, row.id);
    if (status === 'pending') await retryReceiptNotification(row.id, 'admin');
    await deliverReceiptNotifications();
    expect(remote.mock.calls.filter((c) => c[0].endsWith('/emails'))).toHaveLength(0);
    expect(
      await db().prepare('SELECT * FROM receipt_notifications WHERE id=?').get(row.id),
    ).toMatchObject({ status: 'review', last_error: 'deduplication_window_expired' });
    await expect(retryReceiptNotification(row.id, 'admin')).rejects.toMatchObject({ status: 409 });
  },
);
it('can send an old queued notification that has never been attempted', async () => {
  const row = await enqueue();
  await db()
    .prepare("UPDATE receipt_notifications SET created_at=now()-interval '5 days' WHERE id=?")
    .run(row.id);
  expect((await deliverReceiptNotifications()).sent).toBe(1);
});
it('does not silently change the recipient after a failed attempt', async () => {
  const row = await enqueue();
  remote.mockImplementation(async (url: string) =>
    url.includes('/domains/') ? domain() : json({}, 503),
  );
  await deliverReceiptNotifications();
  vi.stubEnv('INQUIRY_NOTIFICATION_TO', 'another@example.org');
  await retryReceiptNotification(row.id, 'admin');
  await deliverReceiptNotifications();
  expect(remote.mock.calls.filter((c) => c[0].endsWith('/emails'))).toHaveLength(1);
  expect(
    await db().prepare('SELECT * FROM receipt_notifications WHERE id=?').get(row.id),
  ).toMatchObject({ status: 'review', last_error: 'configuration_changed' });
});
it.each([400, 401, 403, 422])('moves permanent HTTP %s rejection to review', async (status) => {
  const row = await enqueue();
  remote.mockImplementation(async (url: string) =>
    url.includes('/domains/') ? domain() : json({}, status),
  );
  await deliverReceiptNotifications();
  expect(
    await db().prepare('SELECT * FROM receipt_notifications WHERE id=?').get(row.id),
  ).toMatchObject({ status: 'review', last_error: 'provider_rejected' });
});
it.each([429, 503])('backs off on transient HTTP %s', async (status) => {
  const row = await enqueue();
  remote.mockImplementation(async (url: string) =>
    url.includes('/domains/') ? domain() : json({}, status),
  );
  await deliverReceiptNotifications();
  expect(
    await db().prepare('SELECT * FROM receipt_notifications WHERE id=?').get(row.id),
  ).toMatchObject({ status: 'pending', last_error: 'send_unconfirmed' });
});
it('stops before the network when disabled, and keeps notifications pending', async () => {
  await enqueue();
  vi.stubEnv('EMAIL_DELIVERY_MODE', 'disabled');
  expect(await deliverReceiptNotifications()).toMatchObject({
    configured: false,
    reason: 'disabled',
  });
  expect(remote).not.toHaveBeenCalled();
});
it.each(['unverified', 'wrong_domain', 'sending_disabled'])(
  'refuses %s sender domains without consuming an attempt',
  async (kind) => {
    const row = await enqueue();
    remote.mockResolvedValue(
      json({
        id: domainId,
        name: kind === 'wrong_domain' ? 'attacker.example' : 'example.com',
        status: kind === 'unverified' ? 'pending' : 'verified',
        capabilities: { sending: kind === 'sending_disabled' ? 'disabled' : 'enabled' },
      }),
    );
    expect(await deliverReceiptNotifications()).toMatchObject({ reason: 'domain_not_verified' });
    expect(
      await db().prepare('SELECT attempts FROM receipt_notifications WHERE id=?').get(row.id),
    ).toMatchObject({ attempts: 0 });
    expect(remote).toHaveBeenCalledTimes(1);
  },
);
it('authenticates cron and admin requests and rejects CSRF and anonymous sessions', async () => {
  expect((await receiptNotificationCron(post('/api/notifications/deliver', {}))).status).toBe(401);
  expect(
    (
      await receiptNotificationAdmin(
        new NextRequest('http://localhost:3000/api/admin/notifications'),
      )
    ).status,
  ).toBe(401);
  const anon = await session('anon');
  const req = new NextRequest('http://localhost:3000/api/admin/notifications');
  req.cookies.set('aoki_anon', anon.cookie);
  expect((await receiptNotificationAdmin(req)).status).toBe(401);
  const admin = await session();
  const csrf = post(
    '/api/admin/notifications',
    { action: 'deliver' },
    { origin: 'https://evil.example' },
  );
  csrf.cookies.set('aoki_admin', admin.cookie);
  expect((await receiptNotificationAdmin(csrf)).status).toBe(403);
  const valid = new NextRequest('http://localhost:3000/api/admin/notifications');
  valid.cookies.set('aoki_admin', admin.cookie);
  const response = await receiptNotificationAdmin(valid);
  expect(response.status).toBe(200);
  expect(JSON.stringify(await response.json())).not.toMatch(/re_fake|whsec_|cron-test/);
  vi.stubEnv('EMAIL_DELIVERY_MODE', 'disabled');
  expect(
    (
      await receiptNotificationCron(
        post(
          '/api/notifications/deliver',
          {},
          { authorization: `Bearer ${process.env.NOTIFICATION_CRON_SECRET}` },
        ),
      )
    ).status,
  ).toBe(200);
});
it('rejects forged, mutated and expired webhook signatures before any DB write', async () => {
  expect(
    (await receiptNotificationWebhook(post('/api/notifications/webhook', { fake: true }))).status,
  ).toBe(400);
  expect(
    (await receiptNotificationWebhook(webhook('email.delivered', 'msg_mutation', new Date(), '{}')))
      .status,
  ).toBe(400);
  expect(
    (
      await receiptNotificationWebhook(
        webhook('email.delivered', 'msg_old', new Date(Date.now() - 600_000)),
      )
    ).status,
  ).toBe(400);
  expect(await db().prepare('SELECT * FROM receipt_notification_events').all()).toHaveLength(0);
});
it('deduplicates signed webhooks and never downgrades delivered or bounced on late events', async () => {
  await enqueue();
  await deliverReceiptNotifications();
  expect((await receiptNotificationWebhook(webhook())).status).toBe(200);
  expect((await receiptNotificationWebhook(webhook())).status).toBe(200);
  expect(await db().prepare('SELECT * FROM receipt_notification_events').all()).toHaveLength(1);
  await receiptNotificationWebhook(webhook('email.delivery_delayed', 'msg_late_delay'));
  expect((await receiptNotificationReport()).items[0].delivery_status).toBe('delivered');
  await receiptNotificationWebhook(webhook('email.bounced', 'msg_bounce'));
  await receiptNotificationWebhook(webhook('email.sent', 'msg_late_sent'));
  expect((await receiptNotificationReport()).items[0].delivery_status).toBe('bounced');
  expect(
    JSON.stringify(await db().prepare('SELECT * FROM receipt_notification_events').all()),
  ).not.toContain('private@example.net');
});
it('applies a webhook that arrives before the send response is committed', async () => {
  await enqueue();
  remote.mockImplementation(async (url: string) => {
    if (url.includes('/domains/')) return domain();
    await recordReceiptWebhook('msg_early', {
      type: 'email.delivered',
      created_at: new Date().toISOString(),
      data: { email_id: emailId },
    });
    return json({ id: emailId });
  });
  await deliverReceiptNotifications();
  expect((await receiptNotificationReport()).items[0]).toMatchObject({
    status: 'sent',
    delivery_status: 'delivered',
  });
});
it('fences late failure results from a worker whose lease has been replaced', async () => {
  const row = await enqueue();
  remote.mockImplementation(async (url: string) => {
    if (url.includes('/domains/')) return domain();
    await db()
      .prepare(
        "UPDATE receipt_notifications SET lease_token='new-worker',status='sent',email_id=? WHERE id=?",
      )
      .run(emailId, row.id);
    return json({}, 503);
  });
  await deliverReceiptNotifications();
  expect((await receiptNotificationReport()).items[0].status).toBe('sent');
});
it.each([
  ['invalid_idempotent_request', 'review'],
  ['concurrent_idempotent_requests', 'pending'],
])('handles provider idempotency conflict %s without creating a new key', async (name, status) => {
  const row = await enqueue();
  remote.mockImplementation(async (url: string) =>
    url.includes('/domains/') ? domain() : json({ name }, 409),
  );
  await deliverReceiptNotifications();
  expect(
    await db().prepare('SELECT * FROM receipt_notifications WHERE id=?').get(row.id),
  ).toMatchObject({ status, attempts: 1 });
  expect(
    remote.mock.calls.find((c) => c[0].endsWith('/emails'))![1].headers['Idempotency-Key'],
  ).toBe(`aoki-receipt-${row.id}`);
});
it('stops after the attempt limit without another provider request', async () => {
  const row = await enqueue();
  await db()
    .prepare('UPDATE receipt_notifications SET attempts=12,first_attempt_at=now() WHERE id=?')
    .run(row.id);
  await deliverReceiptNotifications();
  expect((await receiptNotificationReport()).items[0]).toMatchObject({
    status: 'review',
    last_error: 'attempt_limit',
  });
  expect(remote.mock.calls.filter((c) => c[0].endsWith('/emails'))).toHaveLength(0);
});
