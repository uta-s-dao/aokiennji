'use client';
import { useEffect, useState } from 'react';
import { ArrowUpRight, CheckCircle2, Phone } from 'lucide-react';
import SiteShell from '@/components/SiteShell';
import { api, errorMessage } from '@/components/api';
import { currentChat } from '@/components/chat-history';
import { company } from '@/lib/company';
import type { Inquiry, PublicConfig, Quote } from '@/lib/contracts';
export default function Contact() {
  const [form, setForm] = useState({
    name: '',
    company: '',
    email: '',
    message: '',
    consent: false,
    quantity: 1,
  });
  const [productId, setProductId] = useState<string | undefined>(),
    [quote, setQuote] = useState(false),
    [config, setConfig] = useState<PublicConfig | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [receipt, setReceipt] = useState<{ id: string; token?: string } | null>(null);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const subject = p.get('subject');
    const requestedQuantity = Number(p.get('quantity'));
    const quantity =
      Number.isSafeInteger(requestedQuantity) &&
      requestedQuantity > 0 &&
      requestedQuantity <= 100000
        ? requestedQuantity
        : undefined;
    // Written by the chat's hand-off button: what the customer already told us.
    const draft = p.get('conversationId') ? sessionStorage.getItem('aoki-handoff-draft') : null;
    sessionStorage.removeItem('aoki-handoff-draft');
    setProductId(p.get('productId') || undefined);
    setQuote(p.get('quote') === '1');
    if (draft || subject || quantity)
      setForm((f) => ({
        ...f,
        quantity: quantity ?? f.quantity,
        message: draft
          ? `${subject ? `${subject}について相談したいです。\n` : ''}${draft}\n`
          : subject
            ? `${subject}について相談したいです。\n`
            : f.message,
      }));
    api<PublicConfig>('/api/config')
      .then(setConfig)
      .catch(() => {});
  }, []);
  const quoteEnabled = !!config?.flags.quoteRequests;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.consent) return;
    setBusy(true);
    setError('');
    try {
      if (quote && quoteEnabled) {
        const data = await api<Quote>('/api/quotes', {
          method: 'POST',
          body: JSON.stringify({
            name: form.name,
            company: form.company,
            email: form.email,
            message: form.message,
            consent: true,
            conversationId:
              new URLSearchParams(location.search).get('conversationId') ||
              currentChat()?.id ||
              undefined,
            productId,
            quantity: form.quantity,
          }),
        });
        setReceipt({ id: data.id, token: data.token });
      } else {
        const data = await api<Inquiry>('/api/inquiries', {
          method: 'POST',
          body: JSON.stringify({
            name: form.name,
            company: form.company,
            email: form.email,
            message: form.message,
            consent: true,
            conversationId:
              new URLSearchParams(location.search).get('conversationId') ||
              currentChat()?.id ||
              undefined,
          }),
        });
        setReceipt({ id: data.id });
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <SiteShell>
      <div className="page-hero">
        <div className="container">
          <p className="eyebrow">CONTACT</p>
          <h1>お問い合わせ</h1>
          <p>製品のお探しもの、製作や施工のご相談をお聞かせください。</p>
        </div>
      </div>
      <section className="section">
        <div className="container contact-layout">
          <div className="contact-info">
            <p className="eyebrow">GET IN TOUCH</p>
            <h2 className="section-title">
              まずは、
              <br />
              お話を聞かせてください。
            </h2>
            <p>
              用途や仕様がまだ決まっていない段階でも、お気軽にご相談ください。担当者が内容を確認します。
            </p>
            <div className="contact-call">
              <span>お電話でのお問い合わせ</span>
              <a href={`tel:${company.phone}`}>
                <Phone size={23} />
                {company.phone}
              </a>
              <small>電話番号をタップして発信できます</small>
            </div>
          </div>
          <div className="form-panel">
            {config &&
            ((quote && !config.flags.quoteRequests) || (!quote && !config.flags.humanHandoff)) ? (
              <div className="state-box">
                現在、オンラインのお問い合わせは休止しています。お電話でご相談ください。
              </div>
            ) : receipt ? (
              <div className="success-state" role="status">
                <CheckCircle2 size={46} />
                <h2>{quote ? '見積依頼を受け付けました' : 'お問い合わせを受け付けました'}</h2>
                <p>
                  受付番号：<strong>{receipt.id}</strong>
                </p>
                <p>担当者が内容を確認します。お問い合わせありがとうございました。</p>
                {receipt.token && (
                  <a className="button secondary" href={`/quotes/${receipt.token}`}>
                    見積内容を確認する <ArrowUpRight size={17} />
                  </a>
                )}
              </div>
            ) : (
              <form onSubmit={submit}>
                <h2>{quote && quoteEnabled ? '見積依頼フォーム' : 'お問い合わせフォーム'}</h2>
                <p className="form-required-note">
                  <span>*</span> は必須項目です
                </p>
                <div className="form-row">
                  <label>
                    お名前 <span>*</span>
                    <input
                      required
                      maxLength={100}
                      autoComplete="name"
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                    />
                  </label>
                  <label>
                    会社名
                    <input
                      maxLength={100}
                      autoComplete="organization"
                      value={form.company}
                      onChange={(e) => setForm({ ...form, company: e.target.value })}
                    />
                  </label>
                </div>
                <label>
                  メールアドレス <span>*</span>
                  <input
                    required
                    type="email"
                    maxLength={200}
                    autoComplete="email"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                  />
                </label>
                {quote && quoteEnabled && (
                  <label>
                    数量 <span>*</span>
                    <input
                      required
                      type="number"
                      min="1"
                      max="100000"
                      value={form.quantity}
                      onChange={(e) => setForm({ ...form, quantity: Number(e.target.value) })}
                    />
                  </label>
                )}
                <label>
                  ご相談内容 <span>*</span>
                  <textarea
                    required
                    rows={8}
                    maxLength={5000}
                    placeholder="商品名・型番、用途、数量、希望納期などわかる範囲でご記入ください。"
                    value={form.message}
                    onChange={(e) => setForm({ ...form, message: e.target.value })}
                  />
                </label>
                <label className="consent-row">
                  <input
                    type="checkbox"
                    required
                    checked={form.consent}
                    onChange={(e) => setForm({ ...form, consent: e.target.checked })}
                  />
                  <span>
                    <a href="/privacy" target="_blank" rel="noopener noreferrer">
                      プライバシーに関するご案内
                    </a>
                    を確認し、入力情報の取扱いに同意します。
                  </span>
                </label>
                {error && (
                  <div className="form-error" role="alert">
                    {error}
                  </div>
                )}
                <button className="button primary full" type="submit" disabled={busy}>
                  {busy
                    ? '送信しています…'
                    : quote && quoteEnabled
                      ? '見積を依頼する'
                      : '内容を送信する'}{' '}
                  <ArrowUpRight size={19} />
                </button>
              </form>
            )}
          </div>
        </div>
      </section>
    </SiteShell>
  );
}
