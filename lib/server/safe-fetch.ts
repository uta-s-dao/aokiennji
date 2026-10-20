import { lookup } from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

const MAX_BYTES = 10 * 1024 * 1024;
const blocked4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked4.addSubnet(address, prefix, 'ipv4');

function publicIP(address: string): boolean {
  if (isIP(address) === 4) return !blocked4.check(address, 'ipv4');
  if (isIP(address) !== 6) return false;
  const lower = address.toLowerCase();
  if (lower.includes('%') || lower.startsWith('::ffff:')) return false;
  // Global unicast only. Exclude documentation, NAT64, and reserved ranges.
  if (!/^[23][0-9a-f]{0,3}:/.test(lower)) return false;
  const blocked6 = new BlockList();
  for (const [ip, bits] of [
    ['2002::', 16],
    ['3fff::', 20],
    ['2001:db8::', 32],
    ['2001::', 32],
    ['2001:10::', 28],
    ['2001:20::', 28],
    ['64:ff9b::', 96],
  ] as const) {
    blocked6.addSubnet(ip, bits, 'ipv6');
  }
  return !blocked6.check(address, 'ipv6');
}

export function validateExternalUrl(raw: string, httpsOnly = false): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('URLが正しくありません');
  }
  if (url.protocol !== 'https:' && (httpsOnly || url.protocol !== 'http:'))
    throw new Error('URLはHTTP(S)のみ指定できます');
  if (url.username || url.password) throw new Error('認証情報付きURLは使用できません');
  if (!url.hostname || url.hostname.endsWith('.') || url.hostname.includes('%'))
    throw new Error('ホスト名が正しくありません');
  if (
    url.hostname.toLowerCase() === 'localhost' ||
    url.hostname.toLowerCase().endsWith('.localhost')
  )
    throw new Error('ローカルホストは使用できません');
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('許可されないポートです');
  return url;
}

export interface SafeFetchOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  httpsOnly?: boolean;
  allowedDomains?: string[];
  signal?: AbortSignal;
  onChunk?: (chunk: Uint8Array) => unknown;
  onResponse?: (status: number, headers: Headers) => void;
}

export interface SafeResponse {
  status: number;
  headers: Headers;
  body: Buffer;
  url: string;
}

function allowedHost(host: string, domains?: string[]): boolean {
  if (!domains?.length) return true;
  return domains.some((domain) => {
    const clean = domain.trim().toLowerCase().replace(/^\*\./, '');
    return clean && (host === clean || host.endsWith(`.${clean}`));
  });
}

export async function safeFetch(
  raw: string,
  options: SafeFetchOptions = {},
): Promise<SafeResponse> {
  let url = validateExternalUrl(raw, options.httpsOnly);
  const originalHost = url.hostname.toLowerCase();
  const maxRedirects = Math.min(Math.max(options.maxRedirects ?? 3, 0), 5);
  const maxBytes = Math.min(Math.max(options.maxBytes ?? MAX_BYTES, 1), MAX_BYTES);
  const timeout = AbortSignal.timeout(Math.min(Math.max(options.timeoutMs ?? 10000, 100), 30000));
  const deadline = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  let method = options.method ?? 'GET';
  let body = options.body;
  let headers = { ...options.headers };
  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    if (!allowedHost(url.hostname.toLowerCase(), options.allowedDomains))
      throw new Error('許可ドメイン外のURLです');
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = await Promise.race([
      (await lookup(hostname, { all: true, verbatim: true })),
      new Promise<never>((_, reject) => {
        if (deadline.aborted) reject(new Error('取得がタイムアウトしました'));
        else
          deadline.addEventListener(
            'abort',
            () => reject(new Error('取得がタイムアウトしました')),
            { once: true },
          );
      }),
    ]);
    if (!addresses.length || addresses.some((item) => !publicIP(item.address)))
      throw new Error('公開IP以外への接続はできません');
    const pinned = addresses[0];
    const dispatcher = new Agent({
      connect: {
        lookup: (_host, _opts, callback) =>
          (_opts as { all?: boolean }).all
            ? callback(null, [pinned] as never)
            : callback(null, pinned.address, pinned.family),
      },
    });
    try {
      const response = await undiciFetch(url, {
        method,
        headers,
        body,
        redirect: 'manual',
        signal: deadline,
        dispatcher,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || redirects === maxRedirects) throw new Error('リダイレクトが多すぎます');
        const next = validateExternalUrl(new URL(location, url).toString(), options.httpsOnly);
        if (url.protocol === 'https:' && next.protocol !== 'https:')
          throw new Error('HTTPSからHTTPへの転送はできません');
        if (next.hostname.toLowerCase() !== originalHost) {
          headers = Object.fromEntries(
            Object.entries(headers).filter(
              ([key]) =>
                !/^(authorization|proxy-authorization|cookie|x-api-key|x-aoki-signature)$/i.test(
                  key,
                ),
            ),
          );
        }
        if (
          response.status === 303 ||
          ((response.status === 301 || response.status === 302) && method === 'POST')
        ) {
          method = 'GET';
          body = undefined;
          headers = Object.fromEntries(
            Object.entries(headers).filter(
              ([key]) => !/^(content-type|content-length)$/i.test(key),
            ),
          );
        }
        url = next;
        continue;
      }
      const length = Number(response.headers.get('content-length'));
      options.onResponse?.(response.status, response.headers as Headers);
      if (Number.isFinite(length) && length > maxBytes) {
        await response.body?.cancel();
        throw new Error('取得サイズが上限を超えています');
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (response.body)
        for await (const chunk of response.body) {
          total += chunk.length;
          if (total > maxBytes) {
            await response.body.cancel();
            throw new Error('取得サイズが上限を超えています');
          }
          chunks.push(chunk);
          await options.onChunk?.(chunk);
        }
      return {
        status: response.status,
        headers: response.headers as Headers,
        body: Buffer.concat(chunks),
        url: url.toString(),
      };
    } finally {
      await dispatcher.close();
    }
  }
  throw new Error('リダイレクトが多すぎます');
}
