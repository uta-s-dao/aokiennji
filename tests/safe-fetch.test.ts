import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));
vi.mock('undici', () => ({
  Agent: class {
    async close() {}
  },
  fetch: vi.fn(),
}));
import { lookup } from 'node:dns/promises';
import { fetch } from 'undici';
import { safeFetch } from '../lib/server/safe-fetch';
const dns = vi.mocked(lookup),
  network = vi.mocked(fetch);
beforeEach(() => {
  dns.mockReset();
  network.mockReset();
  dns.mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
});
it('checks redirect DNS and blocks an internal destination before a second request', async () => {
  network.mockResolvedValueOnce(
    new Response(null, { status: 302, headers: { location: 'https://169.254.169.254' } }) as never,
  );
  dns
    .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }] as never)
    .mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }] as never);
  await expect(((safeFetch('https://supplier.example')))).rejects.toThrow();
  expect(network).toHaveBeenCalledTimes(1);
});
it('drops source credentials when redirecting to another public host', async () => {
  network
    .mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'https://cdn.example/data' },
      }) as never,
    )
    .mockResolvedValueOnce(new Response('catalog', { status: 200 }) as never);
  const response = await safeFetch('https://supplier.example', {
    headers: { Authorization: 'secret-test-only' },
  });
  expect(response.body.toString()).toBe('catalog');
  expect(
    (network.mock.calls[1][1]?.headers as Record<string, string>).Authorization,
  ).toBeUndefined();
});
it('enforces response byte limits', async () => {
  network.mockResolvedValueOnce(new Response('0123456789', { status: 200 }) as never);
  await expect(((safeFetch('https://supplier.example', { maxBytes: 4 })))).rejects.toThrow();
});
