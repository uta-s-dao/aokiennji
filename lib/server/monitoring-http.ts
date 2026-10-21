import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { ApiError, checkOrigin, rateLimit, requireAdmin } from './auth';
import { limitedBytes, siteError } from './site-content-http';
import { monitoringSettings, monitorReport } from '../monitoring';
import {
  monitoringAdminReport,
  operationsHealth,
  recordMonitorReport,
  saveMonitoringSettings,
} from './monitoring';
const ok = (data: unknown, status = 200) =>
  NextResponse.json(
    { data },
    {
      status,
      headers: { 'Cache-Control': 'private, no-store' },
    },
  );
function monitorAuth(req: NextRequest) {
  const secret = process.env.MONITOR_SECRET || '';
  const expected = Buffer.from(`Bearer ${secret}`);
  const supplied = Buffer.from(req.headers.get('authorization') || '');
  if (
    secret.length < 32 ||
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    throw new ApiError(401, 'unauthorized', '認証が必要です。');
}
async function json(req: NextRequest, limit: number) {
  const bytes = await limitedBytes(req, limit);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ApiError(400, 'invalid_json', '入力形式を確認してください。');
  }
}
export async function monitoringAdmin(req: NextRequest) {
  try {
    const actor = await requireAdmin(req);
    if (req.method === 'GET') return ok(await monitoringAdminReport());
    checkOrigin(req);
    await rateLimit(`monitor-settings:${actor}`, 10, 60000);
    await saveMonitoringSettings(monitoringSettings.parse(await json(req, 4096)), actor);
    return ok(await monitoringAdminReport());
  } catch (error) {
    return siteError(error);
  }
}
export async function monitoringHealth(req: NextRequest) {
  try {
    monitorAuth(req);
  } catch (error) {
    return siteError(error);
  }
  try {
    return ok(await operationsHealth());
  } catch {
    return NextResponse.json(
      { error: { code: 'database_unavailable' } },
      {
        status: 503,
        headers: { 'Cache-Control': 'private, no-store' },
      },
    );
  }
}
export async function monitoringIngest(req: NextRequest) {
  try {
    monitorAuth(req);
    await recordMonitorReport(monitorReport.parse(await json(req, 65536)));
    return ok({ recorded: true });
  } catch (error) {
    return siteError(error);
  }
}
