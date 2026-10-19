'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, CheckCircle2, Printer } from 'lucide-react';
import SiteShell from '@/components/SiteShell';
import { api, date, errorMessage, yen } from '@/components/api';
import type { Order, PublicConfig, Quote } from '@/lib/contracts';
const labels: Record<Quote['status'], string> = {
  requested: '依頼受付',
  draft: '作成中',
  issued: '発行済み',
  accepted: '注文依頼済み',
  cancelled: '取消済み',
};
export default function QuotePage() {
  const { token } = useParams<{ token: string }>();
  const [quote, setQuote] = useState<Quote | null>(null),
    [config, setConfig] = useState<PublicConfig | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [order, setOrder] = useState<Order | null>(null);
  useEffect(() => {
    Promise.all([
      api<Quote>(`/api/quotes/${encodeURIComponent(token)}`),
      api<PublicConfig>('/api/config'),
    ])
      .then(([q, c]) => {
        setQuote(q);
        setConfig(c);
      })
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setLoading(false));
  }, [token]);
  const expired = quote?.expiresAt ? new Date(quote.expiresAt).getTime() < Date.now() : false;
  async function accept() {
    if (!quote || !confirmed) return;
    setBusy(true);
    setError('');
    const storageKey = 'aoki-quote-' + token;
    const key = sessionStorage.getItem(storageKey) || crypto.randomUUID();
    sessionStorage.setItem(storageKey, key);
    try {
      const o = await api<Order>(`/api/quotes/${encodeURIComponent(token)}/accept`, {
        method: 'POST',
        body: JSON.stringify({ confirmed: true, idempotencyKey: key }),
      });
      setOrder(o);
      setQuote({ ...quote, status: 'accepted' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <SiteShell>
      <section className="section quote-page">
        <div className="container narrow">
          <Link className="back-link" href="/">
            <ArrowLeft size={18} /> ホームへ戻る
          </Link>
          {loading ? (
            <div className="state-box">見積を読み込んでいます…</div>
          ) : error && !quote ? (
            <div className="state-box error" role="alert">
              <h2>見積を表示できません</h2>
              <p>{error}</p>
            </div>
          ) : (
            quote && (
              <>
                <div className="quote-title">
                  <div>
                    <p className="eyebrow">QUOTATION</p>
                    <h1>お見積書</h1>
                    <p>見積番号：{quote.id}</p>
                  </div>
                  <span className="pill">{labels[quote.status]}</span>
                </div>
                {quote.isDemo && (
                  <div className="demo-banner in-page">デモ環境：この見積と注文は確認用です</div>
                )}
                <div className="quote-sheet">
                  <div className="quote-parties">
                    <div>
                      <span>お客様</span>
                      <strong>
                        {quote.company && `${quote.company}　`}
                        {quote.name} 様
                      </strong>
                    </div>
                    <div>
                      <span>発行元</span>
                      <strong>アオキエンジ株式会社</strong>
                    </div>
                  </div>
                  <div className="quote-meta">
                    <div>
                      <span>発行日</span>
                      <strong>{date(quote.updatedAt)}</strong>
                    </div>
                    <div>
                      <span>有効期限</span>
                      <strong>{date(quote.expiresAt)}</strong>
                    </div>
                  </div>
                  {quote.status === 'requested' || quote.status === 'draft' ? (
                    <div className="state-box">
                      <h2>お見積りを作成中です</h2>
                      <p>内容を確認後、明細をご案内します。</p>
                    </div>
                  ) : (
                    <>
                      <div className="table-scroll">
                        <table className="data-table quote-lines">
                          <thead>
                            <tr>
                              <th>品名</th>
                              <th>数量</th>
                              <th>単価</th>
                              <th>金額</th>
                            </tr>
                          </thead>
                          <tbody>
                            {quote.lines.map((line, i) => (
                              <tr key={i}>
                                <td>{line.name}</td>
                                <td>{line.quantity}</td>
                                <td>{yen(line.unitPrice)}</td>
                                <td>{yen(line.quantity * line.unitPrice)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <dl className="quote-totals">
                        <div>
                          <dt>小計</dt>
                          <dd>{yen(quote.subtotal)}</dd>
                        </div>
                        <div>
                          <dt>送料</dt>
                          <dd>{yen(quote.shipping)}</dd>
                        </div>
                        <div>
                          <dt>消費税（{quote.taxRate}%）</dt>
                          <dd>{yen(quote.tax)}</dd>
                        </div>
                        <div className="total">
                          <dt>合計（税込）</dt>
                          <dd>{yen(quote.total)}</dd>
                        </div>
                      </dl>
                    </>
                  )}
                  {quote.notes && (
                    <div className="quote-notes">
                      <h2>備考</h2>
                      <p className="preline">{quote.notes}</p>
                    </div>
                  )}
                </div>
                {order ? (
                  <div className="success-state" role="status">
                    <CheckCircle2 size={40} />
                    <h2>注文依頼を受け付けました</h2>
                    <p>注文番号：{order.id}</p>
                    <p>当社で内容を確認します。</p>
                  </div>
                ) : quote.status === 'issued' && config?.flags.orders && !expired ? (
                  <div className="quote-accept">
                    <h2>注文をご希望の場合</h2>
                    <p>明細・金額・有効期限をご確認のうえ、注文依頼をお送りください。</p>
                    <label className="consent-row">
                      <input
                        type="checkbox"
                        checked={confirmed}
                        onChange={(e) => setConfirmed(e.target.checked)}
                      />
                      <span>見積内容、税込合計、有効期限を確認しました</span>
                    </label>
                    {error && (
                      <div className="form-error" role="alert">
                        {error}
                      </div>
                    )}
                    <button
                      className="button primary"
                      type="button"
                      disabled={!confirmed || busy}
                      onClick={accept}
                    >
                      {busy ? '送信しています…' : '注文を依頼する'}
                    </button>
                  </div>
                ) : expired && quote.status === 'issued' ? (
                  <div className="state-box">
                    この見積の有効期限は終了しました。再見積をご依頼ください。
                  </div>
                ) : quote.status === 'accepted' ? (
                  <div className="state-box">この見積は注文依頼済みです。</div>
                ) : null}
                <button
                  className="button secondary print-button"
                  type="button"
                  onClick={() => window.print()}
                >
                  <Printer size={18} /> 印刷する
                </button>
              </>
            )
          )}
        </div>
      </section>
    </SiteShell>
  );
}
