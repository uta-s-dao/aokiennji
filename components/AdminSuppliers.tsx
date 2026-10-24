'use client';
import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import type { Supplier, SupplierInput } from '@/lib/contracts';
import { api, errorMessage } from './api';
import { Empty, Modal, Notice, useNotice } from './AdminCommon';
const blank: SupplierInput = {
  name: '',
  approved: false,
  enabled: true,
  domains: [],
  orderEndpoint: '',
  authEnv: '',
  notes: '',
};
export default function AdminSuppliers() {
  const [items, setItems] = useState<Supplier[]>([]),
    [edit, setEdit] = useState<Supplier | null | false>(false),
    [form, setForm] = useState<SupplierInput>(blank),
    [busy, setBusy] = useState(false);
  const n = useNotice();
  async function load() {
    try {
      setItems(await api<Supplier[]>('/api/admin/suppliers'));
    } catch (e) {
      n.fail(errorMessage(e));
    }
  }
  useEffect(() => {
    load();
  }, []);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api(edit ? `/api/admin/suppliers/${edit.id}` : '/api/admin/suppliers', {
        method: edit ? 'PUT' : 'POST',
        body: JSON.stringify(form),
      });
      setEdit(false);
      n.success('仕入先を保存しました');
      await load();
    } catch (e) {
      n.fail(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="admin-toolbar">
        <p className="muted">取引承認と、検索・注文先の設定を管理します。</p>
        <button
          className="button primary"
          onClick={() => {
            setForm({ ...blank });
            setEdit(null);
          }}
        >
          <Plus size={18} aria-hidden="true" /> 仕入先を追加
        </button>
      </div>
      <Notice message={n.error || n.message} type={n.error ? 'error' : 'success'} />
      <div className="source-grid">
        {items.map((s) => (
          <section className="admin-card source-card" key={s.id}>
            <span className="pill">
              {s.enabled ? (s.approved ? '取引承認済み' : '未承認') : '停止中'}
            </span>
            <h2>{s.name}</h2>
            <p className="muted">{s.domains.join(', ') || '検索ドメイン指定なし'}</p>
            <p>{s.orderEndpoint ? '注文先登録済み（疎通は未検証）' : '注文先未設定'}</p>
            <button
              className="button secondary small"
              onClick={() => {
                setForm({ ...s });
                setEdit(s);
              }}
            >
              編集する
            </button>
          </section>
        ))}
      </div>
      {!items.length && <Empty title="仕入先を登録してください" />}
      {edit !== false && (
        <Modal title="仕入先の設定" onClose={() => setEdit(false)}>
          <form className="admin-form" onSubmit={save}>
            <label>
              名称
              <input
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <label>
              検索・注文の許可ドメイン（カンマ区切り）
              <input
                value={form.domains.join(',')}
                onChange={(e) =>
                  setForm({
                    ...form,
                    domains: e.target.value
                      .split(',')
                      .map((x) => x.trim().toLowerCase())
                      .filter(Boolean),
                  })
                }
              />
            </label>
            <label>
              注文Webhook URL
              <input
                type="url"
                placeholder="https://supplier.example/orders"
                value={form.orderEndpoint}
                onChange={(e) => setForm({ ...form, orderEndpoint: e.target.value })}
              />
            </label>
            <label>
              署名キーの環境変数名
              <input
                placeholder="SUPPLIER_VENDOR_SECRET"
                value={form.authEnv}
                onChange={(e) => setForm({ ...form, authEnv: e.target.value })}
              />
            </label>
            <label>
              社内メモ
              <textarea
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            </label>
            <label className="consent-row">
              <input
                type="checkbox"
                checked={form.approved}
                onChange={(e) => setForm({ ...form, approved: e.target.checked })}
              />
              取引条件を確認し、承認済み
            </label>
            <label className="consent-row">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
              />
              この仕入先を有効にする
            </label>
            {n.error && <Notice type="error" message={n.error} />}
            <button className="button primary" disabled={busy}>
              保存する
            </button>
          </form>
        </Modal>
      )}
    </>
  );
}
