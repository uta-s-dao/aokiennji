import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { parseSupplierWorkbook, importSupplierKnowledge, availableFields } from '../lib/server/supplier-knowledge';
import { list, now, save, resetDbForTests } from '../lib/server/db';
import type { Source } from '../lib/contracts';

async function main() {
  const file = process.argv[2];
  if (!file) throw Error('Supply an XLSX path; --apply --approve-fields imports only private supplier knowledge');
  const bytes = readFileSync(file);
  const parsed = await parseSupplierWorkbook(basename(file), bytes);
  console.log(JSON.stringify({ rows: parsed.supplierRows?.length, warnings: parsed.warnings, sha256: createHash('sha256').update(bytes).digest('hex'), productsImported: 0, stockImported: 0 }));
  if (!process.argv.includes('--apply')) return;
  if (!process.argv.includes('--approve-fields')) throw Error('Field-reference approval required');
  const url = process.env.DATABASE_URL;
  if (!url) throw Error('DATABASE_URL required');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname) && !process.argv.includes('--production-approved')) throw Error('Production import requires authorization');
  const sources = await list<Source>('sources');
  const old = sources.find(s => s.kind === 'supplier_catalog' && s.name === basename(file));
  const source: Source = old || { id: `supplier-workbook-${createHash('sha256').update(basename(file)).digest('hex').slice(0,20)}`, name: basename(file), kind: 'supplier_catalog', url: '', enabled: true, trust: 'internal', visibility: 'internal', syncIntervalHours: 0, config: { answerEnabled: true }, lastSyncedAt: null, lastError: null, recordCount: 0, createdAt: now() };
  if (!old) await save('sources', source);
  const result = await importSupplierKnowledge(source, parsed.supplierRows!, true);
  console.log(JSON.stringify({result, fields: await availableFields()}));
}
main().catch(e => { console.error(e.message);process.exitCode=1; }).finally(resetDbForTests);
