import { expect, it } from 'vitest';
import postgres from 'postgres';
import { NextRequest, NextResponse } from 'next/server';
import { db, getSettings, putSettings, resetDbForTests, save } from '../lib/server/db';
import { requireAdmin, setSession, clearAdmin, rateLimit } from '../lib/server/auth';
import { verifyConversation } from '../lib/server/business';
import { once } from '../lib/server/idempotency';
import { reserveAiCost, settleAiCost } from '../lib/server/ai-budget';
import { getSiteEditor, publishSiteDraft, saveSiteDraft } from '../lib/server/site-content';

it('keeps settings and sessions across app connection restarts, then revokes the session globally', async () => {
  process.env.SESSION_SECRET = 'postgres-integration-session-secret-over-32-characters';
  const settings = await getSettings();
  await putSettings({ ...settings, welcomeMessage: 'persistent across instances' });
  const res = NextResponse.json({});
  const id = await setSession(res, 'admin');
  const req = new NextRequest('http://localhost/api/admin/overview');
  req.cookies.set('aoki_admin', res.cookies.get('aoki_admin')!.value);
  await resetDbForTests();
  expect((await getSettings()).welcomeMessage).toBe('persistent across instances');
  expect(await requireAdmin(req)).toBe(id);
  await clearAdmin(req, NextResponse.json({}));
  await resetDbForTests();
  await expect(requireAdmin(req)).rejects.toMatchObject({ status: 401 });
});
it('rejects other owners and denies browser roles access to private tables', async () => {
  await save(
    'conversations',
    {
      id: 'private',
      title: 'private',
      status: 'open',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    { owner_id: 'owner-a' },
  );
  await expect(verifyConversation('private', 'owner-b')).rejects.toMatchObject({ status: 403 });
  for (const role of ['anon', 'authenticated']) {
    await expect(
      db().transaction(async () => {
        await db().exec(`SET LOCAL ROLE ${role}`);
        await db().prepare('SELECT * FROM app_private.conversations').all();
      })(),
    ).rejects.toMatchObject({ code: '42501' });
  }
  const protection = await db()
    .prepare(
      `SELECT count(*)::int AS count FROM pg_tables WHERE schemaname='app_private' AND NOT rowsecurity`,
    )
    .get();
  expect(protection.count).toBe(0);
});
it('allows exactly the configured number of concurrent rate limited requests', async () => {
  const results = await Promise.allSettled(
    Array.from({ length: 24 }, async () => await rateLimit('concurrent', 5, 60000)),
  );
  expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(5);
  expect(
    (await db().prepare('SELECT count FROM rate_limits WHERE bucket=?').get('concurrent')).count,
  ).toBe(5);
});
it('commits one inquiry for concurrent retries and rejects key reuse with another body', async () => {
  let calls = 0;
  const action = async () => {
    calls++;
    await save('inquiries', { id: 'one', message: 'test' });
    return { id: 'one' };
  };
  const replies = await Promise.all(
    Array.from(
      { length: 12 },
      async () => await once('test-owner', 'same-key', { message: 'test' }, action),
    ),
  );
  expect(calls).toBe(1);
  expect(replies.every((x) => x.id === 'one')).toBe(true);
  await expect(
    once('test-owner', 'same-key', { message: 'changed' }, action),
  ).rejects.toMatchObject({ status: 409 });
  expect((await db().prepare('SELECT count(*)::int AS count FROM inquiries').get()).count).toBe(1);
});
it('rolls back both the action and its idempotency key on failure', async () => {
  await expect(
    once('rollback', 'key', {}, async () => {
      await save('inquiries', { id: 'rollback' });
      throw new Error('abort');
    }),
  ).rejects.toThrow('abort');
  expect(await db().prepare('SELECT id FROM inquiries WHERE id=?').get('rollback')).toBeUndefined();
  expect(
    await db().prepare('SELECT key FROM request_keys WHERE scope=?').get('rollback'),
  ).toBeUndefined();
});
it('prevents budget over-reservation and settles exactly once across connections', async () => {
  const results = await Promise.allSettled(
    Array.from(
      { length: 12 },
      async (_, i) => await reserveAiCost(`cost-${i}`, '2026-10', 30, 100),
    ),
  );
  expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(3);
  const first = results.findIndex((x) => x.status === 'fulfilled');
  await Promise.all(Array.from({ length: 8 }, async () => await settleAiCost(`cost-${first}`, 20)));
  const row = await db().prepare('SELECT * FROM ai_budgets WHERE period=?').get('2026-10');
  expect(Number(row.reserved_microyen)).toBe(60);
  expect(Number(row.spent_microyen)).toBe(20);
  await expect(settleAiCost(`cost-${first}`, 21)).rejects.toMatchObject({ status: 409 });
});
it('accepts one simultaneous site revision and publishes only the requested revision', async () => {
  const initial = await getSiteEditor();
  const results = await Promise.allSettled([
    saveSiteDraft(initial.draft, initial.revision),
    saveSiteDraft(initial.draft, initial.revision),
  ]);
  expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  await expect(publishSiteDraft(initial.revision)).rejects.toMatchObject({ status: 409 });
  const next = await getSiteEditor();
  await publishSiteDraft(next.revision);
});
it('supports a separate restricted server connection without bypassing RLS', async () => {
  const url = process.env.DATABASE_URL!;
  const independent = postgres(url, { max: 1, prepare: false });
  try {
    await independent.begin(async (tx) => {
      await tx.unsafe('SET LOCAL ROLE aoki_app');
      expect((await tx.unsafe('SELECT id FROM app_private.settings'))[0].id).toBe(1);
    });
    await expect(
      independent.begin(async (tx) => {
        await tx.unsafe('SET LOCAL ROLE aoki_app');
        await tx.unsafe('CREATE TABLE app_private.forbidden(id int)');
      }),
    ).rejects.toMatchObject({ code: '42501' });
  } finally {
    await independent.end();
  }
});

it('reads the same inquiry and settings from another application process', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  await save('inquiries', { id: 'another-process', message: 'persistent inquiry' });
  const settings = await getSettings();
  await putSettings({ ...settings, welcomeMessage: 'another-process-setting' });
  const code = `const {list,getSettings,db}=require('./lib/server/db.ts');
    (async()=>{const rows=await list('inquiries');const s=await getSettings();
    await db().close();process.stdout.write(JSON.stringify({found:rows.some(x=>x.id==='another-process'),setting:s.welcomeMessage}));})().catch(()=>process.exit(1));`;
  const child = await promisify(execFile)(process.execPath, ['--import', 'tsx', '-e', code], {
    cwd: process.cwd(),
    env: process.env,
    timeout: 20000,
  });
  expect(JSON.parse(child.stdout)).toEqual({ found: true, setting: 'another-process-setting' });
});

it('keeps the owner and handoff when an older chat turn writes after intake', async () => {
  const { handOff } = await import('../lib/server/business');
  const conversation = {
    id: 'handoff-race',
    title: 'intake',
    status: 'open' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await save('conversations', conversation, { owner_id: 'original-owner' });
  await handOff(conversation);
  await save('conversations', conversation, { owner_id: 'other-owner' });
  expect(await verifyConversation(conversation.id, 'original-owner')).toMatchObject({
    status: 'handed_off',
  });
  await expect(verifyConversation(conversation.id, 'other-owner')).rejects.toMatchObject({
    status: 403,
  });
});

it('fails closed without database configuration instead of creating SQLite storage', async () => {
  await resetDbForTests();
  const previous = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    await expect(getSettings()).rejects.toThrow('SQLite fallback is disabled');
  } finally {
    process.env.DATABASE_URL = previous;
  }
});

it('RLS denies browser rows even if table grants are accidentally widened', async () => {
  await save('conversations', { id: 'rls-secret', status: 'open' }, { owner_id: 'private-owner' });
  await expect(
    db().transaction(async () => {
      await db().exec('GRANT USAGE ON SCHEMA app_private TO anon');
      await db().exec('GRANT SELECT ON app_private.conversations TO anon');
      await db().exec('SET LOCAL ROLE anon');
      const row = await db()
        .prepare('SELECT count(*)::int AS count FROM app_private.conversations')
        .get();
      expect(row.count).toBe(0);
      throw new Error('rollback-policy-test');
    })(),
  ).rejects.toThrow('rollback-policy-test');
});
