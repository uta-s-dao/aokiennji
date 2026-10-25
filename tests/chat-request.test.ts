import { expect, it, vi } from 'vitest';
import { chatRequest } from '../lib/server/chat-request';
import { answerChat, currentMessages } from '../lib/server/chat';
import { db } from '../lib/server/db';

it('replays a completed answer without another turn or generation', async () => {
  const action = vi.fn((receipt) =>
    answerChat('会社の住所を教えて', 'retry-owner', undefined, { receipt }),
  );
  const input = { message: '会社の住所を教えて' };
  const first = await chatRequest('retry-owner', 'lost-response', input, action);
  const again = await chatRequest('retry-owner', 'lost-response', input, action);
  expect(again).toEqual(first);
  expect(action).toHaveBeenCalledTimes(1);
  expect(await currentMessages(first.conversationId)).toHaveLength(2);
});
it('joins concurrent sends while keeping identical deliberate questions separate', async () => {
  const action = vi.fn(async (receipt) => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return answerChat('会社の住所を教えて', 'concurrent', undefined, { receipt });
  });
  const input = { message: '会社の住所を教えて' };
  const results = await Promise.all([
    chatRequest('concurrent', 'same', input, action),
    chatRequest('concurrent', 'same', input, action),
  ]);
  expect(results[0]).toEqual(results[1]);
  expect(action).toHaveBeenCalledTimes(1);
  const deliberate = await chatRequest('concurrent', 'new-key', input, action);
  expect(deliberate.conversationId).not.toBe(results[0].conversationId);
});
it('isolates owners and rejects changing the contents of a received request', async () => {
  const input = { message: '会社の住所を教えて' };
  const a = await chatRequest('owner-a', 'same-key', input, (receipt) =>
    answerChat(input.message, 'owner-a', undefined, { receipt }),
  );
  const b = await chatRequest('owner-b', 'same-key', input, (receipt) =>
    answerChat(input.message, 'owner-b', undefined, { receipt }),
  );
  expect(a.conversationId).not.toBe(b.conversationId);
  await expect(
    chatRequest('owner-a', 'same-key', { message: '違う質問' }, async () => a),
  ).rejects.toMatchObject({ status: 409 });
});
it('reuses the received question and assistant IDs after a failed generation', async () => {
  const input = { message: '会社の住所を教えて' };
  await expect(
    chatRequest('failed-owner', 'retry', input, async (receipt) => {
      await answerChat(input.message, 'failed-owner', undefined, { receipt });
      throw new Error('simulated failure after receipt');
    }),
  ).rejects.toThrow('simulated');
  const result = await chatRequest('failed-owner', 'retry', input, (receipt) =>
    answerChat(input.message, 'failed-owner', undefined, { receipt }),
  );
  expect(await currentMessages(result.conversationId)).toHaveLength(2);
  const count = await db()
    .prepare('SELECT count(*) AS n FROM conversations WHERE owner_id=?')
    .get('failed-owner');
  expect(Number(count.n)).toBe(1);
});
