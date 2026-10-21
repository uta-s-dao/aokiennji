import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { Webhook } from 'svix';
import { z } from 'zod';
import { ApiError, requireAdmin, checkOrigin, rateLimit } from './auth';
import { limitedBytes, siteError } from './site-content-http';
import {
  deliverReceiptNotifications,
  receiptNotificationReport,
  recordReceiptWebhook,
  retryReceiptNotification,
} from './receipt-notifications';

const ok = (data: unknown) =>
  NextResponse.json({ data }, { headers: { 'Cache-Control': 'private, no-store' } });
export async function receiptNotificationAdmin(req: NextRequest) {
  try {
    const actor = await requireAdmin(req);
    if (req.method === 'GET') return ok(await receiptNotificationReport());
    checkOrigin(req);
    await rateLimit(`receipt-notification:${actor}`, 10, 60000);
    const raw = await limitedBytes(req, 4096);
    let json: unknown;
    try {
      json = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new ApiError(400, 'invalid_json', '入力形式を確認してください。');
    }
    const input = z
      .discriminatedUnion('action', [
        z.object({ action: z.literal('deliver') }).strict(),
        z.object({ action: z.literal('retry'), id: z.string().uuid() }).strict(),
      ])
      .parse(json);
    if (input.action === 'retry') await retryReceiptNotification(input.id, actor);
    const result = await deliverReceiptNotifications();
    return ok({ result, report: await receiptNotificationReport() });
  } catch (error) {
    return siteError(error);
  }
}
export async function receiptNotificationCron(req: NextRequest) {
  try {
    const secret = process.env.NOTIFICATION_CRON_SECRET;
    const supplied = Buffer.from(req.headers.get('authorization') || '');
    const expected = Buffer.from(`Bearer ${secret}`);
    if (
      !secret ||
      secret.length < 32 ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      throw new ApiError(401, 'unauthorized', '認証が必要です。');
    return ok(await deliverReceiptNotifications());
  } catch (error) {
    return siteError(error);
  }
}
export async function receiptNotificationWebhook(req: NextRequest) {
  try {
    const secret = process.env.RESEND_WEBHOOK_SECRET;
    if (!secret) throw new ApiError(503, 'setup_required', '通知の署名検証が未設定です。');
    const raw = await limitedBytes(req, 256 * 1024);
    const id = req.headers.get('svix-id') || '';
    let event: unknown;
    try {
      new Webhook(secret).verify(raw.toString('utf8'), {
        'svix-id': id,
        'svix-timestamp': req.headers.get('svix-timestamp') || '',
        'svix-signature': req.headers.get('svix-signature') || '',
      });
      event = JSON.parse(raw.toString('utf8'));
      if (!id || id.length > 256) throw new Error('Invalid event ID');
    } catch {
      throw new ApiError(400, 'invalid_signature', '通知の署名を検証できません。');
    }
    return ok(await recordReceiptWebhook(id, event));
  } catch (error) {
    return siteError(error);
  }
}
