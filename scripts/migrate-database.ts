import postgres from 'postgres';
import { readFile, readdir } from 'node:fs/promises';
import { DEFAULT_SETTINGS } from '../lib/contracts';
import { DEFAULT_SITE_CONTENT } from '../lib/site-content';

async function main() {
  const url = process.env.DATABASE_MIGRATION_URL;
  if (!url) throw new Error('DATABASE_MIGRATION_URL is required');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
  if (!local && !process.argv.includes('--production-approved'))
    throw new Error('Remote migration requires separately approved production application');
  const sql = postgres(url, {
    max: 1,
    prepare: false,
    ssl: local ? false : 'verify-full',
    onnotice: () => {},
  });
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended('aoki:migrations',0))`;
      await tx.unsafe('CREATE SCHEMA IF NOT EXISTS app_migrations');
      await tx.unsafe(
        'CREATE TABLE IF NOT EXISTS app_migrations.versions (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
      );
      const directory = new URL('../supabase/migrations/', import.meta.url);
      for (const filename of (await readdir(directory))
        .filter((f) => /^\d+_[a-z_]+\.sql$/.test(f))
        .sort()) {
        const version = filename.split('_')[0];
        if ((await tx`SELECT version FROM app_migrations.versions WHERE version=${version}`).length)
          continue;
        await tx.unsafe(await readFile(new URL(filename, directory), 'utf8'));
        if (version === '202610200001') {
          await tx`INSERT INTO app_private.settings(id,json) VALUES(1,${JSON.stringify(DEFAULT_SETTINGS)})`;
          await tx`INSERT INTO app_private.site_content(id,revision,draft,published) VALUES(1,0,${JSON.stringify(DEFAULT_SITE_CONTENT)},${JSON.stringify(DEFAULT_SITE_CONTENT)})`;
        }
        await tx`INSERT INTO app_migrations.versions(version) VALUES(${version})`;
      }
    });
    console.log('Database migration applied (no demo or historical data copied).');
  } finally {
    await sql.end();
  }
}
main().catch(() => {
  console.error('Database migration failed; inspect local configuration and SQL');
  process.exitCode = 1;
});
