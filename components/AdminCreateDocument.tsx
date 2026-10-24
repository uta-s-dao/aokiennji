'use client';

import { useEffect, useRef, useState } from 'react';
import type { AdminDocumentInput, Product } from '@/lib/contracts';
import { api, errorMessage, yen } from './api';
import { Modal, Notice } from './AdminCommon';

export default function AdminCreateDocument({
  kind,
  onClose,
  onCreated,
}: {
  kind: 'quote' | 'order';
  onClose: () => void;
  onCreated: () => void;
}) {
  const isOrder = kind === 'order';
  const [form, setForm] = useState<AdminDocumentInput>(() => ({
    name: '',
    company: '',
    email: '',
    message: '',
    notes: '',
    shipping: 0,
    taxRate: 10,
    expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
    lines: [{ productId: null, name: '', quantity: 1, unitPrice: 0 }],
  }));
  const [products, setProducts] = useState<Product[]>([]);
  const [reviewed, setReviewed] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [productError, setProductError] = useState('');
  const request = useRef<{ body: string; key: string } | null>(null);
  const submitting = useRef(false);
  useEffect(() => {
    api<Product[]>('/api/admin/products')
      .then(setProducts)
      .catch(() =>
        setProductError('登録商品を読み込めませんでした。品名を直接入力して作成できます。'),
      );
  }, []);
  function line(index: number, patch: Partial<AdminDocumentInput['lines'][number]>) {
    setForm((value) => ({
      ...value,
      lines: value.lines.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    }));
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      const body = JSON.stringify({
        ...form,
        ...(isOrder ? { aokiReviewed: reviewed, customerConfirmed: confirmed } : {}),
      });
      if (request.current?.body !== body) request.current = { body, key: crypto.randomUUID() };
      await api(`/api/admin/${isOrder ? 'orders' : 'quotes'}`, {
        method: 'POST',
        body,
        headers: { 'Idempotency-Key': request.current.key },
      });
      onCreated();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  const subtotal = form.lines.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const tax = Math.floor(((subtotal + form.shipping) * form.taxRate) / 100);
  return (
    <Modal
      title={isOrder ? '注文を新規作成' : '見積を新規作成'}
      wide
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="admin-form" onSubmit={submit}>
        <fieldset className="document-fields" disabled={busy}>
          <div className="form-grid">
            <label>
              お名前
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
                maxLength={200}
                autoComplete="organization"
                value={form.company}
                onChange={(e) => setForm({ ...form, company: e.target.value })}
              />
            </label>
            <label>
              メールアドレス
              <input
                required
                type="email"
                maxLength={200}
                autoComplete="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </label>
          </div>
          <label>
            ご依頼内容
            <textarea
              maxLength={5000}
              value={form.message}
              onChange={(e) => setForm({ ...form, message: e.target.value })}
            />
          </label>
          {productError && <p className="help">{productError}</p>}
          <div className="quote-editor-lines">
            {form.lines.map((item, index) => (
              <section className="document-line" key={index} aria-label={`明細${index + 1}`}>
                <label>
                  登録商品から選ぶ（任意）
                  <select
                    value={item.productId || ''}
                    onChange={(e) => {
                      const product = products.find((p) => p.id === e.target.value);
                      line(
                        index,
                        product
                          ? {
                              productId: product.id,
                              name: product.name,
                              unitPrice: product.price ?? 0,
                            }
                          : { productId: null },
                      );
                    }}
                  >
                    <option value="">品名を直接入力</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} {p.model}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="quote-editor-line">
                  <label>
                    品名
                    <input
                      required
                      maxLength={300}
                      value={item.name}
                      onChange={(e) => line(index, { name: e.target.value, productId: null })}
                    />
                  </label>
                  <label>
                    数量
                    <input
                      required
                      type="number"
                      min={1}
                      max={100000}
                      step={1}
                      value={item.quantity}
                      onChange={(e) => line(index, { quantity: Number(e.target.value) })}
                    />
                  </label>
                  <label>
                    単価（税抜・円）
                    <input
                      required
                      type="number"
                      min={isOrder ? 1 : 0}
                      max={1000000000}
                      step={1}
                      value={item.unitPrice}
                      onChange={(e) => line(index, { unitPrice: Number(e.target.value) })}
                    />
                  </label>
                  <button
                    type="button"
                    className="link-button"
                    disabled={form.lines.length === 1}
                    aria-label={`明細${index + 1}を削除`}
                    onClick={() =>
                      setForm({ ...form, lines: form.lines.filter((_, i) => i !== index) })
                    }
                  >
                    削除
                  </button>
                </div>
              </section>
            ))}
          </div>
          <button
            type="button"
            className="button secondary small"
            disabled={form.lines.length >= 100}
            onClick={() =>
              setForm({
                ...form,
                lines: [...form.lines, { productId: null, name: '', quantity: 1, unitPrice: 0 }],
              })
            }
          >
            ＋ 明細を追加
          </button>
          <div className="form-grid">
            <label>
              送料（税抜・円）
              <input
                required
                type="number"
                min={0}
                max={1000000000}
                step={1}
                value={form.shipping}
                onChange={(e) => setForm({ ...form, shipping: Number(e.target.value) })}
              />
            </label>
            <label>
              税率
              <select
                value={form.taxRate}
                onChange={(e) => setForm({ ...form, taxRate: Number(e.target.value) })}
              >
                <option value={10}>10%</option>
                <option value={8}>8%</option>
                <option value={0}>0%</option>
              </select>
            </label>
            <label>
              有効期限
              <input
                required
                type="date"
                value={form.expiresAt.slice(0, 10)}
                onChange={(e) => {
                  if (e.target.value)
                    setForm({
                      ...form,
                      expiresAt: new Date(`${e.target.value}T23:59:59+09:00`).toISOString(),
                    });
                }}
              />
            </label>
          </div>
          <div className="quote-totals" aria-live="polite">
            <div>
              <span>小計（税抜）</span>
              <span>{yen(subtotal)}</span>
            </div>
            <div>
              <span>送料</span>
              <span>{yen(form.shipping)}</span>
            </div>
            <div>
              <span>消費税</span>
              <span>{yen(tax)}</span>
            </div>
            <div className="total">
              <span>税込合計</span>
              <output>{yen(subtotal + form.shipping + tax)}</output>
            </div>
          </div>
          <label>
            社内メモ（お客様には表示されません）
            <textarea
              maxLength={5000}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </label>
          {isOrder ? (
            <>
              <p className="help">
                注文内容の控えとして見積も保存します。注文は承認待ちになり、仕入先への送信は別途操作します。
              </p>
              <label className="check-label">
                <input
                  required
                  type="checkbox"
                  checked={reviewed}
                  onChange={(e) => setReviewed(e.target.checked)}
                />
                青木さんによる見積内容の確認済み
              </label>
              <label className="check-label">
                <input
                  required
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                お客様の注文内容・注文意思を確認済み
              </label>
            </>
          ) : (
            <p className="help">下書きで保存します。青木さんの確認後、見積一覧から発行できます。</p>
          )}
          <Notice message={error} type="error" />
          <div className="form-actions">
            <button type="button" className="button secondary" onClick={onClose}>
              キャンセル
            </button>
            <button className="button primary" disabled={isOrder && (!reviewed || !confirmed)}>
              {busy ? '保存しています…' : isOrder ? '承認待ちで注文を作成' : '見積を下書き保存'}
            </button>
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}
