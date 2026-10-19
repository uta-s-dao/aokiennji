import type { SupplierKnowledge, SupplierSiteAudit } from '../contracts';
import records from './data/supplier-site-audit-2026-10-16.json';

// Dated observations from docs/SUPPLIER_SITE_AUDIT_2026-10-16.md.
// Keep this dataset on the server; supply it only through the authenticated API.
function identity(website: string) {
  try {
    const url = new URL(website);
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}
const audits = new Map(
  records.map((record) => [
    identity(record.website),
    {
      checkedOn: record.checkedOn,
      fetchStatus: record.fetchStatus === 'fetched' ? 'fetched' : 'held',
      reason: record.reason,
    } satisfies SupplierSiteAudit,
  ]),
);

export function withSupplierSiteAudit(row: SupplierKnowledge): SupplierKnowledge {
  const audit = audits.get(identity(row.website));
  return { ...row, siteAudit: audit };
}
