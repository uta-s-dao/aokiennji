import type { ChatMessage } from '@/lib/contracts';

// This browser keeps a limited convenience copy of past consultations.
// The full staff transcript stays in the server database independently.
export const ARCHIVE_AFTER_MS = 12 * 3600 * 1000;
const CURRENT = 'aoki-chat-current';
const ARCHIVE = 'aoki-chat-archive';
const KEEP_DAYS = 30;
const KEEP_CHATS = 10;
const KEEP_MESSAGES = 40;

export type SavedMessage = Pick<ChatMessage, 'id' | 'role' | 'content' | 'createdAt'>;
export interface SavedChat {
  id: string;
  title: string;
  updatedAt: string;
  messages: SavedMessage[];
}

function read<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage may be full or disabled; the chat still works without it.
  }
}

export function currentChat(): SavedChat | null {
  return read<SavedChat | null>(CURRENT, null);
}
export function isStale(chat: SavedChat) {
  return Date.now() - Date.parse(chat.updatedAt) > ARCHIVE_AFTER_MS;
}
// The time of the last message, so opening the page does not extend it.
export function saveCurrent(id: string, messages: SavedMessage[]) {
  if (!messages.length) return;
  write(CURRENT, {
    id,
    title: messages.find((m) => m.role === 'user')?.content.slice(0, 40) || 'ご相談',
    updatedAt: messages.at(-1)!.createdAt,
    messages: messages.slice(-KEEP_MESSAGES).map(({ id, role, content, createdAt }) => ({
      id,
      role,
      content: content.slice(0, 2000),
      createdAt,
    })),
  } satisfies SavedChat);
}
export function clearCurrent() {
  try {
    localStorage.removeItem(CURRENT);
  } catch {
    // Nothing to clear.
  }
}
export function archivedChats(): SavedChat[] {
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  return read<SavedChat[]>(ARCHIVE, []).filter((c) => Date.parse(c.updatedAt) > cutoff);
}
// Moves the current consultation into this browser's list of past ones.
export function archiveCurrent() {
  const current = currentChat();
  clearCurrent();
  if (!current?.messages.length) return;
  write(
    ARCHIVE,
    [current, ...archivedChats().filter((c) => c.id !== current.id)].slice(0, KEEP_CHATS),
  );
}
export function removeArchived(id?: string) {
  write(ARCHIVE, id ? archivedChats().filter((c) => c.id !== id) : []);
}
