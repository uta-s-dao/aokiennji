import { beforeEach, expect, it, vi } from 'vitest';
import { searchOpenai } from '../lib/server/search-openai';
import { safeFetch } from '../lib/server/safe-fetch';
vi.mock('../lib/server/safe-fetch', () => ({ safeFetch: vi.fn() }));
vi.mock('../lib/server/ai-usage', () => ({
  beginAiCall: vi.fn(async () => ({
    response: vi.fn(),
    usage: vi.fn(),
    tools: vi.fn(),
    finish: vi.fn(),
  })),
  openaiQuotaPaused: () => false,
  quotaError: () => false,
  pauseOpenaiForQuota: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(safeFetch).mockReset();
  vi.stubEnv('OPENAI_API_KEY', 'synthetic');
  vi.stubEnv('OPENAI_SEARCH_MODEL', 'gpt-4.1-mini');
});
it('filters inaccessible domains before limiting consulted discovery results', async () => {
  const blocked = Array.from({ length: 5 }, (_, i) => ({
    title: `Blocked ${i}`,
    url: `https://sub.blocked.example/${i}`,
    content: 'Not retrievable',
  }));
  const accessible = { url: 'https://accessible.example/product' };
  vi.mocked(safeFetch).mockResolvedValue({
    status: 200,
    url: 'https://api.openai.com/v1/responses',
    headers: new Headers(),
    body: Buffer.from(
      JSON.stringify({
        status: 'completed',
        output: [
          { type: 'web_search_call', action: { sources: [...blocked, accessible] } },
          {
            type: 'message',
            content: [{ type: 'output_text', text: JSON.stringify({ results: blocked }) }],
          },
        ],
      }),
    ),
  });
  const result = await searchOpenai(
    '9007 characteristics',
    [],
    { scope: 'chat' },
    undefined,
    undefined,
    ['blocked.example'],
  );
  expect(result.map((e) => e.url)).toEqual([accessible.url]);
  const body = JSON.parse(String(vi.mocked(safeFetch).mock.calls[0][1]?.body));
  expect(body.instructions).toContain('exclude these domains');
  expect(body.instructions).toContain('blocked.example');
  expect(body.tools[0].filters).toBeUndefined();
});
