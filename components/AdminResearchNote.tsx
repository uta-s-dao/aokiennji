'use client';
import { useState } from 'react';
import { Copy, ExternalLink } from 'lucide-react';
import {
  RESEARCH_ASPECT_LABELS,
  type ProcurementOffer,
  type ResearchFinding,
  type ResearchNote,
} from '@/lib/contracts';
import { datetime, yen } from './api';
import AdminProcurementOffer from './AdminProcurementOffer';

const sourceLabels: Record<ResearchFinding['source'], string> = {
  maker: 'メーカー',
  retailer: '通販サイト',
  carrier: '運送会社',
  supplier: '仕入先',
  other: 'その他',
};
const checkLabels: Record<ResearchFinding['check'], string> = {
  matched: 'ページで確認済み',
  partial: '一部のみ確認',
  mismatch: 'ページの記載と不一致',
  unreachable: '自動取得できず未確認',
};
const nextSteps = [
  '仕入れ可能な価格・税込／税抜・税率・1販売単位の入数を確認する。',
  '必要数量を調達できるか、掲載先の在庫と購入条件を確認する。',
  'お届け先までの送料と、ご注文確定から到着までの日数を確認する。',
  '各候補の「販売概算用の調達条件」に確認結果を保存し、当社の販売見積を作成する。',
];
const needsItemCheck = (finding: ResearchFinding) =>
  (finding.relevance !== null && finding.relevance < 0.5) || finding.itemOnPage === false;
const sharedCheck = (findings: ResearchFinding[]) =>
  findings.length > 0 &&
  findings.every(
    (f) => f.check === findings[0].check && needsItemCheck(f) === needsItemCheck(findings[0]),
  );
const findingValue = (finding: ResearchFinding) =>
  finding.aspect === 'stock'
    ? ({
        InStock: '在庫あり（InStock）',
        OutOfStock: '在庫なし（OutOfStock）',
        PreOrder: '予約受付（PreOrder）',
        BackOrder: '入荷待ち（BackOrder）',
        LimitedAvailability: '在庫僅少（LimitedAvailability）',
        Discontinued: '販売終了（Discontinued）',
      }[finding.value] ?? finding.value)
    : finding.value;

export default function AdminResearchNote({
  note,
  conversationId,
  onOfferSaved,
}: {
  note: ResearchNote;
  conversationId: string;
  onOfferSaved: (offer: ProcurementOffer) => void;
}) {
  const [copyStatus, setCopyStatus] = useState(''),
    [copyFallback, setCopyFallback] = useState(false);
  const sources = new Map<
    string,
    { title: string; findings: ResearchFinding[]; offer?: ProcurementOffer }
  >();
  for (const offer of note.offers ?? [])
    sources.set(offer.url, { title: offer.title || offer.model, findings: [], offer });
  for (const finding of note.findings) {
    const source = sources.get(finding.url);
    if (source) source.findings.push(finding);
    else
      sources.set(finding.url, {
        title: finding.supplierName
          ? `仕入先：${finding.supplierName}`
          : finding.title || finding.url,
        findings: [finding],
      });
  }
  const summary = note.summary
    .split(/\r?\n|(?<=。)/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const stateMessage =
    note.status === 'running'
      ? '調査中です。しばらくしてから開き直してください。'
      : note.status === 'failed'
        ? note.error === 'insufficient_quota'
          ? 'OpenAIの利用残高（クレジット）が不足しているため、調査できませんでした。'
          : '調査を完了できませんでした。'
        : '';
  const text = [
    'AI調査メモ（担当者用・お客様には表示されません）',
    `品目：${note.subject}`,
    `調査日時：${datetime(note.createdAt)}`,
    `調べた項目：${note.aspects.map((a) => RESEARCH_ASPECT_LABELS[a]).join('・')}`,
    ...(note.destination ? [`お届け先：${note.destination}`] : []),
    ...(note.quantity ? [`数量：${note.quantity}`] : []),
    `調査の判定：${note.decidedBy === 'jev' ? 'Jev' : 'ルール'}`,
    ...(stateMessage ? [stateMessage] : []),
    ...summary.map((line) => `・${line}`),
    ...Array.from(sources, ([url, source]) => [
      '',
      `${source.offer ? '調達候補' : '参考情報'}：${source.title}`,
      `URL：${url}`,
      ...(source.offer
        ? [
            `・取得日時：${datetime(source.offer.checkedAt)}`,
            `・調達条件：${source.offer.approved ? '担当者確認済み' : '要確認'}`,
            ...(source.offer.price != null && !source.findings.some((f) => f.aspect === 'price')
              ? [
                  `・仕入価格：${yen(source.offer.price)}（掲載価格を初期表示。調達条件は下記で確認）`,
                ]
              : []),
          ]
        : []),
      ...source.findings.flatMap((finding) => [
        `・${RESEARCH_ASPECT_LABELS[finding.aspect]}：${
          note.sourcing && finding.aspect === 'availability'
            ? source.offer
              ? '型番一致・購入窓口あり'
              : '型番一致・調達条件未確認'
            : findingValue(finding)
        }／${checkLabels[finding.check]}`,
        ...(needsItemCheck(finding) ? ['  注意：別の型式・サイズの可能性'] : []),
        ...(finding.note && !(note.sourcing && finding.aspect === 'availability')
          ? [`  補足：${finding.note}`]
          : []),
      ]),
    ]).flat(),
    ...(note.offers?.length
      ? ['', '次に確認すること', ...nextSteps.map((step) => `・${step}`)]
      : []),
  ].join('\n');
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopyFallback(false);
      setCopyStatus('URLを含む調査メモをコピーしました。');
    } catch {
      setCopyFallback(true);
      setCopyStatus('自動コピーできませんでした。下のメモを選択してコピーしてください。');
    }
  }
  return (
    <article className="research-note" aria-label={`${note.subject}の調査メモ`}>
      <div className="research-note-heading">
        <h3>{note.subject}</h3>
        <button type="button" className="button secondary small" onClick={copy}>
          <Copy size={14} aria-hidden="true" />
          調査メモをコピー
        </button>
      </div>
      {copyStatus && <p role="status">{copyStatus}</p>}
      {copyFallback && (
        <textarea
          className="research-copy-text"
          aria-label="コピー用の調査メモ"
          rows={8}
          readOnly
          value={text}
          onFocus={(event) => event.currentTarget.select()}
        />
      )}
      <dl className="research-meta">
        <div>
          <dt>調査日時</dt>
          <dd>{datetime(note.createdAt)}</dd>
        </div>
        {!note.sourcing && (
          <div>
            <dt>調べた項目</dt>
            <dd>{note.aspects.map((a) => RESEARCH_ASPECT_LABELS[a]).join('・')}</dd>
          </div>
        )}
        {note.destination && (
          <div>
            <dt>お届け先</dt>
            <dd>{note.destination}</dd>
          </div>
        )}
        {!!note.quantity && (
          <div>
            <dt>数量</dt>
            <dd>{note.quantity}</dd>
          </div>
        )}
        <div>
          <dt>調査の判定</dt>
          <dd>{note.decidedBy === 'jev' ? 'Jev' : 'ルール'}</dd>
        </div>
      </dl>
      {stateMessage && <p role="status">{stateMessage}</p>}
      {summary.length > 0 && (
        <ul className="research-bullets research-summary">
          {summary.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      )}
      {note.sourcing && (
        <p className="muted">掲載価格は参考情報です。当社の販売価格は見積で確定します。</p>
      )}
      <div className="research-sources">
        {Array.from(sources, ([url, source], index) => (
          <section className="research-source" key={url} aria-label={source.title}>
            <p className="research-source-kind">
              {source.offer ? '調達候補' : '参考情報'} {index + 1}
              {source.findings[0] &&
                source.findings[0].source !== 'other' &&
                `・${sourceLabels[source.findings[0].source]}`}
            </p>
            <h4>{source.title}</h4>
            <a className="research-source-url" href={url} target="_blank" rel="noopener noreferrer">
              <span>{url}</span>
              <ExternalLink size={14} aria-hidden="true" />
            </a>
            {sharedCheck(source.findings) && (
              <div className="research-check">
                <span className={`research-check-label ${source.findings[0].check}`}>
                  {checkLabels[source.findings[0].check]}
                </span>
              </div>
            )}
            {source.offer && (
              <p className="muted">
                取得：{datetime(source.offer.checkedAt)}
                {source.offer.confirmedAt
                  ? `・担当者確認：${datetime(source.offer.confirmedAt)}`
                  : ''}
              </p>
            )}
            <ul className="research-bullets research-findings">
              {source.offer?.price != null &&
                !source.findings.some((f) => f.aspect === 'price') && (
                  <li>
                    <strong>仕入価格：{yen(source.offer.price)}</strong>
                  </li>
                )}
              {source.findings.map((finding, findingIndex) => (
                <li key={findingIndex}>
                  <strong>
                    {RESEARCH_ASPECT_LABELS[finding.aspect]}：
                    {note.sourcing && finding.aspect === 'availability'
                      ? source.offer
                        ? '型番一致・購入窓口あり'
                        : '型番一致・調達条件未確認'
                      : findingValue(finding)}
                  </strong>
                  {!sharedCheck(source.findings) && (
                    <div className="research-check">
                      <span className={`research-check-label ${finding.check}`}>
                        {checkLabels[finding.check]}
                      </span>
                    </div>
                  )}
                  {needsItemCheck(finding) && (
                    <p className="research-warning">別の型式・サイズの可能性</p>
                  )}
                  {finding.note &&
                    (note.sourcing && finding.aspect === 'availability' ? (
                      <details className="research-excerpt">
                        <summary>判定の根拠（ページ抜粋）を開く</summary>
                        <p className="preline">{finding.note}</p>
                      </details>
                    ) : (
                      <p className="research-finding-note preline">{finding.note}</p>
                    ))}
                </li>
              ))}
            </ul>
            {source.offer && (
              <AdminProcurementOffer
                conversationId={conversationId}
                noteId={note.id}
                offer={source.offer}
                onSaved={onOfferSaved}
              />
            )}
          </section>
        ))}
      </div>
      {!!note.offers?.length && (
        <details className="research-next-steps">
          <summary>次に確認すること</summary>
          <ul className="research-bullets">
            {nextSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}
