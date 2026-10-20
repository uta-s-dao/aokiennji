import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { NextRequest, NextResponse } from 'next/server';
import { db, uid } from './db';

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
function signed(id: string, bindAdminPassword = false) {
  // Changing the admin password invalidates signed admin sessions.
  const key = bindAdminPassword
    ? `${secret()}\0${process.env.ADMIN_PASSWORD_HASH || ''}`
    : secret();
  const h = createHmac('sha256', key).update(id).digest('base64url');
  return `${id}.${h}`;
}
async function readSession(req: NextRequest, kind: 'admin' | 'anon') {
  const raw = req.cookies.get(kind === 'admin' ? ADMIN : ANON)?.value;
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot < 0) return null;
  const id = raw.slice(0, dot);
  const expected = signed(id, kind === 'admin');
  if (
    Buffer.byteLength(raw) !== Buffer.byteLength(expected) ||
    !timingSafeEqual(Buffer.from(raw), Buffer.from(expected))
  )
    return null;
  const row = (await db().prepare('SELECT kind,expires_at FROM sessions WHERE id=?').get(id)) as
    { kind: string; expires_at: number } | undefined;
  return row?.kind === kind && row.expires_at > Date.now() ? id : null;
}
export async function requireAdmin(req: NextRequest) {
  const id = await readSession(req, 'admin');
  if (!id) throw new ApiError(401, 'unauthorized', '管理者ログインが必要です。');
  return id;
}
export async function anonOwner(req: NextRequest) {
  return await readSession(req, 'anon');
}
export async function setSession(res: NextResponse, kind: 'admin' | 'anon') {
  const id = uid();
  const maxAge = kind === 'admin' ? 8 * 3600 : 30 * 86400;
  const expiresAt = Date.now() + maxAge * 1000;
  await db()
    .prepare('INSERT INTO sessions(id,kind,expires_at) VALUES(?,?,?)')
    .run(id, kind, expiresAt);
  const payload = id;
  res.cookies.set(kind === 'admin' ? ADMIN : ANON, signed(payload, kind === 'admin'), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge,
  });
  return id;
}
export async function clearAdmin(req: NextRequest, res: NextResponse) {
  const id = await readSession(req, 'admin');
  if (id) await db().prepare('DELETE FROM sessions WHERE id=?').run(id);
  res.cookies.delete(ADMIN);
}
export function checkOrigin(req: NextRequest) {
  const origin = req.headers.get('origin');
  const expected = process.env.APP_ORIGIN || new URL(req.url).origin;
  if (!origin || origin !== expected)
    throw new ApiError(403, 'invalid_origin', '不正な送信元です。');
}
export async function rateLimit(bucket: string, max: number, windowMs: number) {
  const current = Date.now();
  const row = await db()
    .prepare(
      `
    INSERT INTO rate_limits(bucket,count,reset_at) VALUES(?,1,?)
    ON CONFLICT(bucket) DO UPDATE SET
      count=CASE WHEN rate_limits.reset_at<=? THEN 1 ELSE rate_limits.count+1 END,
      reset_at=CASE WHEN rate_limits.reset_at<=? THEN excluded.reset_at ELSE rate_limits.reset_at END
    WHERE rate_limits.reset_at<=? OR rate_limits.count<?
    RETURNING count
  `,
    )
    .get(bucket, current + windowMs, current, current, current, max);
  if (!row) throw new ApiError(429, 'rate_limited', 'しばらく待ってからお試しください。');
}
export function clientKey(req: NextRequest) {
  return process.env.TRUST_PROXY === 'true'
    ? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim().slice(0, 100) || 'local'
    : 'local';
}
