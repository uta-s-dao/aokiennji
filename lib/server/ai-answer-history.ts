import type { AiAnswer, AiAnswerReport, AiCall, StoredChatMessage } from '../contracts';
import { db } from './db';

export function aiAnswerReport(
  filters: {
    provider?: AiCall['provider'] | 'local';
    since?: string;
    until?: string;
    conversationId?: string;
    limit?: number;
  } = {},
): AiAnswerReport {
  const database = db();
  const calls = new Map<string, AiCall[]>();
  const callRows = filters.conversationId
    ? database
        .prepare(
          "SELECT json FROM ai_calls WHERE scope='chat' AND conversation_id=? ORDER BY created_at, rowid",
        )
        .all(filters.conversationId)
    : database
        .prepare("SELECT json FROM ai_calls WHERE scope='chat' ORDER BY created_at, rowid")
        .all();
  for (const row of callRows as { json: string }[]) {
    const call = JSON.parse(row.json) as AiCall;
    if (!call.context.conversationId || !call.context.turnId) continue;
    const key = JSON.stringify([call.context.conversationId, call.context.turnId]);
    calls.set(key, [...(calls.get(key) || []), call]);
  }
  const rows = filters.conversationId
    ? database
        .prepare('SELECT conversation_id,json FROM messages WHERE conversation_id=? ORDER BY rowid')
        .all(filters.conversationId)
    : database.prepare('SELECT conversation_id,json FROM messages ORDER BY rowid').all();
  const pending = new Map<string, string[]>();
  const answers: AiAnswer[] = [];
  for (const row of rows as { conversation_id: string; json: string }[]) {
    const message = JSON.parse(row.json) as StoredChatMessage;
    const conversationId = row.conversation_id;
    if (message.role === 'user') {
      pending.set(conversationId, [...(pending.get(conversationId) || []), message.id]);
      continue;
    }
    const questions = pending.get(conversationId) || [];
    // Older transcripts predate explicit links. Only pair an unambiguous adjacent turn.
    const turnId = message.replyToId || (questions.length === 1 ? questions[0] : undefined);
    pending.set(conversationId, message.replyToId ? questions.filter((id) => id !== turnId) : []);
    const answer: AiAnswer = {
      id: message.id,
      conversationId,
      content: message.content,
      createdAt: message.createdAt,
      incomplete: !!message.incomplete,
      responseProvider: message.processing?.responseProvider || message.responseProvider || null,
      route: message.route || null,
      processing: message.processing || null,
      linkage: message.replyToId ? 'recorded' : turnId ? 'legacy' : 'unknown',
      calls: turnId ? calls.get(JSON.stringify([conversationId, turnId])) || [] : [],
    };
    if (filters.since && answer.createdAt < filters.since) continue;
    if (filters.until && answer.createdAt > filters.until) continue;
    if (
      filters.provider &&
      answer.responseProvider !== filters.provider &&
      !answer.calls.some((c) => c.provider === filters.provider)
    )
      continue;
    answers.push(answer);
  }
  // rowid order breaks ties in timestamps and keeps the most recent reply first.
  answers.reverse().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return {
    total: answers.length,
    items: answers.slice(0, Math.min(Math.max(filters.limit || 200, 1), 500)),
  };
}
