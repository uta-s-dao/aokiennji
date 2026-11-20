import { useRef, useState } from "react";
import type { Item } from "../domain/model";
import { fields, present } from "../domain/fields";
import type {
  PartnerCandidate,
  PartnerMaster,
  PartnerSourceRef,
} from "../domain/partner-search";
import type { PartnerReport } from "../adapters/partner-research";

type CaseDetails = {
  items: Item[];
  result: { stale: boolean } | null;
  partnerReport: PartnerReport | null;
};

function SourceRows({ refs }: { refs: PartnerSourceRef[] }) {
  return (
    <ul>
      {refs.map((source, i) => (
        <li key={i}>
          {source.fileName} {source.sheet} {source.row}行
          {source.columns && (
            <details>
              <summary>列の対応と原値</summary>
              <dl>
                {Object.entries(source.columns).map(([key, column]) => (
                  <div key={key}>
                    <dt>
                      {column}列 · {source.columnLabels?.[key] ?? key}
                    </dt>
                    <dd>
                      {source.rawValues?.[column] ||
                        source.rawValues?.[key] ||
                        "未記載"}
                    </dd>
                  </div>
                ))}
              </dl>
            </details>
          )}
        </li>
      ))}
    </ul>
  );
}

function Website({ url }: { url: string | null }) {
  if (!url || !/^https?:\/\//i.test(url)) return <>URL未登録</>;
  return (
    <a href={url} target="_blank" rel="noreferrer">
      {url}
    </a>
  );
}

function Candidate({ candidate }: { candidate: PartnerCandidate }) {
  return (
    <article>
      <h4>{candidate.partnerName}</h4>
      {candidate.sourcingBasis && candidate.status === "review" && (
        <p>
          {candidate.sourcingBasis === "material"
            ? "材料の調達先候補"
            : "取扱品の調達先候補"}
          。今回の仕様で手配できるか、製作をどう進めるかを担当者が確認します。
        </p>
      )}
      <Website url={candidate.website} />
      <ul>
        {candidate.assessments.map((a, index) => (
          <li key={index}>
            {a.status === "confirmed"
              ? "一致"
              : a.status === "unconfirmed"
                ? "未確認"
                : "不一致"}{" "}
            · {fields[a.field]?.label ?? a.field} {a.reason}
          </li>
        ))}
      </ul>
      {candidate.evidence.length > 0 && (
        <p>{candidate.evidence.join(" ／ ")}</p>
      )}
      <small>条件組ID {candidate.groupId}</small>
      <SourceRows refs={candidate.sourceRefs} />
    </article>
  );
}

export function PartnerReview({
  cases,
  currentCaseId,
  load,
}: {
  cases: { id: string; phase: string; created_at: number }[];
  currentCaseId: string;
  load: <T>(path: string) => Promise<T>;
}) {
  const [master, setMaster] = useState<PartnerMaster | null>(null);
  const [detail, setDetail] = useState<CaseDetails | null>(null);
  const [error, setError] = useState("");
  const latestCase = useRef("");
  const readCase = async (id: string) => {
    latestCase.current = id;
    setDetail(null);
    setError("");
    if (!id) return;
    try {
      const next = await load<CaseDetails>(
        "/admin/cases/" + encodeURIComponent(id),
      );
      if (latestCase.current === id) setDetail(next);
    } catch (e) {
      if (latestCase.current === id) setError((e as Error).message);
    }
  };
  const report = detail?.partnerReport;
  return (
    <section>
      <h2>協力会社の照合</h2>
      <button
        onClick={async () => {
          try {
            setMaster(await load<PartnerMaster>("/admin/partners"));
            setError("");
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        仕入先一覧を読み込む
      </button>
      {master &&
        (master.status !== "ready" ? (
          <p>{master.reason}</p>
        ) : (
          <details>
            <summary>
              仕入先 {master.partners.length}社（一覧のみ{" "}
              {
                master.partners.filter((p) => p.capabilityState === "list_only")
                  .length
              }
              社）
            </summary>
            <ul>
              {master.partners.map((p) => (
                <li key={p.id}>
                  {p.name} · <Website url={p.website} /> ·{" "}
                  {p.capabilityState === "list_only" ? "一覧のみ" : "照合対象"}
                  <SourceRows refs={p.sourceRefs} />
                </li>
              ))}
            </ul>
          </details>
        ))}
      <label htmlFor="partner-case">照合結果を確認する案件</label>
      <select
        id="partner-case"
        defaultValue=""
        onChange={(e) => void readCase(e.target.value)}
      >
        <option value="">案件を選択</option>
        {cases.map((c) => (
          <option key={c.id} value={c.id}>
            {c.id === currentCaseId ? "現在の相談 · " : ""}AV-
            {c.id.slice(0, 8).toUpperCase()} ·{" "}
            {new Date(c.created_at).toLocaleString("ja-JP")}
          </option>
        ))}
      </select>
      {error && <p role="alert">{error}</p>}
      {detail && detail.items.length > 0 && (
        <section>
          <h3>仕入先への照会条件</h3>
          {detail.items.map((item) => (
            <article key={item.id}>
              <h4>{item.label}</h4>
              <dl>
                {item.fields
                  .filter(
                    (field) =>
                      field.status !== "not_asked" &&
                      field.key !== "equivalent_for_model",
                  )
                  .map((field) => (
                    <div key={field.key}>
                      <dt>{field.label}</dt>
                      <dd>
                        {present(field)}
                        {field.status === "known" &&
                          !field.key.startsWith("equivalent_") &&
                          (field.hardConstraint
                            ? "（指定）"
                            : "（希望・変更可）")}
                        {field.quote && field.quote !== present(field) && (
                          <small>お客様の回答「{field.quote}」</small>
                        )}
                      </dd>
                    </div>
                  ))}
              </dl>
              {report?.followup?.staffTasks
                .filter((task) => task.itemId === item.id)
                .map((task) => (
                  <p key={task.fieldKey}>
                    {fields[task.fieldKey]?.label ?? "仕入先への確認"} ·{" "}
                    {task.reason}
                  </p>
                ))}
            </article>
          ))}
          {report?.followupAnswer && (
            <p>
              調査後の確認 · {report.followup?.offer?.question} 回答：
              {report.followup?.offer?.options.find(
                (option) =>
                  option.value ===
                  (report.followupAnswer?.answer.choice ??
                    report.followupAnswer?.answer.status),
              )?.label ?? report.followupAnswer.answer.value?.text}
            </p>
          )}
        </section>
      )}
      {detail && !report && (
        <p>
          {detail.result?.stale
            ? "条件または資料が更新されました。再調査してください。"
            : "この案件の照合結果はまだありません。"}
        </p>
      )}
      {report && (
        <>
          <p>
            {report.master.reason ??
              (report.master.status === "completed"
                ? "マスタ照合完了"
                : "マスタ照合未完了")}
          </p>
          {report.master.masterVersionId && (
            <small>使用したマスタ版 {report.master.masterVersionId}</small>
          )}
          {report.master.items.map((i) => (
            <section key={i.itemId}>
              <h3>
                {detail?.items.find((x) => x.id === i.itemId)?.label ??
                  i.itemId}
              </h3>
              {detail?.items
                .find((x) => x.id === i.itemId)
                ?.notes?.filter((note) => note.startsWith("寸法種別は未確認"))
                .map((note) => (
                  <p key={note}>{note}</p>
                ))}
              <p>
                一致 {i.match.length}件 ／ 記載不足で要確認 {i.review.length}件
                ／ 不一致 {i.mismatch.length}件
              </p>
              {(
                [
                  ["一致", i.match],
                  ["記載不足で要確認", i.review],
                  ["不一致", i.mismatch],
                ] as const
              ).map(
                ([label, candidates]) =>
                  candidates.length > 0 && (
                    <details key={label} open={label !== "不一致"}>
                      <summary>{label}の条件組</summary>
                      {candidates.map((c) => (
                        <Candidate
                          key={c.partnerId + ":" + c.groupId}
                          candidate={c}
                        />
                      ))}
                    </details>
                  ),
              )}
            </section>
          ))}
          <h3>Web検索</h3>
          <p>{report.webMessage}</p>
          {report.pages.map((p, n) => (
            <article key={n}>
              <h4>{detail?.items.find((x) => x.id === p.itemId)?.label}</h4>
              <Website url={p.url} /> <small>{p.checkedAt}</small>
              <p>確認できた条件 {p.confirmed.join("、") || "なし"}</p>
              <p>未確認 {p.unconfirmed.join("、") || "なし"}</p>
            </article>
          ))}
        </>
      )}
    </section>
  );
}
