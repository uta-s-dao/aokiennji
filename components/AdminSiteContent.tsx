'use client';
import { useEffect, useId, useState } from 'react';
import type { SiteContent, SiteEditorState } from '@/lib/site-content';
import { api, errorMessage } from './api';

function Field({
  label,
  value,
  onChange,
  maxLength,
  multiline = false,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
  multiline?: boolean;
  type?: string;
}) {
  return (
    <label className="cms-field">
      <span>{label}</span>
      {multiline ? (
        <textarea
          value={value}
          maxLength={maxLength}
          rows={4}
          onChange={(e) => onChange(e.target.value)}
          required
        />
      ) : (
        <input
          type={type}
          value={value}
          maxLength={maxLength}
          onChange={(e) => onChange(e.target.value)}
          required
        />
      )}
    </label>
  );
}

function Photo({
  label,
  value,
  onChange,
  disabled,
  onBusy,
  onError,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  onBusy: (busy: boolean) => void;
  onError: (message: string) => void;
}) {
  const hintId = useId();
  return (
    <div className="cms-photo">
      {/* Uploaded draft images require the administrator's cookie. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={value.replace('/api/site-content/images/', '/api/admin/site-content/images/')}
        alt={label}
      />
      <label className="cms-field">
        <span>{label}を選ぶ</span>
        <input
          type="file"
          aria-label={`${label}を選ぶ`}
          aria-describedby={hintId}
          accept="image/jpeg,image/png,image/webp"
          disabled={disabled}
          onChange={async (e) => {
            const input = e.currentTarget;
            const file = input.files?.[0];
            if (!file) return;
            if (file.size > 5 * 1024 * 1024) {
              onError('写真は5MB以下にしてください。');
              input.value = '';
              return;
            }
            onBusy(true);
            try {
              const response = await fetch('/api/admin/site-content/images', {
                method: 'POST',
                body: file,
                credentials: 'same-origin',
                headers: { 'Content-Type': file.type },
              });
              const result = await response.json();
              if (!response.ok)
                throw new Error(result.error?.message || '写真を登録できませんでした。');
              onChange(result.data.url);
            } catch (error) {
              onError(errorMessage(error));
            } finally {
              onBusy(false);
              input.value = '';
            }
          }}
        />
        <small id={hintId}>
          JPEG・PNG・WebP／5MB以下。写真は自動で圧縮します。公開してよい写真を選んでください。
        </small>
      </label>
    </div>
  );
}

export default function AdminSiteContent() {
  const [saved, setSaved] = useState<SiteEditorState | null>(null);
  const [form, setForm] = useState<SiteContent | null>(null);
  const [section, setSection] = useState<'home' | 'news' | 'projects'>('home');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(false);
  const [mobilePreview, setMobilePreview] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const dirty = !!saved && JSON.stringify(form) !== JSON.stringify(saved.draft);

  useEffect(() => {
    let active = true;
    api<SiteEditorState>('/api/admin/site-content')
      .then((data) => {
        if (active) {
          setSaved(data);
          setForm(data.draft);
        }
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    const navigate = (e: Event) => {
      if (dirty && !window.confirm('未保存の編集があります。保存せずに移動しますか？'))
        e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    window.addEventListener('aoki:admin-navigate', navigate);
    return () => {
      window.removeEventListener('beforeunload', warn);
      window.removeEventListener('aoki:admin-navigate', navigate);
    };
  }, [dirty]);

  function update(next: SiteContent) {
    setForm(next);
    setMessage('');
    setPreview(false);
    setConfirmPublish(false);
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!form || !saved) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const state = await api<SiteEditorState>('/api/admin/site-content', {
        method: 'PUT',
        body: JSON.stringify({ revision: saved.revision, content: form }),
      });
      setSaved(state);
      setForm(state.draft);
      setMessage('下書きを保存しました。公開サイトはまだ変更されていません。');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function publish() {
    if (!saved || dirty) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const state = await api<SiteEditorState>('/api/admin/site-content', {
        method: 'POST',
        body: JSON.stringify({ revision: saved.revision }),
      });
      setSaved(state);
      setForm(state.draft);
      setConfirmPublish(false);
      setPreview(false);
      setMessage('公開しました。公開サイトを開き直すと変更を確認できます。');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  if (!form || !saved)
    return (
      <div className="state-box" role={error ? 'alert' : 'status'}>
        {error || '編集内容を読み込んでいます…'}
      </div>
    );
  const photoProps = { disabled: busy, onBusy: setBusy, onError: setError };
  return (
    <div className="cms-editor">
      <section className="admin-card cms-guide">
        <h2>文章と写真を、自分たちで更新できます</h2>
        <p>① 編集 → ② 下書き保存 → ③ プレビューで確認 → ④ 公開</p>
        <p className="muted">
          下書きはお客様には表示されません。「公開」すると、すべての編集項目がまとめて反映されます。
        </p>
        <p>
          <strong>
            {dirty
              ? '未保存の編集があります'
              : saved.hasUnpublishedChanges
                ? '未公開の下書きがあります'
                : '公開内容と同じです'}
          </strong>{' '}
          ／ 最終公開：
          {saved.publishedAt ? new Date(saved.publishedAt).toLocaleString('ja-JP') : '初期内容'}
        </p>
      </section>
      {error && (
        <div className="admin-notice error" role="alert">
          {error}
        </div>
      )}
      {message && (
        <div className="admin-notice" role="status">
          {message}
        </div>
      )}
      <div className="cms-sections" role="group" aria-label="編集する内容">
        {(
          [
            ['home', 'トップページ'],
            ['news', 'お知らせ'],
            ['projects', '製作実績'],
          ] as const
        ).map(([key, label]) => (
          <button
            type="button"
            className={`button ${section === key ? 'primary' : 'secondary'} small`}
            aria-pressed={section === key}
            key={key}
            onClick={() => {
              setSection(key);
              setPreview(false);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <form onSubmit={save} className="admin-form">
        <fieldset disabled={busy} className="cms-fieldset">
          {section === 'home' && (
            <section className="admin-card">
              <h2>トップページの文章</h2>
              <Field
                label="メイン見出し"
                value={form.home.title}
                maxLength={100}
                onChange={(title) => update({ ...form, home: { ...form.home, title } })}
              />
              <Field
                label="見出しの強調部分"
                value={form.home.subtitle}
                maxLength={100}
                onChange={(subtitle) => update({ ...form, home: { ...form.home, subtitle } })}
              />
              <Field
                label="冒頭の紹介文"
                value={form.home.lead}
                maxLength={600}
                multiline
                onChange={(lead) => update({ ...form, home: { ...form.home, lead } })}
              />
              <Field
                label="事業の紹介文"
                value={form.home.introduction}
                maxLength={1000}
                multiline
                onChange={(introduction) =>
                  update({ ...form, home: { ...form.home, introduction } })
                }
              />
              <h2>メイン写真（3枚）</h2>
              {form.home.slides.map((slide, i) => (
                <div className="cms-item" key={i}>
                  <Photo
                    {...photoProps}
                    label={`メイン写真${i + 1}`}
                    value={slide.image}
                    onChange={(image) =>
                      update({
                        ...form,
                        home: {
                          ...form.home,
                          slides: form.home.slides.map((s, n) => (n === i ? { ...s, image } : s)),
                        },
                      })
                    }
                  />
                  <Field
                    label={`写真${i + 1}の説明`}
                    value={slide.label}
                    maxLength={100}
                    onChange={(label) =>
                      update({
                        ...form,
                        home: {
                          ...form.home,
                          slides: form.home.slides.map((s, n) => (n === i ? { ...s, label } : s)),
                        },
                      })
                    }
                  />
                </div>
              ))}
            </section>
          )}
          {section === 'news' && (
            <section className="admin-card">
              <h2>お知らせ</h2>
              <p className="muted">
                公開対象のお知らせを、日付の新しい順にトップページへ表示します。
              </p>
              <button
                type="button"
                className="button secondary small"
                disabled={form.news.length >= 100}
                onClick={() =>
                  update({
                    ...form,
                    news: [
                      {
                        id: crypto.randomUUID(),
                        title: '',
                        body: '',
                        date: new Date().toLocaleDateString('sv-SE'),
                        published: true,
                      },
                      ...form.news,
                    ],
                  })
                }
              >
                お知らせを追加
              </button>
              {!form.news.length && <p className="muted">お知らせはまだありません。</p>}
              {form.news.map((item, i) => (
                <div className="cms-item" key={item.id}>
                  <h3>お知らせ {i + 1}</h3>
                  <Field
                    label="お知らせのタイトル"
                    value={item.title}
                    maxLength={120}
                    onChange={(title) =>
                      update({
                        ...form,
                        news: form.news.map((n) => (n.id === item.id ? { ...n, title } : n)),
                      })
                    }
                  />
                  <Field
                    label="掲載日"
                    type="date"
                    value={item.date}
                    onChange={(date) =>
                      update({
                        ...form,
                        news: form.news.map((n) => (n.id === item.id ? { ...n, date } : n)),
                      })
                    }
                  />
                  <Field
                    label="お知らせの本文"
                    value={item.body}
                    multiline
                    maxLength={3000}
                    onChange={(body) =>
                      update({
                        ...form,
                        news: form.news.map((n) => (n.id === item.id ? { ...n, body } : n)),
                      })
                    }
                  />
                  <label className="cms-checkbox">
                    <input
                      type="checkbox"
                      checked={item.published}
                      onChange={(e) =>
                        update({
                          ...form,
                          news: form.news.map((n) =>
                            n.id === item.id ? { ...n, published: e.target.checked } : n,
                          ),
                        })
                      }
                    />
                    公開対象にする
                  </label>
                  <button
                    type="button"
                    className="button secondary small"
                    onClick={() => {
                      if (
                        confirm(
                          'このお知らせを下書きから削除しますか？公開サイトへの反映には「公開」が必要です。',
                        )
                      )
                        update({ ...form, news: form.news.filter((n) => n.id !== item.id) });
                    }}
                  >
                    このお知らせを削除
                  </button>
                </div>
              ))}
            </section>
          )}
          {section === 'projects' && (
            <section className="admin-card">
              <h2>製作実績</h2>
              <p className="muted">
                公開対象の実績を一覧へ表示し、先頭3件をトップページへ掲載します。
              </p>
              <button
                type="button"
                className="button secondary small"
                disabled={form.projects.length >= 100}
                onClick={() =>
                  update({
                    ...form,
                    projects: [
                      {
                        id: crypto.randomUUID(),
                        name: '',
                        category: '',
                        description: '',
                        image: '/images/tank.jpg',
                        published: true,
                      },
                      ...form.projects,
                    ],
                  })
                }
              >
                実績を追加
              </button>
              {form.projects.map((item, i) => (
                <div className="cms-item" key={item.id}>
                  <h3>実績 {i + 1}</h3>
                  <Field
                    label="実績名"
                    value={item.name}
                    maxLength={120}
                    onChange={(name) =>
                      update({
                        ...form,
                        projects: form.projects.map((p) => (p.id === item.id ? { ...p, name } : p)),
                      })
                    }
                  />
                  <Field
                    label="カテゴリ"
                    value={item.category}
                    maxLength={60}
                    onChange={(category) =>
                      update({
                        ...form,
                        projects: form.projects.map((p) =>
                          p.id === item.id ? { ...p, category } : p,
                        ),
                      })
                    }
                  />
                  <Field
                    label="実績の説明"
                    value={item.description}
                    maxLength={1500}
                    multiline
                    onChange={(description) =>
                      update({
                        ...form,
                        projects: form.projects.map((p) =>
                          p.id === item.id ? { ...p, description } : p,
                        ),
                      })
                    }
                  />
                  <Photo
                    {...photoProps}
                    label={`実績写真${i + 1}`}
                    value={item.image}
                    onChange={(image) =>
                      update({
                        ...form,
                        projects: form.projects.map((p) =>
                          p.id === item.id ? { ...p, image } : p,
                        ),
                      })
                    }
                  />
                  <label className="cms-checkbox">
                    <input
                      type="checkbox"
                      checked={item.published}
                      onChange={(e) =>
                        update({
                          ...form,
                          projects: form.projects.map((p) =>
                            p.id === item.id ? { ...p, published: e.target.checked } : p,
                          ),
                        })
                      }
                    />
                    公開対象にする
                  </label>
                  <div className="cms-actions">
                    <button
                      type="button"
                      className="button secondary small"
                      disabled={i === 0}
                      onClick={() => {
                        const projects = [...form.projects];
                        [projects[i - 1], projects[i]] = [projects[i], projects[i - 1]];
                        update({ ...form, projects });
                      }}
                    >
                      上へ
                    </button>
                    <button
                      type="button"
                      className="button secondary small"
                      disabled={i === form.projects.length - 1}
                      onClick={() => {
                        const projects = [...form.projects];
                        [projects[i], projects[i + 1]] = [projects[i + 1], projects[i]];
                        update({ ...form, projects });
                      }}
                    >
                      下へ
                    </button>
                    <button
                      type="button"
                      className="button secondary small"
                      onClick={() => {
                        if (
                          confirm(
                            'この実績を下書きから削除しますか？公開サイトへの反映には「公開」が必要です。',
                          )
                        )
                          update({
                            ...form,
                            projects: form.projects.filter((p) => p.id !== item.id),
                          });
                      }}
                    >
                      この実績を削除
                    </button>
                  </div>
                </div>
              ))}
            </section>
          )}
        </fieldset>
        <div className="cms-toolbar">
          <button type="submit" className="button primary" disabled={busy || !dirty}>
            {busy ? '処理中…' : '下書き保存'}
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={busy || dirty}
            onClick={() => {
              setPreview(!preview);
              setConfirmPublish(false);
            }}
          >
            プレビュー
          </button>
          <button
            type="button"
            className="button primary"
            disabled={busy || dirty || !saved.hasUnpublishedChanges}
            onClick={() => setConfirmPublish(true)}
          >
            公開する
          </button>
          {dirty && <small>プレビュー・公開の前に下書きを保存してください。</small>}
        </div>
      </form>
      {confirmPublish && (
        <section className="admin-card cms-confirm" aria-label="公開の確認">
          <h2>保存した下書きを公開しますか？</h2>
          <p>
            トップページ・お知らせ・製作実績の変更をまとめて公開します。公開対象のチェックを外した項目は表示されません。
          </p>
          <div className="cms-actions">
            <button type="button" className="button primary" disabled={busy} onClick={publish}>
              この内容を公開
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => setConfirmPublish(false)}
            >
              戻る
            </button>
          </div>
        </section>
      )}
      {preview && (
        <section className="admin-card cms-preview" aria-label="下書きプレビュー">
          <h2>保存した下書きのプレビュー</h2>
          <p className="muted">
            公開サイトと同じ表示です。リンクを押すと移動するため、確認後はプレビューを開き直してください。
          </p>
          <div className="cms-actions">
            <button
              type="button"
              className="button secondary small"
              aria-pressed={!mobilePreview}
              onClick={() => setMobilePreview(false)}
            >
              PC表示
            </button>
            <button
              type="button"
              className="button secondary small"
              aria-pressed={mobilePreview}
              onClick={() => setMobilePreview(true)}
            >
              スマートフォン表示
            </button>
          </div>
          <iframe
            key={`${saved.revision}-${section}`}
            title="保存した下書き"
            src={`/admin/site-preview?view=${section === 'projects' ? 'projects' : 'home'}`}
            className={mobilePreview ? 'cms-frame-mobile' : ''}
          />
        </section>
      )}
    </div>
  );
}
