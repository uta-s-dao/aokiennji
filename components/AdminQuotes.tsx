'use client';
import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import AdminCreateDocument from './AdminCreateDocument';
import type { Quote, QuoteLine } from '@/lib/contracts';
import { api, date, errorMessage, yen } from './api';
import { Empty, Modal, Notice, useNotice } from './AdminCommon';
import { ConversationDetail } from './AdminConversations';
const labels: Record<Quote['status'], string> = {
  requested: '依頼受付',
  draft: '下書き',
  issued: '発行済み',
  accepted: '注文依頼済み',
  cancelled: '取消済み',
};
export default function AdminQuotes() {
  const [creating, setCreating] = useState(false);
  const [aokiReviewed, setAokiReviewed] = useState(false);
  const [items, setItems] = useState<Quote[]>([]),
    [edit, setEdit] = useState<Quote | null>(null),
    [viewing, setViewing] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const n = useNotice();
  async function load() {
    try {
      setItems(await api<Quote[]>('/api/admin/quotes'));
    } catch (e) {
      n.fail(errorMessage(e));
    }
  }
  useEffect(() => {
    load();
  }, []);
  function line(index: number, key: keyof QuoteLine, value: string | number) {
    if (!edit) return;
    setEdit({
      ...edit,
      lines: edit.lines.map((l, i) => (i === index ? { ...l, [key]: value } : l)),
    });
  }
  async function save(status: Quote['status']) {
    if (!edit) return;
    setBusy(true);
    try {
      await api(`/api/admin/quotes/${edit.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          lines: edit.lines,
          shipping: edit.shipping,
          taxRate: edit.taxRate,
          expiresAt: edit.expiresAt,
          notes: edit.notes,
          status,
          aokiReviewed: status === 'issued' && aokiReviewed,
        }),
      });
      setEdit(null);
      setAokiReviewed(false);
      n.success(
        status === 'issued'
          ? '見積を発行しました。お客様へのメールは未送信です。専用リンクを手動でご案内ください。'
          : '見積を保存しました',
      );
      await load();
    } catch (e) {
      n.fail(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const subtotal = edit?.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0) || 0;
  const total = edit
    ? subtotal + edit.shipping + Math.floor(((subtotal + edit.shipping) * edit.taxRate) / 100)
    : 0;
  return (
    <>
      <div className="admin-toolbar">
        <p className="muted">
          正式見積は青木さんの確認後に発行します。発行時にお客様へメールは送信されません。専用リンクを手動でご案内ください。
        </p>
        <button
          className="button primary"
          onClick={() => {
            n.clear();
            setCreating(true);
          }}
        >
          <Plus size={18} aria-hidden="true" /> 見積を新規作成
        </button>
      </div>
      <Notice message={n.error || n.message} type={n.error ? 'error' : 'success'} />
      {items.length ? (
        <div className="admin-card table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>お客様・受付番号</th>
                <th>状態</th>
                <th>合計</th>
                <th>期限</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((q) => (
                <tr key={q.id}>
                  <td>
                    <strong>
                      {q.company} {q.name}
                    </strong>
                    <small>
                      {q.id.slice(0, 8)} · {q.email}
                    </small>
                  </td>
                  <td>
                    <span className="pill">{labels[q.status]}</span>
                  </td>
                  <td>
                    {['requested', 'draft'].includes(q.status) ? '確認中' : yen(q.total)}
                    {q.isDemo && <small>デモ</small>}
                  </td>
                  <td>{date(q.expiresAt)}</td>
                  <td>
                    <div className="source-actions">
                      {['requested', 'draft'].includes(q.status) && (
                        <button
                          className="button secondary small"
                          onClick={() => {
                            setEdit({ ...q, lines: q.lines.map((l) => ({ ...l })) });
                            n.clear();
                          }}
                        >
                          明細を編集
                        </button>
                      )}
                      <a
                        className="button secondary small"
                        href={`/quotes/${q.token}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        見積ページ ↗
                      </a>
                      {q.status === 'issued' && (
                        <button
                          className="link-button"
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(
                                `${location.origin}/quotes/${q.token}`,
                              );
                              n.success('専用リンクをコピーしました');
                            } catch {
                              n.fail('見積ページを開き、アドレスをコピーしてください');
                            }
                          }}
                        >
                          リンクをコピー
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty
          title="見積依頼はまだありません"
          detail="「見積を新規作成」から直接作成するか、お客様の見積依頼を受け付けられます。"
        />
      )}
      {edit && (
        <Modal
          title="見積の明細を作成"
          wide
          onClose={() => {
            setEdit(null);
            setAokiReviewed(false);
          }}
        >
          <div className="admin-form">
            <p>
              <strong>
                {edit.company} {edit.name}
              </strong>{' '}
              · {edit.email}
            </p>
            <p className="preline">{edit.message}</p>
            {edit.conversationId && (
              <button
                type="button"
                className="button secondary small"
                onClick={() => setViewing(edit.conversationId!)}
              >
                チャットの会話とAI調査メモを見る
              </button>
            )}
            <div className="quote-editor-lines">
              {edit.lines.map((l, i) => (
                <div className="quote-editor-line" key={i}>
                  <label>
                    品名
                    <input
                      required
                      value={l.name}
                      onChange={(e) => line(i, 'name', e.target.value)}
                    />
                  </label>
                  <label>
                    数量
                    <input
                      type="number"
                      min="1"
                      value={l.quantity}
                      onChange={(e) => line(i, 'quantity', Number(e.target.value))}
                    />
                  </label>
                  <label>
                    単価（円）
                    <input
                      type="number"
                      min="0"
                      value={l.unitPrice}
                      onChange={(e) => line(i, 'unitPrice', Number(e.target.value))}
                    />
                  </label>
                  <button
                    className="link-button"
                    disabled={edit.lines.length === 1}
                    onClick={() =>
                      setEdit({ ...edit, lines: edit.lines.filter((_, n) => n !== i) })
                    }
                  >
                    削除
                  </button>
                </div>
              ))}
            </div>
            <button
              className="button secondary small"
              onClick={() =>
                setEdit({
                  ...edit,
                  lines: [...edit.lines, { productId: null, name: '', quantity: 1, unitPrice: 0 }],
                })
              }
            >
              明細を追加
            </button>
            <div className="form-grid">
              <label>
                送料（税抜・円）
                <input
                  type="number"
                  min="0"
                  value={edit.shipping}
                  onChange={(e) => setEdit({ ...edit, shipping: Number(e.target.value) })}
                />
              </label>
              <label>
                税率
                <select
                  value={edit.taxRate}
                  onChange={(e) => setEdit({ ...edit, taxRate: Number(e.target.value) })}
                >
                  <option value="10">10%</option>
                  <option value="8">8%</option>
                  <option value="0">0%</option>
                </select>
              </label>
              <label>
                有効期限
                <input
                  type="date"
                  value={edit.expiresAt.slice(0, 10)}
                  onChange={(e) => {
                    if (e.target.value)
                      setEdit({
                        ...edit,
                        expiresAt: new Date(`${e.target.value}T23:59:59+09:00`).toISOString(),
                      });
                  }}
                />
              </label>
              <label>
                税込合計<output className="amount-output">{yen(total)}</output>
              </label>
            </div>
            <label>
              社内メモ（お客様には表示されません）
              <textarea
                value={edit.notes}
                onChange={(e) => setEdit({ ...edit, notes: e.target.value })}
              />
            </label>
            {n.error && <Notice message={n.error} type="error" />}
            <p className="muted">
              見積書のたたき台です。青木さんが明細・価格・在庫・納期を確認してから発行し、お客様のメール宛にご案内してください。
            </p>
            <label className="check-label">
              <input
                type="checkbox"
                checked={aokiReviewed}
                onChange={(e) => setAokiReviewed(e.target.checked)}
              />
              青木さんによる見積内容の確認済み
            </label>
            <div className="form-actions">
              <button className="button secondary" disabled={busy} onClick={() => save('draft')}>
                下書き保存
              </button>
              <button
                className="button primary"
                disabled={busy || !aokiReviewed}
                onClick={() => save('issued')}
              >
                この金額で見積を発行
              </button>
            </div>
          </div>
        </Modal>
      )}
      {creating && (
        <AdminCreateDocument
          kind="quote"
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            n.success('見積を下書き保存しました');
            void load();
          }}
        />
      )}
      {viewing && <ConversationDetail id={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}
