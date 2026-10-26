'use client';
import { useEffect, useState } from 'react';
import { Edit3, Plus, Search, Trash2 } from 'lucide-react';
import type { Product, ProductInput, Source, Supplier } from '@/lib/contracts';
import { AVAILABILITY_LABELS } from '@/lib/contracts';
import { api, date, errorMessage, yen, localDateTime } from './api';
import { Empty, Modal, Notice, useNotice } from './AdminCommon';
const blank: ProductInput = {
  name: '',
  model: '',
  manufacturer: '',
  category: '',
  description: '',
  specifications: '',
  image: '',
  availability: 'needs_review',
  price: null,
  stock: null,
  leadTime: '',
  sourceId: null,
  supplierId: null,
  approved: false,
  visibility: 'public',
  verifiedAt: null,
  isDemo: false,
};
export default function AdminProducts() {
  const [items, setItems] = useState<Product[]>([]),
    [sources, setSources] = useState<Source[]>([]),
    [suppliers, setSuppliers] = useState<Supplier[]>([]),
    [loading, setLoading] = useState(true),
    [query, setQuery] = useState(''),
    [editing, setEditing] = useState<Product | null | false>(false),
    [form, setForm] = useState<ProductInput>(blank),
    [saving, setSaving] = useState(false);
  const notice = useNotice();
  async function load() {
    setLoading(true);
    try {
      const [p, s, u] = await Promise.all([
        api<Product[]>('/api/admin/products'),
        api<Source[]>('/api/admin/sources'),
        api<Supplier[]>('/api/admin/suppliers'),
      ]);
      setItems(p);
      setSources(s);
      setSuppliers(u);
    } catch (e) {
      notice.fail(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);
  function edit(p?: Product) {
    setEditing(p || null);
    setForm(
      p
        ? {
            name: p.name,
            model: p.model,
            manufacturer: p.manufacturer,
            category: p.category,
            description: p.description,
            specifications: p.specifications,
            image: p.image,
            availability: p.availability,
            price: p.price,
            stock: p.stock,
            leadTime: p.leadTime,
            sourceId: p.sourceId,
            supplierId: p.supplierId,
            approved: p.approved,
            visibility: p.visibility,
            verifiedAt: p.verifiedAt,
            isDemo: p.isDemo,
          }
        : { ...blank },
    );
    notice.clear();
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const path = editing ? `/api/admin/products/${editing.id}` : '/api/admin/products';
      await api<Product>(path, { method: editing ? 'PUT' : 'POST', body: JSON.stringify(form) });
      setEditing(false);
      notice.success('商品を保存しました。');
      await load();
    } catch (e) {
      notice.fail(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }
  async function rebuildMetadata(p: Product) {
    try {
      await api(`/api/admin/products/${p.id}/search-metadata`, { method: 'POST' });
      notice.success('検索用情報の再作成を予約しました。定期同期で処理します。');
      await load();
    } catch (e) {
      notice.fail(errorMessage(e));
    }
  }
  async function remove(p: Product) {
    if (!confirm(`「${p.name}」を削除しますか？`)) return;
    try {
      await api(`/api/admin/products/${p.id}`, { method: 'DELETE' });
      notice.success('商品を削除しました。');
      await load();
    } catch (e) {
      notice.fail(errorMessage(e));
    }
  }
  const filtered = items.filter((p) =>
    `${p.name} ${p.model} ${p.manufacturer} ${p.category}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <>
      <div className="admin-toolbar">
        <div className="admin-search">
          <Search size={18} />
          <input
            aria-label="商品を検索"
            placeholder="商品名・型番で検索"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button className="button primary" type="button" onClick={() => edit()}>
          <Plus size={18} /> 商品を追加
        </button>
      </div>
      <Notice
        message={notice.message || notice.error}
        type={notice.error ? 'error' : 'success'}
        onClose={notice.clear}
      />
      {loading ? (
        <div className="state-box">商品を読み込んでいます…</div>
      ) : filtered.length ? (
        <div className="admin-card table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>商品</th>
                <th>取扱状態</th>
                <th>価格</th>
                <th>承認・公開</th>
                <th>確認日</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr key={p.id}>
                  <td>
                    <strong>{p.name}</strong>
                    <small>
                      {p.manufacturer} {p.model}
                    </small>
                    <small>
                      検索用情報：
                      {p.searchMetadata?.status === 'ready'
                        ? '作成済み'
                        : p.searchMetadata?.status === 'pending'
                          ? '作成待ち'
                          : p.searchMetadata?.status === 'failed'
                            ? '再試行待ち'
                            : '未作成'}
                    </small>
                    <button
                      type="button"
                      onClick={() => rebuildMetadata(p)}
                      aria-label={`${p.name}の検索用情報を再作成`}
                    >
                      検索用情報を再作成
                    </button>
                  </td>
                  <td>
                    <span className={`availability ${p.availability}`}>
                      {AVAILABILITY_LABELS[p.availability]}
                    </span>
                  </td>
                  <td>{yen(p.price)}</td>
                  <td>
                    {p.approved ? '承認済' : '未承認'} /{' '}
                    {p.visibility === 'public' ? '公開' : '社内のみ'}
                    {p.isDemo && <small>デモ</small>}
                  </td>
                  <td>{date(p.verifiedAt)}</td>
                  <td>
                    <div className="row-actions">
                      <button type="button" onClick={() => edit(p)} aria-label={`${p.name}を編集`}>
                        <Edit3 size={17} />
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(p)}
                        aria-label={`${p.name}を削除`}
                      >
                        <Trash2 size={17} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty
          title={query ? '検索結果がありません' : '商品がありません'}
          detail="新しい商品を登録するか、情報源から取り込んでください。"
          action={
            <button className="button primary" onClick={() => edit()}>
              <Plus size={18} /> 商品を追加
            </button>
          }
        />
      )}
      {editing !== false && (
        <Modal title={editing ? '商品を編集' : '商品を追加'} wide onClose={() => setEditing(false)}>
          <form onSubmit={save} className="admin-form">
            <div className="form-grid">
              <label>
                商品名 *
                <input
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </label>
              <label>
                型番
                <input
                  value={form.model}
                  onChange={(e) => setForm({ ...form, model: e.target.value })}
                />
              </label>
              <label>
                メーカー
                <input
                  value={form.manufacturer}
                  onChange={(e) => setForm({ ...form, manufacturer: e.target.value })}
                />
              </label>
              <label>
                カテゴリ
                <input
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                />
              </label>
            </div>
            <label>
              説明
              <textarea
                rows={3}
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </label>
            <label>
              仕様・用途
              <textarea
                rows={3}
                value={form.specifications}
                onChange={(e) => setForm({ ...form, specifications: e.target.value })}
              />
            </label>
            <label>
              画像URL
              <input
                value={form.image}
                onChange={(e) => setForm({ ...form, image: e.target.value })}
                placeholder="/images/example.jpg"
              />
            </label>
            <div className="form-grid">
              <label>
                取扱状態
                <select
                  value={form.availability}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      availability: e.target.value as ProductInput['availability'],
                    })
                  }
                >
                  {Object.entries(AVAILABILITY_LABELS).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                価格（税込前・円）
                <input
                  type="number"
                  min="0"
                  value={form.price ?? ''}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      price: e.target.value === '' ? null : Number(e.target.value),
                    })
                  }
                />
              </label>
              <label>
                在庫数
                <input
                  type="number"
                  min="0"
                  value={form.stock ?? ''}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      stock: e.target.value === '' ? null : Number(e.target.value),
                    })
                  }
                />
              </label>
              <label>
                納期目安
                <input
                  value={form.leadTime}
                  onChange={(e) => setForm({ ...form, leadTime: e.target.value })}
                />
              </label>
              <label>
                情報源
                <select
                  value={form.sourceId ?? ''}
                  onChange={(e) => setForm({ ...form, sourceId: e.target.value || null })}
                >
                  <option value="">指定なし</option>
                  {sources.map((s) => (
                    <option value={s.id} key={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                仕入先
                <select
                  value={form.supplierId ?? ''}
                  onChange={(e) => setForm({ ...form, supplierId: e.target.value || null })}
                >
                  <option value="">指定なし</option>
                  {suppliers.map((s) => (
                    <option value={s.id} key={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                情報確認日時
                <input
                  type="datetime-local"
                  value={form.verifiedAt ? localDateTime(form.verifiedAt) : ''}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      verifiedAt: e.target.value ? new Date(e.target.value).toISOString() : null,
                    })
                  }
                />
              </label>
              <label>
                公開範囲
                <select
                  value={form.visibility}
                  onChange={(e) =>
                    setForm({ ...form, visibility: e.target.value as ProductInput['visibility'] })
                  }
                >
                  <option value="public">公開</option>
                  <option value="internal">社内のみ</option>
                </select>
              </label>
            </div>
            <div className="check-grid">
              <label>
                <input
                  type="checkbox"
                  checked={form.approved}
                  onChange={(e) => setForm({ ...form, approved: e.target.checked })}
                />{' '}
                取扱情報を承認済み
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={form.isDemo}
                  onChange={(e) => setForm({ ...form, isDemo: e.target.checked })}
                />{' '}
                デモ商品
              </label>
            </div>
            {notice.error && (
              <div className="form-error" role="alert">
                {notice.error}
              </div>
            )}
            <div className="form-actions">
              <button className="button secondary" type="button" onClick={() => setEditing(false)}>
                キャンセル
              </button>
              <button className="button primary" disabled={saving}>
                {saving ? '保存中…' : '保存する'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
