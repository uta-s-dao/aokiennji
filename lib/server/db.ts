import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_SETTINGS, type AppSettings, type Product, type Source } from '../contracts';

let singleton: Database.Database | undefined;
export const now = () => new Date().toISOString();
export const uid = () => randomUUID();
export const demoMode = () => process.env.DEMO_MODE !== 'false';

export function db(): Database.Database {
  if (singleton) return singleton;
  // Vercel Functions have no durable local disk. Use their writable temp area
  // for an explicitly disposable demo only; production must set DATA_DIR on a
  // persistent Node host or replace SQLite with a managed database.
  const dir =
    process.env.DATA_DIR ||
    (process.env.VERCEL ? '/tmp/aokienji-demo' : join(process.cwd(), '.data'));
  mkdirSync(dir, { recursive: true });
  const conn = new Database(join(dir, 'aokienji.sqlite'));
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  conn.exec(`
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, source_id TEXT, supplier_id TEXT, model_key TEXT, json TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_product_source_model ON products(source_id,model_key) WHERE source_id IS NOT NULL AND model_key IS NOT NULL AND model_key!='';
    CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS source_runs (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, content TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS suppliers (id TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS supplier_knowledge (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, json TEXT NOT NULL, FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE);
    CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id);
    CREATE TABLE IF NOT EXISTS inquiries (id TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS quotes (id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, quote_id TEXT NOT NULL UNIQUE, idempotency_key TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ai_calls (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, provider TEXT NOT NULL, conversation_id TEXT, turn_id TEXT, scope TEXT NOT NULL, json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS ai_calls_created ON ai_calls(created_at);
    CREATE INDEX IF NOT EXISTS ai_calls_turn ON ai_calls(turn_id);
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, kind TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS rate_limits (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS import_previews (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, expires_at INTEGER NOT NULL, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS research_notes (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, created_at TEXT NOT NULL, json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS research_notes_conversation ON research_notes(conversation_id);
  `);
  conn
    .prepare('INSERT OR IGNORE INTO settings(id,json) VALUES(1,?)')
    .run(JSON.stringify(DEFAULT_SETTINGS));
  singleton = conn;
  seedDemo(conn);
  if (!conn.prepare("SELECT key FROM metadata WHERE key='product_identity_v2'").get()) {
    conn.transaction(() => {
      const rows = conn.prepare('SELECT id,json FROM products').all() as {
        id: string;
        json: string;
      }[];
      const update = conn.prepare('UPDATE products SET model_key=? WHERE id=?');
      for (const row of rows) update.run(productIdentity(JSON.parse(row.json)), row.id);
      conn.prepare("INSERT INTO metadata(key,value) VALUES('product_identity_v2','1')").run();
    })();
  }
  return conn;
}

function seedDemo(conn: Database.Database) {
  if (!demoMode() || conn.prepare("SELECT key FROM metadata WHERE key='demo_seeded'").get()) return;
  conn.prepare("INSERT INTO metadata(key,value) VALUES('demo_seeded','1')").run();
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
  conn
    .prepare('INSERT OR IGNORE INTO sources(id,json) VALUES(?,?)')
    .run(source.id, JSON.stringify(source));
  conn.prepare('INSERT OR IGNORE INTO suppliers(id,json) VALUES(?,?)').run(
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
    'INSERT OR IGNORE INTO products(id,source_id,supplier_id,model_key,json) VALUES(?,?,?,?,?)',
  );
  conn.transaction(() =>
    examples.forEach(([name, model, category, description], i) => {
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
      insert.run(p.id, p.sourceId, p.supplierId, productIdentity(p), JSON.stringify(p));
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
export function getSettings(): AppSettings {
  const saved = JSON.parse(
    (db().prepare('SELECT json FROM settings WHERE id=1').get() as { json: string }).json,
  );
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    flags: { ...DEFAULT_SETTINGS.flags, ...saved.flags },
    faq: { ...DEFAULT_SETTINGS.faq, ...saved.faq },
    sourcingEstimate: { ...DEFAULT_SETTINGS.sourcingEstimate, ...saved.sourcingEstimate },
  };
}
export function putSettings(s: AppSettings) {
  db().prepare('UPDATE settings SET json=? WHERE id=1').run(JSON.stringify(s));
}
export function list<T>(table: string): T[] {
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
  return (db().prepare(`SELECT json FROM ${table}`).all() as { json: string }[]).map((r) =>
    JSON.parse(r.json),
  );
}
export function byId<T>(table: string, id: string): T | undefined {
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
  const r = db().prepare(`SELECT json FROM ${table} WHERE id=?`).get(id) as
    { json: string } | undefined;
  return r && JSON.parse(r.json);
}
export function save<T extends { id: string }>(
  table: string,
  value: T,
  extra: Record<string, string | null> = {},
) {
  const cols = ['id', ...Object.keys(extra), 'json'];
  const vals = [value.id, ...Object.values(extra), JSON.stringify(value)];
  db()
    .prepare(
      `INSERT INTO ${table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${cols
        .slice(1)
        .map((c) => `${c}=excluded.${c}`)
        .join(',')}`,
    )
    .run(...vals);
}
export function audit(action: string, entityId: string, summary: string) {
  const value = { id: uid(), action, entityId, summary, createdAt: now() };
  save('audit_events', value);
}
export function resetDbForTests() {
  singleton?.close();
  singleton = undefined;
}
