import { afterEach, expect, it, vi } from 'vitest';
import { db } from '../lib/server/db';
import {
  budgetPeriod,
  budgetState,
  startPaidCall,
  finishPaidCall,
  updateBudget,
} from '../lib/server/ai-budget';
import { quoteCall, actualCost } from '../lib/server/ai-pricing';
import { billingReport } from '../lib/server/billing-report';
import { beginAiCall } from '../lib/server/ai-usage';
import { deliverBudgetNotifications } from '../lib/server/budget-notifications';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const textBody = JSON.stringify({ model: 'gpt-4.1-mini', input: 'test', max_output_tokens: 100 });
const tokens = { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0 };
it('uses Japanese month boundaries exactly', () => {
  expect(budgetPeriod(new Date('2026-10-31T14:59:59Z')).month).toBe('2026-10');
  expect(budgetPeriod(new Date('2026-10-31T15:00:00Z'))).toEqual({
    month: '2026-11',
    start: '2026-10-31T15:00:00.000Z',
    end: '2026-11-30T15:00:00.000Z',
  });
});
it('serializes independent reservations and cannot reuse settled call IDs', async () => {
  const q = quoteCall('openai', 'gpt-4.1-mini', textBody);
  await budgetState();
  await db()
    .prepare('UPDATE ai_budget_policy SET limit_microyen=? WHERE id=1')
    .run(q.reserved * 3);
  const results = await Promise.allSettled(
    Array.from({ length: 16 }, (_, i) =>
      startPaidCall(`parallel-${i}`, 'openai', 'gpt-4.1-mini', textBody),
    ),
  );
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
  const first = results.findIndex((r) => r.status === 'fulfilled');
  await finishPaidCall(`parallel-${first}`, q, tokens, 0, true);
  // The private reservation primitive is idempotent, but the network-attempt boundary is not reusable.
  await expect(
    startPaidCall(`parallel-${first}`, 'openai', 'gpt-4.1-mini', textBody),
  ).rejects.toBeDefined();
});
it('settles once, preserves reservations on missing usage, timeout and over-bound usage', async () => {
  const q = await startPaidCall('cost', 'openai', 'gpt-4.1-mini', textBody);
  await Promise.all(Array.from({ length: 8 }, () => finishPaidCall('cost', q, tokens, 0, true)));
  const settled = await billingReport();
  expect(settled.reservedYen).toBe(0);
  expect(settled.spentYen).toBe(actualCost(q, tokens, 0, true)! / 1e6);
  for (const [id, usage, uncertain] of [
    ['missing', null, false],
    ['timeout', tokens, true],
    ['excess', { ...tokens, outputTokens: 999999 }, false],
  ] as const) {
    const quote = await startPaidCall(id, 'openai', 'gpt-4.1-mini', textBody);
    await finishPaidCall(id, quote, usage, null, true, uncertain);
  }
  const report = await billingReport();
  expect(report.reservedYen).toBe((q.reserved * 3) / 1e6);
  expect(report.reservations.filter((r) => r.holdReason)).toHaveLength(3);
  expect(report.paused).toBe(true);
});
it('keeps a cancelled call reserved and blocks a retry at the call boundary', async () => {
  const quote = quoteCall('openai', 'gpt-4.1-mini', textBody);
  await budgetState();
  await db().prepare('UPDATE ai_budget_policy SET limit_microyen=? WHERE id=1').run(quote.reserved);
  const input = {
    provider: 'openai' as const,
    purpose: 'response' as const,
    model: 'gpt-4.1-mini',
    body: textBody,
    requestShape: {},
  };
  const call = await beginAiCall(input);
  call.response(200);
  call.usage({ input_tokens: 100, output_tokens: 20 });
  await call.finish(false, new DOMException('cancelled', 'AbortError'));

  await expect(beginAiCall(input)).rejects.toMatchObject({ code: 'budget_exceeded' });
  expect(await db().prepare('SELECT id FROM ai_calls').all()).toHaveLength(1);
  expect(await db().prepare('SELECT id FROM ai_reservations').all()).toHaveLength(1);
  const report = await billingReport();
  expect(report.spentYen).toBe(0);
  expect(report.reservedYen).toBe(quote.reserved / 1e6);
  expect(report.stopped).toBe(true);
  expect(report.notifications.some((notification) => notification.kind === 'insufficient')).toBe(
    true,
  );
});
it('settles into the original month and starts a new Japanese month without releasing old holds', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-31T14:59:59Z'));
  const q = await startPaidCall('old', 'openai', 'gpt-4.1-mini', textBody);
  await startPaidCall('held-old', 'openai', 'gpt-4.1-mini', textBody);
  vi.setSystemTime(new Date('2026-10-31T15:00:01Z'));
  await finishPaidCall('old', q, tokens, 0, true);
  const old = await db().prepare("SELECT * FROM ai_budgets WHERE period='2026-10'").get();
  expect(Number(old.reserved_microyen)).toBe(q.reserved);
  expect(Number(old.spent_microyen)).toBeGreaterThan(0);
  expect(await billingReport()).toMatchObject({ period: '2026-11', spentYen: 0, reservedYen: 0 });
});
it('lowering and pausing the budget preserves in-flight reservations and logs changes', async () => {
  const q = await startPaidCall('in-flight', 'openai', 'gpt-4.1-mini', textBody);
  await updateBudget(0, true, 0, 'admin');
  await expect(startPaidCall('after', 'openai', 'gpt-4.1-mini', textBody)).rejects.toMatchObject({
    code: 'budget_exceeded',
  });
  await finishPaidCall('in-flight', q, tokens, 0, true);
  await expect(updateBudget(3000, false, 0, 'admin')).rejects.toMatchObject({ status: 409 });
  await updateBudget(3000, false, 1, 'admin');
  expect((await billingReport()).history).toHaveLength(2);
  await expect(startPaidCall('resumed', 'openai', 'gpt-4.1-mini', textBody)).resolves.toBeDefined();
});
it('blocks unknown prices and unbounded search before making a network request', async () => {
  vi.stubEnv('AI_JEV_MAX_CALL_USD', '');
  for (const [provider, model, body] of [
    ['openai', 'unknown-model', textBody],
    ['jev', 'jev-latest', '{}'],
    [
      'openai',
      'gpt-4.1-mini',
      JSON.stringify({ max_output_tokens: 100, tools: [{ type: 'web_search' }] }),
    ],
  ])
    await expect(startPaidCall('unknown', provider, model, body)).rejects.toMatchObject({
      code: 'price_unregistered',
    });
  expect(await db().prepare('SELECT id FROM ai_reservations').all()).toHaveLength(0);
});
it('records search tool usage separately and keeps an unreported tool charge reserved', async () => {
  const body = JSON.stringify({
    model: 'gpt-4.1-mini',
    max_output_tokens: 100,
    tools: [{ type: 'web_search' }],
    max_tool_calls: 1,
  });
  const call = await beginAiCall({
    provider: 'openai',
    model: 'gpt-4.1-mini',
    body,
    purpose: 'research',
    requestShape: {},
  });
  call.response(200);
  call.usage({ input_tokens: 100, output_tokens: 20 });
  call.tools([{ type: 'web_search_call' }]);
  await call.finish(true);
  const report = await billingReport();
  expect(report.reservedYen).toBe(0);
  expect(report.spentYen).toBeGreaterThan(2); // tool + fixed search input block, yen conversion, margin
  const q = await startPaidCall('missing-tools', 'openai', 'gpt-4.1-mini', body);
  await finishPaidCall('missing-tools', q, tokens, null, true);
  expect((await billingReport()).reservedYen).toBeGreaterThan(0);
});
it('queues thresholds and month-end forecasts exactly once under concurrency', async () => {
  await budgetState();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-03T00:00:00Z'));
  await billingReport();
  await db()
    .prepare("UPDATE ai_budgets SET spent_microyen=2800000000 WHERE period='2026-10'")
    .run();
  await Promise.all(Array.from({ length: 10 }, () => billingReport()));
  const notifications = (await billingReport()).notifications;
  expect(notifications.map((n) => n.kind).sort()).toEqual(['80', '90', 'forecast']);
});
it('denies payment-required calls even without an incoming expiration webhook', async () => {
  vi.stubEnv('BILLING_REQUIRED', 'true');
  vi.stubEnv('BILLING_BASIC_API_LIMIT_JPY', '3000');
  await budgetState();
  await db()
    .prepare('UPDATE billing_account SET json=?::text::jsonb WHERE id=1')
    .run(
      JSON.stringify({
        status: 'active',
        paidPlan: 'basic',
        paidLimitYen: 3000,
        paidUntil: new Date(Date.now() - 1).toISOString(),
      }),
    );
  await expect(startPaidCall('expired', 'openai', 'gpt-4.1-mini', textBody)).rejects.toMatchObject({
    code: 'budget_exceeded',
  });
  await expect(updateBudget(3000, false, 0, 'company')).rejects.toMatchObject({ status: 403 });
});

it('uses the reservation exchange rate even after configuration changes', async () => {
  const q = await startPaidCall('fx-snapshot', 'openai', 'gpt-4.1-mini', textBody);
  vi.stubEnv('AI_BUDGET_USD_JPY', '250');
  await finishPaidCall('fx-snapshot', q, tokens, 0, true);
  expect((await billingReport()).spentYen).toBe(actualCost(q, tokens, 0, true)! / 1e6);
});

it('does not resend an uncertain notification after provider idempotency expires', async () => {
  vi.stubEnv('RESEND_API_KEY', 'unit-only');
  vi.stubEnv('BUDGET_ALERT_TO', 'owner@example.test');
  vi.stubEnv('BUDGET_ALERT_FROM', 'alerts@example.test');
  await db()
    .prepare(
      `INSERT INTO budget_notifications(id,period,kind,message,first_attempt_at)
    VALUES('old','2026-10','80','test',now()-interval '25 hours')`,
    )
    .run();
  const network = vi.spyOn(globalThis, 'fetch');
  await deliverBudgetNotifications();
  expect(network).not.toHaveBeenCalled();
  expect((await db().prepare('SELECT status FROM budget_notifications').get()).status).toBe(
    'review',
  );
});
it('retries notification delivery with a stable key and serializes concurrent workers', async () => {
  vi.stubEnv('RESEND_API_KEY', 'unit-only');
  vi.stubEnv('BUDGET_ALERT_TO', 'owner@example.test');
  vi.stubEnv('BUDGET_ALERT_FROM', 'alerts@example.test');
  await db()
    .prepare(
      "INSERT INTO budget_notifications(id,period,kind,message) VALUES('one','2026-10','80','test')",
    )
    .run();
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValueOnce(new Error('timeout'))
    .mockResolvedValue(new Response(JSON.stringify({ id: 'email_1' }), { status: 200 }));
  await deliverBudgetNotifications();
  await db().prepare("UPDATE budget_notifications SET retry_at=now()-interval '1 second'").run();
  await Promise.all([deliverBudgetNotifications(), deliverBudgetNotifications()]);
  expect(network).toHaveBeenCalledTimes(2);
  expect(
    network.mock.calls.map((c) => (c[1]?.headers as Record<string, string>)['Idempotency-Key']),
  ).toEqual(['aoki-budget-one', 'aoki-budget-one']);
  expect((await db().prepare('SELECT status FROM budget_notifications').get()).status).toBe('sent');
});

it('reserves documented versioned Jev pricing and settles reported input usage without a made-up contract price', () => {
  const body = JSON.stringify({
    model: 'jev-1.14.0',
    state: 'test',
    questions: { next: { type: 'choice', instructions: 'Choose', criteria: { done: 'Done' } } },
  });
  vi.stubEnv('AI_JEV_MAX_CALL_USD', '');
  vi.stubEnv('AI_JEV_PRICE_VERSION', '');
  const q = quoteCall('jev', 'jev-1.14.0', body);
  expect(q.inputRate).toBe(0.042);
  expect(q.outputRate).toBe(0);
  expect(q.reserved).toBeGreaterThan(0);
  expect(
    actualCost(q, { inputTokens: 200, outputTokens: 1, cachedInputTokens: 0 }, 0, true),
  ).toBeGreaterThan(0);
  expect(
    actualCost(q, { inputTokens: 70000, outputTokens: 1, cachedInputTokens: 0 }, 0, true),
  ).toBeNull();
  expect(() => quoteCall('jev', 'jev-future', body)).toThrow();
});
