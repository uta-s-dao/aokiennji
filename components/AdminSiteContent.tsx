'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { Modal } from './AdminCommon';
import SiteContentPreview from './SiteContentPreview';
import {
  contentChanges,
  contentIssues,
  sectionLabels,
  type ContentIssue,
} from '@/lib/site-content-editor';
import type { SiteContent, SiteEditorState } from '@/lib/site-content';
import { api, errorMessage } from './api';
import { prepareSiteImageUpload } from '@/lib/site-image-upload';

function Field({
  label,
  value,
  onChange,
  maxLength,
  multiline = false,
  type = 'text',
  path,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
  multiline?: boolean;
  type?: string;
  path?: string;
  hint?: string;
}) {
  const hintId = useId();
  return (
    <label className="cms-field">
      <span>{label}</span>
      {hint && <small id={hintId}>{hint}</small>}
      {multiline ? (
        <textarea
          aria-label={label}
          aria-describedby={hint ? hintId : undefined}
          data-content-path={path}
          value={value}
          maxLength={maxLength}
          rows={4}
          onChange={(e) => onChange(e.target.value)}
          required
        />
      ) : (
        <input
          aria-label={label}
          aria-describedby={hint ? hintId : undefined}
          data-content-path={path}
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
  const inputId = useId();
  const [uploadError, setUploadError] = useState('');
  return (
    <div className="cms-photo">
      {/* Uploaded draft images require the administrator's cookie. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={value.replace('/api/site-content/images/', '/api/admin/site-content/images/')}
        alt={label}
      />
      <div className="cms-photo-control">
        <strong>現在の写真：{label}</strong>
        <label className="button secondary small" htmlFor={inputId}>
          写真を差し替える
        </label>
        <input
          type="file"
          aria-label={`${label}を選ぶ`}
          id={inputId}
          className="cms-file-input"
          accept="image/jpeg,image/png,image/webp"
          disabled={disabled}
          onChange={async (e) => {
            const input = e.currentTarget;
            const file = input.files?.[0];
            if (!file) return;
            if (file.size > 5 * 1024 * 1024) {
              setUploadError('写真は5MB以下にしてください。');
              onError('写真は5MB以下にしてください。');
              input.value = '';
              return;
            }
            setUploadError('');
            onBusy(true);
            try {
              const upload = await prepareSiteImageUpload(file);
              const response = await fetch('/api/admin/site-content/images', {
                method: 'POST',
                body: upload,
                credentials: 'same-origin',
                headers: { 'Content-Type': upload.type },
              });
              const result = await response.json();
              if (!response.ok)
                throw new Error(result.error?.message || '写真を登録できませんでした。');
              onChange(result.data.url);
            } catch (error) {
              setUploadError(errorMessage(error));
              onError(errorMessage(error));
            } finally {
              onBusy(false);
              input.value = '';
            }
          }}
        />
        {uploadError && (
          <p className="form-error" role="alert">
            {uploadError}
          </p>
        )}
      </div>
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
  const [previewAnchor, setPreviewAnchor] = useState('site-home');
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [issues, setIssues] = useState<ContentIssue[]>([]);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    if (!pendingPath) return;
    const node = [
      ...(editorRef.current?.querySelectorAll<HTMLElement>('[data-content-path]') || []),
    ].find((element) => element.dataset.contentPath === pendingPath);
    if (node) {
      node.focus();
      node.scrollIntoView({ block: 'center' });
      setPendingPath(null);
    }
  }, [pendingPath, section, selectedProject]);
  useEffect(() => {
    const nodes = editorRef.current?.querySelectorAll<HTMLElement>('[data-content-path]');
    nodes?.forEach((node) => {
      const invalid = issues.some((issue) => issue.path === node.dataset.contentPath);
      node.setAttribute('aria-invalid', String(invalid));
    });
  }, [issues, section, selectedProject]);
  useEffect(() => {
    if (!preview && !confirmPublish) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [preview, confirmPublish]);
  function openIssue(issue: ContentIssue) {
    setSection(issue.section);
    if (issue.section === 'projects') setSelectedProject(issue.itemId || null);
    setPendingPath(issue.path);
  }
  function moveProject(index: number, delta: number) {
    if (!form) return;
    const projects = [...form.projects];
    [projects[index], projects[index + delta]] = [projects[index + delta], projects[index]];
    update({ ...form, projects });
  }
  function openPreview(anchor?: string) {
    setPreviewAnchor(
      anchor ||
        (section === 'news'
          ? 'site-news'
          : section === 'projects'
            ? `site-project-${selectedProject || form?.projects.find((p) => p.published)?.id || ''}`
            : 'site-home'),
    );
    setPreview(true);
  }
  function update(next: SiteContent) {
    setForm(next);
    if (issues.length) setIssues(contentIssues(next));
    setMessage('');
    setError('');
    setPreview(false);
    setConfirmPublish(false);
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!form || !saved) return;
    const invalid = contentIssues(form);
    setIssues(invalid);
    if (invalid.length) {
      openIssue(invalid[0]);
      return;
    }
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
  const changes = contentChanges(saved.published, form);
  const savedChanges = contentChanges(saved.published, saved.draft);
  const photoProps = { disabled: busy, onBusy: setBusy, onError: setError };
  return (
    <div className="cms-editor" ref={editorRef}>
      <section className="admin-card cms-guide">
        <h2>保存・公開の状態</h2>{' '}
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
      <details className="cms-help">
        <summary>編集方法・写真の条件</summary>
        <p>
          編集 → 下書き保存 → プレビュー → 公開の順に進めます。保存だけではサイトに反映されません。
        </p>
        <p>公開すると、全タブの保存済み変更がまとめて反映されます。</p>
        <p>写真はJPEG・PNG・WebP、5MB以下。自動で圧縮します。公開してよい写真をご用意ください。</p>
      </details>
      {issues.length > 0 && (
        <div className="admin-notice error cms-issues" role="alert">
          <strong>入力が必要な項目があります</strong>
          {issues.map((issue) => (
            <button
              type="button"
              className="link-button"
              key={issue.path}
              onClick={() => openIssue(issue)}
            >
              {issue.message}
            </button>
          ))}
        </div>
      )}
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
            aria-label={label}
            aria-pressed={section === key}
            key={key}
            onClick={() => {
              setSection(key);
              setPreview(false);
            }}
          >
            {label}
            {(changes.some((change) => change.section === key) ||
              JSON.stringify(form[key]) !== JSON.stringify(saved.draft[key])) && (
              <span className="cms-change-mark">
                {JSON.stringify(form[key]) !== JSON.stringify(saved.draft[key])
                  ? '未保存'
                  : '未公開'}
              </span>
            )}
            {issues.some((issue) => issue.section === key) && (
              <span>要入力 {issues.filter((issue) => issue.section === key).length}</span>
            )}
          </button>
        ))}
      </div>
      <form onSubmit={save} className="admin-form" noValidate>
        <fieldset disabled={busy} className="cms-fieldset">
          {section === 'home' && (
            <section className="admin-card">
              <div className="card-title">
                <h2>トップページの文章</h2>
                <button
                  type="button"
                  className="button secondary small"
                  disabled={dirty}
                  onClick={() => openPreview('site-home')}
                >
                  掲載位置を確認
                </button>
              </div>
              <Field
                label="メイン見出し"
                path="home.title"
                hint="トップ最上部の写真に重なる見出しの1行目です。"
                value={form.home.title}
                maxLength={100}
                onChange={(title) => update({ ...form, home: { ...form.home, title } })}
              />
              <Field
                label="見出しの強調部分"
                path="home.subtitle"
                hint="メイン見出しの下に表示する強調行です。"
                value={form.home.subtitle}
                maxLength={100}
                onChange={(subtitle) => update({ ...form, home: { ...form.home, subtitle } })}
              />
              <Field
                label="冒頭の紹介文"
                path="home.lead"
                hint="トップ最上部の見出しの下に表示します。"
                value={form.home.lead}
                maxLength={600}
                multiline
                onChange={(lead) => update({ ...form, home: { ...form.home, lead } })}
              />
              <Field
                label="事業の紹介文"
                path="home.introduction"
                hint="トップの写真より下にある「OUR BUSINESS」の大きな文章です。"
                value={form.home.introduction}
                maxLength={1000}
                multiline
                onChange={(introduction) =>
                  update({ ...form, home: { ...form.home, introduction } })
                }
              />
              <button
                type="button"
                className="link-button"
                disabled={dirty}
                onClick={() => openPreview('strength')}
              >
                事業の紹介文の掲載位置を確認
              </button>
              <h2>メイン写真（3枚）</h2>
              <p className="help">
                トップ最上部で切り替わる写真です。写真の条件は「編集方法・写真の条件」で確認できます。
              </p>
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
                    path={`home.slides.${i}.label`}
                    hint="写真の内容を短く説明します。"
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
                    path={`news.${i}.title`}
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
                    path={`news.${i}.date`}
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
                    path={`news.${i}.body`}
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
              <p className="help">
                公開対象の先頭3件がトップページにも表示されます。編集する実績を選んでください。
              </p>
              <button
                type="button"
                className="button secondary small"
                disabled={form.projects.length >= 100}
                onClick={() => {
                  const id = crypto.randomUUID();
                  update({
                    ...form,
                    projects: [
                      {
                        id,
                        name: '',
                        category: '',
                        description: '',
                        image: '/images/tank.jpg',
                        published: true,
                      },
                      ...form.projects,
                    ],
                  });
                  setSelectedProject(id);
                  setPendingPath('projects.0.name');
                }}
              >
                ＋ 実績を追加
              </button>
              <div className="cms-project-list" aria-label="実績の一覧">
                {form.projects.map((item, i) => (
                  <div className="cms-project-row" key={item.id}>
                    <button
                      type="button"
                      className="cms-project-select"
                      aria-expanded={selectedProject === item.id}
                      onClick={() => {
                        setSelectedProject(item.id);
                        setPendingPath(`projects.${i}.name`);
                      }}
                    >
                      <img
                        src={item.image.replace(
                          '/api/site-content/images/',
                          '/api/admin/site-content/images/',
                        )}
                        alt=""
                      />
                      <span>
                        <strong>{item.name || '新しい実績（名称未入力）'}</strong>
                        <small>
                          {item.published ? '公開対象' : '非公開'}
                          {issues.some((issue) => issue.itemId === item.id) ? ' ・要入力' : ''}
                        </small>
                      </span>
                    </button>
                    <div className="cms-order-buttons">
                      <button
                        type="button"
                        className="button secondary small"
                        aria-label={`${item.name || '新しい実績'}を上へ`}
                        disabled={i === 0}
                        onClick={() => moveProject(i, -1)}
                      >
                        上へ
                      </button>
                      <button
                        type="button"
                        className="button secondary small"
                        aria-label={`${item.name || '新しい実績'}を下へ`}
                        disabled={i === form.projects.length - 1}
                        onClick={() => moveProject(i, 1)}
                      >
                        下へ
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              {form.projects.map(
                (item, i) =>
                  selectedProject === item.id && (
                    <div className="cms-item" key={item.id} aria-label="実績の編集">
                      <div className="card-title">
                        <h3>{item.name || '新しい実績'}を編集</h3>
                        <button
                          type="button"
                          className="button secondary small"
                          onClick={() => setSelectedProject(null)}
                        >
                          編集を閉じる
                        </button>
                      </div>
                      <Field
                        label="実績名"
                        path={`projects.${i}.name`}
                        value={item.name}
                        maxLength={120}
                        onChange={(name) =>
                          update({
                            ...form,
                            projects: form.projects.map((p) =>
                              p.id === item.id ? { ...p, name } : p,
                            ),
                          })
                        }
                      />
                      <Field
                        label="カテゴリ"
                        path={`projects.${i}.category`}
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
                        path={`projects.${i}.description`}
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
                          disabled={dirty || !item.published}
                          onClick={() => openPreview(`site-project-${item.id}`)}
                        >
                          この実績の掲載位置を確認
                        </button>
                        <button
                          type="button"
                          className="button secondary small"
                          onClick={() => {
                            if (
                              confirm(
                                'この実績を下書きから削除しますか？公開するまでサイトには残ります。',
                              )
                            ) {
                              update({
                                ...form,
                                projects: form.projects.filter((p) => p.id !== item.id),
                              });
                              setSelectedProject(null);
                            }
                          }}
                        >
                          この実績を削除
                        </button>
                      </div>
                    </div>
                  ),
              )}
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
              openPreview();
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
            変更をまとめて公開
          </button>
          {dirty && <small>プレビュー・公開の前に下書きを保存してください。</small>}
        </div>
      </form>
      {confirmPublish && (
        <Modal
          title="公開する変更の確認"
          onClose={() => {
            if (!busy) setConfirmPublish(false);
          }}
          wide
        >
          <p>以下の保存済み変更をまとめて公開します。</p>
          <div className="cms-change-list">
            {savedChanges.map((change, index) => (
              <article key={index}>
                <h3>
                  {sectionLabels[change.section]}：{change.label}
                </h3>
                <dl>
                  <div>
                    <dt>現在の内容</dt>
                    <dd>
                      {change.image && change.before ? (
                        <img
                          src={change.before.replace(
                            '/api/site-content/images/',
                            '/api/admin/site-content/images/',
                          )}
                          alt="現在の写真"
                        />
                      ) : (
                        change.before || '（空欄）'
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>公開後</dt>
                    <dd>
                      {change.image ? (
                        <img
                          src={change.after.replace(
                            '/api/site-content/images/',
                            '/api/admin/site-content/images/',
                          )}
                          alt="公開後の写真"
                        />
                      ) : (
                        change.after || '（空欄）'
                      )}
                    </dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="cms-actions">
            <button
              type="button"
              className="button primary"
              disabled={busy || dirty}
              onClick={publish}
            >
              {busy ? '公開しています…' : 'この内容を公開'}
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
        </Modal>
      )}
      {preview && (
        <SiteContentPreview
          revision={saved.revision}
          view={section === 'projects' ? 'projects' : 'home'}
          anchor={previewAnchor}
          onClose={() => setPreview(false)}
        />
      )}
    </div>
  );
}
