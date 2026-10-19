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
afterEach(() => {
  resetDbForTests();
  rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function issue(kind: 'admin' | 'anon' = 'admin') {
  const response = NextResponse.json({});
  const id = setSession(response, kind);
  const name = kind === 'admin' ? 'aoki_admin' : 'aoki_anon';
  const cookie = response.cookies.get(name)!;
  return { id, cookie, request: requestCookie(name, cookie.value) };
}
function requestCookie(name: string, value: string) {
  const request = new NextRequest('https://example.com/api/admin/overview');
  request.cookies.set(name, value);
  return request;
}

it('keeps a signed demo admin session valid across independent Vercel databases', () => {
  vi.stubEnv('NODE_ENV', 'production');
  const { id, request, cookie } = issue();
  expect(cookie).toMatchObject({
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 8 * 3600,
  });
  resetDbForTests();
  vi.stubEnv('DATA_DIR', join(directory, 'another-instance'));
  expect(requireAdmin(request)).toBe(id);
});

it('rejects changes to a signed session or its expiry', () => {
  const { cookie } = issue();
  const tampered = cookie.value.replace(/:\d{13}\./, ':9999999999999.');
  expect(() => requireAdmin(requestCookie('aoki_admin', tampered))).toThrow('ログイン');
  expect(() => requireAdmin(requestCookie('aoki_admin', cookie.value + 'x'))).toThrow('ログイン');
});

it('checks the signed expiry on the server', () => {
  vi.useFakeTimers();
  const { request } = issue();
  vi.setSystemTime(Date.now() + 8 * 3600 * 1000);
  expect(() => requireAdmin(request)).toThrow('ログイン');
});

it('invalidates demo admin sessions when the password or signing secret changes', () => {
  const { request } = issue();
  vi.stubEnv('ADMIN_PASSWORD_HASH', 'replacement-password-hash');
  expect(() => requireAdmin(request)).toThrow('ログイン');
  vi.stubEnv('ADMIN_PASSWORD_HASH', 'auth-test-only-password-hash');
  vi.stubEnv('SESSION_SECRET', 'replacement-session-secret-at-least-32-characters');
  expect(() => requireAdmin(request)).toThrow('ログイン');
});

it('keeps anonymous ownership in the database and cannot use it as admin authentication', () => {
  const { id, request, cookie } = issue('anon');
  expect(anonOwner(request)).toBe(id);
  expect(() => requireAdmin(requestCookie('aoki_admin', cookie.value))).toThrow('ログイン');
  db().prepare('DELETE FROM sessions').run();
  expect(anonOwner(request)).toBeNull();
});

it.each([
  { vercel: '', demo: 'true' },
  { vercel: '1', demo: 'false' },
])('keeps revocable database admin sessions outside Vercel demos: %j', ({ vercel, demo }) => {
  vi.stubEnv('VERCEL', vercel);
  vi.stubEnv('DEMO_MODE', demo);
  const { id, request } = issue();
  expect(requireAdmin(request)).toBe(id);
  const response = NextResponse.json({});
  clearAdmin(request, response);
  expect(response.cookies.get('aoki_admin')?.value).toBe('');
  expect(() => requireAdmin(request)).toThrow('ログイン');
});

it('clears the browser cookie when a demo admin logs out', () => {
  const { request } = issue();
  const response = NextResponse.json({});
  clearAdmin(request, response);
  expect(response.cookies.get('aoki_admin')?.value).toBe('');
  expect(() => requireAdmin(requestCookie('aoki_admin', ''))).toThrow('ログイン');
});
