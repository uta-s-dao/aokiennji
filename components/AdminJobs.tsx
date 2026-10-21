'use client';
import { useEffect, useState } from 'react';
import type { JobReport, WebJob } from '@/lib/server/jobs';
import { api, datetime, errorMessage } from './api';
import { Empty, Notice, useNotice } from './AdminCommon';
const jobs: Record<string, string> = {
  sync: '情報同期',
  notifications: '通知再試行',
  cleanup: '期限切れ整理',
  backup: 'バックアップ',
  restore: '復元検証',
};
const states: Record<string, string> = {
  running: '実行中',
  success: '成功',
  failed: '失敗',
  deferred: '設定待ち',
  interrupted: '中断・要確認',
};
const alerts: Record<string, string> = {
  pending: '通知待ち',
  sending: '送信処理中',
  sent: '送信受付済み',
  review: '送信結果の確認が必要',
};
export default function AdminJobs() {
  const [report, setReport] = useState<JobReport | null>(null);
  const [busy, setBusy] = useState(false);
  const notice = useNotice();
  async function load() {
    try {
      setReport(await api('/api/admin/jobs'));
    } catch (e) {
      notice.fail(errorMessage(e));
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function run(job: WebJob) {
    setBusy(true);
    try {
      const response = await api<{
        report: JobReport;
        result: { status?: string; skipped?: string };
      }>('/api/admin/jobs', { method: 'POST', body: JSON.stringify({ job }) });
      setReport(response.report);
      if (response.result.skipped)
        notice.success('同じ処理が実行中です。完了後に更新してください。');
      else if (response.result.status === 'failed')
        notice.fail('処理に失敗しました。履歴と通知状態を確認してください。');
      else
        notice.success(
          response.result.status === 'deferred'
            ? '設定が不足しているため保留しました。'
            : '処理を完了しました。',
        );
    } catch (e) {
      notice.fail(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="billing-page">
      <Notice message={notice.error || notice.message} type={notice.error ? 'error' : 'success'} />
      <div className="billing-heading">
        <div>
          <h2>定期処理・バックアップ</h2>
          <p>実行履歴と障害通知を確認できます。</p>
        </div>
        <button className="button button-outline" onClick={() => void load()} disabled={busy}>
          更新
        </button>
      </div>
      {report && (
        <>
          <section className="admin-card">
            <h3>運用の設定</h3>
            <p>
              定期起動：
              {report.config.schedulerEnabled
                ? '有効（稼働状況は履歴で確認）'
                : '無効・配備待ち'}{' '}
              ／ 起動認証：{report.config.cronConfigured ? '設定あり' : '未設定'}
            </p>
            <p>
              障害通知先：{report.config.alertRecipientConfigured ? '設定あり' : '未設定'} ／
              メール送信：{report.config.emailEnabled ? '有効' : '無効'}
            </p>
            <p>
              障害は受付通知にも記録します。サイトやDB全体の停止検知には、別途外部監視が必要です。
            </p>
            <p>
              保存期間が決まっていない相談・見積・原本・バックアップは自動削除しません。バックアップと復元は管理された別の実行環境から行います。
            </p>
          </section>
          <section className="admin-card">
            <h3>今すぐ実行</h3>
            <div className="button-row">
              {(['sync', 'notifications', 'cleanup'] as const).map((job) => (
                <button
                  key={job}
                  className="button button-outline"
                  disabled={busy}
                  onClick={() => void run(job)}
                >
                  {jobs[job]}
                </button>
              ))}
            </div>
            <p>
              情報同期は期限を過ぎた情報源を1件ずつ処理します。期限切れ整理はセッション・取込プレビュー・頻度制限だけが対象です。
            </p>
          </section>
          <section className="admin-card">
            <h3>実行履歴</h3>
            {!report.runs.length ? (
              <Empty title="まだ実行記録はありません。" />
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>処理・実行番号</th>
                      <th>開始・終了</th>
                      <th>結果</th>
                      <th>障害通知</th>
                      <th>詳細</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.runs.map((run) => {
                      const alert = report.alerts.find((a) => a.job_run_id === run.id);
                      return (
                        <tr key={run.id}>
                          <td>
                            {jobs[run.job]}
                            <small className="muted">{run.id}</small>
                          </td>
                          <td>
                            {datetime(run.started_at)}
                            <br />
                            {run.finished_at ? datetime(run.finished_at) : '未完了'}
                          </td>
                          <td>{states[run.status]}</td>
                          <td>
                            {alert ? alerts[alert.status] : '—'}
                            {alert?.delivery_status === 'delivered' && '（到達確認）'}
                          </td>
                          <td>
                            <details>
                              <summary>処理内容</summary>
                              <pre
                                style={{
                                  whiteSpace: 'pre-wrap',
                                  overflowWrap: 'anywhere',
                                  maxWidth: 320,
                                }}
                              >
                                {JSON.stringify(run.detail, null, 2)}
                              </pre>
                            </details>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
