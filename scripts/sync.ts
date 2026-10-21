import nextEnv from '@next/env';
nextEnv.loadEnvConfig(process.cwd());
async function main() {
  const { runWebJob } = await import('../lib/server/jobs');
  const { db } = await import('../lib/server/db');
  try {
    const result = await runWebJob('sync');
    console.log(JSON.stringify(result));
    if ('status' in result && result.status === 'failed') process.exitCode = 1;
  } finally {
    await db().close();
  }
}
main().catch(() => {
  console.error('同期を実行できませんでした。管理画面の実行履歴を確認してください。');
  process.exitCode = 1;
});
