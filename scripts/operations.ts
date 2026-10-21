// Separate, trusted Node runner. Never run pg_dump in a public HTTP request or Worker.
import nextEnv from '@next/env';
nextEnv.loadEnvConfig(process.cwd());
async function main() {
  const [action, directory] = process.argv.slice(2);
  if (!['backup', 'restore'].includes(action) || !directory || process.argv.length !== 4)
    throw new Error(
      'Usage: node --import tsx scripts/operations.ts backup|restore <new-directory>',
    );
  const { backup, restore } = await import('./backup-tools.mjs');
  const { runJob } = await import('../lib/server/jobs');
  const { db } = await import('../lib/server/db');
  try {
    if (action === 'restore') {
      const detail = await restore(directory);
      process.env.DATABASE_URL = process.env.RESTORE_DATABASE_URL;
      await db().close();
      const result = await runJob('restore', `manual:${crypto.randomUUID()}`, async () => ({
        status: 'success',
        detail,
      }));
      console.log(JSON.stringify(result));
    } else {
      process.env.DATABASE_URL = process.env.BACKUP_DATABASE_URL;
      const result = await runJob(
        'backup',
        process.env.BACKUP_RUN_SLOT || `manual:${crypto.randomUUID()}`,
        async () => ({ status: 'success', detail: await backup(directory) }),
      );
      console.log(JSON.stringify(result));
      if ('status' in result && result.status === 'failed') process.exitCode = 1;
      if ('skipped' in result && result.skipped === 'already_running') process.exitCode = 75;
    }
  } finally {
    await db().close();
  }
}
main().catch(() => {
  console.error(
    'Operation failed. Check isolated target, credentials, empty destination and artifact integrity.',
  );
  process.exitCode = 1;
});
