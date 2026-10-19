import Database from 'better-sqlite3';
import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { safeFetch } from '../lib/server/safe-fetch';

// Read-only, bounded public-page experiment. No application DB initialization,
// credentials, form submission, login, or stock/lead-time approval.
type Supplier = { supplierName: string; products: string; website: string };
type Rule = { allow: boolean; path: string };
type Robots = { url: string; status?: number; error?: string; rules: Rule[] };
type Page = {
  requestedUrl: string;
  url?: string;
  status?: number;
  error?: string;
  elapsedMs: number;
  title?: string;
  characters?: number;
  encoding?: string;
  appUtf8ReplacementCharacters?: number;
  sha256?: string;
  file?: string;
  stockMentions?: string[];
  deliveryMentions?: string[];
  structuredProducts?: { name?: string; sku?: string; availability: string[] }[];
  links?: { url: string; text: string; score: number }[];
  externalCatalogs?: { url: string; text: string }[];
};

function robotRules(text: string): Rule[] {
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let current = { agents: [] as string[], rules: [] as Rule[] };
  let hasDirective = false;
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([\w-]+)\s*:\s*(.*?)\s*$/.exec(line.split('#')[0]);
    if (!match) continue;
    const [, field, value] = match;
    if (field.toLowerCase() === 'user-agent') {
      if (hasDirective) {
        groups.push(current);
        current = { agents: [], rules: [] };
        hasDirective = false;
      }
      current.agents.push(value.toLowerCase());
    } else if (current.agents.length) {
      hasDirective = true;
      if (/^(allow|disallow)$/i.test(field) && value)
        current.rules.push({ allow: field.toLowerCase() === 'allow', path: value });
    }
  }
  groups.push(current);
  // safeFetch without an override uses undici's default User-Agent.
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && 'undici'.includes(a)));
  return (specific.length ? specific : groups.filter((g) => g.agents.includes('*'))).flatMap(
    (g) => g.rules,
  );
}
function allowed(url: string, rules: Rule[]) {
  const parsed = new URL(url);
  const path = parsed.pathname + parsed.search;
  const matches = rules
    .filter((r) => {
      const pattern = r.path
        .replace(/\$$/, '')
        .split('*')
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
      return new RegExp(`^${pattern}${r.path.endsWith('$') ? '$' : ''}`).test(path);
    })
    .sort(
      (a, b) =>
        b.path.replace(/[*$]/g, '').length - a.path.replace(/[*$]/g, '').length ||
        Number(b.allow) - Number(a.allow),
    );
  return matches[0]?.allow ?? true;
}
function mentions(text: string, pattern: RegExp) {
  return [...text.matchAll(pattern)]
    .slice(0, 5)
    .map((m) => text.slice(Math.max(0, m.index! - 65), m.index! + 125));
}
function decode(body: Buffer, type: string | null) {
  const head = body.subarray(0, 4096).toString('ascii');
  const label =
    /charset\s*=\s*["']?([\w-]+)/i.exec(type || '')?.[1] ||
    /charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1] ||
    'utf-8';
  try {
    return { html: new TextDecoder(label).decode(body), encoding: label };
  } catch {
    return { html: body.toString('utf8'), encoding: 'utf-8 (fallback)' };
  }
}
async function main() {
  const dbPath = resolve(process.argv[2] || '.data/aokienji.sqlite');
  const output = resolve(
    process.argv[3] || `.data/verification/supplier-sites-${new Date().toISOString().slice(0, 10)}`,
  );
  mkdirSync(output, { recursive: true });
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const suppliers: Supplier[] = db
    .prepare('SELECT json FROM supplier_knowledge')
    .all()
    .map((r) => JSON.parse((r as { json: string }).json))
    .filter((s: Supplier) => !process.argv[4] || new RegExp(process.argv[4]).test(s.website));
  db.close();
  const urls = [...new Set(suppliers.map((s) => s.website).filter(Boolean))];
  const robotsCache = new Map<string, Promise<Robots>>();
  const robotsFor = (url: string) => {
    const origin = new URL(url).origin;
    if (!robotsCache.has(origin))
      robotsCache.set(
        origin,
        (async () => {
          const robotsUrl = new URL('/robots.txt', origin).href;
          try {
            const r = await safeFetch(robotsUrl, {
              timeoutMs: 5000,
              maxBytes: 512000,
              maxRedirects: 3,
            });
            writeFileSync(
              resolve(
                output,
                `${createHash('sha256').update(origin).digest('hex').slice(0, 16)}-robots.txt`,
              ),
              r.body,
            );
            return {
              url: robotsUrl,
              status: r.status,
              rules: r.status === 200 ? robotRules(r.body.toString('utf8')) : [],
            };
          } catch (e) {
            return { url: robotsUrl, error: String(e), rules: [] };
          }
        })(),
      );
    return robotsCache.get(origin)!;
  };
  const fetchPage = async (requestedUrl: string): Promise<Page> => {
    const started = Date.now();
    const page: Page = { requestedUrl, elapsedMs: 0 };
    const robots = await robotsFor(requestedUrl);
    // Fail closed for robots failures; 404/410 mean no file, not permission.
    if (robots.error || ![200, 404, 410].includes(robots.status || 0))
      return { ...page, error: 'robots_unverified', elapsedMs: Date.now() - started };
    if (!allowed(requestedUrl, robots.rules))
      return { ...page, error: 'robots_disallowed', elapsedMs: Date.now() - started };
    try {
      // Same timeout, byte limit and redirect limit as sourcing.inspectPage.
      const r = await safeFetch(requestedUrl, {
        timeoutMs: 5000,
        maxBytes: 2000000,
        maxRedirects: 3,
      });
      page.status = r.status;
      page.url = r.url;
      page.sha256 = createHash('sha256').update(r.body).digest('hex');
      page.file = `${page.sha256.slice(0, 20)}.html`;
      writeFileSync(resolve(output, page.file), r.body);
      if (r.status !== 200) return page;
      const decoded = decode(r.body, r.headers.get('content-type'));
      page.encoding = decoded.encoding;
      page.appUtf8ReplacementCharacters = (r.body.toString('utf8').match(/\uFFFD/g) || []).length;
      const $ = cheerio.load(decoded.html);
      page.title = $('title').text().trim().slice(0, 250);
      page.structuredProducts = [];
      const inspect = (v: unknown, depth = 0) => {
        if (!v || typeof v !== 'object' || depth > 8 || page.structuredProducts!.length >= 15)
          return;
        if (Array.isArray(v)) {
          v.slice(0, 100).forEach((item) => inspect(item, depth + 1));
          return;
        }
        const item = v as Record<string, unknown>;
        if ([item['@type']].flat().includes('Product')) {
          const offers = [item.offers].flat() as Record<string, unknown>[];
          page.structuredProducts!.push({
            name: typeof item.name === 'string' ? item.name.slice(0, 120) : undefined,
            sku: typeof item.sku === 'string' ? item.sku.slice(0, 120) : undefined,
            availability: offers
              .filter(Boolean)
              .flatMap((o) => (typeof o.availability === 'string' ? [o.availability] : [])),
          });
        }
        Object.values(item).forEach((child) => inspect(child, depth + 1));
      };
      $('script[type="application/ld+json"]').each((_, el) => {
        try {
          inspect(JSON.parse($(el).text()));
        } catch {
          /* Non-JSON metadata. */
        }
      });
      page.links = [];
      page.externalCatalogs = [];
      $('a[href]').each((_, el) => {
        const a = $(el);
        const label = (a.text() || a.find('img').attr('alt') || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120);
        try {
          const target = new URL(a.attr('href')!, r.url);
          target.hash = '';
          if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password)
            return;
          const key = `${target.pathname} ${label}`;
          if (
            /logout|login|cart|basket|checkout|add_|delete|お問い合わせ|お問合せ|採用|ニュース|privacy/i.test(
              key,
            ) ||
            /\.(pdf|zip|jpg|png|xlsx?)$/i.test(target.pathname)
          )
            return;
          const score =
            (/product|goods|item|shopbrand|shopdetail|\/shop|製品|商品|カタログ|在庫|ショップ|断熱/i.test(
              key,
            )
              ? 5
              : 0) +
            (/detail|item\/|products?\/[^/]+|商品詳細|納期|在庫/i.test(key) ? 4 : 0) +
            (/\/products\/detail|shopdetail|\/shop\/products\/detail/i.test(target.pathname)
              ? 5
              : 0);
          if (!score) return;
          if (target.origin === new URL(r.url).origin)
            page.links!.push({ url: target.href, text: label, score });
          else if (page.externalCatalogs!.length < 12)
            page.externalCatalogs!.push({ url: target.href, text: label });
        } catch {
          /* Invalid or non-HTTP link. */
        }
      });
      page.links = [...new Map(page.links.map((l) => [l.url, l])).values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, 25);
      $('script,style,noscript,svg,iframe,nav,footer,header').remove();
      const text = ($('main').text() || $('body').text()).normalize('NFKC').replace(/\s+/g, ' ');
      page.characters = text.trim().length;
      page.stockMentions = mentions(text, /在庫|欠品|品切れ|受注生産|売り切れ|sold out|in stock/gi);
      page.deliveryMentions = mentions(text, /納期|出荷|発送|お届け|営業日/g);
      return page;
    } catch (e) {
      page.error = String(e);
      return page;
    } finally {
      page.elapsedMs = Date.now() - started;
    }
  };
  const audits: { website: string; pages: Page[] }[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < urls.length) {
        const website = urls[next++];
        const pages = [await fetchPage(website)];
        // Third-party company directories are not product catalog sources.
        const directory = /shigotomarugoto|kitakyushucci/.test(new URL(website).hostname);
        while (!directory && pages.length < 4 && pages[0].status === 200) {
          const candidate = pages
            .toReversed()
            .flatMap((p) => p.links || [])
            .filter((l) => !pages.some((p) => p.requestedUrl === l.url || p.url === l.url))
            .sort((a, b) => b.score - a.score)[0];
          if (!candidate) break;
          await delay(1000);
          pages.push(await fetchPage(candidate.url));
        }
        audits.push({ website, pages });
        writeFileSync(resolve(output, 'progress.json'), JSON.stringify(audits, null, 2));
        console.log(
          `${audits.length}/${urls.length} ${new URL(website).hostname}: ${pages.map((p) => p.error || p.status).join(', ')}`,
        );
      }
    }),
  );
  audits.sort((a, b) => urls.indexOf(a.website) - urls.indexOf(b.website));
  const result = {
    checkedAt: new Date().toISOString(),
    dbPath,
    supplierRows: suppliers.map(({ supplierName, products, website }) => ({
      supplierName,
      products,
      website,
    })),
    uniqueUrls: urls.length,
    robots: await Promise.all(robotsCache.values()),
    audits,
  };
  writeFileSync(resolve(output, 'results.json'), JSON.stringify(result, null, 2));
  const cell = (s: unknown) => `"${String(s ?? '').replaceAll('"', '""')}"`;
  const rows = suppliers.map((s) => {
    const a = audits.find((a) => a.website === s.website);
    return [
      s.supplierName,
      s.products,
      s.website,
      a?.pages[0].status,
      a?.pages[0].error,
      a?.pages.length,
      a?.pages.reduce((n, p) => n + (p.characters || 0), 0),
      a?.pages.flatMap((p) => p.stockMentions || []).join('\n'),
    ]
      .map(cell)
      .join(',');
  });
  writeFileSync(
    resolve(output, 'suppliers.csv'),
    '\uFEFF会社名,取扱品,登録URL,HTTP,エラー,確認ページ数,本文文字数,在庫語の出現（数量保証ではない）\n' +
      rows.join('\n'),
  );
  console.log(`Saved ${suppliers.length} rows / ${audits.length} URLs to ${output}`);
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
