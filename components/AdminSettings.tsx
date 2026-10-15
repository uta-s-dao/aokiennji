'use client';
import { useEffect, useState } from 'react';
import type { AppSettings, Flags, ProviderStatus, ProviderCheck } from '@/lib/contracts';
import { api, errorMessage } from './api';
import { Notice, useNotice } from './AdminCommon';
import AdminEstimatePolicy from './AdminEstimatePolicy';
const options: [keyof Flags, string, string][] = [
  ['chat', '商品相談チャット', 'サイト上で商品・製作の相談を受け付けます'],
  ['humanHandoff', '担当者への引継ぎ', '連絡先と相談内容を受付一覧に保存します'],
  ['showPrice', '価格を表示', '承認された最新の販売価格を案内します'],
  ['showStock', '在庫を表示', '確認済みの在庫数を案内します'],
  ['showLeadTime', '納期を表示', '確認済みの納期目安を案内します'],
  [
    'webSearch',
    '未登録商品のWeb検索・調達先調査',
    '台帳にない型番も検索し、調達候補と掲載価格を会話のAI調査メモに残します。お客様には当社への取り寄せ・見積相談を案内します',
  ],
  [
    'aiResearch',
    'AIによる価格・納期の調査（担当者向け）',
    '価格・在庫・納期・送料を聞かれた品目を、メーカー・通販・運送会社・仕入先のサイトで調べ、会話の「AI調査メモ」に残します。お客様には表示しません',
  ],
  ['quoteRequests', '見積依頼を受け付ける', '数量・連絡先を聞き、見積案件を作成します'],
  ['autoQuote', '自動見積', '有効な登録価格がある商品から見積を発行します'],
  ['orders', '注文依頼を受け付ける', '発行した見積から顧客が注文を依頼できます'],
  [
    'autoOrder',
    '条件に合う注文を自動処理',
    '承認済み仕入先と金額上限の条件を満たす注文を処理します',
  ],
];
export default function AdminSettings() {
  const [form, setForm] = useState<AppSettings | null>(null),
    [providers, setProviders] = useState<ProviderStatus[]>([]),
    [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState('');
  const n = useNotice();
  useEffect(() => {
    let active = true;
    Promise.all([
      api<AppSettings>('/api/admin/settings'),
      api<ProviderStatus[]>('/api/admin/providers'),
    ])
      .then(([s, p]) => {
        if (!active) return;
        setForm(s);
        setProviders(p);
      })
      .catch((e) => {
        if (active) n.fail(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, []);
  function toggle(key: keyof Flags) {
    if (!form) return;
    const flags = { ...form.flags, [key]: !form.flags[key] };
    if (!flags.quoteRequests) {
      flags.autoQuote = false;
      flags.orders = false;
      flags.autoOrder = false;
    }
    if (!flags.orders) flags.autoOrder = false;
    setForm({ ...form, flags });
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      setForm(
        await api<AppSettings>('/api/admin/settings', {
          method: 'PUT',
          body: JSON.stringify(form),
        }),
      );
      n.success('設定を保存しました。公開画面にも適用されます。');
    } catch (e) {
      n.fail(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function checkConnection(id: string) {
    setChecking(id);
    try {
      const check = await api<ProviderCheck>(`/api/admin/providers/${id}/test`, { method: 'POST' });
      setProviders(await api<ProviderStatus[]>('/api/admin/providers'));
      if (check.ok) n.success(`${check.message} 応答時間 ${check.durationMs}ms`);
      else n.fail(check.message);
    } catch (e) {
      n.fail(errorMessage(e));
    } finally {
      setChecking('');
    }
  }
  return (
    <>
      <Notice message={n.error || n.message} type={n.error ? 'error' : 'success'} />
      {form ? (
        <form onSubmit={save} className="admin-form">
          <section className="admin-card ai-setup-card">
            <h2>AIチャットの接続設定</h2>
            <p className="muted">
              価格・在庫・納期など登録情報で決まる質問はそのまま回答し、それ以外の相談は会話の流れを踏まえて生成AIが回答します。
            </p>
            <div className="admin-notice" role="status">
              {form.responseProvider === 'local'
                ? '現在は登録情報とルールによる応答です。生成AIは有効になっていません。'
                : providers.find((p) => p.id === form.responseProvider)?.configured
                  ? '生成AIを選択しています。設定を保存後、「接続を確認」で実通信を確認してください。'
                  : `生成AIの接続は未完了です。${form.responseProvider === 'openai' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY'} をサーバーに設定してください。`}
            </div>
            <div className="ai-presets">
              <button
                type="button"
                className="button secondary small"
                onClick={() =>
                  setForm({
                    ...form,
                    decisionProvider: 'local',
                    model: '',
                    responseProvider: 'openai',
                    responseModel: 'gpt-4.1-mini',
                  })
                }
              >
                OpenAIの構成を選ぶ（推奨）
              </button>
              <button
                type="button"
                className="button secondary small"
                onClick={() =>
                  setForm({
                    ...form,
                    decisionProvider: 'jev',
                    model: 'jev-latest',
                    responseProvider: 'openai',
                    responseModel: 'gpt-4.1-mini',
                  })
                }
              >
                Jev＋OpenAIの構成を選ぶ
              </button>
            </div>
            <ol className="ai-setup-steps">
              <li>
                <a href="https://console.typesafe.ai/" target="_blank" rel="noreferrer">
                  TypeSafe
                </a>{' '}
                と{' '}
                <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">
                  OpenAI
                </a>{' '}
                でAPIキーを発行します。
              </li>
              <li>
                サーバーの <code>.env.local</code> に <code>TYPESAFE_API_KEY</code> と{' '}
                <code>OPENAI_API_KEY</code>{' '}
                を保存し、サーバーを再起動します。キーの値は画面やチャットに公開しないでください。
              </li>
              <li>
                下の方式を選んで設定を保存し、各サービスの接続確認を実行します。確認時に少量のAPI利用が発生します。
              </li>
              <li>
                「情報源」にExcel・PDF等を取り込み、回答への利用を承認します。Web検索には別途ExaまたはTavilyのキーが必要です。
              </li>
            </ol>
            <details className="ai-routing-guide">
              <summary>ローカル処理とAIの使い分け</summary>
              <dl>
                <dt>ローカルで確定</dt>
                <dd>
                  登録済み商品の照合、価格・在庫・納期、数量・税込の計算、公開範囲、見積・注文・取り置きの手続き、担当者への相談方法、送料・値引き・支払条件・会社情報の案内。
                </dd>
                <dt>OpenAI等で会話</dt>
                <dd>
                  用途・仕様の相談、比較、条件の整理と要約、短い返事への応答。お客様が伝えた条件を踏まえて答えます。価格・在庫・納期や約束は生成AIに書かせず、不適切な表現は理由を添えて1回だけ書き直させます。
                </dd>
                <dt>Jev（任意）</dt>
                <dd>
                  曖昧な商品説明から取扱分野を推定します。推奨構成では使わず、分野の判断も生成AIが会話の中で行います。
                </dd>
                <dt>事実の質問と相談が混在</dt>
                <dd>
                  事実の回答を先に表示し、AIの補足を続けて表示します。AIが失敗しても、確定した登録値の回答は保持します。
                </dd>
                <dt>AIを使わないとき</dt>
                <dd>
                  会話からお客様の条件を拾い、確認ポイントと担当者への相談方法を組み立てて回答します。
                </dd>
                <dt>担当者への引継ぎ</dt>
                <dd>
                  相談が進むと「この内容で担当者に相談する」ボタンを表示し、相談内容を入力した問い合わせフォームを開きます。
                </dd>
              </dl>
              <p className="muted">
                実際の振り分け理由・使用した方式・所要時間は「操作履歴」で確認できます。
              </p>
            </details>
          </section>
          <section className="admin-card">
            <div className="card-title">
              <h2>機能オプション</h2>
            </div>
            <div className="settings-list">
              {options.map(([key, label, help]) => (
                <label className="setting-row" key={key}>
                  <div>
                    <strong>{label}</strong>
                    <p>{help}</p>
                  </div>
                  <input
                    role="switch"
                    aria-label={label}
                    type="checkbox"
                    checked={form.flags[key]}
                    disabled={
                      (['autoQuote', 'orders'].includes(key) && !form.flags.quoteRequests) ||
                      (key === 'autoOrder' && !form.flags.orders)
                    }
                    onChange={() => toggle(key)}
                  />
                </label>
              ))}
            </div>
          </section>
          <section className="admin-card">
            <h2>検索と判断の方式</h2>
            <div className="form-grid">
              <label>
                Web検索
                <select
                  value={form.searchProvider}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      searchProvider: e.target.value as AppSettings['searchProvider'],
                    })
                  }
                >
                  <option value="none">利用しない</option>
                  <option value="openai">OpenAI（商品・調達候補の検索）</option>
                  <option value="exa">Exa</option>
                  <option value="tavily">Tavily</option>
                </select>
              </label>
              <label>
                質問・資料の判断
                <select
                  value={form.decisionProvider}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      decisionProvider: e.target.value as AppSettings['decisionProvider'],
                      model: '',
                    })
                  }
                >
                  <option value="local">登録情報とルール</option>
                  <option value="jev">Jev / TypeSafe</option>
                  <option value="gemini">Gemini</option>
                </select>
              </label>
              <label>
                回答文を生成するAI
                <select
                  value={form.responseProvider}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      responseProvider: e.target.value as AppSettings['responseProvider'],
                      responseModel: '',
                    })
                  }
                >
                  <option value="local">利用しない（登録情報とルール）</option>
                  <option value="openai">OpenAI</option>
                  <option value="gemini">Gemini</option>
                </select>
              </label>
              <label>
                回答生成のモデル名
                <input
                  value={form.responseModel}
                  disabled={form.responseProvider === 'local'}
                  onChange={(e) => setForm({ ...form, responseModel: e.target.value })}
                  placeholder={
                    form.responseProvider === 'gemini' ? 'gemini-2.5-flash' : 'gpt-4.1-mini'
                  }
                />
              </label>
              <label>
                モデル名（省略時は標準）
                <input
                  value={form.model}
                  onChange={(e) => setForm({ ...form, model: e.target.value })}
                  placeholder={form.decisionProvider === 'jev' ? 'jev-latest' : 'gemini-2.5-flash'}
                />
              </label>
              <label>
                情報の有効期間（時間）
                <input
                  type="number"
                  min="1"
                  max="8760"
                  value={form.freshnessHours}
                  onChange={(e) => setForm({ ...form, freshnessHours: Number(e.target.value) })}
                />
              </label>
              <label>
                自動注文の上限（税込・円）
                <input
                  type="number"
                  min="0"
                  value={form.maxAutoOrderAmount}
                  onChange={(e) => setForm({ ...form, maxAutoOrderAmount: Number(e.target.value) })}
                />
              </label>
            </div>
            <div className="provider-grid">
              {providers.map((p) => (
                <div key={p.id}>
                  <strong>{p.name}</strong>
                  <span className={`pill ${p.configured ? 'positive' : ''}`}>
                    {p.configured ? 'キー設定済み' : '未設定'}
                  </span>
                  <small>
                    {p.purpose} / {p.envKey}
                  </small>
                  <small>
                    {p.check
                      ? `${p.check.ok ? '接続確認成功' : '接続確認失敗'} · ${new Date(p.check.checkedAt).toLocaleString('ja-JP')} · ${p.check.durationMs}ms`
                      : '実通信は未確認'}
                  </small>
                  <button
                    type="button"
                    className="button secondary small"
                    disabled={!p.configured || !!checking}
                    onClick={() => checkConnection(p.id)}
                  >
                    {checking === p.id ? '確認中…' : '接続を確認'}
                  </button>
                </div>
              ))}
            </div>
            <p className="muted">
              キーはサーバーの環境変数に設定します。「キー設定済み」は実通信の成功を示すものではありません。
              接続確認は保存済みのモデル設定を使用します。明確な型番・価格等は登録値から即答し、曖昧な相談にAIを使います。
            </p>
          </section>
          <section className="admin-card">
            <h2>相談のご案内</h2>
            <label>
              会社名
              <input
                value={form.companyName}
                onChange={(e) => setForm({ ...form, companyName: e.target.value })}
              />
            </label>
            <label>
              チャットの最初のメッセージ
              <textarea
                rows={3}
                value={form.welcomeMessage}
                onChange={(e) => setForm({ ...form, welcomeMessage: e.target.value })}
              />
            </label>
          </section>
          <section className="admin-card">
            <h2>よくある質問への回答</h2>
            <p className="muted">
              チャットはここに書いた内容をそのまま案内します。空欄の項目は「担当者が確認します」と答えます。
            </p>
            {(
              [
                ['hours', '営業時間・電話の受付時間', '例：平日 8:30〜17:30（土日祝休み）'],
                ['quoteResponse', '見積回答の目安', '例：通常1〜2営業日'],
                ['shipping', '送料の考え方', '例：北九州市内は配達無料、その他は実費'],
                ['pickup', '来社での引き取り', '例：在庫品は事前のお電話で引き取り可能です'],
              ] as const
            ).map(([key, label, placeholder]) => (
              <label key={key}>
                {label}
                <input
                  value={form.faq[key]}
                  maxLength={300}
                  placeholder={placeholder}
                  onChange={(e) =>
                    setForm({ ...form, faq: { ...form.faq, [key]: e.target.value } })
                  }
                />
              </label>
            ))}
          </section>
          <AdminEstimatePolicy
            value={form.sourcingEstimate}
            onChange={(patch) =>
              setForm(
                (current) =>
                  current && {
                    ...current,
                    sourcingEstimate: { ...current.sourcingEstimate, ...patch },
                  },
              )
            }
          />
          <button className="button primary" disabled={busy}>
            {busy ? '保存中…' : '設定を保存する'}
          </button>
        </form>
      ) : (
        <p>設定を読み込んでいます…</p>
      )}
    </>
  );
}
