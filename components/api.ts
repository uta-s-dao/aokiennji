import type { ApiResult } from '@/lib/contracts';

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      ...init,
      headers:
        init?.body instanceof FormData
          ? init.headers
          : { 'Content-Type': 'application/json', ...init?.headers },
    });
  } catch {
    throw new ApiError(
      'NETWORK_ERROR',
      '通信できませんでした。接続を確認して再度お試しください。',
      0,
    );
  }
  let result: ApiResult<T>;
  try {
    result = await response.json();
  } catch {
    throw new ApiError(
      'INVALID_RESPONSE',
      'サーバーからの応答を読み取れませんでした。',
      response.status,
    );
  }
  if (!response.ok || result.error || result.data === undefined)
    throw new ApiError(
      result.error?.code || 'REQUEST_FAILED',
      result.error?.message || '処理を完了できませんでした。',
      response.status,
    );
  return result.data;
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '処理を完了できませんでした。';
}
export function yen(value: number | null | undefined): string {
  return typeof value === 'number' ? `${new Intl.NumberFormat('ja-JP').format(value)}円` : '要確認';
}
export function date(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleDateString('ja-JP') : '未確認';
}
export function datetime(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString('ja-JP') : '未確認';
}

export function localDateTime(value: string): string {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

export async function streamChat(
  input: { message: string; conversationId?: string },
  onText: (text: string) => void,
): Promise<import('@/lib/contracts').ChatResponse> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(65000),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || '回答を取得できませんでした。');
  }
  if (!response.body) throw new Error('回答を読み取れませんでした。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: import('@/lib/contracts').ChatResponse | undefined;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trimEnd();
        buffer = buffer.slice(index + 1);
        if (!line.startsWith('data: ')) continue;
        const event = JSON.parse(line.slice(6));
        if (event.type === 'text') onText(event.data);
        if (event.type === 'result') result = event.data;
        if (event.type === 'error') throw new Error(event.data);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (!result) throw new Error('回答が途中で切れました。もう一度お試しください。');
  return result;
}
