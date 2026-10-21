import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, type StoredChatMessage } from '../lib/contracts';
import { db, putSettings, resetDbForTests, save } from '../lib/server/db';
import { answerChat, currentMessages } from '../lib/server/chat';
import { aiAnswerReport } from '../lib/server/ai-answer-history';
import { beginAiCall } from '../lib/server/ai-usage';

vi.mock('../lib/server/safe-fetch', () => ({ safeFetch: vi.fn() }));
const directory = mkdtempSync(join(tmpdir(), 'aoki-answer-history-'));
beforeEach(async () => {
  vi.stubEnv('DATA_DIR', directory);
  vi.stubEnv('DEMO_MODE', 'true');
  vi.stubEnv('TYPESAFE_API_KEY', '');
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('GEMINI_API_KEY', '');
  (await resetDbForTests());
  rmSync(directory, { recursive: true, force: true });
  db();
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  (await resetDbForTests());
  rmSync(directory, { recursive: true, force: true });
});
const createdAt = '2026-10-15T00:00:00.000Z';
async function conversation(id: string) {
  (await save(
    'conversations',
    { id, title: '質問は利用記録へ複製しない', createdAt, updatedAt: createdAt, status: 'open' },
    { owner_id: 'customer' },
  ));
}
async function message(
  conversationId: string,
  value: Partial<StoredChatMessage> & Pick<StoredChatMessage, 'id' | 'role'>,
) {
  (await save(
    'messages',
    {
      createdAt,
      content:
        value.role === 'user' ? `お客様の質問本文-${value.id}` : `お客様への回答-${value.id}`,
      ...value,
      conversationId,
    },
    { conversation_id: conversationId },
  ));
}
async function call(
  conversationId: string,
  turnId: string,
  purpose: 'classification' | 'response' | 'research' = 'response',
) {
  const usage = (await beginAiCall({
    provider: purpose === 'classification' ? 'jev' : 'openai',
    model: purpose === 'classification' ? `model-${turnId}` : 'gpt-4.1-mini',
    purpose,
    body: JSON.stringify({ input: 'private-request-body', max_output_tokens: 256 }),
    requestShape: { bodyKeys: ['input'] },
    context: { scope: 'chat', conversationId, turnId },
  }));
  usage.response(200);
  (await usage.finish(true));
}

it('includes local answers and fallback reasons while keeping staff traces out of public history', async () => {
  const question = 'DEMO-CAST-01の1個あたりの価格を教えてください。';
  const first = await answerChat(question, 'customer');
  (await putSettings({ ...DEFAULT_SETTINGS, responseProvider: 'openai' }));
  const second = await answerChat('用途について相談したい', 'customer', first.conversationId);
  const report = (await aiAnswerReport({ conversationId: first.conversationId, limit: 1 }));
  expect(report.total).toBe(2);
  expect(report.items).toHaveLength(1);
  expect(report.items[0]).toMatchObject({
    id: second.message.id,
    linkage: 'recorded',
    responseProvider: 'local',
    processing: { responseReason: 'missing_key', responseModel: null },
    calls: [],
  });
  expect((await aiAnswerReport()).items.find((a) => a.id === first.message.id)).toMatchObject({
    processing: {
      classificationProvider: 'local',
      responseProvider: 'local',
      responseMode: 'local',
    },
    calls: [],
  });
  expect(JSON.stringify((await aiAnswerReport()))).not.toContain(question);
  for (const value of [first.message, second.message, ...(await currentMessages(first.conversationId))]) {
    expect(value).not.toHaveProperty('processing');
    expect(value).not.toHaveProperty('replyToId');
  }
  expect((await aiAnswerReport({ provider: 'openai' })).total).toBe(0);
  expect((await aiAnswerReport({ provider: 'local' })).total).toBe(2);
  expect((await aiAnswerReport({ since: '2999-01-01T00:00:00.000Z' })).total).toBe(0);
});

it('links each answer explicitly despite overlapping turns, retries and research after the answer', async () => {
  (await conversation('c1'));
  (await conversation('c2'));
  (await message('c1', { id: 'question-a', role: 'user' }));
  (await message('c1', { id: 'question-b', role: 'user' }));
  (await message('c1', {
    id: 'answer-b',
    role: 'assistant',
    replyToId: 'question-b',
    responseProvider: 'local',
  }));
  (await message('c1', {
    id: 'answer-a',
    role: 'assistant',
    replyToId: 'question-a',
    responseProvider: 'openai',
  }));
  (await message('c2', { id: 'question-c', role: 'user' }));
  (await message('c2', {
    id: 'answer-c',
    role: 'assistant',
    replyToId: 'question-c',
    responseProvider: 'local',
    incomplete: true,
  }));
  (await call('c1', 'question-b', 'classification'));
  (await call('c1', 'question-a'));
  (await call('c1', 'question-a'));
  (await call('c1', 'question-a', 'research'));
  // Even a bad/misrouted call with the same turn ID must not cross conversations.
  (await call('c2', 'question-a'));
  const report = (await aiAnswerReport({ conversationId: 'c1', limit: 1 }));
  expect(report.total).toBe(2);
  expect(report.items[0]).toMatchObject({ id: 'answer-a', linkage: 'recorded' });
  expect(report.items[0].calls).toHaveLength(3);
  expect(
    report.items[0].calls.every(
      (c) => c.context.conversationId === 'c1' && c.context.turnId === 'question-a',
    ),
  ).toBe(true);
  expect((await aiAnswerReport({ provider: 'jev' })).items.map((a) => a.id)).toEqual(['answer-b']);
  expect((await aiAnswerReport({ conversationId: 'c2' })).items[0]).toMatchObject({
    id: 'answer-c',
    incomplete: true,
    calls: [],
  });
  expect(JSON.stringify(report)).not.toContain('お客様の質問本文');
  expect(JSON.stringify(report)).not.toContain('private-request-body');
});

it('labels historical gaps without attributing an ambiguous API call to the wrong answer', async () => {
  (await conversation('legacy'));
  (await message('legacy', { id: 'aborted', role: 'user' }));
  (await message('legacy', { id: 'old-question', role: 'user' }));
  (await message('legacy', { id: 'ambiguous-answer', role: 'assistant' }));
  (await message('legacy', { id: 'clear-question', role: 'user' }));
  (await message('legacy', { id: 'clear-answer', role: 'assistant', responseProvider: 'openai' }));
  (await call('legacy', 'old-question'));
  (await call('legacy', 'clear-question'));
  const report = (await aiAnswerReport());
  expect(report.items.find((a) => a.id === 'ambiguous-answer')).toMatchObject({
    linkage: 'unknown',
    responseProvider: null,
    processing: null,
    calls: [],
  });
  expect(report.items.find((a) => a.id === 'clear-answer')).toMatchObject({
    linkage: 'legacy',
    processing: null,
    calls: [{ model: 'gpt-4.1-mini' }],
  });
});
