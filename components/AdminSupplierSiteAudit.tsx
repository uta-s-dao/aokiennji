'use client';
import { useState } from 'react';
import type { SupplierKnowledge } from '@/lib/contracts';

export default function AdminSupplierSiteAudit({ rows }: { rows: SupplierKnowledge[] }) {
  const [query, setQuery] = useState('');
  const groups = new Map<string, { names: string[]; audit: SupplierKnowledge['siteAudit'] }>();
  for (const row of rows) {
    if (!row.website) continue;
    const entry = groups.get(row.website);
    if (entry) {
      if (!entry.names.includes(row.supplierName)) entry.names.push(row.supplierName);
    } else groups.set(row.website, { names: [row.supplierName], audit: row.siteAudit });
  }
  const term = query.normalize('NFKC').toLowerCase().trim();
  const visible = [...groups].filter(([url, entry]) =>
    [url, ...entry.names, entry.audit?.reason || '未点検']
      .join(' ')
      .normalize('NFKC')
      .toLowerCase()
      .includes(term),
  );
  return (
    <section aria-label="参照URLと点検理由" className="supplier-site-audit">
      <h3>参照URLと点検理由</h3>
      <p className="muted">
        2026-10-16の点検記録です。本文の取得成功と、必要数量の在庫・当社発送日の確認を分けて表示しています。
      </p>
      <label>
        会社名・URL・理由で絞り込む
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <p>
        {visible.length} / {groups.size} URL（同じURLの登録はまとめて表示）
      </p>
      <ul className="supplier-site-audit-list">
        {visible.map(([url, entry]) => (
          <li key={url}>
            <strong>{entry.names.join('／')}</strong>
            <a href={url} target="_blank" rel="noopener noreferrer">
              {url}
            </a>
            <p className="muted">
              {entry.audit
                ? `点検日：${entry.audit.checkedOn}・${entry.audit.fetchStatus === 'fetched' ? '本文取得成功／調達条件は要確認' : '自動巡回を保留'}`
                : '未点検：このURLに対応する点検記録はありません。'}
            </p>
            {entry.audit && <p>理由：{entry.audit.reason}</p>}
          </li>
        ))}
      </ul>
      {!visible.length && <p>一致するURLはありません。</p>}
      {rows.some((row) => !row.website) && (
        <p className="muted">URLが未登録の会社は、「情報源・取込」の「登録内容」で確認できます。</p>
      )}
    </section>
  );
}
