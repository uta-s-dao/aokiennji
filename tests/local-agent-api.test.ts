import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import {
  localAgentEndpoint,
  fetchOpenaiResponse,
  responseBudgets,
} from '../lib/server/response-transport';
import { createResponsesServer } from '../scripts/agent-openai-server.mjs';

const token = 'a-local-test-token-with-at-least-32-characters';
const directories: string[] = [];
const servers: Server[] = [];
async function listen(server: Server) {
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
function localEnv(url: string) {
  vi.stubEnv('LOCAL_AGENT_API_URL', url + '/v1/responses');
  vi.stubEnv('DATA_DIR', resolve('.data/verification/transport-test/sandbox'));
  vi.stubEnv('DEMO_MODE', 'true');
  vi.stubEnv('ALLOW_LIVE_ORDERS', 'false');
  vi.stubEnv('NODE_ENV', 'test');
  const directory = mkdtempSync(join(tmpdir(), 'aoki-agent-transport-'));
  directories.push(directory);
  const file = join(directory, 'token');
  writeFileSync(file, token);
  vi.stubEnv('LOCAL_AGENT_API_TOKEN_FILE', file);
}
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it('keeps the real API endpoint and time budgets when the local mode is absent', () => {
  vi.stubEnv('LOCAL_AGENT_API_URL', '');
  expect(localAgentEndpoint()).toBeNull();
  expect(responseBudgets()).toEqual({ request: 8000, chat: 13000, retry: 7000, generation: 12000 });
});
it.each([
  'https://127.0.0.1:4010',
  'http://localhost:4010',
  'http://192.168.1.2:4010',
  'http://example.com:4010',
  'http://user:password@127.0.0.1:4010',
])('rejects unsafe local endpoint %s', (url) => {
  localEnv(url);
  expect(() => localAgentEndpoint()).toThrow();
});
it('rejects production, the migrated normal database, and live orders', () => {
  localEnv('http://127.0.0.1:4010');
  vi.stubEnv('NODE_ENV', 'production');
  expect(() => localAgentEndpoint()).toThrow();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DATA_DIR', resolve('.data'));
  expect(() => localAgentEndpoint()).toThrow();
  vi.stubEnv('DATA_DIR', resolve('.data/verification/test/sandbox'));
  vi.stubEnv('ALLOW_LIVE_ORDERS', 'true');
  expect(() => localAgentEndpoint()).toThrow();
});
it('uses only the bridge credential and delivers actual streamed bytes', async () => {
  let authorization;
  const url = await listen(
    createServer((req, res) => {
      authorization = req.headers.authorization;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"type":"response.output_text.delta","delta":"会話"}\n\n');
      res.end('data: {"type":"response.completed"}\n\n');
    }),
  );
  localEnv(url);
  const chunks: Uint8Array[] = [];
  const response = await fetchOpenaiResponse({
    headers: { Authorization: 'Bearer real-key-must-not-leave' },
    body: '{}',
    onChunk: (chunk) => chunks.push(chunk),
  });
  expect(authorization).toBe('Bearer ' + token);
  expect(response.status).toBe(200);
  expect(Buffer.concat(chunks).toString()).toContain('会話');
});
it('refuses redirects rather than forwarding local credentials', async () => {
  const target = vi.fn((_req, res) => res.end('unexpected'));
  const targetURL = await listen(createServer(target));
  const url = await listen(
    createServer((_req, res) => {
      res.writeHead(302, { Location: targetURL });
      res.end();
    }),
  );
  localEnv(url);
  await expect(fetchOpenaiResponse({ body: '{}' })).rejects.toThrow();
  expect(target).not.toHaveBeenCalled();
});
it('authenticates the API, refuses fabricated web research, and supports SSE completion', async () => {
  const responder = {
    alive: true,
    respond: vi.fn(async (_body, delta) => {
      delta('回答');
      return '回答';
    }),
  };
  const url = await listen(createResponsesServer({ responder, token }));
  expect((await fetch(url + '/v1/responses', { method: 'POST', body: '{}' })).status).toBe(401);
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const request = (data: object) =>
    fetch(url + '/v1/responses', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'local-agent', input: '相談', ...data }),
    });
  expect((await request({ tools: [{ type: 'web_search' }] })).status).toBe(400);
  expect(responder.respond).not.toHaveBeenCalled();
  const response = await request({ stream: true });
  const stream = await response.text();
  expect(stream).toContain('response.output_text.delta');
  expect(stream).toContain('response.completed');
  expect(stream).toContain('"model":"local-agent"');
  expect(stream).toContain('"usage":null');
});
