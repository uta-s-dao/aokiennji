import type { Source } from '../lib/contracts';
import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());
async function main() {
  const { list } = await import('../lib/server/db');
  const { syncSource } = await import('../lib/server/ingestion');

  let failed = false;
  for (const source of (await list<Source>('sources'))) {
    if (
      !source.enabled ||
      !['website', 'json_api', 'csv_url'].includes(source.kind) ||
      source.syncIntervalHours <= 0
    )
      continue;
    if (
      source.lastSyncedAt &&
      Date.now() - Date.parse(source.lastSyncedAt) < source.syncIntervalHours * 3600000
    )
      continue;
    try {
      const result = await syncSource(source.id);
      console.log(
        `${source.name}: ${result.imported + result.updated}件 / 文書${result.documents}件`,
      );
    } catch {
      failed = true;
      console.error(`${source.name}: 同期失敗。管理画面の情報源履歴を確認してください。`);
    }
  }
  if (failed) process.exitCode = 1;
}
main().catch(() => {
  console.error('同期を開始できませんでした');
  process.exitCode = 1;
});
