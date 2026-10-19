'use client';
import { useEffect, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import type { Inquiry } from '@/lib/contracts';
import type { AdminConversation, AdminConversationDetail } from '@/lib/source-verification';
import { api, datetime, errorMessage } from './api';
import { Empty, Modal, Notice, useNotice } from './AdminCommon';
import AdminResearchNote from './AdminResearchNote';
import AdminChatHistory from './AdminChatHistory';
// A chat with its staff-only research notes. Also opened from a quote request.
export function ConversationDetail({
  id,
  selectedAnswerId,
  onClose,
}: {
  id: string;
  selectedAnswerId?: string;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<AdminConversationDetail | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setDetail(null);
    setError('');
    api<AdminConversationDetail>(`/api/admin/conversations/${encodeURIComponent(id)}`)
      .then((value) => {
        if (active) setDetail(value);
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [id]);
  if (error)
    return (
      <Modal title="会話" onClose={onClose}>
        <Notice message={error} type="error" />
      </Modal>
    );
  if (!detail)
    return (
      <Modal title="会話と回答の詳細" wide onClose={onClose}>
        <p role="status">会話を読み込んでいます…</p>
      </Modal>
    );
  function download() {
    if (!detail?.verification) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(detail.verification, null, 2)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `${detail.verification.id}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }
  return (
    <Modal
      title={selectedAnswerId ? '回答とAI処理の詳細' : detail.conversation.title}
      wide
      onClose={onClose}
    >
      {detail.conversation.verification && (
        <div className="admin-toolbar">
          <p className="muted">
            {detail.verification?.simulation
              ? `顧客会話検証（${detail.verification.simulation.turnCount}往復）`
              : '実API検証'}
            ・OpenAI（{detail.conversation.verification.responseModel}）・優先参照先
            {detail.conversation.verification.preferredSiteCount}サイト
          </p>
          <button className="button secondary small" type="button" onClick={download}>
            <Download size={15} />
            {detail.verification?.simulation
              ? 'この会話の全記録をJSON保存'
              : 'この質問の全記録をJSON保存'}
          </button>
        </div>
      )}
      {detail.verification?.simulation && (
        <details className="research-notes">
          <summary>会話の検証結果</summary>
          <p>
            {detail.verification.simulation.label}：{detail.verification.simulation.customerGoal}
          </p>
          <p className="muted">
            {detail.verification.simulation.questionAgent}
            。回答ごとの出典とAPI利用記録は下の会話内で確認できます。
          </p>
          {detail.verification.simulation.quoteOutcome && (
            <p>
              見積依頼：受付済み ／ 正式見積：
              {detail.verification.simulation.quoteOutcome.issued ? '発行済み' : '未発行'}
              {' ／ 注文：'}
              {detail.verification.simulation.quoteOutcome.ordered ? 'あり' : 'なし'}
              <br />
              {detail.verification.simulation.quoteOutcome.lineName}・
              {detail.verification.simulation.quoteOutcome.quantity}個
              {!!detail.verification.simulation.quoteOutcome.blockers.length && (
                <span className="muted">
                  <br />
                  発行前の確認：{detail.verification.simulation.quoteOutcome.blockers.join('、')}
                </span>
              )}
            </p>
          )}
          {detail.verification.simulation.review && (
            <>
              <p>
                <strong>
                  {
                    { pass: '大きな問題なし', needs_review: '確認が必要', fail: '問題あり' }[
                      detail.verification.simulation.review.verdict
                    ]
                  }
                </strong>
                ：{detail.verification.simulation.review.summary}
              </p>
              <ul className="research-bullets">
                {detail.verification.simulation.review.findings.map((finding, index) => (
                  <li key={index}>
                    第{finding.turn}回答：{finding.detail}
                  </li>
                ))}
              </ul>
            </>
          )}
          {!!detail.verification.simulation.customerUiErrors?.length && (
            <details>
              <summary>お客様役の操作の再試行</summary>
              {detail.verification.simulation.customerUiErrors.map((item) => (
                <p key={item.round}>
                  {item.round}回目：{item.message}
                </p>
              ))}
            </details>
          )}
          {!!detail.verification.simulation.technicalFindings?.length && (
            <>
              <p>
                <strong>回答と検索記録の照合で見つかった問題</strong>
              </p>
              <ul className="research-bullets">
                {detail.verification.simulation.technicalFindings.map((finding, index) => (
                  <li key={index}>
                    第{finding.turn}回答：{finding.detail}
                    <p className="muted">根拠：{finding.evidence}</p>
                  </li>
                ))}
              </ul>
            </>
          )}
        </details>
      )}
      <AdminChatHistory
        messages={detail.messages}
        answers={detail.answers}
        selectedAnswerId={selectedAnswerId}
      />
      {detail.research?.length ? (
        <details className="research-notes">
          <summary>AI調査メモ（担当者用・お客様には表示されません）</summary>
          {detail.research.map((note) => (
            <AdminResearchNote
              key={note.id}
              note={note}
              conversationId={id}
              readOnly={!!detail.conversation.verification}
              onOfferSaved={(saved) =>
                setDetail(
                  (current) =>
                    current && {
                      ...current,
                      research: current.research.map((n) =>
                        n.id === note.id
                          ? {
                              ...n,
                              offers: n.offers?.map((o) => (o.id === saved.id ? saved : o)),
                            }
                          : n,
                      ),
                    },
                )
              }
            />
          ))}
          <details className="research-legend">
            <summary>確認状況の見方</summary>
            <ul className="research-bullets">
              <li>ページで確認済み：取得したページに該当する記載があります。</li>
              <li>一部のみ確認：数値の一部や短い語のみ確認できた項目です。</li>
              <li>ページの記載と不一致：AIの読み違いの可能性があります。</li>
              <li>自動取得できず未確認：ページを自動取得できず、照合できていません。</li>
              <li>別の型式・サイズの可能性：お客様の品目と一致していない可能性があります。</li>
            </ul>
            <p>お客様への回答前に、出典URLから最新の条件をご確認ください。</p>
          </details>
        </details>
      ) : null}
    </Modal>
  );
}
export default function AdminConversations() {
  const [conversations, setConversations] = useState<AdminConversation[]>([]),
    [inquiries, setInquiries] = useState<Inquiry[]>([]),
    [viewing, setViewing] = useState<string | null>(null),
    [edit, setEdit] = useState<Inquiry | null>(null),
    [busy, setBusy] = useState(false);
  const n = useNotice();
  async function load(openRequested = false) {
    try {
      const [c, i] = await Promise.all([
        api<AdminConversation[]>('/api/admin/conversations'),
        api<Inquiry[]>('/api/admin/inquiries'),
      ]);
      setConversations(c);
      setInquiries(i);
      if (openRequested) {
        const params = new URLSearchParams(location.search);
        const requested = c.find(
          (conversation) =>
            conversation.id === params.get('conversation') ||
            conversation.verification?.id === params.get('case'),
        );
        if (requested) view(requested.id);
      }
    } catch (e) {
      n.fail(errorMessage(e));
    }
  }
  useEffect(() => {
    load(true);
  }, []);
  function view(id: string) {
    setViewing(id);
    history.replaceState(
      null,
      '',
      `/admin?tab=conversations&conversation=${encodeURIComponent(id)}`,
    );
  }
  function closeConversation() {
    setViewing(null);
    history.replaceState(null, '', '/admin?tab=conversations');
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!edit) return;
    setBusy(true);
    try {
      await api(`/api/admin/inquiries/${edit.id}`, {
        method: 'PUT',
        body: JSON.stringify({ status: edit.status, notes: edit.notes }),
      });
      setEdit(null);
      n.success('対応状況を保存しました');
      load();
    } catch (e) {
      n.fail(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Notice message={n.error || n.message} type={n.error ? 'error' : 'success'} />
      <section className="admin-card">
        <h2>担当者へのお問い合わせ</h2>
        {inquiries.length ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>お客様</th>
                  <th>内容</th>
                  <th>状態</th>
                  <th>受付日時</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {inquiries.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <strong>
                        {i.company} {i.name}
                      </strong>
                      <small>{i.email}</small>
                    </td>
                    <td>{i.message.slice(0, 80)}</td>
                    <td>{{ new: '未対応', in_progress: '対応中', resolved: '完了' }[i.status]}</td>
                    <td>{datetime(i.createdAt)}</td>
                    <td>
                      <button className="button secondary small" onClick={() => setEdit({ ...i })}>
                        確認
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="まだお問い合わせはありません" />
        )}
      </section>
      <section className="admin-card">
        <div className="admin-conversations-heading">
          <h2>チャットの履歴（{conversations.length}件）</h2>
          <button type="button" className="button secondary small" onClick={() => load()}>
            <RefreshCw size={14} />
            更新
          </button>
        </div>
        <p className="admin-conversations-note">
          受け付けたすべてのチャットを保存しています。新しい相談を始めても、過去の会話は残ります。
          各会話を開くと、回答の情報源と検索経路も確認できます。
        </p>
        {conversations.length ? (
          <div className="conversation-list">
            {conversations.map((c) => (
              <button key={c.id} data-conversation-id={c.id} onClick={() => view(c.id)}>
                <strong>{c.title}</strong>
                {c.verification && <small>{c.verification.responseModel}</small>}
                <span>
                  {c.verification
                    ? c.verification.kind === 'customer_simulation'
                      ? `顧客会話検証（${c.verification.turnCount}往復）`
                      : '実API検証'
                    : c.status === 'handed_off'
                      ? '担当者に引継ぎ済み'
                      : c.status === 'closed'
                        ? '終了'
                        : '相談中'}
                </span>
                <small>{datetime(c.updatedAt)}</small>
              </button>
            ))}
          </div>
        ) : (
          <Empty title="まだチャットの履歴はありません" />
        )}
      </section>
      {viewing && <ConversationDetail id={viewing} onClose={closeConversation} />}
      {edit && (
        <Modal title="お問い合わせの対応" onClose={() => setEdit(null)}>
          <form className="admin-form" onSubmit={save}>
            <p>
              <strong>
                {edit.company} {edit.name}
              </strong>
              <br />
              {edit.email}
            </p>
            <p className="preline">{edit.message}</p>
            {edit.conversationId && (
              <button
                type="button"
                className="button secondary"
                onClick={() => {
                  view(edit.conversationId!);
                  setEdit(null);
                }}
              >
                関連する会話を見る
              </button>
            )}
            <label>
              対応状態
              <select
                value={edit.status}
                onChange={(e) => setEdit({ ...edit, status: e.target.value as Inquiry['status'] })}
              >
                <option value="new">未対応</option>
                <option value="in_progress">対応中</option>
                <option value="resolved">完了</option>
              </select>
            </label>
            <label>
              社内メモ
              <textarea
                rows={5}
                value={edit.notes}
                onChange={(e) => setEdit({ ...edit, notes: e.target.value })}
              />
            </label>
            {n.error && <Notice message={n.error} type="error" />}
            <button className="button primary" disabled={busy}>
              保存する
            </button>
          </form>
        </Modal>
      )}
    </>
  );
}
