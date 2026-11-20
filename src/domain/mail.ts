import type { Snapshot, PublicResult } from "./model";
import { present } from "./fields";
import { customerNextStep } from "./customer-copy";
import { isTentative } from "./grounding";
export function makeMailDraft(
  s: Snapshot,
  r: PublicResult | null,
  email = "",
  uriLimit = 1800,
) {
  const pending = Boolean(s.unresolvedInputs?.length);
  const includePriorRequest =
    !s.extractionFailed &&
    s.unresolvedInputs?.some(
      (e) => isTentative(e.text) && /材料|調達|材質|SUS|アルミ/.test(e.text),
    );
  const safePendingFields =
    pending &&
    s.unresolvedInputs!.every((e) =>
      e.partialFor || s.pendingChanges?.some((p) => p.eventId === e.id),
    )
      ? s.brief.items.flatMap((i, index) => {
          const stable = i.fields.filter(
            (f) =>
              f.status !== "not_asked" &&
              f.key !== "description" &&
              !s.pendingChanges?.some(
                (p) => p.itemId === i.id && p.key === f.key,
              ),
          );
          return stable.length
            ? [
                `【${s.pendingChanges?.some((p) => p.itemId === i.id && ["model", "product_name"].includes(p.key)) ? `品目${index + 1}` : i.label}：今回の追加相談で変更対象になっていない条件】`,
                ...stable.map(
                  (f) =>
                    `${f.label}：${f.status === "unknown" && /未定|後で決め|まだ決め|決まっていない|決めていない/.test(f.quote ?? "") ? `未定（${f.quote}）` : present(f)}`,
                ),
              ]
            : [];
        })
      : [];
  const ref = "AV-" + s.brief.caseId.slice(0, 8).toUpperCase();
  const subject = `商品・製作の取扱相談（照会番号 ${ref}）`;
  const body = [
    `照会番号：${ref}`,
    "商品・加工・製作について相談します。",
    ...(pending
      ? [
          "",
          "最新の相談を確認中のため、以前の条件・判断を現在の確定仕様としては記載していません。",
          ...safePendingFields,
          ...(includePriorRequest
            ? [
                "追加相談前の発言（現在の確定条件ではありません）：",
                s.inputs.find(
                  (e) =>
                    e.type === "customer_text" &&
                    !s.unresolvedInputs?.some((u) => u.id === e.id),
                )?.text ?? "当初の条件は未確認です。",
              ]
            : []),
        ]
      : s.brief.items.flatMap((i) => [
          "",
          `【${i.label}】`,
          ...i.fields
            .filter((f) => f.status !== "not_asked")
            .map(
              (f) =>
                `${f.label}：${f.status === "unknown" && /未定|後で決め|まだ決め|決まっていない|決めていない/.test(f.quote ?? "") ? `未定（${f.quote}）` : present(f)}`,
            ),
          ...i.notes.map((n) => `補足：${n}`),
        ])),
    ...(s.unresolvedInputs?.length
      ? [
          "",
          "解釈・確認が未完了の入力：",
          ...s.unresolvedInputs.map((e) => e.text),
        ]
      : []),
    ...(s.overflow.length
      ? ["", "別案件への分割が必要な未処理入力：", ...s.overflow]
      : []),
    "",
    ...(pending || !r || r.stale
      ? ["確認結果：未確認（再調査が必要です）"]
      : r.status === "failed"
        ? ["確認結果：調査未完了"]
        : [
            `確認日時：${r.createdAt}`,
            ...r.items.flatMap((i) => [
              `${i.label}：${i.scopeAssessment.reason}`,
              `今回の依頼：${i.reason}`,
              ...(i.webFindings ?? []).flatMap((page) => [
                `公開ページの記載：${page.confirmed.join("、")}`,
                ...(page.unconfirmed.length ? [`ページで未確認：${page.unconfirmed.join("、")}`] : []),
                `参照元：${page.url}（確認日時 ${page.checkedAt}）`,
              ]),
              `次のご相談：${customerNextStep(i)}`,
            ]),
          ]),
    ...(s.attachmentNames.length
      ? [
          "",
          "写真・図面はメールにも添付してください。",
          ...s.attachmentNames.map((n) => `添付名：${n}`),
        ]
      : []),
    "",
    "追記：",
  ].join("\n");
  const canMail =
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !/[\r\n]/.test(email);
  const full = canMail
    ? `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
    : null;
  const shortened =
    full !== null && new TextEncoder().encode(full).length > uriLimit;
  return {
    subject,
    body,
    mailto: full
      ? shortened
        ? `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent("照会番号：" + ref + "\n相談内容の全文をコピーして貼り付けてください。")}`
        : full
      : null,
    shortened,
    reference: ref,
    notice: !canMail
      ? "メール起動は準備中です。相談内容の全文をコピーできます。"
      : shortened
        ? "全文をコピーしてメール本文へ貼り付けてください。"
        : null,
  };
}
