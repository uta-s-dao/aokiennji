'use client';
import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import AdminCreateDocument from './AdminCreateDocument';
import type { Order, Quote } from '@/lib/contracts';
import { api, datetime, errorMessage, yen } from './api';
import { Empty, Notice, useNotice } from './AdminCommon';
import AdminProcurementHistory from './AdminProcurementHistory';
const labels: Record<Order['status'], string> = {
  pending_approval: '承認待ち',
  approved: '承認済み',
  dispatched: '送信済み',
  simulated: 'デモ送信済み',
  failed: '送信失敗',
  needs_reconciliation: '送信結果の確認が必要',
};
export default function AdminOrders() {
  const [creating, setCreating] = useState(false);
  const [items, setItems] = useState<Order[]>([]),
    [quotes, setQuotes] = useState<Quote[]>([]),
    [busy, setBusy] = useState('');
  const n = useNotice();
  async function load() {
    try {
      const [orders, quoteList] = await Promise.all([
        api<Order[]>('/api/admin/orders'),
        api<Quote[]>('/api/admin/quotes'),
      ]);
      setItems(orders);
      setQuotes(quoteList);
    } catch (e) {
      n.fail(errorMessage(e));
    }
  }
  useEffect(() => {
    load();
  }, []);
  async function action(o: Order, name: 'approve' | 'dispatch') {
    if (
      name === 'dispatch' &&
      !o.isDemo &&
      !confirm('この注文を設定された仕入先へ実送信します。実行しますか？')
    )
      return;
    setBusy(o.id);
    try {
      const updated = await api<Order>(`/api/admin/orders/${o.id}/${name}`, { method: 'POST' });
      n.success(
        updated.status === 'simulated'
          ? 'デモ送信を記録しました。外部への発注は行っていません。'
          : labels[updated.status],
      );
      await load();
    } catch (e) {
      n.fail(errorMessage(e));
    } finally {
      setBusy('');
    }
  }
  return (
    <>
      <div className="admin-toolbar">
        <p className="muted">お客様からの注文依頼と、管理画面から作成した注文を管理します。</p>
        <button
          className="button primary"
          onClick={() => {
            n.clear();
            setCreating(true);
          }}
        >
          <Plus size={18} aria-hidden="true" /> 注文を新規作成
        </button>
      </div>
      <Notice message={n.error || n.message} type={n.error ? 'error' : 'success'} />
      {items.length ? (
        <div className="admin-card table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>注文番号</th>
                <th>金額</th>
                <th>状態</th>
                <th>受付日時</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((o) => (
                <tr key={o.id}>
                  <td>
                    <strong>{o.id.slice(0, 8)}</strong>
                    <small>
                      {quotes.find((q) => q.id === o.quoteId)?.company}{' '}
                      {quotes.find((q) => q.id === o.quoteId)?.name}
                    </small>
                    <small>見積 {o.quoteId.slice(0, 8)}</small>
                    {o.isDemo && <small>デモ注文</small>}
                  </td>
                  <td>{yen(o.total)}</td>
                  <td>
                    <span className="pill">{labels[o.status]}</span>
                    {o.lastError && <p className="form-error">{o.lastError}</p>}
                    {o.externalId && <small>受付 {o.externalId}</small>}
                  </td>
                  <td>{datetime(o.createdAt)}</td>
                  <td>
                    {o.status === 'pending_approval' ? (
                      <button
                        className="button primary small"
                        disabled={busy === o.id}
                        onClick={() => action(o, 'approve')}
                      >
                        承認する
                      </button>
                    ) : ['approved', 'failed'].includes(o.status) ? (
                      <button
                        className="button primary small"
                        disabled={busy === o.id}
                        onClick={() => action(o, 'dispatch')}
                      >
                        {o.isDemo ? 'デモ送信を実行' : '仕入先へ送信'}
                      </button>
                    ) : o.status === 'needs_reconciliation' ? (
                      <span className="muted">仕入先に受付状況をご確認ください</span>
                    ) : (
                      <span className="muted">送信記録済み・入荷は別途確認</span>
                    )}
                    {['dispatched', 'simulated'].includes(o.status) &&
                      o.supplierId &&
                      quotes
                        .find((q) => q.id === o.quoteId)
                        ?.lines.map((line, index) =>
                          line.productId ? (
                            <AdminProcurementHistory
                              key={index}
                              endpoint={`/api/admin/orders/${o.id}/history/${index}`}
                            />
                          ) : null,
                        )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty
          title="注文依頼はまだありません"
          detail="「注文を新規作成」から直接作成できます。注文機能を有効にすると、お客様の見積ページからも依頼できます。"
        />
      )}
      {creating && (
        <AdminCreateDocument
          kind="order"
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            n.success('承認待ちの注文を作成しました');
            void load();
          }}
        />
      )}
    </>
  );
}
