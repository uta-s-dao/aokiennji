// Explicit local-only acceptance test. Requires two separate, running local Supabase stacks.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { globSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import postgres from 'postgres';
import { backup, restore } from './backup-tools.mjs';
const sourceStatus = process.env.BACKUP_SOURCE_STATUS_FILE;
const targetStatus = process.env.BACKUP_TARGET_STATUS_FILE;
if (!sourceStatus || !targetStatus) throw new Error('Two explicit local status files are required');
const source = JSON.parse(await readFile(sourceStatus, 'utf8')).env;
const target = JSON.parse(await readFile(targetStatus, 'utf8')).env;
for (const env of [source, target])
  for (const key of ['DB_URL', 'API_URL'])
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(env[key]).hostname))
      throw new Error('Local stacks only');
if (source.API_URL === target.API_URL)
  throw new Error('Two separate Storage services are required');
const sourceUrl = new URL(source.DB_URL);
sourceUrl.pathname = '/aoki_backup_fixture_' + Date.now();
const targetUrl = new URL(target.DB_URL);
targetUrl.pathname = '/aoki_restore_fixture_' + Date.now();
const root = resolve('.data/verification/uta11');
await mkdir(root, { recursive: true, mode: 0o700 });
const directory = join(root, 'backup-' + Date.now());
const privateKey = join(
  homedir(),
  `.config/aokiennji/secrets/uta11-backup-key-${sourceUrl.pathname.slice(1)}`,
);
const encryption = randomBytes(32).toString('base64');
await writeFile(privateKey, encryption, { mode: 0o600 });
Object.assign(process.env, {
  BACKUP_DATABASE_URL: sourceUrl.href,
  BACKUP_STORAGE_URL: source.API_URL,
  BACKUP_STORAGE_KEY: source.SERVICE_ROLE_KEY,
  BACKUP_ENCRYPTION_KEY: encryption,
  RESTORE_DATABASE_URL: targetUrl.href,
  RESTORE_STORAGE_URL: target.API_URL,
  RESTORE_STORAGE_KEY: target.SERVICE_ROLE_KEY,
});
process.env.BACKUP_PG_BIN ||= [
  ...globSync(
    join(homedir(), '.supabase/cache/stack/slim-services/postgres/*/linux-amd64/*/bin/pg_dump'),
  ),
][0]?.replace(/\/pg_dump$/, '');
const a = postgres(source.DB_URL, { max: 1, onnotice: () => {} }),
  b = postgres(target.DB_URL, { max: 1, onnotice: () => {} });
const bucket = 'uta11-fixture-' + randomUUID();
const objectPath = 'documents/original.txt';
const original = Buffer.from('UTA-11 Storage 原本の復元検証\n架空データのみ。\n');
const report = {
  sourceDatabase: sourceUrl.pathname.slice(1),
  targetDatabase: targetUrl.pathname.slice(1),
  checks: [],
};
async function storage(env, path, options = {}) {
  const r = await fetch(`${env.API_URL}/storage/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${env.SERVICE_ROLE_KEY}`,
      apikey: env.SERVICE_ROLE_KEY,
      ...options.headers,
    },
  });
  if (!r.ok) {
    await r.body?.cancel();
    throw new Error(
      `Local Storage fixture operation failed: HTTP ${r.status}, ${path.split('/').slice(0, 3).join('/')}`,
    );
  }
  return r;
}
try {
  const existing = await (await storage(source, '/bucket')).json();
  const other = await (await storage(target, '/bucket')).json();
  if (existing.length || other.length)
    throw new Error('Fixture requires empty local Storage services; do not reuse existing data');
  await a`CREATE DATABASE ${a(sourceUrl.pathname.slice(1))}`;
  await b`CREATE DATABASE ${b(targetUrl.pathname.slice(1))}`;
  const migration = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/migrate-database.ts'],
    { env: { ...process.env, DATABASE_MIGRATION_URL: sourceUrl.href }, encoding: 'utf8' },
  );
  if (migration.status !== 0) throw new Error('Fixture migration failed');
  const fixture = postgres(sourceUrl.href, { max: 1, onnotice: () => {} });
  try {
    await fixture`INSERT INTO app_private.inquiries(id,json) VALUES('backup-fixture',${JSON.stringify({ name: '架空の復元検証', message: '実顧客データなし' })})`;
    await fixture`INSERT INTO app_private.site_images(id,bytes,created_at) VALUES('00000000-0000-4000-8000-000000000011',${Buffer.from([0, 1, 2, 3, 254, 255])},now())`;
  } finally {
    await fixture.end();
  }
  await storage(source, '/bucket', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: bucket, name: bucket, public: false }),
  });
  await storage(
    source,
    `/object/${bucket}/${objectPath.split('/').map(encodeURIComponent).join('/')}`,
    { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: original },
  );
  report.backup = await backup(directory);
  report.checks.push('encrypted_db_and_storage_backup');
  report.restore = await restore(directory);
  report.checks.push('database_table_counts_and_digests_match', 'storage_bytes_and_hashes_match');
  const repeated = await restore(directory).then(
    () => false,
    (e) => e.message.includes('empty'),
  );
  if (!repeated) throw new Error('Non-empty restore target was not rejected');
  report.checks.push('non_empty_target_refused');
  process.env.RESTORE_DATABASE_URL = sourceUrl.href;
  const same = await restore(directory).then(
    () => false,
    (e) => e.message.includes('distinct'),
  );
  if (!same) throw new Error('Same-environment restore was not rejected');
  report.checks.push('same_source_target_refused');
  report.completedAt = new Date().toISOString();
  await writeFile(join(root, 'restore-report.json'), JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify(report, null, 2));
} finally {
  // Never remove unrelated buckets/databases. Keep restored target and encrypted artifacts for review.
  await storage(source, `/bucket/${bucket}/empty`, { method: 'POST' }).catch(() => {});
  await storage(source, `/bucket/${bucket}`, { method: 'DELETE' }).catch(() => {});
  await a.end();
  await b.end();
}
