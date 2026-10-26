import { preferredSites } from '../lib/server/preferred-sources';
import { crawlSupplierCatalog } from '../lib/server/supplier-catalog';
import { db } from '../lib/server/db';

async function main() {
  // Explicit domain scope; does not approve products or change search settings.
  const args = process.argv.slice(2);
  const domain = args[args.indexOf('--domain') + 1];
  if (!args.includes('--domain') || !domain || !/^[a-z0-9.-]+$/i.test(domain))
    throw Error(
      'Usage: tsx scripts/refresh-supplier-catalog.ts --domain example.com [--max-pages 16]',
    );
  const maxPages = args.includes('--max-pages')
    ? Number(args[args.indexOf('--max-pages') + 1])
    : 16;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20)
    throw Error('max-pages must be 1..20');
  try {
    const site = (await preferredSites()).find(
      (s) => s.domain === domain && s.eligible && s.sourceId,
    );
    if (!site) throw Error('Eligible registered source not found');
    const result = await crawlSupplierCatalog(site, { maxPages });
    console.log(
      JSON.stringify({
        domain,
        pages: result.documents.length,
        entries: result.documents.reduce((n, d) => n + d.supplierCatalog.entries.length, 0),
        failures: result.failures.length,
        limited: result.limited,
      }),
    );
    if (result.failures.length) process.exitCode = 1;
  } finally {
    await db().close();
  }
}
main().catch(() => {
  console.error('商品掲載索引の更新を完了できませんでした。登録先と接続設定を確認してください。');
  process.exitCode = 1;
});
