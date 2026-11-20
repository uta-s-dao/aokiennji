import React, { useState, useEffect, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import type { Item, Question, PublicResult } from "../domain/model";
import { fields, labels, present } from "../domain/fields";
import { customerItemName, customerNextStep } from "../domain/customer-copy";
import type { ResearchFollowupAnswer } from "../domain/research-followup";
import { ResearchQuestion, type ResultQuestion } from "./research-question";
import { PartnerReview } from "./partner-review";
import "./style.css";
type CaseView = {
  caseId: string;
  revision: number;
  phase: string;
  items: Item[];
  question: Question | null;
  canResearch: boolean;
  questionsAsked: number;
  overflow: string[];
  unresolvedInputs?: string[];
  canRestoreIntake?: boolean;
  pendingFieldKeys?: {itemId:string;key:string}[];
  attachments: { id: string; name: string; analysis: string }[];
  job: { id: string; status: string; stage: string; deadline: number } | null;
  result: PublicResult | null;
  followup?: ResultQuestion | null;
};
type Draft = {
  subject: string;
  body: string;
  mailto: string | null;
  shortened: boolean;
  notice: string | null;
};
let csrf = "";
async function request<T = Record<string, unknown>>(
  path: string,
  method = "GET",
  data?: unknown,
  extra: Record<string, string> = {},
) {
  const r = await fetch("/api/v2" + path, {
    method,
    headers: {
      ...(method !== "GET" ? { "X-CSRF-Token": csrf } : {}),
      ...(data instanceof FormData
        ? {}
        : data !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
      ...extra,
    },
    ...(data === undefined
      ? {}
      : { body: data instanceof FormData ? data : JSON.stringify(data) }),
  });
  const b = (await r.json()) as T & { message?: string; error?: string };
  if (!r.ok) throw new Error(b.message ?? b.error);
  return b;
}
const uuid = () => crypto.randomUUID();
function App() {
  const [provider, setProvider] = useState("demo");
  const [hostedTrial, setHostedTrial] = useState(
    location.pathname.startsWith("/availability-v2/"),
  );
  const [ready, setReady] = useState(false),
    [caseId, setCaseId] = useState(localStorage.getItem("av2_case") ?? ""),
    [view, setView] = useState<CaseView | null>(null),
    [input, setInput] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [editing, setEditing] = useState(false),
    [draft, setDraft] = useState<Draft | null>(null),
    [admin, setAdmin] = useState(location.hash === "#admin");
  const questionRef = useRef<HTMLHeadingElement>(null),
    mutation = useRef<{ key: string; id: string } | null>(null);
  useEffect(() => {
    request<{ csrf: string; extraction: string; mode?: string }>("/session")
      .then((s) => {
        csrf = s.csrf;
        setProvider(s.extraction);
        setHostedTrial(s.mode === "hosted-trial");
        setReady(true);
      })
      .catch((e) => setError(String(e)));
  }, []);
  const refresh = useCallback(async () => {
    if (caseId) {
      let v = await request<CaseView>("/cases/" + caseId);
      if (v.canRestoreIntake) {
        try {
          await request("/cases/" + caseId + "/restore-intake", "POST", {
            expectedRevision: v.revision,
          });
        } catch (err) {
          // Another tab may have already restored or edited the same consultation.
          const latest = await request<CaseView>("/cases/" + caseId);
          if (latest.canRestoreIntake) throw err;
          setView(latest);
          return latest;
        }
        v = await request<CaseView>("/cases/" + caseId);
      }
      setView(v);
      return v as CaseView;
    }
    return null;
  }, [caseId]);
  useEffect(() => {
    if (ready && caseId) refresh().catch((e) => setError(e.message));
  }, [ready, caseId, refresh]);
  useEffect(() => {
    if (
      !ready ||
      !caseId ||
      !view?.job ||
      !["queued", "running"].includes(view.job.status)
    )
      return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let count = 0;
    const poll = async () => {
      if (cancelled) return;
      if (!document.hidden) {
        try {
          const v = await refresh();
          if (v && !["queued", "running"].includes(v.job?.status ?? "")) return;
        } catch (e) {
          setError((e as Error).message);
        }
      }
      if (!cancelled)
        timer = setTimeout(poll, ++count < 3 ? 1000 : count < 10 ? 2000 : 5000);
    };
    timer = setTimeout(poll, 1000);
    const visible = () => {
      if (!document.hidden) {
        clearTimeout(timer);
        void poll();
      }
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [ready, caseId, view?.job?.id, view?.job?.status, refresh]);
  useEffect(() => {
    questionRef.current?.focus();
  }, [view?.question?.id]);
  function keyFor(key: string) {
    if (mutation.current?.key !== key) mutation.current = { key, id: uuid() };
    return mutation.current.id;
  }
  async function work(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      mutation.current = null;
    } catch (e) {
      setError((e as Error).message);
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  async function ensureCase() {
    if (caseId) return caseId;
    const c = await request<{ caseId: string }>(
      "/cases",
      "POST",
      {},
      { "Idempotency-Key": keyFor("create") },
    );
    setCaseId(c.caseId);
    localStorage.setItem("av2_case", c.caseId);
    return c.caseId as string;
  }
  async function answer(answer: {
    type: string;
    text?: string;
    optionId?: string;
  }) {
    await work(async () => {
      const cid = await ensureCase();
      const v = view ?? { revision: 0, question: null };
      const b = {
        kind: "answer_mutation",
        mutationId: keyFor(JSON.stringify(answer)),
        expectedRevision: v.revision,
        questionId: v.question?.id ?? "initial",
        answer,
      };
      const result = await request<{ notice: string | null }>(
        `/cases/${cid}/answers`,
        "POST",
        b,
      );
      if (result.notice) setNotice(result.notice);
      const refreshed = await request<CaseView>("/cases/" + cid);
      setView(refreshed);
      if (
        answer.type !== "text" ||
        !refreshed.unresolvedInputs?.includes(answer.text ?? "")
      )
        setInput("");
      setDraft(null);
    });
  }
  async function answerResearchQuestion(answer: ResearchFollowupAnswer) {
    await work(async () => {
      const offer = view?.followup;
      if (!offer || !view) return;
      const response = await request<{ jobId: string | null }>(
        `/cases/${caseId}/followup`,
        "POST",
        {
          mutationId: keyFor(JSON.stringify([offer.id, answer])),
          expectedRevision: view.revision,
          jobId: offer.jobId,
          questionId: offer.id,
          answer,
        },
      );
      setNotice(
        response.jobId
          ? "回答を反映してもう一度調べます。"
          : "回答を記録しました。現在の条件で担当者に相談できます。",
      );
      await refresh();
      setDraft(null);
    });
  }
  async function research() {
    await work(async () => {
      if (!view) return;
      const response = await request<{ notice: string | null }>(
        `/cases/${caseId}/research`,
        "POST",
        {
          mutationId: keyFor("research"),
          expectedRevision: view.revision,
        },
      );
      if (response.notice) setNotice(response.notice);
      await refresh();
      setEditing(false);
      setDraft(null);
    });
  }
  async function saveField(
    itemId: string,
    key: string,
    value: string,
    optional: boolean,
  ) {
    await work(async () => {
      if (!view) return;
      const def = fields[key];
      const m = value.match(/^([0-9]+(?:\.[0-9]+)?)\s*(.*)$/);
      const code = def.values
        ? (Object.keys(labels).find((k) => labels[k] === value) ?? value)
        : value;
      const response = await request<{ notice: string }>(
        `/cases/${caseId}/fields`,
        "PATCH",
        {
          mutationId: keyFor(itemId + key + value + optional),
          expectedRevision: view.revision,
          text: value + (optional ? "（任意・変更可）" : ""),
          change: {
            itemId,
            key,
            text: code,
            ...(def.units
              ? { number: m ? Number(m[1]) : null, unit: m?.[2] || null }
              : {}),
            hardConstraint: !optional,
          },
        },
      );
      await refresh();
      setDraft(null);
      setNotice(response.notice);
    });
  }
  async function upload(file: File, itemId?: string, supersedes?: string) {
    await work(async () => {
      const cid = await ensureCase();
      const f = new FormData();
      f.set("file", file);
      f.set("mutationId", keyFor("file:" + file.name + file.size));
      f.set("expectedRevision", String(view?.revision ?? 0));
      if (itemId) f.set("itemId", itemId);
      if (supersedes) f.set("supersedes", supersedes);
      const r = await request<{ notice: string }>(
        `/cases/${cid}/attachments`,
        "POST",
        f,
      );
      setNotice(r.notice);
      setView(await request<CaseView>("/cases/" + cid));
      setDraft(null);
    });
  }
  async function prepareMail() {
    await work(async () => {
      const d = await request<Draft>(`/cases/${caseId}/mail-draft`, "POST", {});
      setDraft(d);
    });
  }
  async function copyDraft() {
    await work(async () => {
      const d =
        draft ??
        (await request<Draft>(`/cases/${caseId}/mail-draft`, "POST", {}));
      setDraft(d);
      try {
        await navigator.clipboard.writeText(d.subject + "\n\n" + d.body);
        await request(`/cases/${caseId}/events`, "POST", {
          code: "draft_copied",
        });
        setNotice("相談内容をコピーしました。");
      } catch {
        setNotice("下の相談内容を選択してコピーしてください。");
      }
    });
  }
  function reset() {
    localStorage.removeItem("av2_case");
    setCaseId("");
    setView(null);
    setInput("");
    setDraft(null);
    setError("");
    setEditing(false);
  }
  const researching =
      !!view?.job && ["queued", "running"].includes(view.job.status),
    result =
      view?.result &&
      !editing &&
      !researching &&
      !(view.phase === "collecting" && view.question)
        ? view.result
        : null,
    nextSteps = result?.items.map(customerNextStep) ?? [],
    sharedNextStep =
      nextSteps.length && nextSteps.every((text) => text === nextSteps[0])
        ? nextSteps[0]
        : null;
  const inputForm = (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void answer({ type: "text", text: input });
      }}
    >
      <label htmlFor="answer">{view ? "回答" : "ご希望の内容"}</label>
      <textarea
        id="answer"
        disabled={busy}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder={view ? "分かる範囲でお答えください。ほかの条件や訂正も一緒に伝えられます。" : "例：メーカー名と型番、交換したい部品、製作したいもの"}
        rows={4}
        maxLength={2000}
      />
      <button className="primary" disabled={busy || !input.trim()}>
        {busy ? "回答を確認中…" : view ? "次へ" : "相談を始める"}
      </button>
    </form>
  );
  return (
    <>
      <header>
        <div className="brand">
          <span className="mark" aria-hidden="true">
            A
          </span>
          <span>
            商品・製作の取扱確認
            <small>
              {hostedTrial
                ? "管理者向け試用 · 架空資料・AI送信なし"
                : "ローカル試用"}
            </small>
          </span>
        </div>
        <nav>
          {!hostedTrial && (
            <button
              onClick={() => {
                setAdmin(!admin);
                location.hash = admin ? "" : "admin";
              }}
            >
              管理
            </button>
          )}
          <button disabled={busy} onClick={reset}>
            新しい相談
          </button>
        </nav>
      </header>
      <main>
        {admin && !hostedTrial ? (
          <Admin currentCaseId={caseId} />
        ) : (
          <>
            <div className="steps" aria-label="相談の流れ">
              <span className={!result && !researching ? "active" : ""}>
                1 聞き取り
              </span>
              <span className={result || researching ? "active" : ""}>
                2 調査と結果
              </span>
            </div>
            {error && (
              <div className="error" role="alert">
                {error} 入力内容は保持しています。もう一度操作できます。
              </div>
            )}
            {notice && (
              <div className="notice" role="status">
                {notice}
              </div>
            )}
            {!view && !caseId && (
              <section className="intro">
                <p className="eyebrow">商品購入・加工・製作のご相談</p>
                <h1>
                  どのような商品・加工・製作を
                  <br className="desktop" />
                  ご希望ですか？
                </h1>
                <p>必要なことを短く伺ってから、取扱いを調べます。</p>
              </section>
            )}
            {ready &&
              (!view || view.phase === "collecting" || !!view.question) &&
              !editing &&
              (!result || !!view?.question) &&
              !researching && (
                <section className="question-card">
                  {view && (
                    <h1 ref={questionRef} tabIndex={-1}>
                      {view.question?.text ??
                        "分かる情報があれば追記できます。"}
                    </h1>
                  )}
                  {(!hostedTrial || view?.question?.inputType !== "select") &&
                    inputForm}
                  {view?.question?.options.map((o) => (
                    <button
                      className="option"
                      key={o.id}
                      disabled={busy}
                      onClick={() => answer({ type: "option", optionId: o.id })}
                    >
                      {o.label}
                    </button>
                  ))}
                  {view?.question?.itemId && (
                    <div className="actions">
                      <button
                        disabled={busy}
                        onClick={() => answer({ type: "unknown" })}
                      >
                        分からない
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => answer({ type: "skip" })}
                      >
                        この質問を飛ばす
                      </button>
                    </div>
                  )}
                  {!hostedTrial &&
                    !!view?.items.length &&
                    (!view.unresolvedInputs?.length ||
                      view.pendingFieldKeys) && (
                      <section
                        className="received-conditions"
                        aria-label="ここまでに伺った条件"
                      >
                        <h2>ここまでに伺った条件</h2>
                        {view.items.map((item) => (
                          <div key={item.id}>
                            <strong>{item.label}</strong>
                            <dl>
                              {item.fields
                                .filter(
                                  (f) =>
                                    (f.status === "known" ||
                                      f.status === "unknown" ||
                                      f.status === "skipped") &&
                                    !(
                                      ["description", "product_name"].includes(
                                        f.key,
                                      ) && f.value?.text === item.label
                                    ) &&
                                    !f.key.startsWith("equivalent_") &&
                                    !view.pendingFieldKeys?.some(
                                      (p) =>
                                        p.itemId === item.id && p.key === f.key,
                                    ),
                                )
                                .map((f) => (
                                  <div key={f.key}>
                                    <dt>{f.label}</dt>
                                    <dd>{present(f)}</dd>
                                  </div>
                                ))}
                            </dl>
                          </div>
                        ))}
                      </section>
                    )}
                  {view?.overflow.length ? (
                    <div className="notice">
                      <p>
                        3品目以下に分ける必要があります。以下の入力を保持しています。
                      </p>
                      {view.overflow.map((v, i) => (
                        <div key={i}>
                          <pre>{v}</pre>
                          <button
                            disabled={busy}
                            onClick={() =>
                              work(async () => {
                                const child = await request<{ caseId: string }>(
                                  `/cases/${caseId}/split`,
                                  "POST",
                                  {
                                    mutationId: keyFor("split:" + i),
                                    expectedRevision: view.revision,
                                    index: i,
                                  },
                                );
                                setCaseId(child.caseId);
                                localStorage.setItem("av2_case", child.caseId);
                                setView(
                                  await request<CaseView>(
                                    "/cases/" + child.caseId,
                                  ),
                                );
                                setNotice(
                                  "先頭の3品目までを別案件にしました。残りは元の相談に保持しています。",
                                );
                              })
                            }
                          >
                            先頭3品目までを別案件へ分割
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {!view && (
                    <div className="examples">
                      <span>デモ例</span>
                      {[
                        "AX-100を購入したい",
                        "図面の架台を製作したい。塗料は支給。来月上旬を希望",
                        "リング材を支給するので穴加工してほしい",
                      ].map((t) => (
                        <button key={t} onClick={() => setInput(t)}>
                          {t}
                        </button>
                      ))}
                    </div>
                  )}
                  <AttachmentInput
                    disabled={busy}
                    onFile={(f) => upload(f)}
                    label="写真・図面を添付（任意）"
                  />
                  {view && (
                    <button
                      className="secondary"
                      disabled={busy || !view.canResearch}
                      onClick={research}
                    >
                      この内容で調べる
                    </button>
                  )}
                </section>
              )}
            {researching && !editing && (
              <section className="question-card">
                <div className="spinner" aria-hidden="true" />
                <h1 tabIndex={-1} ref={questionRef}>
                  この条件で取扱いを確認しています
                </h1>
                <p role="status">{view?.job?.stage}</p>
                <p>画面を閉じても調査は継続します。</p>
              </section>
            )}
            {result && (
              <section className="result">
                <p className="eyebrow">今回の確認結果</p>
                <h1>{result.headline}</h1>
                {result.stale && (
                  <p className="error">
                    条件または資料が更新されています。再調査してください。
                  </p>
                )}
                {view?.followup && (
                  <ResearchQuestion
                    key={view.followup.id}
                    offer={view.followup}
                    busy={busy}
                    itemLabel={
                      view.items.find((i) => i.id === view.followup?.itemId)
                        ?.label
                    }
                    onAnswer={answerResearchQuestion}
                  />
                )}
                {result.items.map((i) => (
                  <article key={i.itemId}>
                    <h2>{customerItemName(i)}</h2>
                    {!view?.question &&
                      view?.items
                        .find((item) => item.id === i.itemId)
                        ?.fields.some((f) =>
                          ["unknown", "skipped", "conflict"].includes(f.status),
                        ) && (
                        <p>
                          分からなかった条件：
                          {view.items
                            .find((item) => item.id === i.itemId)!
                            .fields.filter((f) =>
                              ["unknown", "skipped", "conflict"].includes(
                                f.status,
                              ),
                            )
                            .map((f) => fields[f.key]?.label ?? f.label)
                            .join("、")}
                        </p>
                      )}
                    {i.scopeAssessment.status === "in_scope" &&
                      i.verdict !== "can_handle" && (
                        <p className="scope">{i.scopeAssessment.reason}</p>
                      )}
                    {i.reasonCode !== "APPROVED_SCOPE_MATCH" ? (
                      <p>{i.reason}</p>
                    ) : result.items.length > 1 ? (
                      <p>取扱可能です。</p>
                    ) : null}
                    {!sharedNextStep && !view?.question && !view?.followup && (
                      <p className="next-step">{customerNextStep(i)}</p>
                    )}
                    {view?.items
                      .find((item) => item.id === i.itemId)
                      ?.notes.filter((n) => n.startsWith("寸法種別は未確認"))
                      .map((note) => (
                        <p key={note}>{note}</p>
                      ))}
                    {i.webFindings?.map((page) => (
                      <section key={page.url}>
                        <h3>公開ページで確認した条件</h3>
                        <ul>
                          {page.confirmed.map((v) => (
                            <li key={v}>{v}</li>
                          ))}
                        </ul>
                        {!!page.unconfirmed.length && (
                          <p>未確認：{page.unconfirmed.join("、")}</p>
                        )}
                        <a href={page.url} target="_blank" rel="noreferrer">
                          {new URL(page.url).hostname}
                        </a>
                        <small>確認日時：{page.checkedAt}</small>
                      </section>
                    ))}
                    <details>
                      <summary>根拠・確認した条件</summary>
                      <ul>
                        {i.conditions.map((v, n) => (
                          <li key={n}>{v}</li>
                        ))}
                      </ul>
                      <p>
                        在庫確保、正式納期、価格、技術的適合を保証する回答ではありません。
                      </p>
                      {[...i.scopeAssessment.evidence, ...i.evidence]
                        .filter(
                          (ev, n, a) =>
                            a.findIndex((v) => v.id === ev.id) === n,
                        )
                        .map((ev) => (
                          <p key={ev.id}>
                            {ev.url ? (
                              <a href={ev.url} target="_blank" rel="noreferrer">
                                {ev.label}
                              </a>
                            ) : (
                              ev.label
                            )}
                            <small>確認日時：{ev.checkedAt}</small>
                          </p>
                        ))}
                    </details>
                    {i.missingFields.length > 0 && (
                      <div>
                        <p>
                          照会前に確認する項目{" "}
                          {i.missingFields.map((key) => fields[key]?.label ?? key).join("、")}
                        </p>
                        <button
                          onClick={() => {
                            setEditing(true);
                            setTimeout(
                              () =>
                                document
                                  .getElementById(
                                    `edit-${i.itemId}-${i.missingFields[0]}`,
                                  )
                                  ?.focus(),
                              50,
                            );
                          }}
                        >
                          不足条件を修正する
                        </button>
                      </div>
                    )}
                  </article>
                ))}
                {sharedNextStep && !view?.question && !view?.followup && (
                  <p className="next-step">{sharedNextStep}</p>
                )}
                {view?.question && (
                  <p>
                    まだ確認できる項目があります。チャットの質問を続けられます。
                  </p>
                )}
                <div className="actions">
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={prepareMail}
                  >
                    メールで相談する
                  </button>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={copyDraft}
                  >
                    相談内容をコピー
                  </button>
                  <button disabled={busy} onClick={research}>
                    {result.status === "failed" ? "調査を再試行" : "再調査"}
                  </button>
                </div>
              </section>
            )}
            {result && !view?.question && !view?.followup && (
              <section className="question-card">
                <h2>追加の相談・訂正</h2>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void answer({ type: "text", text: input });
                  }}
                >
                  <label htmlFor="followup">回答</label>
                  <textarea
                    id="followup"
                    value={input}
                    disabled={busy}
                    onChange={(e) => setInput(e.target.value)}
                    rows={3}
                    maxLength={2000}
                  />
                  <button className="primary" disabled={busy || !input.trim()}>
                    送信
                  </button>
                </form>
              </section>
            )}
            {!!view?.unresolvedInputs?.length && !result && (
              <section className="notice" role="status">
                <p>
                  {view.question
                    ? "確認できる条件を、チャットで続けて伺います。"
                    : "残った確認事項は、担当者に相談できます。"}
                </p>
                <p>以前の条件による判定は保留しています。</p>
                <details>
                  <summary>確認待ちの相談内容</summary>
                  {view.unresolvedInputs.map((t, i) => (
                    <p key={i}>{t}</p>
                  ))}
                </details>
                <details>
                  <summary>ここまでの内容で担当者へ相談する場合</summary>
                  <button disabled={busy} onClick={prepareMail}>
                    このままメールで相談する
                  </button>
                </details>
              </section>
            )}
            {view && (
              <button
                className="edit-toggle"
                onClick={() => setEditing(!editing)}
              >
                {editing ? "入力内容の編集を閉じる" : "入力内容を確認・修正"}
              </button>
            )}
            {editing && view && (
              <section className="question-card">
                <h1>入力内容を確認・修正</h1>
                {!!view.unresolvedInputs?.length && (
                  <p>
                    追加相談前の条件です。変更が未定なら、このままメールで相談できます。
                  </p>
                )}
                {view.items.map((item) => (
                  <article key={item.id}>
                    <h2>{item.label}</h2>
                    {[
                      ...new Set([
                        ...item.fields.map((f) => f.key),
                        ...(view.result?.items.find((i) => i.itemId === item.id)
                          ?.missingFields ?? []),
                        "request_scope",
                        "material_supply",
                        "work_scope",
                        "drawing_revision",
                        "coating",
                        "excluded_work",
                        "supplied_parts",
                        "destination",
                        "quantity",
                        "required_date",
                      ]),
                    ].map((key) => (
                      <FieldEditor
                        key={key}
                        item={item}
                        fieldKey={key}
                        disabled={busy}
                        onSave={saveField}
                      />
                    ))}
                    <AttachmentInput
                      disabled={busy}
                      label="この品目に写真・図面を追加"
                      onFile={(f) => upload(f, item.id)}
                    />
                  </article>
                ))}
                {view.attachments.map((a) => (
                  <div key={a.id}>
                    <p>
                      {a.name} ·{" "}
                      {a.analysis === "not_analyzed"
                        ? "受領済み・内容は未解析"
                        : a.analysis}
                    </p>
                    <AttachmentInput
                      disabled={busy}
                      label="この添付を最新図面に差し替える"
                      onFile={(f) => upload(f, undefined, a.id)}
                    />
                  </div>
                ))}
                <button
                  className="primary"
                  disabled={busy || !view.canResearch}
                  onClick={research}
                >
                  この内容で調べる
                </button>
                <button disabled={busy} onClick={prepareMail}>
                  メール文を作成
                </button>
              </section>
            )}
            {draft && (
              <section className="question-card">
                <h2>メール相談の内容</h2>
                {draft.notice && <p role="status">{draft.notice}</p>}
                <label htmlFor="mail-text">件名と本文</label>
                <textarea
                  id="mail-text"
                  readOnly
                  rows={14}
                  value={draft.subject + "\n\n" + draft.body}
                />
                <div className="actions">
                  <button className="primary" onClick={copyDraft}>
                    全文をコピー
                  </button>
                  {draft.mailto && (
                    <a
                      className="button"
                      href={draft.mailto}
                      onClick={() => {
                        void request(`/cases/${caseId}/events`, "POST", {
                          code: "mail_opened",
                        });
                      }}
                    >
                      メールソフトを開く
                    </a>
                  )}
                </div>
                <p>
                  送信はお客様のメールソフトで行います。写真・図面は自動添付されません。
                </p>
              </section>
            )}
            <details className="privacy">
              <summary>相談内容と情報の扱い</summary>
              <p>
                {hostedTrial
                  ? "架空の資料を使う管理者向け試用です。"
                  : "ローカル環境の登録資料で取扱条件を確認します。"}
                {provider === "openai"
                  ? "自由文の必要な内容をOpenAI APIへ送り、入力条件を抽出します。"
                  : provider === "disabled"
                    ? "自由文の自動抽出は停止中です。"
                    : "自由文は簡易のデモ抽出で処理します。"}
                {hostedTrial
                  ? "試用には架空の判断資料を使用しています。"
                  : "協力会社の照合後、候補が0件でWeb検索が有効な場合は、検索用の条件を外部サービスに送ります。仕入先一覧や図面は送信しません。"}
                案件・添付の暫定保管期限は作成から30日です。
              </p>
              {view && (
                <button
                  onClick={() =>
                    work(async () => {
                      await request("/cases/" + caseId, "DELETE");
                      reset();
                    })
                  }
                >
                  この相談と添付を削除する
                </button>
              )}
            </details>
          </>
        )}
      </main>
      <footer>
        取扱確認からメール相談へ。
        <span>実モデル・実資料による実用評価は未実施です。</span>
      </footer>
    </>
  );
}
function AttachmentInput({
  disabled,
  onFile,
  label,
}: {
  disabled: boolean;
  onFile: (f: File) => void;
  label: string;
}) {
  return (
    <label className="attachment">
      {label}
      <input
        type="file"
        accept="image/jpeg,image/png,image/webp,application/pdf"
        disabled={disabled}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
      <small>JPEG / PNG / WebP / PDF · 各10MB、3件まで</small>
    </label>
  );
}
function FieldEditor({
  item,
  fieldKey,
  disabled,
  onSave,
}: {
  item: Item;
  fieldKey: string;
  disabled: boolean;
  onSave: (id: string, k: string, v: string, o: boolean) => void;
}) {
  const f = item.fields.find((f) => f.key === fieldKey),
    def = fields[fieldKey];
  const [value, setValue] = useState(
      f?.value ? (labels[f.value.text] ?? f.value.text) : "",
    ),
    [optional, setOptional] = useState(f ? !f.hardConstraint : false);
  useEffect(() => {
    setValue(f?.value ? (labels[f.value.text] ?? f.value.text) : "");
  }, [f?.value?.text]);
  if (!def) return null;
  return (
    <form
      className="field-editor"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(item.id, fieldKey, value, optional);
      }}
    >
      <label htmlFor={`edit-${item.id}-${fieldKey}`}>
        {def.label}
        <small>{f ? present(f) : "未確認"}</small>
      </label>
      {def.values ? (
        <select
          id={`edit-${item.id}-${fieldKey}`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        >
          <option value="">選択してください</option>
          {def.values.map((v) => (
            <option key={v} value={labels[v] ?? v}>
              {labels[v] ?? v}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={`edit-${item.id}-${fieldKey}`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={
            def.units ? `単位付き（例：10${def.units[0]}）` : "現在の希望条件"
          }
        />
      )}
      <label className="check">
        <input
          type="checkbox"
          checked={optional}
          onChange={(e) => setOptional(e.target.checked)}
        />
        任意・変更可
      </label>
      <button disabled={disabled || !value.trim()}>保存</button>
    </form>
  );
}
function Admin({currentCaseId}: {currentCaseId: string}) {
  const [token, setToken] = useState(""),
    [data, setData] = useState<{
      rules: unknown[];
      sources: unknown[];
      knowledgeRevision: number;
      cases: {id: string; phase: string; created_at: number}[];
      failures: unknown[];
    } | null>(null),
    [rule, setRule] = useState(""),
    [source, setSource] = useState(""),
    [message, setMessage] = useState("");
  const headers = { "X-Local-Admin-Token": token };
  async function action(fn: () => Promise<void>) {
    try {
      await fn();
    } catch (e) {
      setMessage((e as Error).message);
    }
  }
  const load = async () =>
    setData(
      await request<{
        rules: unknown[];
        sources: unknown[];
        knowledgeRevision: number;
        cases: {id: string; phase: string; created_at: number}[];
        failures: unknown[];
      }>("/admin/state", "GET", undefined, headers),
    );
  return (
    <section className="question-card">
      <h1>ローカル管理</h1>
      <p>架空ルールの準備、取込、検証、承認・撤回を確認できます。</p>
      <label htmlFor="admin-token">ローカル管理トークン</label>
      <input
        id="admin-token"
        type="password"
        value={token}
        onChange={(e) => { setToken(e.target.value); setData(null); }}
      />
      <div className="actions">
        <button onClick={() => action(load)}>読み込む</button>
        <button
          onClick={() =>
            action(async () => {
              await request("/admin/demo", "POST", {}, headers);
              await load();
              setMessage("架空のデモ資料を登録しました。");
            })
          }
        >
          デモ資料を準備
        </button>
      </div>
      <p role="status">{message}</p>
      {data && (
        <>
          <PartnerReview cases={data.cases} currentCaseId={currentCaseId} load={path => request(path, "GET", undefined, headers)} />
          <p>判断資料の版：{data.knowledgeRevision}</p>
          <h2>ルール一覧</h2>
          {data.rules.map((r, n) => (
            <button key={n} onClick={() => setRule(JSON.stringify(r, null, 2))}>
              ルール {n + 1} を編集
            </button>
          ))}
          <label htmlFor="rule-json">
            ルールJSON（承認状態・有効期限を含む）
          </label>
          <textarea
            id="rule-json"
            rows={12}
            value={rule}
            onChange={(e) => setRule(e.target.value)}
          />
          <div className="actions">
            <button
              onClick={() =>
                action(async () => {
                  await request(
                    "/admin/rules",
                    "POST",
                    { rule: JSON.parse(rule), preview: true },
                    headers,
                  );
                  setMessage(
                    "検証に合格しました。対象・方式・公開説明を確認してから保存してください。",
                  );
                })
              }
            >
              検証プレビュー
            </button>
            <button
              onClick={() =>
                action(async () => {
                  await request(
                    "/admin/rules",
                    "POST",
                    {
                      rule: JSON.parse(rule),
                      expectedKnowledgeRevision: data.knowledgeRevision,
                    },
                    headers,
                  );
                  await load();
                  setMessage("ルールを保存しました。");
                })
              }
            >
              承認状態を含め保存
            </button>
          </div>
          <label htmlFor="source-json">原資料メタデータJSON</label>
          <textarea
            id="source-json"
            rows={6}
            value={source}
            onChange={(e) => setSource(e.target.value)}
          />
          <button
            onClick={() =>
              action(async () => {
                await request(
                  "/admin/sources",
                  "POST",
                  { source: JSON.parse(source) },
                  headers,
                );
                await load();
                setMessage("原資料の設定を保存しました。");
              })
            }
          >
            原資料を登録
          </button>
          <details>
            <summary>案件・運用状態</summary>
            <pre>
              {JSON.stringify(
                { cases: data.cases, failures: data.failures },
                null,
                2,
              )}
            </pre>
          </details>
          <button
            onClick={() =>
              action(async () => {
                await request("/admin/maintenance", "POST", {}, headers);
                setMessage("outbox回復・期限処理・削除処理を実行しました。");
              })
            }
          >
            保守処理を実行
          </button>
        </>
      )}
    </section>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
