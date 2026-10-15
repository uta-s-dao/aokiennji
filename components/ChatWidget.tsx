'use client';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  History,
  MessageCircle,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { ChatMessage, Conversation, PublicConfig } from '@/lib/contracts';
import Link from 'next/link';
import { api, datetime, errorMessage, streamChat } from './api';
import {
  archiveCurrent,
  archivedChats,
  clearCurrent,
  currentChat,
  isStale,
  removeArchived,
  saveCurrent,
  type SavedChat,
} from './chat-history';

export function openChat(message = '') {
  api<PublicConfig>('/api/config')
    .then((c) => {
      if (!c.flags.chat) {
        window.location.href = '/contact';
        return;
      }
      window.dispatchEvent(new CustomEvent('aoki:chat', { detail: message }));
    })
    .catch(() => window.dispatchEvent(new CustomEvent('aoki:chat', { detail: message })));
}
export type ChatViewState = { open: boolean; modal: boolean };
const availability = {
  available: '取扱あり',
  orderable: '取り寄せ対応',
  needs_review: '要確認',
  unavailable: '取扱対象外',
};

export default function ChatWidget({
  config,
  onStateChange,
}: {
  config: PublicConfig | null;
  onStateChange?: (state: ChatViewState) => void;
}) {
  const [open, setOpen] = useState(false);
  const [docked, setDocked] = useState(false);
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationId, setConversationId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [partialReply, setPartialReply] = useState('');
  const [restoring, setRestoring] = useState(true);
  // Past consultations saved in this browser, and the one being viewed.
  const [archive, setArchive] = useState<SavedChat[]>([]);
  const [viewing, setViewing] = useState<'list' | SavedChat | null>(null);
  const [error, setError] = useState('');
  const [atBottom, setAtBottom] = useState(true);
  const [viewport, setViewport] = useState<CSSProperties>({});
  const input = useRef<HTMLTextAreaElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const sending = useRef(false);
  const enabled = config?.flags.chat !== false;
  const lastMessage = messages.at(-1);

  useEffect(() => {
    const media = window.matchMedia('(min-width: 1200px)');
    const update = () => setDocked(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useLayoutEffect(() => {
    onStateChange?.({ open: open && enabled, modal: open && enabled && !docked });
  }, [open, enabled, docked, onStateChange]);
  useEffect(() => {
    let active = true;
    // Earlier versions kept the conversation per browser tab.
    sessionStorage.removeItem('aoki-conversation');
    const saved = currentChat();
    // After a long pause the next visit starts a new consultation; the last
    // one moves to this browser's list of past consultations.
    if (saved && isStale(saved)) archiveCurrent();
    setArchive(archivedChats());
    if (!saved || isStale(saved)) {
      setRestoring(false);
      return;
    }
    api<{ conversation: Conversation; messages: ChatMessage[] }>(
      `/api/chat/${encodeURIComponent(saved.id)}`,
    )
      .then((x) => {
        if (active) {
          setConversationId(saved.id);
          setMessages(x.messages);
        }
      })
      .catch(() => {
        if (active) clearCurrent();
      })
      .finally(() => {
        if (active) setRestoring(false);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (conversationId && !restoring) saveCurrent(conversationId, messages);
  }, [conversationId, messages, restoring]);
  useEffect(() => {
    const handler = (event: Event) => {
      previousFocus.current = document.activeElement as HTMLElement;
      setOpen(true);
      const text = (event as CustomEvent<string>).detail;
      if (text) setDraft(text);
    };
    window.addEventListener('aoki:chat', handler);
    return () => window.removeEventListener('aoki:chat', handler);
  }, []);
  useEffect(() => {
    if (!enabled) setOpen(false);
  }, [enabled]);
  useEffect(() => {
    if (open) {
      // Focus must not scroll the document underneath the conversation.
      input.current?.focus({ preventScroll: true });
      if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
    } else if (previousFocus.current) {
      // Wait for the parent to reveal the consultation form again.
      const frame = requestAnimationFrame(() => {
        const target = previousFocus.current?.isConnected ? previousFocus.current : trigger.current;
        target?.focus({ preventScroll: true });
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [open]);
  useEffect(() => {
    if (!open || docked) return;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const visualViewport = window.visualViewport;
    const update = () =>
      setViewport(
        visualViewport ? { height: visualViewport.height, top: visualViewport.offsetTop } : {},
      );
    update();
    visualViewport?.addEventListener('resize', update);
    visualViewport?.addEventListener('scroll', update);
    return () => {
      document.body.style.overflow = oldOverflow;
      visualViewport?.removeEventListener('resize', update);
      visualViewport?.removeEventListener('scroll', update);
    };
  }, [open, docked]);
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
      if (e.key !== 'Tab' || docked) return;
      const nodes = Array.from(
        panel.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),a[href],textarea:not(:disabled),summary',
        ) || [],
      ).filter((node) => node.getClientRects().length);
      const first = nodes[0],
        last = nodes.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, docked]);
  useLayoutEffect(() => {
    if (!open || !input.current) return;
    input.current.style.height = 'auto';
    input.current.style.height = `${Math.min(input.current.scrollHeight, 104)}px`;
  }, [draft, open]);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!open || !el) return;
    const latest = el.querySelector<HTMLElement>('.chat-message:last-of-type');
    if (lastMessage?.role === 'assistant' && latest) {
      el.scrollTop += latest.getBoundingClientRect().top - el.getBoundingClientRect().top - 18;
    } else el.scrollTop = el.scrollHeight;
    setAtBottom(el.scrollHeight - el.clientHeight - el.scrollTop < 32);
  }, [messages.length, busy, restoring, open, lastMessage?.role]);
  useLayoutEffect(() => {
    if (partialReply && atBottom && scroller.current)
      scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [partialReply, atBottom]);

  const send = useCallback(
    async (value?: string) => {
      const message = (value ?? draft).trim();
      if (!message || sending.current || restoring || !enabled) return;
      sending.current = true;
      setViewing(null);
      setError('');
      setBusy(true);
      setPartialReply('');
      setDraft('');
      const temp: ChatMessage = {
        id: `temp-${Date.now()}`,
        role: 'user',
        content: message,
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, temp]);
      try {
        const res = await streamChat({ message, conversationId }, setPartialReply);
        setConversationId(res.conversationId);
        setMessages((prev) => [...prev, res.message]);
      } catch (e) {
        setMessages((prev) => prev.filter((m) => m.id !== temp.id));
        setDraft(message);
        setError(errorMessage(e));
      } finally {
        sending.current = false;
        setBusy(false);
        setPartialReply('');
        input.current?.focus({ preventScroll: true });
      }
    },
    [draft, restoring, enabled, conversationId],
  );

  function resetConversation() {
    if (busy || restoring) return;
    archiveCurrent();
    setArchive(archivedChats());
    setViewing(null);
    setMessages([]);
    setConversationId(undefined);
    setDraft('');
    setError('');
    input.current?.focus({ preventScroll: true });
  }
  if (!enabled) return null;
  return (
    <>
      {!open && (
        <button
          ref={trigger}
          className="chat-launch"
          type="button"
          onClick={() => {
            previousFocus.current = document.activeElement as HTMLElement;
            setOpen(true);
          }}
          aria-label="商品相談チャットを開く"
          aria-expanded={open}
          aria-controls="product-chat"
        >
          <MessageCircle size={21} />
          <span>商品について相談する</span>
          <span className="chat-launch-dot" />
        </button>
      )}
      {open && (
        <div
          className={`chat-overlay ${docked ? 'is-docked' : 'is-modal'}`}
          style={docked ? undefined : viewport}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !docked) setOpen(false);
          }}
        >
          <section
            ref={panel}
            id="product-chat"
            className="chat-panel"
            role="dialog"
            aria-modal={!docked}
            aria-label="商品相談チャット"
          >
            <header className="chat-head">
              <div className="chat-avatar">
                <Bot size={21} />
              </div>
              <div className="chat-heading">
                <strong>商品相談アシスタント</strong>
                <small>アオキエンジ株式会社</small>
              </div>
              {archive.length > 0 && (
                <button
                  className="icon-button"
                  type="button"
                  aria-label="過去の相談"
                  title="過去の相談"
                  aria-pressed={!!viewing}
                  disabled={busy}
                  onClick={() => setViewing(viewing ? null : 'list')}
                >
                  <History size={17} />
                </button>
              )}
              <button
                className="icon-button"
                type="button"
                aria-label="新しい相談を始める"
                title="新しい相談を始める"
                disabled={busy || restoring}
                onClick={resetConversation}
              >
                <RotateCcw size={17} />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="チャットを閉じる"
                onClick={() => setOpen(false)}
              >
                <X size={21} />
              </button>
            </header>
            <div className="chat-thread">
              <div
                className="chat-messages"
                ref={scroller}
                role="log"
                aria-label="相談の会話"
                aria-live="polite"
                aria-busy={busy || restoring}
                onScroll={() => {
                  const el = scroller.current;
                  if (el) setAtBottom(el.scrollHeight - el.clientHeight - el.scrollTop < 32);
                }}
              >
                {viewing === 'list' && (
                  <div className="chat-archive">
                    <div className="chat-archive-head">
                      <button type="button" onClick={() => setViewing(null)}>
                        <ChevronLeft size={14} />
                        相談に戻る
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          removeArchived();
                          setArchive([]);
                          setViewing(null);
                        }}
                      >
                        <Trash2 size={13} />
                        すべて削除
                      </button>
                    </div>
                    <p className="chat-archive-note">
                      この端末で見られる履歴です（30日・10件まで）。削除しても、お店に送信済みの会話は残ります。
                    </p>
                    {archive.map((c) => (
                      <button
                        type="button"
                        key={c.id}
                        className="chat-archive-item"
                        onClick={() => setViewing(c)}
                      >
                        <strong>{c.title}</strong>
                        <small>
                          {datetime(c.updatedAt)}・{c.messages.length}件
                        </small>
                      </button>
                    ))}
                  </div>
                )}
                {viewing && viewing !== 'list' && (
                  <div className="chat-archive">
                    <div className="chat-archive-head">
                      <button type="button" onClick={() => setViewing('list')}>
                        <ChevronLeft size={14} />
                        過去の相談
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          removeArchived(viewing.id);
                          const rest = archivedChats();
                          setArchive(rest);
                          setViewing(rest.length ? 'list' : null);
                        }}
                      >
                        <Trash2 size={13} />
                        この相談を削除
                      </button>
                    </div>
                    <p className="chat-archive-note">
                      {datetime(viewing.updatedAt)}までのご相談（閲覧のみ）
                    </p>
                    {viewing.messages.map((m) => (
                      <article className={`chat-message ${m.role}`} key={m.id}>
                        {m.role === 'assistant' && (
                          <div className="chat-author">
                            <span>A</span>アオキエンジ
                          </div>
                        )}
                        <div className="chat-bubble">{m.content}</div>
                      </article>
                    ))}
                  </div>
                )}
                {!viewing && !messages.length && !restoring && (
                  <div className="chat-welcome">
                    <span className="chat-welcome-icon">
                      <MessageCircle size={25} />
                    </span>
                    <p className="chat-eyebrow">AOKI ENG / PRODUCT SUPPORT</p>
                    <h2>
                      こんにちは。
                      <br />
                      何をお探しですか？
                    </h2>
                    <p>
                      {config?.welcomeMessage ||
                        '商品の取扱いや納期、図面からの製作まで。お気軽にお聞きください。'}
                    </p>
                    <div className="chat-starters">
                      {[
                        '耐熱ガラスを探している',
                        '図面から製作できますか？',
                        'どんなことを相談できますか？',
                      ].map((s) => (
                        <button key={s} type="button" onClick={() => send(s)}>
                          {s}
                          <ArrowUpRight size={15} />
                        </button>
                      ))}
                    </div>
                    {archive[0] && (
                      <button
                        type="button"
                        className="chat-previous"
                        onClick={() => setViewing(archive[0])}
                      >
                        <History size={14} />
                        前回の相談を見る（{datetime(archive[0].updatedAt)}）
                      </button>
                    )}
                  </div>
                )}
                {restoring && (
                  <div className="chat-status" role="status">
                    前の会話を読み込んでいます…
                  </div>
                )}
                {!viewing &&
                  messages.map((m, index) => (
                    <article className={`chat-message ${m.role}`} key={m.id} data-message-id={m.id}>
                      {m.role === 'assistant' && (
                        <div className="chat-author">
                          <span>A</span>アオキエンジ
                        </div>
                      )}
                      <div className="chat-bubble">{m.content}</div>
                      {m.role === 'assistant' &&
                      m.products?.length &&
                      m.presentation === 'reply' ? (
                        <div className="chat-topic">
                          <Check size={12} />
                          {m.products.length === 1
                            ? m.products[0].model
                            : `${m.products.length}件の商品について`}
                        </div>
                      ) : null}
                      {m.role === 'assistant' &&
                        m.presentation !== 'reply' &&
                        m.products?.map((p, productIndex) => (
                          <div className="chat-product" key={p.id}>
                            <div className="chat-product-top">
                              <div>
                                <small>
                                  {m.products!.length > 1 && `${productIndex + 1}. `}
                                  {p.model}
                                </small>
                                <strong>{p.name}</strong>
                              </div>
                              <span className={`availability ${p.availability}`}>
                                {availability[p.availability]}
                              </span>
                            </div>
                            <details className="chat-product-details">
                              <summary>
                                商品情報を見る
                                <ChevronDown size={14} />
                              </summary>
                              <div>
                                {p.manufacturer && (
                                  <p>
                                    <span>メーカー</span>
                                    {p.manufacturer}
                                  </p>
                                )}
                                {config?.flags.showPrice && p.price !== null && (
                                  <p>
                                    <span>参考価格</span>¥{p.price.toLocaleString('ja-JP')}（税抜）
                                  </p>
                                )}
                                {config?.flags.showStock && p.stock !== null && (
                                  <p>
                                    <span>登録在庫</span>
                                    {p.stock}個
                                  </p>
                                )}
                                {config?.flags.showLeadTime && p.leadTime && (
                                  <p>
                                    <span>納期</span>
                                    {p.leadTime}
                                  </p>
                                )}
                                {p.verifiedAt && (
                                  <p>
                                    <span>確認日</span>
                                    {new Date(p.verifiedAt).toLocaleDateString('ja-JP')}
                                  </p>
                                )}
                                <Link href={`/products/${p.id}`} onClick={() => setOpen(false)}>
                                  商品詳細・見積へ
                                  <ArrowUpRight size={13} />
                                </Link>
                              </div>
                            </details>
                          </div>
                        ))}
                      {m.role === 'assistant' &&
                        m.evidence?.some((e) => e.url && e.visibility === 'public') && (
                          <details className="chat-evidence">
                            <summary>
                              回答の参照元
                              <ChevronDown size={12} />
                            </summary>
                            {m.evidence
                              .filter((e) => e.url && e.visibility === 'public')
                              .map((e, i) => (
                                <a target="_blank" rel="noopener noreferrer" key={i} href={e.url}>
                                  {e.title}
                                  <ArrowUpRight size={12} />
                                </a>
                              ))}
                          </details>
                        )}
                      {m.role === 'assistant' &&
                      index === messages.length - 1 &&
                      !busy &&
                      m.handoff &&
                      (m.handoff === 'quote'
                        ? config?.flags.quoteRequests
                        : config?.flags.humanHandoff) ? (
                        <Link
                          className="chat-handoff"
                          href={`/contact?${new URLSearchParams({
                            ...(conversationId ? { conversationId } : {}),
                            ...(m.handoff === 'quote' ? { quote: '1' } : {}),
                            ...(m.handoff === 'quote' && m.requestedQuantity
                              ? { quantity: String(m.requestedQuantity) }
                              : {}),
                            ...(m.handoff === 'quote' && m.handoffProductId && m.products?.[0]
                              ? { productId: m.handoffProductId, subject: m.products[0].name }
                              : {}),
                          })}`}
                          onClick={() => {
                            // The form starts from what was discussed here.
                            if (m.handoffDraft)
                              sessionStorage.setItem('aoki-handoff-draft', m.handoffDraft);
                            setOpen(false);
                          }}
                        >
                          <MessageCircle size={15} />
                          {m.handoff === 'quote'
                            ? 'この内容で見積を依頼する'
                            : 'この内容で担当者に相談する'}
                          <ArrowUpRight size={14} />
                        </Link>
                      ) : null}
                      {m.role === 'assistant' &&
                      index === messages.length - 1 &&
                      !busy &&
                      m.suggestions?.length ? (
                        <div className="chat-suggestions">
                          {m.suggestions.map((s) => (
                            <button type="button" key={s} onClick={() => send(s)}>
                              {s}
                              <ArrowUpRight size={12} />
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </article>
                  ))}
                {busy && partialReply ? (
                  <div className="chat-streaming" role="status">
                    <div className="chat-author">
                      <span>A</span>アオキエンジ
                    </div>
                    <div className="chat-bubble">{partialReply}</div>
                  </div>
                ) : (
                  busy && (
                    <div className="chat-loading" role="status">
                      <span />
                      <span />
                      <span />
                      <small>内容を確認しています</small>
                    </div>
                  )
                )}
              </div>
              {!atBottom && (
                <button
                  className="chat-jump"
                  type="button"
                  aria-label="最新のメッセージへ"
                  onClick={() =>
                    scroller.current?.scrollTo({
                      top: scroller.current.scrollHeight,
                      behavior: 'smooth',
                    })
                  }
                >
                  <ArrowDown size={16} />
                </button>
              )}
            </div>
            <footer className="chat-compose">
              {error && (
                <div className="form-error" role="alert">
                  {error}{' '}
                  <button type="button" className="link-button" onClick={() => send()}>
                    再試行
                  </button>
                </div>
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  send();
                }}
              >
                <textarea
                  ref={input}
                  rows={1}
                  maxLength={2000}
                  placeholder="続けて質問できます…"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (
                      e.key === 'Enter' &&
                      !e.shiftKey &&
                      !e.nativeEvent.isComposing &&
                      e.nativeEvent.keyCode !== 229
                    ) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  aria-label="相談内容"
                  disabled={restoring}
                />
                <button
                  type="submit"
                  aria-label="メッセージを送信"
                  disabled={busy || restoring || !draft.trim()}
                >
                  <ArrowUp size={20} />
                </button>
              </form>
              <div className="chat-compose-foot">
                <span>
                  {config?.demoMode
                    ? 'デモの商品情報でご案内しています'
                    : '登録情報をもとにご案内します'}
                </span>
                {config?.flags.humanHandoff && (
                  <Link
                    href={`/contact${conversationId ? '?conversationId=' + encodeURIComponent(conversationId) : ''}`}
                    onClick={() => setOpen(false)}
                    aria-label="担当者へのお問い合わせ"
                  >
                    担当者に相談
                    <ArrowUpRight size={12} />
                  </Link>
                )}
              </div>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
