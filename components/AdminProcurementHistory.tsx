'use client';
import { useState } from 'react';
import type {
  ProcurementAction,
  ProcurementCase,
  ProcurementHistory,
} from '@/lib/procurement-memory';
import { api, datetime, errorMessage } from './api';

const labels = {
  ordered: '発注済み',
  partial: '一部入荷',
  received: '全数入荷',
  unavailable: '調達不可',
  delayed: '遅延判明',
  cancelled: '発注取消',
  returned: '返品',
  void: '記録取消',
  conditions_confirmed: '担当者が条件確認',
  order_sent: 'アプリから発注送信',
};
export default function AdminProcurementHistory({ endpoint }: { endpoint: string }) {
  const [data, setData] = useState<ProcurementHistory | null>(null);
  const [quantity, setQuantity] = useState('');
  const [received, setReceived] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<{
    eventId: string;
    action: ProcurementAction;
    caseId?: string;
    quantity?: number;
    receivedQuantity?: number;
  } | null>(null);
  async function load() {
    setBusy(true);
    try {
      const next = await api<ProcurementHistory>(endpoint);
      setData(next);
      setQuantity((v) => v || String(next.suggestedQuantity || ''));
      setNotice('');
    } catch (e) {
      setNotice(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function record(action: ProcurementAction, item?: ProcurementCase, count?: number) {
    const payload = {
      eventId: crypto.randomUUID(),
      action,
      ...(item ? { caseId: item.id } : { quantity: Number(quantity) }),
      ...(count !== undefined ? { receivedQuantity: count } : {}),
    };
    await submit(payload);
  }
  async function submit(payload: NonNullable<typeof pending>) {
    setBusy(true);
    setPending(payload);
    try {
      setData(
        await api<ProcurementHistory>(endpoint, { method: 'POST', body: JSON.stringify(payload) }),
      );
      setPending(null);
      setReceived('');
      setNotice('実績を保存しました。現在の在庫・納期は別途確認してください。');
    } catch (e) {
      setNotice(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const active = data?.cases.find(
    (c) => c.isDemo === data.isDemo && ['ordered', 'partial'].includes(c.status),
  );
  const button = (
    text: string,
    action: ProcurementAction,
    item?: ProcurementCase,
    count?: number,
  ) => (
    <button
      type="button"
      className="button secondary small"
      disabled={busy || !!pending}
      onClick={() => record(action, item, count)}
    >
      {text}
    </button>
  );
  return (
    <details
      className="procurement-offer"
      onToggle={(e) => {
        if (e.target === e.currentTarget && e.currentTarget.open) void load();
      }}
    >
      <summary>発注・入荷の実績を記録／確認</summary>
      <p className="muted">
        商品・調達先・判定の根拠は自動で保存します。外部で行った発注や入荷は、下のボタンで結果だけを記録してください。
      </p>
      {data && (
        <>
          <p>
            <strong>{data.model}</strong>・{data.supplierName}
            {data.isDemo ? '（デモ記録・実績集計の対象外）' : ''}
          </p>
          <p>
            同じ型番・調達先の実績：全数入荷 {data.summary.completed}件／調達不可{' '}
            {data.summary.unavailable}件／遅延 {data.summary.delayed}件
          </p>
          <p className="muted">
            過去の実績です。今回の在庫・全数引当・発送日の確約には使いません。日時は結果を記録した日時です。
          </p>
          {!active && data.canStart && (
            <>
              <label>
                今回発注・確認した必要数量（個）
                <input
                  type="number"
                  min="1"
                  max="1000000000"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                />
              </label>
              <p className="muted">
                数量は会話から初期入力します。実際に発注・確認した数量に直してください。「発注済みを記録」は履歴の保存です。
              </p>
              <div className="button-row">
                {button('外で発注済みを記録', 'ordered')}
                {button('確認したが調達不可', 'unavailable')}
              </div>
            </>
          )}
          {active && (
            <>
              <p>
                進行中：{active.quantity}個発注・{active.receivedQuantity}個入荷済み
              </p>
              <div className="button-row">
                {button('全数入荷を記録', 'received', active, active.quantity)}
                {button('遅延を記録', 'delayed', active)}
                {active.receivedQuantity === 0 && button('調達不可を記録', 'unavailable', active)}
                {button('発注取消を記録', 'cancelled', active)}
              </div>
              <details>
                <summary>分納の入荷数を記録</summary>
                <label>
                  累計入荷数（個）
                  <input
                    type="number"
                    min={Math.max(1, active.receivedQuantity)}
                    max={active.quantity}
                    value={received}
                    onChange={(e) => setReceived(e.target.value)}
                  />
                </label>
                {button('累計入荷数を保存', 'received', active, Number(received))}
              </details>
            </>
          )}
          {!!data.cases.length && (
            <ul className="research-bullets">
              {data.cases.map((c) => (
                <li key={c.id}>
                  {labels[c.status]}：{c.receivedQuantity}/{c.quantity}個
                  {c.delayed ? '・遅延あり' : ''}・{datetime(c.updatedAt)}
                  {c.isDemo ? '（デモ）' : ''}{' '}
                  {c.isDemo === data.isDemo &&
                    c.status === 'received' &&
                    button('返品を記録', 'returned', c)}{' '}
                  {c.isDemo === data.isDemo &&
                    c.status !== 'void' &&
                    button('誤記録を取り消す', 'void', c)}
                </li>
              ))}
            </ul>
          )}
          {!!data.events.length && (
            <details>
              <summary>記録と当時の根拠を開く</summary>
              <ul className="research-bullets">
                {data.events.map((e) => (
                  <li key={e.id}>
                    {datetime(e.createdAt)}・{labels[e.action]}
                    {e.isDemo ? '（デモ）' : ''}
                  </li>
                ))}
              </ul>
              <details>
                <summary>発注時のページ判定・確認条件</summary>
                {data.cases.map((c) => (
                  <div key={c.id}>
                    <p>
                      {datetime(c.createdAt)}・{c.model}・{c.quantity}個
                    </p>
                    {c.snapshot.offer && (
                      <p>
                        当時の担当者確認：{c.snapshot.offer.approved ? '確認済み' : '未確認'}
                        ・調達可能数量：{c.snapshot.offer.availableQuantity ?? '未確認'}
                      </p>
                    )}
                    {c.snapshot.findings?.map((f, i) => (
                      <p className="preline" key={i}>
                        {f.value}
                        <br />
                        {f.note}
                      </p>
                    ))}
                  </div>
                ))}
              </details>
            </details>
          )}
        </>
      )}
      {pending && !busy && (
        <button type="button" className="button secondary small" onClick={() => submit(pending)}>
          同じ記録を再送
        </button>
      )}
      {pending && !busy && (
        <button
          type="button"
          className="button secondary small"
          onClick={() => {
            setPending(null);
            void load();
          }}
        >
          最新の状態を確認して編集に戻る
        </button>
      )}
      {busy && <p role="status">読み込み・保存中…</p>}
      {notice && <p role="status">{notice}</p>}
    </details>
  );
}
