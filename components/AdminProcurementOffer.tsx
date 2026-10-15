'use client';
import { useState } from 'react';
import type { ProcurementOffer } from '@/lib/contracts';
import { PREFECTURES } from '@/lib/sourcing-estimate';
import { api, datetime, errorMessage } from './api';

export default function AdminProcurementOffer({
  conversationId,
  noteId,
  offer,
  onSaved,
}: {
  conversationId: string;
  noteId: string;
  offer: ProcurementOffer;
  onSaved: (o: ProcurementOffer) => void;
}) {
  const [form, setForm] = useState(offer),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const change = (patch: Partial<ProcurementOffer>) =>
    setForm((current) => ({ ...current, ...patch, approved: false }));
  const number = (
    key:
      | 'price'
      | 'packQuantity'
      | 'availableQuantity'
      | 'procurementShippingNet'
      | 'customerShippingNet'
      | 'deliveryMinDays'
      | 'deliveryMaxDays',
    label: string,
    min = 0,
    max = 1000000000,
  ) => (
    <label key={key}>
      {label}
      <input
        type="number"
        min={min}
        max={max}
        value={form[key] ?? ''}
        placeholder="未確認"
        onInput={(e) =>
          change({ [key]: e.currentTarget.value === '' ? null : Number(e.currentTarget.value) })
        }
      />
    </label>
  );
  async function save() {
    setBusy(true);
    setNotice('');
    try {
      const saved = await api<ProcurementOffer>(
        `/api/admin/conversations/${conversationId}/research/${noteId}/offers/${offer.id}`,
        { method: 'PUT', body: JSON.stringify(form) },
      );
      setForm(saved);
      onSaved(saved);
      setNotice('調達条件を保存しました。次のチャットの質問から適用します。');
    } catch (e) {
      setNotice(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="procurement-offer">
      <summary>
        販売概算用の調達条件：{offer.title || offer.model}
        {form.approved ? '（確認済み）' : '（要確認）'}
      </summary>
      <p>
        <a href={offer.url} target="_blank" rel="noopener noreferrer">
          出典を開く
        </a>
        ・取得：{datetime(offer.checkedAt)}
        {form.confirmedAt ? `・担当者確認：${datetime(form.confirmedAt)}` : ''}
      </p>
      <p className="muted">
        同じ仕入先の条件を入力してください。価格は掲載価格を初期表示しています。仕入れ可能な価格・税区分・入数・数量・配送条件を出典で確認し、最後に確認済みにチェックします。
      </p>
      <div className="form-grid">
        {number('price', '1販売単位の仕入価格（円）', 1)}
        <label>
          仕入価格の税区分
          <select
            value={form.taxIncluded === null ? '' : String(form.taxIncluded)}
            onChange={(e) =>
              change({
                taxIncluded: e.target.value === '' ? null : e.target.value === 'true',
                approved: false,
              })
            }
          >
            <option value="">未確認</option>
            <option value="true">税込</option>
            <option value="false">税抜</option>
          </select>
        </label>
        <label>
          仕入時の税率
          <select
            value={form.purchaseTaxRate ?? ''}
            onChange={(e) =>
              change({
                purchaseTaxRate:
                  e.target.value === '' ? null : (Number(e.target.value) as 0 | 8 | 10),
                approved: false,
              })
            }
          >
            <option value="">未確認</option>
            {[0, 8, 10].map((v) => (
              <option value={v} key={v}>
                {v}%
              </option>
            ))}
          </select>
        </label>
        {number('packQuantity', '1販売単位あたりの入数（個）', 1, 100000)}
        {number('availableQuantity', '確認できた調達可能数量（個）')}
        <label>
          配送条件を確認したお届け先
          <select
            value={form.destination}
            onChange={(e) => change({ destination: e.target.value })}
          >
            <option value="">未確認</option>
            {PREFECTURES.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        {number('procurementShippingNet', '仕入先→当社の送料（税抜・円）')}
        {number('customerShippingNet', 'お客様への請求送料（税抜・円）')}
        {number('deliveryMinDays', 'お届けまでの最短営業日数', 0, 365)}
        {number('deliveryMaxDays', 'お届けまでの最長営業日数', 0, 365)}
      </div>
      <p className="muted">
        配送日数は、ご注文確定からお客様への到着までの目安です。当社経由なら両区間を含めてください。営業日は仕入先・配送会社の営業日を確認してください。
      </p>
      <div className="check-grid">
        <label>
          <input
            type="checkbox"
            checked={form.approved}
            onChange={(e) => {
              const approved = e.target.checked;
              setForm((current) => ({ ...current, approved }));
            }}
          />
          仕入可否と入力した条件を確認済み（未入力の項目は未確認のまま保存）
        </label>
      </div>
      <button type="button" className="button secondary small" disabled={busy} onClick={save}>
        {busy ? '保存中…' : '調達条件を保存'}
      </button>
      {notice && <p role="status">{notice}</p>}
    </details>
  );
}
