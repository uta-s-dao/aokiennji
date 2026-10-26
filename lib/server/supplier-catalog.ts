import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import type {
  AppSettings,
  AiUsageContext,
  ChatMessage,
  PreferredSite,
  Source,
  SourceTrace,
  SupplierKnowledge,
  StoredChatMessage,
} from '../contracts';
import { byId, list, now, save } from './db';
import { safeFetch } from './safe-fetch';
import { decodeHtml } from './html';
import {
  finishSourceStage,
  preferredDomains,
  preferredSiteFor,
  preferredSites,
  startSourceStage,
} from './preferred-sources';
import { itemFieldsFromText } from './supplier-knowledge';
import { searchWeb } from './providers';

export type CatalogEntry = { name: string; model?: string };
type CatalogDocument = {
  id: string;
  sourceId: string;
  title: string;
  url: string;
  content: string;
  createdAt: string;
  supplierCatalog: { version: 1; entries: CatalogEntry[] };
};
export const catalogNameKey = (s: string) =>
  s
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[\s®™©]/g, '');
const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

export function productNameLookupReply(
  name: string,
  lookup: NonNullable<ChatMessage['productNameLookup']>,
) {
  const outcome =
    lookup.status === 'identified'
      ? `${lookup.investigation ? '社内資料・登録先ページで、この名称または型番の記載を確認しました。' : '登録仕入先の商品掲載で、この名称に一致する情報を確認しました。'}\n${lookup.matches.map((p) => `掲載商品名：${p.name}${p.model ? `（掲載型番：${p.model}）` : ''}`).join('\n')}\n${lookup.checkedAt ? `掲載確認日：${lookup.checkedAt.slice(0, 10)}。` : ''}掲載型番は製品の識別情報です。必要な寸法・仕様への適合は未確認です。`
      : lookup.status === 'not_searched'
        ? '登録商品を照合しましたが、登録済みの商品掲載索引にも一致する情報がありません。外部サイトの検索は現在無効のため、まだ検索していません。'
        : lookup.status === 'failed'
          ? '外部検索または商品ページの取得を完了できず、掲載の有無を確認できませんでした。'
          : '今回確認できた商品ページの範囲では、この名称に一致する掲載は見つかりませんでした。サイト全体に商品がないという判断ではありません。';
  const progress = lookup.investigation?.question
    ? `\n${lookup.investigation.question}`
    : lookup.investigation && ['step_limit', 'timeout'].includes(lookup.investigation.stopReason)
      ? '\n調査の上限に達したため、確認できた範囲でご案内しています。'
      : '';
  return `「${name}」をお探しですね。\n${outcome}\n当社の販売・調達可否と現在庫は未確認です。お問い合わせから、この名称と必要な仕様を担当者へ送って確認できます。まだ依頼は送信していません。${progress}`;
}

// Match a product name in its own record, never an arbitrary nearby number.
export function catalogEntries(html: string): CatalogEntry[] {
  const $ = cheerio.load(html);
  const entries: CatalogEntry[] = [];
  $('table').each((_, table) => {
    const rows = $(table).find('tr').toArray();
    const header = rows.findIndex((row) => /製品名|商品名|Product name/i.test($(row).text()));
    if (header < 0) return;
    const headings = $(rows[header])
      .find('th,td')
      .toArray()
      .map((c) => clean($(c).text()));
    const nameIndex = headings.findIndex((h) => /^(?:製品名|商品名|Product name)$/i.test(h));
    const modelIndex = headings.findIndex((h) =>
      /型番|品番|製品番号|TOMBO\s*No|Model|SKU/i.test(h),
    );
    if (nameIndex < 0) return;
    for (const row of rows.slice(header + 1)) {
      const cells = $(row)
        .find('td')
        .toArray()
        .map((c) => clean($(c).text()));
      const name = cells[nameIndex];
      const model = modelIndex >= 0 ? cells[modelIndex] : undefined;
      if (name && name.length <= 200 && (!model || model.length <= 100))
        entries.push({ name, ...(model ? { model } : {}) });
    }
  });
  let visited = 0;
  const inspect = (value: unknown, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 8 || ++visited > 1000) return;
    if (Array.isArray(value)) {
      value.forEach((v) => inspect(v, depth + 1));
      return;
    }
    const v = value as Record<string, unknown>;
    if ([v['@type']].flat().includes('Product') && typeof v.name === 'string') {
      const name = clean(v.name);
      const model = [v.model, v.mpn, v.sku].find((m) => typeof m === 'string') as
        string | undefined;
      if (name && name.length <= 200 && (!model || model.length <= 100))
        entries.push({ name, ...(model ? { model: clean(model) } : {}) });
    }
    Object.values(v).forEach((child) => inspect(child, depth + 1));
  };
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      inspect(JSON.parse($(el).text()));
    } catch {
      /* Invalid metadata is not evidence. */
    }
  });
  return [
    ...new Map(entries.map((e) => [`${catalogNameKey(e.name)}\0${e.model || ''}`, e])).values(),
  ].slice(0, 1000);
}

type Rule = { allow: boolean; path: string };
export function catalogRobots(text: string): Rule[] {
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let group = { agents: [] as string[], rules: [] as Rule[] },
    directives = false;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([\w-]+)\s*:\s*(.*?)\s*$/.exec(line.split('#')[0]);
    if (!m) continue;
    const [, key, value] = m;
    if (key.toLowerCase() === 'user-agent') {
      if (directives) {
        groups.push(group);
        group = { agents: [], rules: [] };
        directives = false;
      }
      group.agents.push(value.toLowerCase());
    } else if (group.agents.length) {
      directives = true;
      if (/^(allow|disallow)$/i.test(key) && value)
        group.rules.push({ allow: /^allow$/i.test(key), path: value });
    }
  }
  groups.push(group);
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && 'undici'.includes(a)));
  return (specific.length ? specific : groups.filter((g) => g.agents.includes('*'))).flatMap(
    (g) => g.rules,
  );
}
export function catalogAllowed(raw: string, rules: Rule[]) {
  const u = new URL(raw),
    path = u.pathname + u.search;
  const matches = rules
    .filter((r) => {
      const pattern = r.path
        .replace(/\$$/, '')
        .split('*')
        .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
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

export async function crawlSupplierCatalog(
  site: PreferredSite,
  options: { signal?: AbortSignal; maxPages?: number; seedUrls?: string[] } = {},
) {
  if (!site.eligible || !site.sourceId) throw Error('catalog_source_ineligible');
  const source = await byId<Source>('sources', site.sourceId);
  if (!source?.enabled || (source.kind === 'supplier_catalog' && !source.config.answerEnabled))
    throw Error('catalog_source_disabled');
  const deadline = AbortSignal.any([
    AbortSignal.timeout(20000),
    ...(options.signal ? [options.signal] : []),
  ]);
  const fetchPage = (url: string, maxBytes = 2000000) =>
    safeFetch(url, { allowedDomains: [site.domain], maxBytes, timeoutMs: 4000, signal: deadline });
  const robots = await fetchPage(new URL('/robots.txt', site.url).href, 100000);
  if (![200, 404, 410].includes(robots.status)) throw Error('robots_unverified');
  const rules = catalogRobots(robots.status === 200 ? robots.body.toString('utf8') : '');
  const sameSite = (raw: string) => {
    try {
      const u = new URL(raw);
      return (
        ['http:', 'https:'].includes(u.protocol) &&
        u.hostname.replace(/^www\./, '') === site.domain &&
        !u.username &&
        !u.password
      );
    } catch {
      return false;
    }
  };
  const queue = [...new Set([...(options.seedUrls || []), site.url])]
    .filter(sameSite)
    .map((url) => ({ url, depth: 0 }));
  const seen = new Set<string>(),
    documents: CatalogDocument[] = [],
    failures: string[] = [];
  const maxPages = Math.min(20, Math.max(1, options.maxPages || 8));
  while (queue.length && seen.size < maxPages && !deadline.aborted) {
    const { url, depth } = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    if (!catalogAllowed(url, rules)) {
      if (depth === 0) failures.push(url);
      continue;
    }
    try {
      const response = await fetchPage(url);
      if (
        response.status !== 200 ||
        !sameSite(response.url) ||
        !catalogAllowed(response.url, rules)
      )
        throw Error('catalog_page_unavailable');
      const html = decodeHtml(response.body, response.headers.get('content-type'));
      const $ = cheerio.load(html),
        entries = catalogEntries(html);
      $('script,style,noscript,nav,header,footer,iframe,form,svg').remove();
      const content = clean($('main').text() || $('body').text()).slice(0, 100000);
      const doc: CatalogDocument = {
        id: `supplier-page-${createHash('sha256').update(`${site.sourceId}\0${response.url}`).digest('hex')}`,
        sourceId: site.sourceId!,
        title: clean($('title').text()),
        url: response.url,
        content,
        createdAt: now(),
        supplierCatalog: { version: 1, entries },
      };
      // Refresh also removes obsolete records on pages that no longer list items.
      await save('documents', doc, { source_id: site.sourceId, content: doc.content });
      documents.push(doc);
      if (depth >= 2) continue;
      const links = $('a[href]')
        .toArray()
        .flatMap((a) => {
          try {
            const u = new URL($(a).attr('href')!, response.url);
            u.hash = '';
            if (
              !sameSite(u.href) ||
              u.search ||
              /\.(?:pdf|png|jpe?g|zip|xlsx?|docx?)$/i.test(u.pathname) ||
              !/product|catalog|item|製品|商品|取扱|取り扱/i.test(
                decodeURI(u.pathname) + $(a).text(),
              )
            )
              return [];
            return [{ url: u.href, depth: depth + 1 }];
          } catch {
            return [];
          }
        });
      queue.push(
        ...links
          .filter((l) => !seen.has(l.url) && !queue.some((q) => q.url === l.url))
          .slice(0, 30),
      );
    } catch {
      failures.push(url);
    }
  }
  if (deadline.aborted && queue.length) failures.push(queue[0].url);
  return { documents, failures, limited: queue.length > 0 };
}

// Reuse the existing sync job. Only previously indexed sites are refreshed;
// registering a supplier alone never starts a site-wide crawl.
export async function refreshIndexedSupplierCatalog() {
  const documents = (await list<CatalogDocument>('documents')).filter((d) => d.supplierCatalog);
  const sites = await preferredSites();
  const due = documents
    .filter(
      (d) =>
        Number.isFinite(Date.parse(d.createdAt)) &&
        Date.now() - Date.parse(d.createdAt) >= 86400000,
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const doc of due) {
    const site = sites.find(
      (s) =>
        s.sourceId === doc.sourceId &&
        preferredSiteFor(doc.url, {
          version: 1,
          registeredRevision: '',
          preferredSites: [s],
          stages: [],
          observations: [],
        }),
    );
    if (!site) continue;
    const source = await byId<Source>('sources', site.sourceId!);
    if (!source?.enabled || (source.kind === 'supplier_catalog' && !source.config.answerEnabled))
      continue;
    const seeds = due
      .filter(
        (d) =>
          d.sourceId === site.sourceId &&
          new URL(d.url).hostname.replace(/^www\./, '') === site.domain,
      )
      .map((d) => d.url)
      .slice(0, 5);
    const scan = await crawlSupplierCatalog(site, { seedUrls: seeds });
    return {
      status: scan.failures.length ? ('failed' as const) : ('success' as const),
      detail: {
        processed: 1,
        catalogPages: scan.documents.length,
        errors: scan.failures.length,
        limited: scan.limited,
      },
    };
  }
  return { status: 'success' as const, detail: { processed: 0 } };
}

export async function lookupProductName(
  name: string,
  input: {
    trace: SourceTrace;
    settings: AppSettings;
    context: AiUsageContext;
    signal?: AbortSignal;
    message?: string;
  },
) {
  const { trace, settings } = input;
  const found: CatalogEntry[] = [];
  let checkedAt: string | undefined;
  const registered = startSourceStage(
    trace,
    'registered_data',
    name,
    [],
    '登録済み仕入先の商品掲載索引を商品名で照合',
  );
  const consider = (
    doc: CatalogDocument,
    origin: 'registered_data' | 'preferred_sites' = 'registered_data',
  ) => {
    const matches =
      doc.supplierCatalog?.entries.filter((e) => catalogNameKey(e.name) === catalogNameKey(name)) ||
      [];
    for (const match of matches) {
      found.push(match);
      if (!checkedAt || doc.createdAt < checkedAt) checkedAt = doc.createdAt;
      trace.observations.push({
        title: doc.title,
        url: doc.url,
        sourceId: doc.sourceId,
        origin,
        outcome: 'identified',
        reason: '商品名が同一レコードで一致。自社取扱・在庫は未確認',
        excerpt: JSON.stringify(match),
        retrievedAt: doc.createdAt,
      });
    }
  };
  for (const doc of await list<CatalogDocument>('documents')) {
    if (
      !doc.supplierCatalog ||
      !trace.preferredSites.some(
        (s) =>
          s.eligible &&
          s.sourceId === doc.sourceId &&
          preferredSiteFor(doc.url, { ...trace, preferredSites: [s] }),
      )
    )
      continue;
    const source = await byId<Source>('sources', doc.sourceId);
    const age = Date.now() - Date.parse(doc.createdAt);
    if (
      !source?.enabled ||
      (source.kind === 'supplier_catalog' && !source.config.answerEnabled) ||
      !Number.isFinite(age) ||
      age > 7 * 86400000 ||
      age < 0
    )
      continue;
    consider(doc);
  }
  finishSourceStage(registered, 'done', found.length ? '登録索引で一致' : '登録索引に一致なし');
  const result = (status: 'identified' | 'not_found' | 'not_searched' | 'failed') => ({
    status,
    ...(checkedAt ? { checkedAt } : {}),
    matches: [
      ...new Map(found.map((e) => [`${catalogNameKey(e.name)}\0${e.model || ''}`, e])).values(),
    ],
  });
  const resumeRequested =
    input.context.conversationId &&
    input.message &&
    settings.flags.webSearch &&
    process.env.TYPESAFE_API_KEY &&
    (
      (await (
        await import('./business')
      ).conversationMessages(input.context.conversationId)) as StoredChatMessage[]
    )
      .toReversed()
      .find((m) => m.sourceTrace?.investigation?.subject === name)?.sourceTrace?.investigation
      ?.stopReason === 'needs_customer';
  if (found.length && !resumeRequested) {
    trace.conclusion = '登録索引の商品名に一致。販売・在庫は未確認';
    return result('identified');
  }
  if (
    !settings.flags.webSearch ||
    (settings.searchProvider === 'none' && !process.env.TYPESAFE_API_KEY)
  ) {
    trace.conclusion = '索引に一致なし。外部検索は無効のため未実行';
    return result('not_searched');
  }
  if (process.env.TYPESAFE_API_KEY) {
    const { investigateProduct } = await import('./investigation');
    return investigateProduct(name, {
      ...input,
      message: input.message || name,
      context: { ...input.context, conversationId: input.context.conversationId || '' },
    });
  }
  const stage = startSourceStage(
    trace,
    'preferred_sites',
    name,
    preferredDomains(trace),
    '商品名で登録仕入先を優先検索し、商品ページのレコードを照合',
  );
  try {
    let searchFailed = false;
    const evidence = await searchWeb(name, settings, stage.domains, {
      context: input.context,
      signal: input.signal,
      onSearch: (search) => {
        (stage.searches ||= []).push(search);
      },
    }).catch(() => {
      searchFailed = true;
      return [];
    });
    stage.returnedUrls = evidence.flatMap((e) => (e.url ? [e.url] : []));
    const fields = itemFieldsFromText(name);
    const rows = await list<SupplierKnowledge>('supplier_knowledge');
    const candidates = trace.preferredSites.filter(
      (s) =>
        s.eligible &&
        s.sourceId &&
        (evidence.some((e) => e.url && preferredSiteFor(e.url, trace)?.domain === s.domain) ||
          rows.some(
            (r) =>
              r.approved &&
              r.sourceId === s.sourceId &&
              r.website === s.url &&
              r.fields.some((f) => fields.includes(f)),
          )),
    );
    const sites = [...new Map(candidates.map((s) => [s.domain, s])).values()].slice(0, 2);
    let failed = searchFailed;
    for (const site of sites) {
      const seeds = evidence
        .flatMap((e) =>
          e.url && preferredSiteFor(e.url, trace)?.domain === site.domain ? [e.url] : [],
        )
        .slice(0, 3);
      const scan = await crawlSupplierCatalog(site, { signal: input.signal, seedUrls: seeds });
      scan.documents.forEach((doc) => consider(doc, 'preferred_sites'));
      for (const url of scan.failures)
        trace.observations.push({
          title: '商品ページ取得未完了',
          url,
          sourceId: site.sourceId,
          origin: 'preferred_sites',
          outcome: 'unreachable',
          reason: '取得失敗またはrobots制限',
          excerpt: '',
          retrievedAt: now(),
        });
      failed ||= !!scan.failures.length;
    }
    const status = found.length ? 'identified' : failed || !sites.length ? 'failed' : 'not_found';
    finishSourceStage(
      stage,
      status === 'identified' ? 'done' : status === 'failed' ? 'failed' : 'done',
      found.length
        ? '商品名に一致する掲載を確認。販売・在庫は未確認'
        : '件数・深さを限定した照合。サイト全体の不存在を意味しない',
    );
    trace.conclusion = stage.reason;
    return result(status);
  } catch {
    finishSourceStage(stage, 'failed', '外部検索または商品ページ取得を完了できませんでした');
    trace.conclusion = stage.reason;
    return result('failed');
  }
}
