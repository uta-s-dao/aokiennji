import type { Snapshot, PublicResult } from "./model";
import { present } from "./fields";
export function makeMailDraft(
  s: Snapshot,
  r: PublicResult | null,
  email = "",
  uriLimit = 1800,
) {
  const ref = "AV-" + s.brief.caseId.slice(0, 8).toUpperCase();
  const subject = `商品・製作の取扱相談（照会番号 ${ref}）`;
  const body = [
    `照会番号：${ref}`,
    "商品・加工・製作について相談します。",
    ...s.brief.items.flatMap((i) => [
      "",
      `【${i.label}】`,
      ...i.fields
        .filter((f) => f.status !== "not_asked")
        .map((f) => `${f.label}：${present(f)}`),
      ...i.notes.map((n) => `補足：${n}`),
    ]),
    ...(s.overflow.length
      ? ["", "別案件への分割が必要な未処理入力：", ...s.overflow]
      : []),
    "",
    ...(!r || r.stale
      ? ["確認結果：未確認（再調査が必要です）"]
      : r.status === "failed"
        ? ["確認結果：調査未完了"]
        : [
            `確認日時：${r.createdAt}`,
            ...r.items.flatMap((i) => [
              `${i.label}：${i.scopeAssessment.reason}`,
              `今回の依頼：${i.reason}`,
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
