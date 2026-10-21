import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ApiError, checkOrigin, requireAdmin, rateLimit } from './auth';
import { limitedBytes, siteError } from './site-content-http';
import { WEB_JOBS, jobReport, runScheduledJobs, runWebJob } from './jobs';
const ok = (data: unknown) =>
  NextResponse.json({ data }, { headers: { 'Cache-Control': 'private, no-store' } });
export async function jobsCron(req: NextRequest) {
  try {
    const secret = process.env.JOB_CRON_SECRET || '';
    const expected = Buffer.from(`Bearer ${secret}`);
    const supplied = Buffer.from(req.headers.get('authorization') || '');
    if (
      secret.length < 32 ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      throw new ApiError(401, 'unauthorized', '認証が必要です。');
    if (process.env.JOBS_ENABLED !== 'true')
      throw new ApiError(503, 'jobs_disabled', '定期処理は無効です。');
    const results = await runScheduledJobs();
    return NextResponse.json(
      { data: results },
      {
        status: results.some((result) => 'status' in result && result.status === 'failed')
          ? 503
          : 200,
        headers: { 'Cache-Control': 'private, no-store' },
      },
    );
  } catch (error) {
    return siteError(error);
  }
}
export async function jobsAdmin(req: NextRequest) {
  try {
    const actor = await requireAdmin(req);
    if (req.method === 'GET') return ok(await jobReport());
    checkOrigin(req);
    await rateLimit(`jobs:${actor}`, 10, 60000);
    const raw = await limitedBytes(req, 1024);
    let input: unknown;
    try {
      input = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new ApiError(400, 'invalid_json', '入力形式を確認してください。');
    }
    const { job } = z
      .object({ job: z.enum(WEB_JOBS) })
      .strict()
      .parse(input);
    return ok({ result: await runWebJob(job), report: await jobReport() });
  } catch (error) {
    return siteError(error);
  }
}
