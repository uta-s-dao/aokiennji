import { readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { safeFetch, type SafeFetchOptions, type SafeResponse } from './safe-fetch';

const OPENAI_RESPONSES = 'https://api.openai.com/v1/responses';

// This switch belongs to the local test launcher, never to saved/public settings.
export function localAgentEndpoint(): string | null {
  const raw = process.env.LOCAL_AGENT_API_URL;
  if (process.env.NODE_ENV === 'production') {
    if (raw) throw Error('Local agent is disabled in production');
    return null;
  }
  if (!raw) return null;
  const dataDir = resolve(/* turbopackIgnore: true */ process.env.DATA_DIR || '.data');
  const normalDir = resolve('.data');
  const canonical = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  if (
    process.env.DEMO_MODE !== 'true' ||
    process.env.ALLOW_LIVE_ORDERS === 'true' ||
    canonical(dataDir) === canonical(normalDir) ||
    !dataDir.startsWith(resolve('.data/verification') + sep)
  )
    throw Error('Local agent requires development mode and an isolated verification database');
  const url = new URL(raw);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.pathname !== '/v1/responses' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw Error('Local agent endpoint must be an explicit loopback Responses URL');
  return url.href;
}

export function responseBudgets(webSearch = false) {
  return localAgentEndpoint()
    ? { request: 120000, chat: 125000, retry: 60000, generation: 120000 }
    : { request: 8000, chat: webSearch ? 55000 : 13000, retry: 7000, generation: 12000 };
}

export function responseEndpoint() {
  return localAgentEndpoint() || OPENAI_RESPONSES;
}

export async function fetchOpenaiResponse(options: SafeFetchOptions): Promise<SafeResponse> {
  const endpoint = localAgentEndpoint();
  if (!endpoint) return safeFetch(OPENAI_RESPONSES, options);
  const tokenFile = process.env.LOCAL_AGENT_API_TOKEN_FILE;
  if (!tokenFile) throw Error('Local agent token file is required');
  const token = readFileSync(tokenFile, 'utf8').trim();
  if (!/^[A-Za-z0-9_-]{32,200}$/.test(token)) throw Error('Invalid local agent token');
  // Deliberately do not forward the real OpenAI Authorization header.
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs || responseBudgets().request),
    ...(options.signal ? [options.signal] : []),
  ]);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: options.body,
    redirect: 'error',
    signal,
  });
  options.onResponse?.(response.status, response.headers);
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > (options.maxBytes || 300000))
          throw Error('Local agent response exceeds byte limit');
        chunks.push(value);
        options.onChunk?.(value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  }
  return {
    status: response.status,
    headers: response.headers,
    body: Buffer.concat(chunks),
    url: endpoint,
  };
}
