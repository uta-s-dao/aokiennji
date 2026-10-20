// Run migrations/tests with only the isolated local Supabase connection.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('Usage: node scripts/database-local.mjs <command> [args...]');
const status = JSON.parse(
  readFileSync(`${homedir()}/.config/aokiennji/secrets/supabase-local-status.json`, 'utf8'),
);
const url = status.env.DB_URL;
if (!url || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
  throw new Error('Expected local Supabase');
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) =>
      !name.startsWith('SUPABASE_') && !['DATABASE_URL', 'DATABASE_MIGRATION_URL'].includes(name),
  ),
);
const result = spawnSync(command, args, {
  stdio: 'inherit',
  env: { ...env, DATABASE_URL: url, DATABASE_MIGRATION_URL: url },
});
if (result.error) throw new Error('Unable to run local database command');
process.exit(result.status ?? 1);
