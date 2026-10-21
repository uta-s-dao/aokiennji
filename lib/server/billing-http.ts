import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ApiError, requireAdmin, checkOrigin, rateLimit } from './auth';
import { limitedBytes } from './site-content-http';
import { billingReport } from './billing-report';
import { updateBudget } from './ai-budget';
import { checkout, portal, processStripeEvent, stripeClient } from './stripe-billing';
import { deliverBudgetNotifications } from './budget-notifications';
import { PLAN_IDS } from '../billing';

function ok(data: unknown) {
  return NextResponse.json({ data }, { headers: { 'Cache-Control': 'private, no-store' } });
}
function failure(error: unknown) {
  const known = error instanceof ApiError;
  return NextResponse.json(
    {
      error: {
        code: known ? error.code : 'billing_failed',
        message: known
          ? error.message
          : error instanceof z.ZodError || error instanceof SyntaxError
            ? '入力内容を確認してください。'
            : '処理を確認できませんでした。時間をおいて再度お試しください。',
      },
    },
    {
      status: known
        ? error.status
        : error instanceof z.ZodError || error instanceof SyntaxError
          ? 400
          : 500,
      headers: { 'Cache-Control': 'private, no-store' },
    },
  );
}
export async function billingRequest(req: NextRequest, action = '') {
  try {
    const actor = await requireAdmin(req);
    if (req.method !== 'GET') {
      checkOrigin(req);
      await rateLimit(`billing:${actor}`, 20, 60000);
    }
    if (!action && req.method === 'GET') return ok(await billingReport());
    if (!action && req.method === 'PATCH') {
      const input = z
        .object({
          limitYen: z.number().int().min(0).max(100_000),
          paused: z.boolean(),
          revision: z.number().int().min(0),
        })
        .strict()
        .parse(JSON.parse((await limitedBytes(req, 4096)).toString('utf8')));
      await updateBudget(input.limitYen, input.paused, input.revision, actor);
      return ok(await billingReport());
    }
    if (action === 'checkout' && req.method === 'POST') {
      const input = z
        .object({ plan: z.enum(PLAN_IDS) })
        .strict()
        .parse(JSON.parse((await limitedBytes(req, 4096)).toString('utf8')));
      return ok(await checkout(input.plan, actor));
    }
    if (action === 'portal' && req.method === 'POST') return ok(await portal(actor));
    throw new ApiError(404, 'not_found', '操作が見つかりません。');
  } catch (error) {
    return failure(error);
  }
}
export async function stripeWebhook(req: NextRequest) {
  try {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) throw new ApiError(503, 'webhook_setup_required', '決済通知が未設定です。');
    const raw = await limitedBytes(req, 512 * 1024);
    let event;
    try {
      event = stripeClient().webhooks.constructEvent(
        raw,
        req.headers.get('stripe-signature') || '',
        secret,
      );
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(400, 'invalid_signature', '決済通知を検証できません。');
    }
    await processStripeEvent(event);
    return ok({ received: true });
  } catch (error) {
    return failure(error);
  }
}
export async function budgetCron(req: NextRequest) {
  try {
    const secret = process.env.BUDGET_CRON_SECRET;
    const supplied = req.headers.get('authorization') || '';
    const expected = `Bearer ${secret}`;
    if (
      !secret ||
      secret.length < 32 ||
      Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    )
      throw new ApiError(401, 'unauthorized', '認証が必要です。');
    return ok(await deliverBudgetNotifications());
  } catch (error) {
    return failure(error);
  }
}
