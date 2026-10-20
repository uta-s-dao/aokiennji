import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { anonOwner, clearAdmin, requireAdmin, setSession } from '../lib/server/auth';
import { db, resetDbForTests } from '../lib/server/db';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'aoki-auth-'));
  vi.stubEnv('DATA_DIR', directory);
  vi.stubEnv('VERCEL', '1');
  vi.stubEnv('DEMO_MODE', 'true');
  vi.stubEnv('SESSION_SECRET', 'auth-test-only-session-secret-at-least-32-characters');
  vi.stubEnv('ADMIN_PASSWORD_HASH', 'auth-test-only-password-hash');
});
afterEach(async () => {
  await resetDbForTests();
  rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function issue(kind: 'admin' | 'anon' = 'admin') {
  const response = NextResponse.json({});
  const id = await setSession(response, kind);
  const name = kind === 'admin' ? 'aoki_admin' : 'aoki_anon';
  const cookie = response.cookies.get(name)!;
  return { id, cookie, request: requestCookie(name, cookie.value) };
}
function requestCookie(name: string, value: string) {
  const request = new NextRequest('https://example.com/api/admin/overview');
  request.cookies.set(name, value);
  return request;
}

it('keeps a database admin session valid across independent app connections', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  const { id, request, cookie } = await issue();
  expect(cookie).toMatchObject({
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 8 * 3600,
  });
  await resetDbForTests();
  vi.stubEnv('DATA_DIR', join(directory, 'another-instance'));
  expect(await requireAdmin(request)).toBe(id);
});

it('rejects changes to a signed session or its expiry', async () => {
  const { cookie } = await issue();
  const tampered = cookie.value.replace(/^./, cookie.value[0] === 'a' ? 'b' : 'a');
  await expect(
    async () => await requireAdmin(requestCookie('aoki_admin', tampered)),
  ).rejects.toThrow('ログイン');
  await expect(
    async () => await requireAdmin(requestCookie('aoki_admin', cookie.value + 'x')),
  ).rejects.toThrow('ログイン');
});

it('checks the persisted expiry on the server', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const { request } = await issue();
  vi.setSystemTime(Date.now() + 8 * 3600 * 1000);
  await expect(async () => await requireAdmin(request)).rejects.toThrow('ログイン');
});

it('invalidates demo admin sessions when the password or signing secret changes', async () => {
  const { request } = await issue();
  vi.stubEnv('ADMIN_PASSWORD_HASH', 'replacement-password-hash');
  await expect(async () => await requireAdmin(request)).rejects.toThrow('ログイン');
  vi.stubEnv('ADMIN_PASSWORD_HASH', 'auth-test-only-password-hash');
  vi.stubEnv('SESSION_SECRET', 'replacement-session-secret-at-least-32-characters');
  await expect(async () => await requireAdmin(request)).rejects.toThrow('ログイン');
});

it('keeps anonymous ownership in the database and cannot use it as admin authentication', async () => {
  const { id, request, cookie } = await issue('anon');
  expect(await anonOwner(request)).toBe(id);
  await expect(
    async () => await requireAdmin(requestCookie('aoki_admin', cookie.value)),
  ).rejects.toThrow('ログイン');
  await db().prepare('DELETE FROM sessions').run();
  expect(await anonOwner(request)).toBeNull();
});

it.each([
  { vercel: '', demo: 'true' },
  { vercel: '1', demo: 'false' },
])('keeps revocable database admin sessions outside Vercel demos: %j', async ({ vercel, demo }) => {
  vi.stubEnv('VERCEL', vercel);
  vi.stubEnv('DEMO_MODE', demo);
  const { id, request } = await issue();
  expect(await requireAdmin(request)).toBe(id);
  const response = NextResponse.json({});
  await clearAdmin(request, response);
  expect(response.cookies.get('aoki_admin')?.value).toBe('');
  await expect(async () => await requireAdmin(request)).rejects.toThrow('ログイン');
});

it('clears the browser cookie when a demo admin logs out', async () => {
  const { request } = await issue();
  const response = NextResponse.json({});
  await clearAdmin(request, response);
  expect(response.cookies.get('aoki_admin')?.value).toBe('');
  await expect(async () => await requireAdmin(requestCookie('aoki_admin', ''))).rejects.toThrow(
    'ログイン',
  );
});
