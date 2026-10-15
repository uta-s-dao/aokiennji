import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, type Conversation } from '../lib/contracts';
import { db, list, putSettings, resetDbForTests } from '../lib/server/db';
import { conversationMessages, verifyConversation } from '../lib/server/business';
import { answerChat, currentMessages } from '../lib/server/chat';

vi.mock('../lib/server/safe-fetch', () => ({ safeFetch: vi.fn() }));
const directory = mkdtempSync(join(tmpdir(), 'aoki-conversation-history-'));
beforeEach(() => {
  vi.stubEnv('DATA_DIR', directory);
  vi.stubEnv('DEMO_MODE', 'true');
  vi.stubEnv('TYPESAFE_API_KEY', '');
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('GEMINI_API_KEY', '');
  resetDbForTests();
  rmSync(directory, { recursive: true, force: true });
  db();
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => {
  resetDbForTests();
  rmSync(directory, { recursive: true, force: true });
});

it('retains every turn beyond the browser copy limit and keeps separate consultations', async () => {
  const questions = Array.from({ length: 21 }, (_, i) => `こんにちは。ご挨拶${i + 1}回目です。`);
  let id: string | undefined;
  const replies: string[] = [];
  for (const question of questions) {
    const result = await answerChat(question, 'customer', id);
    id = result.conversationId;
    replies.push(result.message.content);
  }
  const second = await answerChat('ありがとうございます', 'customer');
  expect(second.conversationId).not.toBe(id);
  expect(list<Conversation>('conversations')).toHaveLength(2);
  const stored = conversationMessages(id!);
  expect(stored).toHaveLength(42);
  expect(stored.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(questions);
  expect(stored.filter((m) => m.role === 'assistant').map((m) => m.content)).toEqual(replies);
  expect(new Set(stored.map((m) => m.id)).size).toBe(42);
});

it('records an accepted question even when the reply is aborted before any text', async () => {
  const signal = AbortSignal.abort();
  await expect(answerChat('こんにちは', 'customer', undefined, { signal })).rejects.toThrow('中断');
  const [conversation] = list<Conversation>('conversations');
  expect(verifyConversation(conversation.id, 'customer')).toEqual(conversation);
  expect(conversationMessages(conversation.id)).toMatchObject([
    { role: 'user', content: 'こんにちは' },
  ]);
  const resumed = await answerChat('ありがとうございます', 'customer', conversation.id);
  expect(conversationMessages(resumed.conversationId).map((m) => m.role)).toEqual([
    'user',
    'user',
    'assistant',
  ]);
});

it('retains the streamed text as incomplete when delivery fails and excludes it from public context', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'unit-openai');
  putSettings({ ...DEFAULT_SETTINGS, responseProvider: 'openai' });
  let offered = '';
  await expect(
    answerChat('DEMO-GLASS-01の価格と用途を相談したい', 'customer', undefined, {
      onText: (text) => {
        offered = text;
        throw new Error('stream disconnected');
      },
    }),
  ).rejects.toThrow('stream disconnected');
  expect(offered).toContain('4,800');
  const [conversation] = list<Conversation>('conversations');
  expect(conversationMessages(conversation.id)).toMatchObject([
    { role: 'user', content: 'DEMO-GLASS-01の価格と用途を相談したい' },
    { role: 'assistant', content: offered, incomplete: true },
  ]);
  expect(currentMessages(conversation.id).map((m) => m.role)).toEqual(['user']);
});

it('stores the final reply before sending it and replaces partial text without duplicate replies', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'unit-openai');
  putSettings({ ...DEFAULT_SETTINGS, responseProvider: 'openai' });
  const chunks: string[] = [];
  const result = await answerChat('DEMO-GLASS-01の価格と用途を相談したい', 'customer', undefined, {
    onText: (text) => chunks.push(text),
  });
  expect(chunks.length).toBeGreaterThan(1);
  expect(conversationMessages(result.conversationId)).toHaveLength(2);
  expect(conversationMessages(result.conversationId).at(-1)).toMatchObject(
    JSON.parse(JSON.stringify(result.message)),
  );
  expect(conversationMessages(result.conversationId).at(-1)?.incomplete).toBeUndefined();

  await expect(
    answerChat('こんにちは', 'customer', undefined, {
      onText: () => {
        throw new Error('final delivery failed');
      },
    }),
  ).rejects.toThrow('final delivery failed');
  const greeting = list<Conversation>('conversations').find((c) => c.title === 'こんにちは')!;
  expect(conversationMessages(greeting.id)).toHaveLength(2);
  expect(conversationMessages(greeting.id).at(-1)?.incomplete).toBeUndefined();
});

it('rejects another customer without recording anything in the conversation', async () => {
  const result = await answerChat('こんにちは', 'customer');
  await expect(answerChat('他人の発言', 'stranger', result.conversationId)).rejects.toThrow(
    'アクセス',
  );
  expect(conversationMessages(result.conversationId)).toHaveLength(2);
  expect(list<Conversation>('conversations')).toHaveLength(1);
});
