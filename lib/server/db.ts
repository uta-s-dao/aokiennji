import { asyncForEach } from '@/lib/async-arrays';
import { randomUUID } from 'node:crypto';
import { DEFAULT_SETTINGS, type AppSettings, type Product, type Source } from '../contracts';
import { database } from './database';
export { lockResource } from './database';
export const now = () => new Date().toISOString();
export const uid = () => randomUUID();
export const demoMode = () => process.env.DEMO_MODE !== 'false';
export function db() {
  return database;
}
// Explicit development fixture; never called implicitly on application startup.
export async function seedDemoData() {
  await seedDemo(database);
}
async function seedDemo(conn: typeof database) {
  if (!demoMode() || (await conn.prepare("SELECT key FROM metadata WHERE key='demo_seeded'").get()))
    return;
  await conn
    .prepare("INSERT INTO metadata(key,value) VALUES('demo_seeded','1') ON CONFLICT DO NOTHING")
    .run();
  const createdAt = now();
  const source: Source = {
    id: 'demo-catalog',
    name: '確認用サンプル商品',
    kind: 'manual',
    url: '',
    enabled: true,
    trust: 'internal',
    visibility: 'public',
    syncIntervalHours: 0,
    config: {},
    lastSyncedAt: createdAt,
    lastError: null,
    recordCount: 6,
    createdAt,
  };
  await conn
    .prepare('INSERT INTO sources(id,json) VALUES(?,?) ON CONFLICT DO NOTHING')
    .run(source.id, JSON.stringify(source));
  await conn.prepare('INSERT INTO suppliers(id,json) VALUES(?,?) ON CONFLICT DO NOTHING').run(
    'demo-supplier',
    JSON.stringify({
      id: 'demo-supplier',
      name: '検証用の架空仕入先',
      approved: true,
      enabled: true,
      domains: [],
      orderEndpoint: '',
      authEnv: '',
      notes: 'デモ注文のみ',
      createdAt,
    }),
  );
  const examples: Array<[string, string, string, string]> = [
    [
      '耐熱ガラス（確認用）',
      'DEMO-GLASS-01',
      '耐熱ガラス・鋳物',
      '用途、寸法、使用温度に合わせて相談する確認用データです。',
    ],
    [
      '炉内金物（確認用）',
      'DEMO-FURNACE-01',
      '耐火材・炉内金物',
      '材質、取付条件を確認する確認用データです。',
    ],
    [
      'スタッド部材（確認用）',
      'DEMO-STUD-01',
      '耐火材・炉内金物',
      '径、長さ、施工条件を確認する確認用データです。',
    ],
    [
      '鋳物部品（確認用）',
      'DEMO-CAST-01',
      '耐熱ガラス・鋳物',
      '図面と用途に合わせて相談する確認用データです。',
    ],
    [
      '排ガスダクト（確認用）',
      'DEMO-DUCT-01',
      '鋼構造物・機械装置',
      '寸法と現場条件から製作を相談する確認用データです。',
    ],
    [
      '搬送台車（確認用）',
      'DEMO-CART-01',
      '鋼構造物・機械装置',
      '積載量と搬送環境を確認する確認用データです。',
    ],
  ];
  const insert = conn.prepare(
    'INSERT INTO products(id,source_id,supplier_id,model_key,json) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING',
  );
  await conn.transaction(
    async () =>
      await asyncForEach(examples, async ([name, model, category, description], i) => {
        const p: Product = {
          id: `demo-${i + 1}`,
          name,
          model,
          manufacturer: '',
          category,
          description,
          specifications: '仕様は相談時に確認します。',
          image: '',
          availability: i < 2 ? 'available' : i < 4 ? 'orderable' : 'needs_review',
          price: i < 4 ? 4800 + i * 1200 : null,
          stock: i < 2 ? 12 + i * 8 : null,
          leadTime: i < 4 ? '確認後3〜5営業日（デモ）' : '',
          sourceId: source.id,
          supplierId: 'demo-supplier',
          approved: true,
          visibility: 'public',
          verifiedAt: createdAt,
          isDemo: true,
          createdAt,
          updatedAt: createdAt,
        };
        await insert.run(p.id, p.sourceId, p.supplierId, productIdentity(p), JSON.stringify(p));
      }),
  )();
}
export function normalize(s: string) {
  return s
    .normalize('NFKC')
    .toLocaleLowerCase('ja')
    .replace(/[\s\-‐‑‒–—―ー_]/g, '');
}
export function productIdentity(p: Pick<Product, 'manufacturer' | 'model'>) {
  return p.model ? `${normalize(p.manufacturer)}:${normalize(p.model)}` : '';
}
export async function getSettings(): Promise<AppSettings> {
  const saved = JSON.parse(
    ((await db().prepare('SELECT json FROM settings WHERE id=1').get()) as { json: string }).json,
  );
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    flags: { ...DEFAULT_SETTINGS.flags, ...saved.flags },
    faq: { ...DEFAULT_SETTINGS.faq, ...saved.faq },
    sourcingEstimate: { ...DEFAULT_SETTINGS.sourcingEstimate, ...saved.sourcingEstimate },
  };
}
export async function putSettings(s: AppSettings) {
  await db().prepare('UPDATE settings SET json=? WHERE id=1').run(JSON.stringify(s));
}
export async function list<T>(table: string): Promise<T[]> {
  if (
    ![
      'products',
      'sources',
      'source_runs',
      'documents',
      'suppliers',
      'supplier_knowledge',
      'conversations',
      'messages',
      'inquiries',
      'quotes',
      'orders',
      'audit_events',
    ].includes(table)
  )
    throw Error('Invalid table');
  return ((await db().prepare(`SELECT json FROM ${table}`).all()) as { json: string }[]).map((r) =>
    JSON.parse(r.json),
  );
}
export async function byId<T>(table: string, id: string): Promise<T | undefined> {
  if (
    ![
      'products',
      'sources',
      'source_runs',
      'documents',
      'suppliers',
      'supplier_knowledge',
      'conversations',
      'messages',
      'inquiries',
      'quotes',
      'orders',
      'audit_events',
    ].includes(table)
  )
    throw Error('Invalid table');
  const r = (await db().prepare(`SELECT json FROM ${table} WHERE id=?`).get(id)) as
    { json: string } | undefined;
  return r && JSON.parse(r.json);
}
export async function save<T extends { id: string }>(
  table: string,
  value: T,
  extra: Record<string, string | null> = {},
) {
  const allowed: Record<string, string[]> = {
    products: ['source_id', 'supplier_id', 'model_key'],
    sources: [],
    source_runs: ['source_id'],
    documents: ['source_id', 'content'],
    suppliers: [],
    supplier_knowledge: ['source_id'],
    conversations: ['owner_id'],
    messages: ['conversation_id'],
    inquiries: [],
    quotes: ['token'],
    orders: ['quote_id', 'idempotency_key'],
    audit_events: [],
    research_notes: ['conversation_id', 'created_at'],
    procurement_cases: ['context_key', 'model_key'],
    procurement_events: ['context_key', 'case_id'],
  };
  if (
    !Object.hasOwn(allowed, table) ||
    Object.keys(extra).some((key) => !allowed[table].includes(key))
  )
    throw new Error('Invalid table or column');
  const cols = ['id', ...Object.keys(extra), 'json'];
  const vals = [value.id, ...Object.values(extra), JSON.stringify(value)];
  const updates = cols
    .slice(1)
    .filter((c) => !(table === 'conversations' && c === 'owner_id'))
    .map((c) =>
      table === 'conversations' && c === 'json'
        ? "json=CASE WHEN conversations.json::jsonb->>'status'='handed_off' AND excluded.json::jsonb->>'status'='open' THEN jsonb_set(excluded.json::jsonb,'{status}','\"handed_off\"'::jsonb)::text ELSE excluded.json END"
        : `${c}=excluded.${c}`,
    );
  await db()
    .prepare(
      `INSERT INTO ${table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${updates.join(',')}`,
    )
    .run(...vals);
}
export async function audit(action: string, entityId: string, summary: string, actorId?: string) {
  const value = {
    id: uid(),
    action,
    entityId,
    summary,
    createdAt: now(),
    ...(actorId ? { actorId } : {}),
  };
  await save('audit_events', value);
}
export async function resetDbForTests() {
  return await database.close();
}
