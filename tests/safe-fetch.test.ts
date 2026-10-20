import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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
  await expect(safeFetch('https://supplier.example')).rejects.toThrow();
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
  await expect(safeFetch('https://supplier.example', { maxBytes: 4 })).rejects.toThrow();
});

afterEach(() => vi.unstubAllGlobals());
function workerFetch() {
  vi.stubGlobal('navigator', { userAgent: 'Cloudflare-Workers' });
  const native = vi.fn();
  vi.stubGlobal('fetch', native);
  return native;
}
it('uses Workers public HTTP egress after checking CNAME and public IP answers', async () => {
  const native = workerFetch();
  dns.mockResolvedValue([
    { address: 'cdn.example.', family: 4 },
    { address: '93.184.216.34', family: 4 },
  ] as never);
  native.mockResolvedValue(new Response('catalog'));
  expect((await safeFetch('https://supplier.example')).body.toString()).toBe('catalog');
  expect(network).not.toHaveBeenCalled();
  expect(native).toHaveBeenCalledTimes(1);
});
it('blocks private DNS answers on Workers, including mixed public and private records', async () => {
  const native = workerFetch();
  dns.mockResolvedValue([
    { address: '93.184.216.34', family: 4 },
    { address: '10.0.0.1', family: 4 },
  ] as never);
  await expect(safeFetch('https://supplier.example')).rejects.toThrow('公開IP');
  expect(native).not.toHaveBeenCalled();
});
it('rechecks redirects on Workers and strips credentials before the next public request', async () => {
  const native = workerFetch();
  native
    .mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'https://cdn.example/data' } }),
    )
    .mockResolvedValueOnce(new Response('catalog'));
  await safeFetch('https://supplier.example', {
    headers: { Authorization: 'test-secret', Cookie: 'test-cookie' },
  });
  expect(native.mock.calls[1][1].headers).toEqual({});
  expect(dns).toHaveBeenCalledTimes(2);
});
it('blocks a private redirect on Workers before a second fetch', async () => {
  const native = workerFetch();
  native.mockResolvedValueOnce(
    new Response(null, { status: 302, headers: { location: 'https://internal.example' } }),
  );
  dns
    .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }] as never)
    .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }] as never);
  await expect(safeFetch('https://supplier.example')).rejects.toThrow('公開IP');
  expect(native).toHaveBeenCalledTimes(1);
});
