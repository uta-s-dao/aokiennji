import { expect, it } from 'vitest';
import type { Conversation } from '../lib/contracts';
import {
  sourceVerificationReport,
  verificationConversation,
  withVerificationConversations,
} from '../lib/server/source-verification';

it('keeps previous batches and the ten new natural conversations without losing or duplicating them', () => {
  const customer: Conversation = {
    id: 'customer-chat',
    title: 'お客様の相談',
    status: 'open',
    createdAt: '2026-10-19T00:00:00Z',
    updatedAt: '2026-10-19T00:00:00Z',
  };
  const original = structuredClone(customer);
  const history = withVerificationConversations([customer]);
  expect(sourceVerificationReport().scenarios).toHaveLength(52);
  expect(history).toHaveLength(53);
  expect(history[0]).toEqual(customer);
  expect(customer).toEqual(original);
  expect(history.filter((c) => c.verification)).toHaveLength(52);
  expect(history.filter((c) => c.verification?.kind === 'customer_simulation')).toHaveLength(42);
  expect(new Set(history.map((c) => c.id)).size).toBe(53);
  expect(withVerificationConversations(history)).toEqual(history);
  expect(history.every((c, i) => i === 0 || c.updatedAt <= history[i - 1].updatedAt)).toBe(true);
});

it('opens each archived conversation with its exact recorded answer, trace, research and all API outcomes', () => {
  const report = sourceVerificationReport();
  for (const scenario of report.scenarios) {
    const detail = verificationConversation(scenario.conversationId)!;
    expect(detail.conversation.verification).toMatchObject({
      id: scenario.id,
      responseModel: scenario.simulation?.configuration.responseModel || report.responseModel,
      preferredSiteCount: report.initialPreferredDomains.length,
    });
    expect(detail.messages.map((m) => m.content)).toEqual(
      scenario.messages?.map((m) => m.content) || [scenario.question, scenario.response],
    );
    const last = detail.answers.at(-1)!;
    expect(last).toMatchObject({
      id: scenario.answerId,
      conversationId: scenario.conversationId,
      content: scenario.response,
      sourceTrace: scenario.answers?.at(-1)?.sourceTrace || scenario.sourceTrace,
    });
    if (scenario.answers) expect(detail.answers).toEqual(scenario.answers);
    else expect(last.calls).toEqual(scenario.aiCalls.items);
    expect(detail.research).toEqual(scenario.notes);
    expect(detail.verification).toEqual(scenario);
  }
  expect(verificationConversation('unknown-customer-chat')).toBeUndefined();
});

it('preserves every turn and source trace including conversations of different lengths', () => {
  const simulations = sourceVerificationReport().scenarios.filter((s) => s.simulation);
  expect(simulations).toHaveLength(42);
  for (const scenario of simulations) {
    const detail = verificationConversation(scenario.conversationId)!;
    expect(detail.messages.filter((m) => m.role === 'user')).toHaveLength(
      scenario.simulation!.turnCount,
    );
    expect(detail.answers).toHaveLength(scenario.simulation!.turnCount);
    expect(scenario.simulation?.review).toBeDefined();
    expect(detail.verification?.simulation?.review).toEqual(scenario.simulation?.review);
    for (const answer of detail.answers) {
      const message = scenario.messages!.find((m) => m.id === answer.id)!;
      expect(answer.content).toBe(message.content);
      expect(answer.sourceTrace).toEqual(message.sourceTrace);
      expect(answer.calls.every((c) => c.context.turnId === message.replyToId)).toBe(true);
      expect(answer.calls.every((c) => c.context.conversationId === scenario.conversationId)).toBe(
        true,
      );
    }
  }
});

it('records requested quotes separately from formal issuance and purchases', () => {
  const sales = sourceVerificationReport().scenarios.filter((s) => s.simulation?.quoteOutcome);
  expect(sales.length).toBeGreaterThanOrEqual(22);
  for (const scenario of sales) {
    expect(scenario.simulation?.quoteOutcome).toMatchObject({
      status: 'requested',
      issued: false,
      ordered: false,
    });
    expect(scenario.simulation?.quoteOutcome?.blockers.length).toBeGreaterThan(0);
    expect(
      scenario
        .messages!.filter((m) => m.role === 'assistant')
        .every((m) => !/担当者|現時点では必要数量分の在庫・発送日は未確定/.test(m.content)),
    ).toBe(true);
  }
});

it('records all ten adaptive customers with the requested GPT-4.1 model and keeps their actor calls separate', () => {
  const natural = sourceVerificationReport().scenarios.filter((s) =>
    s.id.startsWith('staged-natural-'),
  );
  expect(natural).toHaveLength(10);
  for (const s of natural) {
    expect(s.simulation!.questionAgent).toContain('次の発言を生成');
    expect(s.simulation!.configuration.responseModel).toBe('gpt-4.1');
    expect(s.simulation!.turnCount).toBeGreaterThanOrEqual(2);
    expect(s.aiCalls.items.every((c) => c.context.conversationId === s.conversationId)).toBe(true);
    expect(s.messages!.every((m) => m.role === 'user' || m.salesState)).toBe(true);
  }
});

it('attributes the new ten conversations and accepted reply calls to Astra while preserving older models', () => {
  const history = withVerificationConversations([]);
  const astra = sourceVerificationReport().scenarios.filter((s) => s.id.startsWith('astra-'));
  expect(astra).toHaveLength(10);
  const replies = astra.flatMap((s) => s.aiCalls.items).filter((c) => c.purpose === 'response');
  expect(replies.length).toBeGreaterThan(0);
  expect(replies.every((c) => c.model === 'gpt-6-astra' && c.outcome === 'accepted')).toBe(true);
  for (const scenario of astra) {
    expect(history.find((c) => c.id === scenario.conversationId)?.verification?.responseModel).toBe(
      'gpt-6-astra',
    );
  }
  expect(history.filter((c) => c.verification?.responseModel === 'gpt-4.1-mini')).toHaveLength(30);
});
