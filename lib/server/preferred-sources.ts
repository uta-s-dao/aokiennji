import type {
  AppSettings,
  AiUsageContext,
  Evidence,
  PreferredSite,
  Product,
  Source,
  SourceObservation,
  SourceSearchStage,
  SourceTrace,
  Supplier,
  SupplierKnowledge,
} from '../contracts';
import { byId, db, list, now } from './db';
import { modelIdentity, exactModelOnPage } from './product-model';
import { withSupplierSiteAudit } from './supplier-site-audit';
import { searchWeb } from './providers';
import { createHash } from 'node:crypto';

function website(raw: string) {
  try {
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return;
    url.hash = '';
    return { url: url.href, domain: url.hostname.replace(/^www\./, '') };
  } catch {
    return;
  }
}

export async function preferredSites(): Promise<PreferredSite[]> {
  const sites: PreferredSite[] = [];
  const sources = await list<Source>('sources');
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const add = (raw: string, rest: Omit<PreferredSite, 'url' | 'domain'>) => {
    const parsed = website(raw);
    if (parsed) sites.push({ ...parsed, ...rest });
  };
  for (const row of await list<SupplierKnowledge>('supplier_knowledge')) {
    const source = sourceById.get(row.sourceId);
    if (!row.approved || !source?.enabled) continue;
    const audit = withSupplierSiteAudit(row).siteAudit;
    add(row.website, {
      name: row.supplierName,
      sourceId: source.id,
      kind: 'supplier_catalog',
      eligible: audit?.fetchStatus !== 'held',
      reason:
        audit?.fetchStatus === 'held'
          ? audit.reason
          : '登録済みの仕入先。商品・在庫・取引条件は別途確認',
    });
  }
  for (const source of sources.filter((s) => s.enabled)) {
    // API/CSV endpoints are ingested as records, not treated as HTML product pages.
    if (source.kind === 'website')
      add(source.url, {
        name: source.name,
        sourceId: source.id,
        kind: 'source',
        eligible: true,
        reason: '情報源・取込に登録されたWebサイト',
      });
    for (const domain of source.config.allowedDomains || [])
      add(`https://${domain}/`, {
        name: source.name,
        sourceId: source.id,
        kind: 'source',
        eligible: true,
        reason: '情報源に登録された参照ドメイン',
      });
  }
  for (const supplier of (await list<Supplier>('suppliers')).filter((s) => s.approved && s.enabled))
    for (const domain of supplier.domains)
      add(`https://${domain}/`, {
        name: supplier.name,
        kind: 'supplier',
        eligible: true,
        reason: '承認済み仕入先の参照ドメイン',
      });
  return sites;
}
export async function createSourceTrace(): Promise<SourceTrace> {
  // Hash records at the database instead of transferring and JSON-parsing every
  // document body just to check whether evidence changed. No cross-request cache:
  // edits, deletions and disabled sources affect the very next read.
  const revisions = await db()
    .prepare(
      ['sources', 'documents', 'products', 'supplier_knowledge', 'suppliers']
        .map(
          (table) =>
            `SELECT '${table}' AS name, md5(coalesce(string_agg(id || ':' || md5(json), ',' ORDER BY id), '')) AS revision FROM ${table}`,
        )
        .join(' UNION ALL '),
    )
    .all();
  const registeredRevision = createHash('sha256').update(JSON.stringify(revisions)).digest('hex');
  return {
    version: 1,
    registeredRevision,
    preferredSites: await preferredSites(),
    stages: [],
    observations: [],
  };
}
export const preferredDomains = (trace: SourceTrace) => [
  ...new Set(trace.preferredSites.filter((s) => s.eligible).map((s) => s.domain)),
];
export function preferredSiteFor(url: string, trace: SourceTrace) {
  const parsed = website(url);
  return (
    parsed &&
    trace.preferredSites.find(
      (s) => s.eligible && (parsed.domain === s.domain || parsed.domain.endsWith(`.${s.domain}`)),
    )
  );
}
export function startSourceStage(
  trace: SourceTrace,
  scope: SourceSearchStage['scope'],
  query: string,
  domains: string[],
  reason: string,
) {
  const stage: SourceSearchStage = {
    scope,
    query,
    domains,
    reason,
    startedAt: now(),
    completedAt: null,
    status: 'running',
    returnedUrls: [],
  };
  trace.stages.push(stage);
  return stage;
}
export function finishSourceStage(
  stage: SourceSearchStage,
  status: SourceSearchStage['status'],
  reason?: string,
) {
  stage.status = status;
  stage.completedAt = now();
  if (reason) stage.reason = reason;
}
export async function registeredModelRecords(model: string): Promise<SourceObservation[]> {
  const records: SourceObservation[] = [];
  for (const p of await list<Product>('products')) {
    const source = p.sourceId && (await byId<Source>('sources', p.sourceId));
    if (!source || !source.enabled || modelIdentity(p.model) !== modelIdentity(model)) continue;
    records.push({
      title: `${source.name}：${p.name}`,
      url: source.url,
      sourceId: source.id,
      origin: 'registered_data',
      outcome: 'identified',
      reason: '登録商品に型番が一致。販売価格を仕入価格へ流用せず、調達条件は担当者確認',
      excerpt: JSON.stringify({
        model: p.model,
        description: p.description,
        specifications: p.specifications,
        availability: p.availability,
        approved: p.approved,
        verifiedAt: p.verifiedAt,
        isDemo: p.isDemo,
      }),
      retrievedAt: p.updatedAt,
    });
  }
  for (const doc of await list<{
    id: string;
    sourceId: string;
    title: string;
    content: string;
    url: string;
    createdAt: string;
    supplierCatalog?: unknown;
  }>('documents')) {
    const source = await byId<Source>('sources', doc.sourceId);
    // Listing indexes have their own record-level matching, freshness and access checks.
    if (doc.supplierCatalog || !source?.enabled || !exactModelOnPage(model, doc.content)) continue;
    const index = doc.content.toUpperCase().indexOf(model.toUpperCase());
    records.push({
      title: `${source.name}：${doc.title}`,
      url: doc.url || source.url,
      sourceId: source.id,
      origin: 'registered_data',
      outcome: 'identified',
      reason: '取込資料に型番の記載あり。調達・在庫は担当者確認',
      excerpt: doc.content.slice(Math.max(0, index - 250), Math.max(0, index - 250) + 1800),
      retrievedAt: doc.createdAt,
    });
  }
  return records;
}
export async function searchRegisteredFirst(
  query: string,
  settings: AppSettings,
  trace: SourceTrace,
  options: { context?: AiUsageContext; signal?: AbortSignal } = {},
): Promise<Evidence[]> {
  const domains = preferredDomains(trace);
  const scopes = domains.length
    ? (['preferred_sites', 'public_web'] as const)
    : (['public_web'] as const);
  for (const scope of scopes) {
    const stage = startSourceStage(
      trace,
      scope,
      query,
      scope === 'preferred_sites' ? domains : [],
      scope === 'preferred_sites'
        ? '登録参照先を優先検索'
        : domains.length
          ? '登録参照先では候補を取得できなかったため外部Webへ拡張'
          : '有効な登録参照サイトがないため外部Webを検索',
    );
    try {
      const found = await searchWeb(query, settings, stage.domains, {
        ...options,
        onSearch: (search) => {
          (stage.searches ||= []).push(search);
        },
      });
      stage.returnedUrls = found.flatMap((e) => (e.url ? [e.url] : []));
      finishSourceStage(stage, 'done');
      found.forEach((e) => {
        const site = preferredSiteFor(e.url || '', trace);
        trace.observations.push({
          title: e.title,
          url: e.url || '',
          sourceId: site?.sourceId,
          origin: site ? 'preferred_sites' : scope,
          outcome: 'discovered',
          reason: '検索結果。商品・購入条件は未照合',
          excerpt: e.excerpt,
          retrievedAt: e.retrievedAt,
        });
      });
      if (found.length)
        return found.map((e) =>
          preferredSiteFor(e.url || '', trace) ? { ...e, visibility: 'internal' } : e,
        );
    } catch (error) {
      finishSourceStage(stage, 'failed', error instanceof Error ? error.message : '検索失敗');
      if (options.signal?.aborted || scope === 'public_web') throw error;
    }
  }
  return [];
}
