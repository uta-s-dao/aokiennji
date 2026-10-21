'use client';
import { useEffect, useState } from 'react';
import type { BillingReport, PlanId } from '@/lib/billing';
import { api, datetime, errorMessage, yen } from './api';
import { Notice } from './AdminCommon';

const statusLabels: Record<string, string> = {
  active: '契約中',
  past_due: '支払いの確認が必要',
  canceled: '解約済み',
  incomplete: '初回のお支払い待ち',
  incomplete_expired: '申込期限切れ',
  unpaid: '未払い',
  paused: '契約停止中',
  trialing: '試用中（有料枠は未付与）',
};
const deliveryLabels: Record<string, string> = {
  pending: '送信待ち',
  sending: '送信確認中',
  sent: 'メール送信済み',
  review: '送信結果の確認が必要',
};
const historyLabels: Record<string, string> = {
  'budget.updated': '利用上限・停止設定の変更',
  'pricing.bound_exceeded': '使用量が予約時の想定を超えたため自動停止',
  'checkout.created': 'プランの申込',
  'portal.opened': '契約管理画面を開いた',
  'subscription.reconciled': '支払い・契約状態の反映',
};
export default function AdminBilling() {
  const [report, setReport] = useState<BillingReport | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState('0');
  const [paused, setPaused] = useState(false);
  async function load() {
    try {
      const data = await api<BillingReport>('/api/admin/billing');
      setReport(data);
      setLimit(String(data.limitYen));
      setPaused(data.paused);
      setError('');
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function save() {
    if (!report) return;
    setBusy(true);
    setNotice('');
    setError('');
    try {
      const data = await api<BillingReport>('/api/admin/billing', {
        method: 'PATCH',
        body: JSON.stringify({ limitYen: Number(limit), paused, revision: report.revision }),
      });
      setReport(data);
      setNotice('設定を保存しました。今月の使用額・予約額は引き継がれます。');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function payment(action: 'checkout' | 'portal', plan?: PlanId) {
    setBusy(true);
    setError('');
    try {
      const { url } = await api<{ url: string }>(`/api/admin/billing/${action}`, {
        method: 'POST',
        body: JSON.stringify({ plan }),
      });
      const destination = new URL(url);
      if (
        destination.protocol !== 'https:' ||
        !['checkout.stripe.com', 'billing.stripe.com'].includes(destination.hostname)
      )
        throw new Error('決済画面のURLを確認できませんでした。');
      location.assign(destination.href);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <div className="billing-page">
      <Notice message={error} type="error" />
      <Notice message={notice} />
      {!report ? (
        <div className="state-box">
          利用状況を読み込んでいます…
          {error && (
            <button className="button secondary" onClick={load}>
              再読み込み
            </button>
          )}
        </div>
      ) : (
        <>
          <section className="admin-card">
            <div className="billing-heading">
              <div>
                <h2>今月のAPI利用状況</h2>
                <p>{report.period}（日本時間の月初〜月末）</p>
              </div>
              <button className="button secondary" disabled={busy} onClick={load}>
                最新の状況を確認
              </button>
            </div>
            <p role="status" className={report.stopped ? 'billing-warning' : ''}>
              {report.stopped ? `有料API停止中：${report.stopReason}` : '利用可能'} —
              登録情報の案内・お問い合わせ受付は継続します。
            </p>
            <div className="stat-grid">
              {[
                ['使用額（概算）', report.spentYen],
                ['処理中・確認待ちの予約額', report.reservedYen],
                ['利用できる残額', report.remainingYen],
                ['API原価の月額上限', report.limitYen],
              ].map(([label, value]) => (
                <div className="stat-card" key={label}>
                  <span>{label}</span>
                  <strong>{yen(Math.ceil(Number(value)))}</strong>
                </div>
              ))}
            </div>
            <progress
              aria-label="API利用枠の使用率"
              max={Math.max(report.limitYen, 1)}
              value={Math.min(report.limitYen || 1, report.spentYen + report.reservedYen)}
            />
            <p>
              月末の使用見込み：
              {report.forecastYen === null ? '集計開始から1日後に表示' : yen(report.forecastYen)}
              <span className="help">（現在の使用ペースによる目安）</span>
            </p>
            <p className="help">
              80％・90％到達時、月内の超過が見込まれるときに運用担当者へプラン変更を案内します。
              上限が不足すると新しい有料処理を停止します。
            </p>
          </section>
          <section className="admin-card">
            <h2>月額プラン・お支払い</h2>
            <p>
              契約状態：{statusLabels[report.billing.status] || report.billing.status}
              {report.billing.paidUntil &&
                ` ／ 支払確認済みの利用期限：${datetime(report.billing.paidUntil)}`}
            </p>
            {report.billing.enabled && report.billing.testMode && (
              <p className="billing-warning">テスト環境です。実際の請求・引落しは行いません。</p>
            )}
            {!report.billing.ready && (
              <p className="help">
                お支払い設定の準備中です。運用担当者が契約条件・各プランの利用枠を設定すると、お申し込みいただけます。
              </p>
            )}
            <div className="billing-plans">
              {report.plans.map((plan) => (
                <article className="billing-plan" key={plan.id}>
                  <h3>
                    {plan.name}
                    {report.billing.paidPlan === plan.id && '（利用中）'}
                  </h3>
                  <strong>
                    {yen(plan.monthlyYen)}
                    <small> / 月（税込）</small>
                  </strong>
                  <p>
                    AI・検索APIの利用枠：
                    {plan.apiLimitYen === null ? '準備中' : `${yen(plan.apiLimitYen)} / 月`}
                  </p>
                  <button
                    className="button secondary"
                    disabled={busy || !report.billing.ready || !plan.configured}
                    onClick={() =>
                      payment(report.billing.hasSubscription ? 'portal' : 'checkout', plan.id)
                    }
                  >
                    {report.billing.hasSubscription ? 'プラン変更を確認' : 'このプランで申し込む'}
                  </button>
                </article>
              ))}
            </div>
            <p className="help">
              カード情報はStripeの画面で登録します。増額は差額の支払い確認後、減額・解約は契約期間の終了時に反映します。
              月途中の変更でも、その月の使用額・予約額はリセットされません。
            </p>
            {report.billing.hasSubscription && (
              <button
                className="button secondary"
                disabled={busy || !report.billing.ready}
                onClick={() => payment('portal')}
              >
                契約・支払いを管理
              </button>
            )}
          </section>
          <section className="admin-card">
            <h2>利用上限・一時停止</h2>
            <form
              className="billing-controls"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <label>
                API原価の月額上限（円）
                <input
                  type="number"
                  min="0"
                  max={report.editableMaxYen}
                  step="1"
                  required
                  value={limit}
                  onChange={(e) => setLimit(e.target.value)}
                />
              </label>
              <label className="billing-check">
                <input
                  type="checkbox"
                  checked={paused}
                  onChange={(e) => setPaused(e.target.checked)}
                />
                有料APIを一時停止する
              </label>
              <button className="button primary" disabled={busy}>
                設定を保存
              </button>
            </form>
            <p className="help">
              設定可能な上限：{yen(report.editableMaxYen)}。
              上限を下げても、実行済み・処理中の費用は取り消されません。
            </p>
          </section>
          <section className="admin-card">
            <h2>運用担当者への通知</h2>
            {!report.notificationsConfigured && (
              <p className="billing-warning">
                メール通知は未設定です。現在はこの画面に通知を保存しています。
              </p>
            )}
            {report.notificationsConfigured && (
              <p className="help">
                メールは定期実行の送信処理で配信します。送信待ちが続く場合は運用担当者へご連絡ください。
              </p>
            )}
            {!report.notifications.length && <p>通知はありません。</p>}
            {report.notifications.map((n) => (
              <div className="billing-log" key={n.id}>
                <strong>{deliveryLabels[n.status] || n.status}</strong>{' '}
                <small>{datetime(n.created_at)}</small>
                <p>{n.message}</p>
              </div>
            ))}
          </section>
          <section className="admin-card">
            <h2>集計の対象と計算根拠</h2>
            <p>
              公開相談・検索・追加調査・再試行・接続試験を含む、このサイトのAI・検索APIが対象です。
            </p>
            <p>
              料金表：{report.pricing.version} ／ 1米ドル＝{report.pricing.usdJpy}円 ／ 安全余裕{' '}
              {report.pricing.marginPercent}％。
              サーバー・ドメイン・決済手数料などは、このAPI原価集計に含みません。
            </p>
            <p className="help">
              提供元の請求確定額とは異なる概算です。為替・税・料金改定や同じAPIキーの他システム利用は、
              このサイトの制御だけでは抑えられません。専用キーを利用します。
              使用量不明の処理は予約額を維持し、未登録の料金は呼出しを停止します。
            </p>
            <details>
              <summary>対応する料金と直近100件の処理を確認</summary>
              <p>{report.pricing.models.join('、')}</p>
              {report.reservations.map((r) => (
                <details className="billing-log" key={r.id}>
                  <summary>
                    {r.provider} / {r.model} —{' '}
                    {r.settledYen === null
                      ? `予約 ${yen(Math.ceil(r.reservedYen))}`
                      : `使用 ${yen(Math.ceil(r.settledYen))}`}{' '}
                    ({datetime(r.createdAt)})
                  </summary>
                  {r.holdReason && <p>{r.holdReason}</p>}
                  <pre>{JSON.stringify(r.detail, null, 2)}</pre>
                </details>
              ))}
            </details>
          </section>
          <section className="admin-card">
            <h2>上限・契約の変更履歴</h2>
            {!report.history.length && <p>変更履歴はありません。</p>}
            {report.history.map((h) => (
              <details className="billing-log" key={h.id}>
                <summary>
                  {datetime(h.created_at)} — {historyLabels[h.kind] || h.kind}
                </summary>
                <pre>{JSON.stringify(h.detail, null, 2)}</pre>
              </details>
            ))}
          </section>
        </>
      )}
    </div>
  );
}
