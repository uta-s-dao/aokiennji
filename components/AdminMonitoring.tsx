'use client';
import { useEffect, useState } from 'react';
import { CHECK_LABELS, type MonitoringSettings } from '@/lib/monitoring';
import type { MonitoringAdminReport } from '@/lib/server/monitoring';
import { api, datetime, errorMessage, yen } from './api';
import { Notice, useNotice } from './AdminCommon';

const states = { ok: '正常', failure: '要対応', unknown: '未確認', disabled: '無効・対象外' };
const transport = {
  ready: '送信設定あり',
  disabled: '送信無効',
  setup_required: '通知先の設定待ち',
  failure: '通知送信に失敗・再試行待ち',
};
const links = [
  ['billing', '利用枠・停止と再開'],
  ['settings', 'AIの設定・接続確認'],
  ['notifications', '受付通知・再試行'],
  ['jobs', '同期・バックアップ履歴'],
  ['audit', '操作履歴'],
];
export default function AdminMonitoring({ navigate }: { navigate: (tab: string) => void }) {
  const [report, setReport] = useState<MonitoringAdminReport | null>(null);
  const [form, setForm] = useState<MonitoringSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const n = useNotice();
  function update(value: MonitoringAdminReport) {
    setReport(value);
    setForm(value.settings);
  }
  async function load() {
    setBusy(true);
    try {
      update(await api('/api/admin/monitoring'));
    } catch (e) {
      n.fail(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      update(await api('/api/admin/monitoring', { method: 'PUT', body: JSON.stringify(form) }));
      n.success('監視設定を保存しました。外部監視が次に接続したときに反映されます。');
    } catch (e) {
      n.fail(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="billing-page">
      <Notice message={n.error || n.message} type={n.error ? 'error' : 'success'} />
      <div className="billing-heading">
        <div>
          <h2>運用・外部監視</h2>
          <p>利用枠、接続、定期処理と障害通知を確認します。</p>
        </div>
        <button className="button button-outline" onClick={() => void load()} disabled={busy}>
          更新
        </button>
      </div>
      <div className="button-row">
        {links.map(([tab, label]) => (
          <button key={tab} className="button button-outline" onClick={() => navigate(tab)}>
            {label}
          </button>
        ))}
      </div>
      {report && form && (
        <>
          <section className="admin-card">
            <h3>現在の状態</h3>
            <dl>
              {Object.entries(report.checks).map(([key, value]) => (
                <div key={key}>
                  <dt>{CHECK_LABELS[key as keyof typeof CHECK_LABELS]}</dt>
                  <dd>{states[value]}</dd>
                </div>
              ))}
            </dl>
            <p>
              {report.usage.period}のAPI原価：使用 {yen(report.usage.spentYen)} ／ 予約{' '}
              {yen(report.usage.reservedYen)} ／ 上限 {yen(report.usage.limitYen)}
            </p>
            <p>
              有料API：{report.usage.paused ? '管理者が停止中' : '利用枠に従って制御'} ／ チャット：
              {report.usage.chatEnabled ? '有効' : '無効'} ／ 担当者向けAI調査：
              {report.usage.researchEnabled ? '有効' : '無効'}
            </p>
            <ul>
              {report.usage.providers.map((p) => (
                <li key={p.id}>
                  {p.name}：
                  {!p.configured
                    ? '未設定'
                    : p.check
                      ? `${p.check.ok ? '接続確認済み' : '接続確認失敗'}（${datetime(p.check.checkedAt)}）`
                      : '設定あり・接続未確認'}
                </li>
              ))}
            </ul>
          </section>
          <section className="admin-card">
            <h3>外部監視の稼働</h3>
            <p>接続認証：{report.monitorSecretConfigured ? '設定あり' : '未設定'}</p>
            <p>
              最終受信：{report.heartbeat ? datetime(report.heartbeat.receivedAt) : '未接続'}
              {report.heartbeat?.stale && '（5分以上受信していません）'}
            </p>
            <p>
              外部通知：
              {report.heartbeat
                ? transport[report.heartbeat.transport as keyof typeof transport]
                : '未確認'}
            </p>
            {report.heartbeat && (
              <p>
                反映済み設定：版{report.heartbeat.configRevision} ／ 保存済み：版{form.revision}
              </p>
            )}
            <p>
              サイト停止中の通知は、別の実行環境が保持した直近の設定で続きます。停止中の履歴は復旧後に取り込みます。送信受付済みはメールの到達確認を意味しません。
            </p>
          </section>
          <form className="admin-card" onSubmit={save}>
            <h3>外部監視の通知と判定</h3>
            <fieldset disabled={busy}>
              <div className="form-grid">
                <label>
                  外部監視の通知先メール
                  <input
                    type="email"
                    maxLength={254}
                    value={form.recipient}
                    onChange={(e) => setForm({ ...form, recipient: e.target.value.trim() })}
                  />
                </label>
                <label>
                  障害と判定する連続回数
                  <input
                    type="number"
                    min={1}
                    max={10}
                    required
                    value={form.failureThreshold}
                    onChange={(e) => setForm({ ...form, failureThreshold: Number(e.target.value) })}
                  />
                </label>
                <label>
                  復旧と判定する連続回数
                  <input
                    type="number"
                    min={1}
                    max={10}
                    required
                    value={form.recoveryThreshold}
                    onChange={(e) =>
                      setForm({ ...form, recoveryThreshold: Number(e.target.value) })
                    }
                  />
                </label>
                <label>
                  定期処理の遅延判定（分）
                  <input
                    type="number"
                    min={10}
                    max={1440}
                    required
                    value={form.jobStaleMinutes}
                    onChange={(e) => setForm({ ...form, jobStaleMinutes: Number(e.target.value) })}
                  />
                </label>
                <label>
                  バックアップの遅延判定（時間・0で対象外）
                  <input
                    type="number"
                    min={0}
                    max={720}
                    required
                    value={form.backupStaleHours}
                    onChange={(e) => setForm({ ...form, backupStaleHours: Number(e.target.value) })}
                  />
                </label>
              </div>
            </fieldset>
            <p>
              通知先を空にすると、新しい宛先での送信を保留します。受付通知・利用枠通知の宛先は各通知の設定で確認してください。実行環境と監視頻度の登録は別途必要です。
            </p>
            <p>
              バックアップは実行先と頻度が確定してから監視を有効にしてください。無効・未接続の項目を稼働確認済みとは扱いません。
            </p>
            <button type="submit" className="button" disabled={busy}>
              監視設定を保存
            </button>
          </form>
          <section className="admin-card">
            <h3>障害・復旧と外部通知の履歴</h3>
            {!report.events.length ? (
              <p>取り込まれた履歴はありません。</p>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>日時</th>
                      <th>対象</th>
                      <th>状態</th>
                      <th>通知</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.events.map((event) => (
                      <tr key={event.id}>
                        <td>{datetime(event.occurredAt)}</td>
                        <td>{CHECK_LABELS[event.category]}</td>
                        <td>
                          {event.transition === 'down' ? '障害' : '復旧'}
                          <small className="muted">{event.incidentId}</small>
                        </td>
                        <td>
                          {
                            {
                              pending: '送信待ち',
                              accepted: '送信受付済み',
                              review: '要確認・自動再送停止',
                            }[event.status]
                          }
                          （{event.attempts}回）
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <section className="admin-card">
            <h3>管理画面を開けない場合</h3>
            <p>
              CloudflareでWorker・配備・Hyperdrive、SupabaseでDB、Resendで通知の状態を確認してください。API利用枠は提供元の請求画面とも照合します。
            </p>
            <p>
              契約・支払い・DNS変更とバックアップ復元は、各サービスの管理画面と担当者の運用手順で行います。会社ドメインと通知先への実到達は、接続後に受入確認が必要です。
            </p>
          </section>
        </>
      )}
    </div>
  );
}
