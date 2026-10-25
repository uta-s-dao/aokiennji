import { createHash } from 'node:crypto';
import type { ChatResponse } from '../contracts';
import { ApiError } from './auth';
import { db, lockResource, uid } from './db';

type Receipt = { conversationId: string; userId: string; assistantId: string };
type State = {
  receipt: Receipt;
  attempt: string;
  startedAt: number;
  status: 'running' | 'failed' | 'done';
  result?: ChatResponse;
};

// Short transactions protect reservations; answer generation keeps its own
// durable receipt/partial-message transactions and never holds a DB lock open.
export async function chatRequest(
  owner: string,
  key: string,
  input: { message: string; conversationId?: string; attachmentIds?: string[] },
  action: (receipt: Receipt) => Promise<ChatResponse>,
): Promise<ChatResponse> {
  const scope = `chat:${owner}`;
  const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const attempt = uid();
  const deadline = Date.now() + 185000;
  while (true) {
    const state = await db().transaction(async () => {
      await lockResource(`${scope}:${key}`);
      const row = await db()
        .prepare('SELECT request_hash,response FROM request_keys WHERE scope=? AND key=?')
        .get(scope, key);
      if (row && row.request_hash !== hash)
        throw new ApiError(409, 'chat_request_conflict', '同じ受付キーでは内容を変更できません。');
      const old: State | undefined = row && JSON.parse(row.response);
      if (
        old?.status === 'done' ||
        (old?.status === 'running' && Date.now() - old.startedAt < 240000)
      )
        return old;
      const next: State = {
        receipt: old?.receipt || {
          conversationId: input.conversationId || uid(),
          userId: uid(),
          assistantId: uid(),
        },
        attempt,
        startedAt: Date.now(),
        status: 'running',
      };
      await db()
        .prepare(
          'INSERT INTO request_keys(scope,key,request_hash,response) VALUES(?,?,?,?) ON CONFLICT(scope,key) DO UPDATE SET response=excluded.response',
        )
        .run(scope, key, hash, JSON.stringify(next));
      return next;
    })();
    if (state.status === 'done') return state.result!;
    if (state.attempt === attempt) {
      try {
        const result = await action(state.receipt);
        await db()
          .prepare('UPDATE request_keys SET response=? WHERE scope=? AND key=?')
          .run(JSON.stringify({ ...state, status: 'done', result }), scope, key);
        return result;
      } catch (error) {
        await db()
          .prepare('UPDATE request_keys SET response=? WHERE scope=? AND key=?')
          .run(JSON.stringify({ ...state, status: 'failed' }), scope, key);
        throw error;
      }
    }
    if (Date.now() >= deadline)
      throw new ApiError(
        503,
        'chat_still_running',
        '回答を処理中です。しばらく待ってから再試行してください。',
      );
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
