import type { Conversation } from '../contracts';
import type { AdminConversation, AdminConversationDetail } from '../source-verification';
import { ApiError } from './auth';

// Workers substitute this module at build time so development transcripts are
// absent from both the bundle and the production administrator's live history.
export function sourceVerificationReport(): never {
  throw new ApiError(404, 'verification_disabled', '検証記録は開発環境で確認してください。');
}
export function withVerificationConversations(conversations: Conversation[]): AdminConversation[] {
  return [...conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export function verificationConversation(_id: string): AdminConversationDetail | undefined {
  return undefined;
}
