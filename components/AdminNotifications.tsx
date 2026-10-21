'use client';
import { useEffect, useState } from 'react';
import type { ReceiptNotificationReport } from '@/lib/server/receipt-notifications';
import { api, date, errorMessage } from './api';
import { Empty, Notice, useNotice } from './AdminCommon';
const states: Record<string, string> = {
  pending: '通知待ち',
  sending: '処理中',
  sent: '送信受付済み',
  review: '要確認',
};
const delivery: Record<string, string> = {
  unknown: '未確認',
  sent: '送信済み',
  delivered: '到達確認',
  delivery_delayed: '到達遅延',
  bounced: '宛先不達',
  complained: '迷惑メール報告',
  failed: '配信失敗',
  suppressed: '配信抑止',
};
const errors: Record<string, string> = {
  deduplication_window_expired:
    '再送の安全期限を超えました。Resendの履歴と受付を照合してください。',
  attempt_limit: '再試行の上限に達しました。',
  configuration_changed: '送信元・宛先が初回の設定と異なります。',
  provider_rejected: '送信サービスが拒否しました。設定と送信履歴を確認してください。',
  send_unconfirmed: '送信結果を確認できませんでした。同じ通知として再試行します。',
};
export default function AdminNotifications() {
  const [report, setReport] = useState<ReceiptNotificationReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const notice = useNotice();
  async function load() {
    try {
      setReport(await api('/api/admin/notifications'));
    } catch (e) {
      notice.fail(errorMessage(e));
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function run(id?: string) {
    setBusy(true);
    try {
      const response = await api<{
        report: ReceiptNotificationReport;
        result: { sent: number; reason?: string };
      }>('/api/admin/notifications', {
        method: 'POST',
        body: JSON.stringify(id ? { action: 'retry', id } : { action: 'deliver' }),
      });
      setReport(response.report);
      if (response.result.reason)
        notice.fail(
          response.result.reason === 'domain_not_verified'
            ? '送信元ドメインの検証を確認できません。通知は保留されています。'
            : 'メール送信が無効、または設定が不足しています。',
        );
      else notice.success(`送信受付：${response.result.sent}件。最新の状態を確認してください。`);
    } catch (e) {
      notice.fail(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <p className="muted">社内向けの受付通知です。お客様への正式見積メールは手動で送付します。</p>
      <Notice message={notice.error || notice.message} type={notice.error ? 'error' : 'success'} />
      {!report ? (
        <p role="status">通知履歴を読み込んでいます…</p>
      ) : (
        <>
          <section className="admin-card">
            <h2>メール送信設定</h2>
            <p>
              {report.config.ready
                ? '送信設定あり（送信時にドメインを検証）'
                : 'メール送信は無効、または設定待ちです。受付は保存されています。'}
            </p>
            <p>
              送信元：{report.config.from || '未設定'}
              <br />
              通知先：{report.config.to || '未設定'}
            </p>
            <p>
              送信元ドメイン：
              {report.config.domain?.status === 'verified' ? '検証済み' : '未検証・確認待ち'}
              {report.config.domain?.checked_at && `（${date(report.config.domain.checked_at)}）`}
              <br />
              到達通知：{report.config.webhookConfigured ? '署名鍵設定あり' : '署名鍵未設定'}
            </p>
            <p className="muted">
              送信受付済みでも到達は未確定です。「到達確認」は宛先メールサーバーの受理を示し、担当者の閲覧確認ではありません。要確認の通知は送信履歴と照合し、受付対応を続けてください。
            </p>
            <button
              className="button primary"
              disabled={busy || !report.config.ready}
              onClick={() => run()}
            >
              通知待ちを送信
            </button>{' '}
            <button className="button secondary" disabled={busy} onClick={load}>
              最新の状態に更新
            </button>
          </section>
          <h2>受付通知の履歴（最新100件）</h2>
          {report.items.length ? (
            <div className="admin-card table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>受付</th>
                    <th>送信状態</th>
                    <th>到達状況</th>
                    <th>試行</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {report.items.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <strong>
                          {item.job_run_id
                            ? '定期処理の障害'
                            : item.inquiry_id
                              ? 'お問い合わせ'
                              : '見積依頼'}
                        </strong>
                        <small>{item.job_run_id || item.inquiry_id || item.quote_id}</small>
                        <small>{date(item.created_at)}</small>
                      </td>
                      <td>
                        {states[item.status]}
                        {item.last_error && (
                          <small>{errors[item.last_error] || '確認が必要です。'}</small>
                        )}
                        {item.sender && (
                          <small>
                            {item.sender} → {(item.recipients || []).join(', ')}
                          </small>
                        )}
                      </td>
                      <td>
                        {delivery[item.delivery_status] || '未確認'}
                        {item.delivery_at && <small>{date(item.delivery_at)}</small>}
                      </td>
                      <td>
                        {item.attempts}回
                        {item.retry_at && <small>次回：{date(item.retry_at)}</small>}
                      </td>
                      <td>
                        <button
                          className="button secondary"
                          onClick={() => setSelected(selected === item.id ? null : item.id)}
                        >
                          送信履歴
                        </button>{' '}
                        {item.status === 'pending' && (
                          <button
                            className="button secondary"
                            disabled={busy || !report.config.ready}
                            onClick={() => run(item.id)}
                          >
                            再試行
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="受付通知はまだありません。" />
          )}
          {selected && (
            <section className="admin-card">
              <h3>選択した通知の送信履歴</h3>
              <p>通知ID：{selected}</p>
              {report.attempts
                .filter((a) => a.notification_id === selected)
                .map((a) => (
                  <p key={a.id}>
                    {date(a.started_at)}：
                    {(
                      {
                        sending: '送信中',
                        accepted: 'API受付済み',
                        rejected: '拒否',
                        unknown: '結果未確認',
                      } as Record<string, string>
                    )[a.outcome] || '未確認'}
                    {a.http_status ? `（HTTP ${a.http_status}）` : ''}
                  </p>
                ))}
              {!report.attempts.some((a) => a.notification_id === selected) && (
                <p>送信はまだ試行されていません。</p>
              )}
            </section>
          )}
        </>
      )}
    </>
  );
}
