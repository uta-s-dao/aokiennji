'use client';
import { useEffect, useState } from 'react';
import { Plus, RefreshCw, Upload, Edit3, History } from 'lucide-react';
import {
  SOURCE_LABELS,
  type Source,
  type SourceInput,
  type ImportPreview,
  type ImportResult,
  type SourceRun,
  type SupplierKnowledge,
  type SupplierKnowledgeRow,
} from '@/lib/contracts';
import { api, datetime, errorMessage } from './api';
import { Empty, Modal, Notice, useNotice } from './AdminCommon';
import AdminSupplierSiteAudit from './AdminSupplierSiteAudit';
const blank: SourceInput = {
  name: '',
  kind: 'xlsx',
  url: '',
  enabled: true,
  trust: 'internal',
  visibility: 'internal',
  syncIntervalHours: 24,
  config: {},
};
const fields: Record<string, string> = {
  name: '商品名（必須）',
  model: '型番（必須）',
  manufacturer: 'メーカー',
  category: 'カテゴリ',
  description: '説明',
  specifications: '仕様',
  price: '販売価格',
  stock: '在庫',
  leadTime: '納期',
  availability: '取扱状態',
  verifiedAt: '確認日時',
  visibility: '公開範囲',
  image: '画像URL',
};
export default function AdminSources() {
  const [items, setItems] = useState<Source[]>([]),
    [loaded, setLoaded] = useState(false),
    [edit, setEdit] = useState<Source | null | false>(false),
    [form, setForm] = useState<SourceInput>(blank),
    [mappingJson, setMappingJson] = useState('{}'),
    [busy, setBusy] = useState(false),
    [uploadSource, setUploadSource] = useState<Source | null>(null),
    [preview, setPreview] = useState<ImportPreview | null>(null),
    [mapping, setMapping] = useState<Record<string, string>>({}),
    [approved, setApproved] = useState(false),
    [result, setResult] = useState<ImportResult | null>(null),
    [runs, setRuns] = useState<SourceRun[] | null>(null);
  const [knowledge, setKnowledge] = useState<SupplierKnowledge[] | null>(null);
  const notice = useNotice();
  async function load() {
    try {
      setItems(await api<Source[]>('/api/admin/sources'));
    } catch (e) {
      notice.fail(errorMessage(e));
    } finally {
      setLoaded(true);
    }
  }
  useEffect(() => {
    load();
  }, []);
  function open(s?: Source) {
    setForm(s ? { ...s, config: { ...s.config } } : { ...blank, config: {} });
    setMappingJson(JSON.stringify(s?.config.mapping || {}, null, 2));
    setEdit(s || null);
    notice.clear();
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const data = { ...form, config: { ...form.config, mapping: JSON.parse(mappingJson) } };
      await api(edit ? `/api/admin/sources/${edit.id}` : '/api/admin/sources', {
        method: edit ? 'PUT' : 'POST',
        body: JSON.stringify(data),
      });
      setEdit(false);
      notice.success('情報源を保存しました。');
      await load();
    } catch (e) {
      notice.fail(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function sync(s: Source) {
    setBusy(true);
    try {
      const r = await api<ImportResult>(`/api/admin/sources/${s.id}/sync`, { method: 'POST' });
      setResult(r);
      notice.success('同期が完了しました。取扱承認は商品画面で確認してください。');
      await load();
    } catch (e) {
      notice.fail(errorMessage(e));
      await load();
    } finally {
      setBusy(false);
    }
  }
  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !uploadSource) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('sourceId', uploadSource.id);
      const p = await api<ImportPreview>('/api/admin/import/preview', { method: 'POST', body: fd });
      setPreview(p);
      setMapping(p.suggestedMapping);
      setApproved(false);
    } catch (e) {
      notice.fail(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function commit() {
    if (!preview) return;
    setBusy(true);
    try {
      setResult(
        await api<ImportResult>('/api/admin/import/commit', {
          method: 'POST',
          body: JSON.stringify({ previewId: preview.previewId, mapping, approved }),
        }),
      );
      setPreview(null);
      setUploadSource(null);
      notice.success('取込を保存しました。');
      await load();
    } catch (e) {
      notice.fail(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="admin-toolbar">
        <p className="muted">商品台帳・仕入先一覧・カタログ・Webの情報をまとめて管理します。</p>
        <button className="button primary" onClick={() => open()}>
          <Plus size={18} /> 情報源を追加
        </button>
      </div>
      <Notice message={notice.error || notice.message} type={notice.error ? 'error' : 'success'} />
      <p className="muted">
        商品調査では、有効な登録商品・取込資料を先に照合し、登録された仕入先・Webサイトを優先検索します。
        登録先で商品・調達候補を確認できない場合に外部Webへ広げます。回答ごとの出典と検索経路は「相談・引継ぎ」の会話詳細で確認できます。
      </p>
      <div className="template-links">
        取込テンプレート：
        <a href="/templates/products.xlsx" download>
          Excel
        </a>
        <a href="/templates/products.csv" download>
          CSV
        </a>
      </div>
      {!loaded ? (
        <Empty title="読み込んでいます…" />
      ) : !items.length ? (
        <Empty
          title="情報源を追加してください"
          detail="Excelやカタログなど、利用する資料を登録できます。"
        />
      ) : (
        <div className="source-grid">
          {items.map((s) => (
            <section className="admin-card source-card" key={s.id}>
              <div className="card-title">
                <span className="pill">{SOURCE_LABELS[s.kind]}</span>
                <span className={`status-dot ${s.enabled ? 'on' : ''}`}>
                  {s.enabled ? '有効' : '停止中'}
                </span>
              </div>
              <h2>{s.name}</h2>
              <p className="muted">
                {s.recordCount}件 · {s.visibility === 'internal' ? '社内資料' : '公開資料'}
              </p>
              <small>最終同期：{datetime(s.lastSyncedAt)}</small>
              {s.kind === 'supplier_catalog' && (
                <p className="muted">
                  お客様への分野案内：
                  {s.enabled && s.config.answerEnabled
                    ? '利用する（承認済みの分野のみ）'
                    : '利用しない'}{' '}
                  · 社名・HPは非公開
                </p>
              )}
              {s.lastError && <p className="form-error">{s.lastError}</p>}
              <div className="source-actions">
                <button className="button secondary small" onClick={() => open(s)}>
                  <Edit3 size={15} /> 編集
                </button>
                {['csv', 'xlsx', 'supplier_catalog', 'pdf', 'docx', 'text'].includes(s.kind) ? (
                  <button
                    className="button secondary small"
                    disabled={!s.enabled || busy}
                    onClick={() => {
                      setUploadSource(s);
                      setPreview(null);
                    }}
                  >
                    <Upload size={15} /> 取込
                  </button>
                ) : (
                  <button
                    className="button secondary small"
                    disabled={!s.enabled || busy}
                    onClick={() => sync(s)}
                  >
                    <RefreshCw size={15} /> 同期
                  </button>
                )}
                {s.kind === 'supplier_catalog' && (
                  <button
                    className="button secondary small"
                    onClick={async () => {
                      try {
                        setKnowledge(
                          await api<SupplierKnowledge[]>(`/api/admin/sources/${s.id}/knowledge`),
                        );
                      } catch (e) {
                        notice.fail(errorMessage(e));
                      }
                    }}
                  >
                    登録内容
                  </button>
                )}
                <button
                  className="icon-button"
                  aria-label={`${s.name}の同期履歴`}
                  onClick={async () => {
                    try {
                      setRuns(await api<SourceRun[]>(`/api/admin/sources/${s.id}/runs`));
                    } catch (e) {
                      notice.fail(errorMessage(e));
                    }
                  }}
                >
                  <History size={17} />
                </button>
              </div>
            </section>
          ))}
        </div>
      )}
      {edit !== false && (
        <Modal title={edit ? '情報源を編集' : '情報源を追加'} wide onClose={() => setEdit(false)}>
          <form className="admin-form" onSubmit={save}>
            <div className="form-grid">
              <label>
                名称
                <input
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </label>
              <label>
                種類
                <select
                  value={form.kind}
                  disabled={!!edit && edit.kind === 'supplier_catalog'}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      kind: e.target.value as Source['kind'],
                      ...(e.target.value === 'supplier_catalog'
                        ? { visibility: 'internal', syncIntervalHours: 0 }
                        : {}),
                    })
                  }
                >
                  {Object.entries(SOURCE_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                信頼区分
                <select
                  value={form.trust}
                  onChange={(e) => setForm({ ...form, trust: e.target.value as Source['trust'] })}
                >
                  <option value="internal">社内管理情報</option>
                  <option value="approved_supplier">承認済み仕入先</option>
                  <option value="discovery">未確認の公開情報</option>
                </select>
              </label>
              <label>
                資料の公開範囲
                <select
                  value={form.visibility}
                  disabled={form.kind === 'supplier_catalog'}
                  onChange={(e) =>
                    setForm({ ...form, visibility: e.target.value as Source['visibility'] })
                  }
                >
                  <option value="internal">社内のみ</option>
                  <option value="public">公開可能</option>
                </select>
              </label>
            </div>
            {form.kind === 'supplier_catalog' && (
              <>
                <p className="muted">
                  社名・HPは管理画面内だけに保存します。確認した取扱分野をお客様に案内し、詳細は担当者への相談につなげます。売買金額は取り込みません。
                </p>
                <label className="consent-row">
                  <input
                    type="checkbox"
                    checked={!!form.config.answerEnabled}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        config: { ...form.config, answerEnabled: e.target.checked },
                      })
                    }
                  />
                  承認済みの取扱分野をチャットの回答に使う
                </label>
                <label>
                  資料の補足（社内のみ）
                  <textarea
                    rows={3}
                    value={form.config.text || ''}
                    placeholder="例：主要な取引先に限る。掲載会社には取引口座あり。"
                    onChange={(e) =>
                      setForm({ ...form, config: { ...form.config, text: e.target.value } })
                    }
                  />
                </label>
              </>
            )}
            {form.kind === 'manual' ? (
              <label>
                資料テキスト
                <textarea
                  rows={6}
                  value={form.config.text || ''}
                  onChange={(e) =>
                    setForm({ ...form, config: { ...form.config, text: e.target.value } })
                  }
                />
              </label>
            ) : (
              ['website', 'csv_url', 'json_api'].includes(form.kind) && (
                <>
                  <label>
                    取得URL
                    <input
                      type="url"
                      required
                      value={form.url}
                      onChange={(e) => setForm({ ...form, url: e.target.value })}
                    />
                  </label>
                  <div className="form-grid">
                    <label>
                      更新間隔（時間・0は手動のみ）
                      <input
                        type="number"
                        min="0"
                        max="8760"
                        value={form.syncIntervalHours}
                        onChange={(e) =>
                          setForm({ ...form, syncIntervalHours: Number(e.target.value) })
                        }
                      />
                    </label>
                    <label>
                      認証用の環境変数名
                      <input
                        placeholder="SOURCE_VENDOR_TOKEN"
                        value={form.config.authEnv || ''}
                        onChange={(e) =>
                          setForm({ ...form, config: { ...form.config, authEnv: e.target.value } })
                        }
                      />
                    </label>
                  </div>
                  <label>
                    許可ドメイン（カンマ区切り・省略可）
                    <input
                      value={form.config.allowedDomains?.join(',') || ''}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          config: {
                            ...form.config,
                            allowedDomains: e.target.value
                              .split(',')
                              .map((x) => x.trim())
                              .filter(Boolean),
                          },
                        })
                      }
                    />
                  </label>
                  {form.kind === 'json_api' && (
                    <label>
                      商品配列のパス
                      <input
                        placeholder="data.products"
                        value={form.config.itemsPath || ''}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            config: { ...form.config, itemsPath: e.target.value },
                          })
                        }
                      />
                    </label>
                  )}
                  <label>
                    項目の対応付け（JSON）
                    <textarea
                      rows={4}
                      value={mappingJson}
                      onChange={(e) => setMappingJson(e.target.value)}
                    />
                    <small>例：{`{"name":"商品名","model":"型番","price":"販売価格"}`}</small>
                  </label>
                </>
              )
            )}
            <label className="consent-row">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
              />
              この情報源を有効にする
            </label>
            <p className="muted">
              {form.kind === 'supplier_catalog'
                ? '保存後にExcelを取り込み、回答に使う分野を確認してください。一覧にない分野についても、対応不可とは断定しません。'
                : '資料の公開範囲と商品情報の公開・承認は別に管理します。同期後の変更は商品画面で確認してください。'}
            </p>
            {notice.error && <Notice message={notice.error} type="error" />}
            <button className="button primary" disabled={busy}>
              保存する
            </button>
          </form>
        </Modal>
      )}
      {uploadSource && (
        <Modal
          title={`${uploadSource.name}を取り込む`}
          wide
          onClose={() => {
            setUploadSource(null);
            setPreview(null);
          }}
        >
          <div className="admin-form">
            <label className="upload-area">
              <Upload size={26} />
              <strong>ファイルを選択</strong>
              <span>
                {uploadSource.kind === 'supplier_catalog'
                  ? 'XLSX'
                  : 'CSV / XLSX / PDF / DOCX / TXT'}{' '}
                · 最大10MB
              </span>
              <input
                type="file"
                accept={
                  uploadSource.kind === 'supplier_catalog' ? '.xlsx' : '.csv,.xlsx,.pdf,.docx,.txt'
                }
                disabled={busy}
                onChange={upload}
              />
            </label>
            {busy && <p>処理しています…</p>}
            {preview && (
              <>
                <p>
                  {preview.fileName} · {preview.totalRows}行 / 文書 {preview.documents.length}件
                </p>
                {preview.warnings.map((warning, i) => (
                  <p className="form-error" key={i}>
                    {warning}
                  </p>
                ))}
                {preview.supplierRows && (
                  <>
                    <p>
                      社名・HP・元の記載は社内のみ。「回答に使う分野」の表現だけをお客様に案内します。
                    </p>
                    <SupplierKnowledgeTable rows={preview.supplierRows} />
                    <label className="consent-row">
                      <input
                        type="checkbox"
                        checked={approved}
                        onChange={(e) => setApproved(e.target.checked)}
                      />
                      回答に使う分野を確認しました
                    </label>
                    <p className="muted">
                      未承認での保存もできます。再取込では、この情報源の登録内容を置き換えます。
                    </p>
                  </>
                )}
                {preview.rows.length > 0 && (
                  <>
                    <div className="mapping-grid">
                      {Object.entries(fields).map(([key, label]) => (
                        <label key={key}>
                          {label}
                          <select
                            value={mapping[key] || ''}
                            onChange={(e) => setMapping({ ...mapping, [key]: e.target.value })}
                          >
                            <option value="">取り込まない</option>
                            {preview.headers.map((h) => (
                              <option value={h} key={h}>
                                {h}
                              </option>
                            ))}
                          </select>
                        </label>
                      ))}
                    </div>
                    <details>
                      <summary>先頭の行を確認</summary>
                      <div className="table-scroll">
                        <table className="data-table">
                          <thead>
                            <tr>
                              {preview.headers.map((h) => (
                                <th key={h}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {preview.rows.slice(0, 5).map((row, i) => (
                              <tr key={i}>
                                {preview.headers.map((h) => (
                                  <td key={h}>{row[h]}</td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </details>
                    <label className="consent-row">
                      <input
                        type="checkbox"
                        checked={approved}
                        onChange={(e) => setApproved(e.target.checked)}
                      />
                      確認日時と販売条件を確認しました。取扱情報を承認して取り込む
                    </label>
                    <p className="muted">
                      同じ情報源・メーカー・型番の既存商品は更新されます。承認しない場合は「要確認」として登録します。
                    </p>
                  </>
                )}
                {preview.documents.map((d, i) => (
                  <div className="document-preview" key={i}>
                    <strong>{d.title}</strong>
                    <p>{d.content}</p>
                  </div>
                ))}
                <button
                  className="button primary"
                  disabled={busy || (!!preview.rows.length && (!mapping.name || !mapping.model))}
                  onClick={commit}
                >
                  この内容で取り込む
                </button>
              </>
            )}
            {notice.error && <Notice message={notice.error} type="error" />}
          </div>
        </Modal>
      )}
      {result && (
        <Modal title="取込結果" onClose={() => setResult(null)}>
          <p>
            追加 {result.imported}件 / 更新 {result.updated}件 / 文書 {result.documents}件
          </p>
          {result.errors.map((e, i) => (
            <p className="form-error" key={i}>
              {e.row}行目：{e.message}
            </p>
          ))}
          {result.warnings.map((w, i) => (
            <p key={i}>{w}</p>
          ))}
          <button className="button secondary" onClick={() => setResult(null)}>
            閉じる
          </button>
        </Modal>
      )}
      {runs && (
        <Modal title="同期履歴" onClose={() => setRuns(null)}>
          {runs.length ? (
            runs.map((r) => (
              <div className="activity-entry" key={r.id}>
                <strong>{r.status === 'success' ? '完了' : '失敗'}</strong>
                <p>{r.message}</p>
                <small>{datetime(r.createdAt)}</small>
              </div>
            ))
          ) : (
            <Empty title="まだ同期履歴はありません" />
          )}
        </Modal>
      )}
      {knowledge && (
        <Modal title="登録した仕入先情報（社内のみ）" wide onClose={() => setKnowledge(null)}>
          <p>
            {knowledge.length}件 · 回答利用の承認済み {knowledge.filter((r) => r.approved).length}件
          </p>
          <AdminSupplierSiteAudit rows={knowledge} />
          <details>
            <summary>元の登録情報・回答に使う分野を確認</summary>
            <SupplierKnowledgeTable rows={knowledge} />
          </details>
        </Modal>
      )}
    </>
  );
}

function SupplierKnowledgeTable({ rows }: { rows: SupplierKnowledgeRow[] }) {
  return (
    <div className="table-scroll" style={{ maxHeight: 360, overflow: 'auto' }}>
      <table className="data-table">
        <thead>
          <tr>
            <th>出典</th>
            <th>会社名（非公開）</th>
            <th>元の記載（非公開）</th>
            <th>HP（非公開）</th>
            <th>回答に使う分野</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              <td>
                {row.sheet} {row.row}行
              </td>
              <td>{row.supplierName}</td>
              <td>{row.products}</td>
              <td>
                {row.website ? (
                  <a href={row.website} target="_blank" rel="noreferrer">
                    HPを確認
                  </a>
                ) : (
                  'なし'
                )}
              </td>
              <td>{row.fields.join('、') || '対応分野なし（回答に使用しません）'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
