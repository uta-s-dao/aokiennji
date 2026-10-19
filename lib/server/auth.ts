import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { NextRequest, NextResponse } from 'next/server';
import { db, demoMode, uid } from './db';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
const ADMIN = 'aoki_admin';
const ANON = 'aoki_anon';
export function hashPassword(password: string) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('base64url')}$${scryptSync(password, salt, 64).toString('base64url')}`;
}
export function verifyPassword(password: string, encoded: string) {
  try {
    const [algorithm, saltText, hashText] = encoded.split('$');
    if (algorithm !== 'scrypt') return false;
    const salt = Buffer.from(saltText, 'base64url'),
      expected = Buffer.from(hashText, 'base64url');
    return expected.length === 64 && timingSafeEqual(scryptSync(password, salt, 64), expected);
  } catch {
    return false;
  }
}
function secret() {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32)
    throw new ApiError(
      503,
      'setup_required',
      '初期設定が必要です。npm run setup を実行してください。',
    );
  return value;
}
function statelessAdmin(kind: 'admin' | 'anon') {
  // Demo functions cannot share a SQLite session table across Vercel instances.
  return kind === 'admin' && !!process.env.VERCEL && demoMode();
}
function signed(id: string, bindAdminPassword = false) {
  // Changing the admin password also invalidates the demo's signed sessions.
  const key = bindAdminPassword
    ? `${secret()}\0${process.env.ADMIN_PASSWORD_HASH || ''}`
    : secret();
  const h = createHmac('sha256', key).update(id).digest('base64url');
  return `${id}.${h}`;
}
function readSession(req: NextRequest, kind: 'admin' | 'anon') {
  const raw = req.cookies.get(kind === 'admin' ? ADMIN : ANON)?.value;
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot < 0) return null;
  const id = raw.slice(0, dot);
  const stateless = statelessAdmin(kind);
  const expected = signed(id, stateless);
  if (
    Buffer.byteLength(raw) !== Buffer.byteLength(expected) ||
    !timingSafeEqual(Buffer.from(raw), Buffer.from(expected))
  )
    return null;
  if (stateless) {
    const match = /^admin-v1:([0-9a-f-]{36}):(\d{13})$/.exec(id);
    return match && Number(match[2]) > Date.now() ? match[1] : null;
  }
  const row = db().prepare('SELECT kind,expires_at FROM sessions WHERE id=?').get(id) as
    { kind: string; expires_at: number } | undefined;
  return row?.kind === kind && row.expires_at > Date.now() ? id : null;
}
export function requireAdmin(req: NextRequest) {
  const id = readSession(req, 'admin');
  if (!id) throw new ApiError(401, 'unauthorized', '管理者ログインが必要です。');
  return id;
}
export function anonOwner(req: NextRequest) {
  return readSession(req, 'anon');
}
export function setSession(res: NextResponse, kind: 'admin' | 'anon') {
  const id = uid();
  const maxAge = kind === 'admin' ? 8 * 3600 : 30 * 86400;
  const expiresAt = Date.now() + maxAge * 1000;
  const stateless = statelessAdmin(kind);
  if (!stateless)
    db().prepare('INSERT INTO sessions(id,kind,expires_at) VALUES(?,?,?)').run(id, kind, expiresAt);
  const payload = stateless ? `admin-v1:${id}:${expiresAt}` : id;
  res.cookies.set(kind === 'admin' ? ADMIN : ANON, signed(payload, stateless), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge,
  });
  return id;
}
export function clearAdmin(req: NextRequest, res: NextResponse) {
  const id = readSession(req, 'admin');
  if (id && !statelessAdmin('admin')) db().prepare('DELETE FROM sessions WHERE id=?').run(id);
  // Demo cookies expire after eight hours; rotate the password/secret to revoke all copies.
  res.cookies.delete(ADMIN);
}
export function checkOrigin(req: NextRequest) {
  const origin = req.headers.get('origin');
  const expected = process.env.APP_ORIGIN || new URL(req.url).origin;
  if (!origin || origin !== expected)
    throw new ApiError(403, 'invalid_origin', '不正な送信元です。');
}
export function rateLimit(bucket: string, max: number, windowMs: number) {
  const current = Date.now();
  const row = db().prepare('SELECT count,reset_at FROM rate_limits WHERE bucket=?').get(bucket) as
    { count: number; reset_at: number } | undefined;
  if (!row || row.reset_at < current) {
    db()
      .prepare(
        'INSERT INTO rate_limits(bucket,count,reset_at) VALUES(?,?,?) ON CONFLICT(bucket) DO UPDATE SET count=1, reset_at=excluded.reset_at',
      )
      .run(bucket, 1, current + windowMs);
    return;
  }
  if (row.count >= max)
    throw new ApiError(429, 'rate_limited', 'しばらく待ってからお試しください。');
  db().prepare('UPDATE rate_limits SET count=count+1 WHERE bucket=?').run(bucket);
}
export function clientKey(req: NextRequest) {
  return process.env.TRUST_PROXY === 'true'
    ? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim().slice(0, 100) || 'local'
    : 'local';
}
