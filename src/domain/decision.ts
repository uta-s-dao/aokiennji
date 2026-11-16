import {
  AppError,
  type ResearchBrief,
  type Item,
  type CapabilityRule,
  type Source,
  type PublicResult,
  type ItemResult,
  type PublicEvidence,
} from "./model";
import { fields, normalized, present } from "./fields";
import { resolveCategories } from "./category";
import {
  validateCapabilityRule,
  validatePublicResult,
} from "../generated/validators.js";
export function checkRule(r: CapabilityRule, source: Source | undefined) {
  if (
    !validateCapabilityRule(r) ||
    !source ||
    source.id !== r.sourceId ||
    r.predicates.some((p) => !fields[p.field]) ||
    [...r.requiredFields, ...r.coveredFields].some((k) => !fields[k])
  )
    throw new AppError("INVALID_RULE");
  for (const p of r.predicates) {
    if (
      p.op === "range" &&
      (p.min > p.max || !fields[p.field].units?.includes(p.unit))
    )
      throw new AppError("INVALID_RULE");
    if (p.op !== "range") {
      const values = p.op === "eq" ? [p.value] : p.values;
      if (
        fields[p.field].values &&
        values.some((v) => !fields[p.field].values!.includes(String(v)))
      )
        throw new AppError("INVALID_RULE");
      if (fields[p.field].units && values.some((v) => typeof v === "number"))
        throw new AppError("INVALID_RULE");
    }
  }
  if (
    r.approvalStatus === "approved" &&
    (!source.public_allowed ||
      source.role !== "seller" ||
      source.confirmation_stage !== "current_policy" ||
      !r.validUntil ||
      Date.parse(r.validUntil) <= Date.parse(r.approvedAt ?? "") ||
      !r.publicStatement.trim())
  )
    throw new AppError("APPROVAL_REQUIRED");
  if (
    r.assessmentScope === "request" &&
    r.approvalStatus === "approved" &&
    !r.predicates.some((p) => p.field === "request_scope")
  )
    throw new AppError("INVALID_RULE");
  if (
    r.assessmentScope === "request" &&
    r.predicates.some(
      (p) =>
        p.field === "request_scope" &&
        p.op !== "range" &&
        (p.op === "eq" ? [p.value] : p.values).some((value) =>
          ["processing", "fabrication"].includes(String(value)),
        ),
    ) &&
    !r.predicates.some((p) => p.field === "material_supply")
  )
    throw new AppError("INVALID_RULE");
}
function matches(r: CapabilityRule, i: Item) {
  if (r.category !== i.category) return false;
  const model = i.fields.find((f) => f.key === "model")?.value?.text;
  if (
    r.modelAliases.length &&
    (!model ||
      !r.modelAliases.some(
        (v) => v.toLocaleUpperCase() === model.toLocaleUpperCase(),
      ))
  )
    return false;
  return r.predicates.every((p) => {
    const f = i.fields.find((f) => f.key === p.field);
    if (!f || f.status !== "known" || !f.value) return false;
    if (p.op === "range") {
      if (f.value.number == null || !f.value.unit) return false;
      const a = normalized(f.value.number, f.value.unit),
        lo = normalized(p.min, p.unit),
        hi = normalized(p.max, p.unit);
      return (
        a.dimension === lo.dimension &&
        a.value >= lo.value &&
        a.value <= hi.value
      );
    }
    const v =
      typeof (p.op === "eq" ? p.value : p.values[0]) === "number"
        ? f.value.number
        : f.value.text;
    return p.op === "eq"
      ? v === p.value
      : p.values.includes(v as string | number);
  });
}
function publicEvidence(r: CapabilityRule, time: number): PublicEvidence {
  return {
    id: r.id,
    label: r.publicStatement,
    url: null,
    checkedAt: new Date(time).toISOString(),
  };
}
export function decideAvailability(
  b: ResearchBrief,
  rules: CapabilityRule[],
  sources: Source[],
  jobId: string,
  status: PublicResult["status"] = "completed",
  time = Date.now(),
): PublicResult {
  const valid = rules.filter((r) => {
    try {
      checkRule(
        r,
        sources.find((s) => s.id === r.sourceId),
      );
      return (
        r.approvalStatus === "approved" &&
        r.validUntil != null &&
        Date.parse(r.validUntil) > time &&
        Date.parse(r.approvedAt!) <= time
      );
    } catch {
      return false;
    }
  });
  const items: ItemResult[] = resolveCategories(b.items, valid, time).map((i) => {
    const matched = valid.filter((r) => matches(r, i));
    const scope = matched.filter((r) => r.assessmentScope === "business_scope");
    const request = matched.filter((r) => r.assessmentScope === "request");
    const scopePos = scope.filter((r) => r.decision === "supported"),
      scopeNeg = scope.filter((r) => r.decision === "excluded");
    const required = [...new Set(request.flatMap((r) => r.requiredFields))];
    const missing = required.filter(
      (k) => !i.fields.some((f) => f.key === k && f.status === "known"),
    );
    const hard = i.fields.filter(
      (f) => f.hardConstraint && f.status !== "not_applicable",
    );
    const supported = request.filter(
      (r) =>
        r.decision === "supported" &&
        r.requiredFields.every((k) =>
          i.fields.some((f) => f.key === k && f.status === "known"),
        ) &&
        hard.every(
          (f) => f.status === "known" && r.coveredFields.includes(f.key),
        ),
    );
    const excluded = request.filter(
      (r) =>
        r.decision === "excluded" &&
        r.requiredFields.every((k) =>
          i.fields.some((f) => f.key === k && f.status === "known"),
        ),
    );
    const conflict =
      (scopePos.length > 0 && scopeNeg.length > 0) ||
      (supported.length > 0 && excluded.length > 0) ||
      i.fields.some((f) => f.status === "conflict");
    let scopeStatus: "in_scope" | "out_of_scope" | "unconfirmed" =
      scopePos.length && !scopeNeg.length
        ? "in_scope"
        : scopeNeg.length && !scopePos.length
          ? "out_of_scope"
          : "unconfirmed";
    if (
      scopeStatus === "unconfirmed" &&
      !scopeNeg.length &&
      supported.length &&
      !conflict
    )
      scopeStatus = "in_scope";
    const scopeRules =
      scopeStatus === "in_scope"
        ? scopePos.length
          ? scopePos
          : supported
        : scopeStatus === "out_of_scope"
          ? scopeNeg
          : [];
    let verdict: ItemResult["verdict"] = "needs_review",
      reasonCode: ItemResult["reasonCode"] = "NO_APPROVED_SCOPE",
      reason = "今回の条件での取扱可否は、担当者確認が必要です。";
    let resultRules: CapabilityRule[] = [];
    if (i.notes.some((n) => n.startsWith("未確認の顧客入力："))) {
      reasonCode = "MISSING_CONDITIONS";
      reason =
        "未確認の入力条件が残っているため、今回の依頼は担当者確認が必要です。";
    } else if (
      conflict ||
      (scopeStatus === "out_of_scope" && supported.length)
    ) {
      reasonCode = "CONFLICTING_EVIDENCE";
      reason = "判断資料または入力条件に矛盾があり、担当者確認が必要です。";
    } else if (request.some((r) => r.decision === "review_only")) {
      reasonCode = "MISSING_CONDITIONS";
    } else if (supported.length && scopeStatus === "in_scope") {
      verdict = "can_handle";
      reasonCode = "APPROVED_SCOPE_MATCH";
      reason = "承認済みの取扱範囲と今回の必須条件が一致しています。";
      resultRules = supported;
    } else if (excluded.length) {
      verdict = "out_of_scope";
      reasonCode = "APPROVED_EXCLUSION_MATCH";
      reason = excluded[0].publicStatement;
      resultRules = excluded;
    } else if (scopeStatus === "out_of_scope") {
      reasonCode = "NO_APPROVED_SCOPE";
      reason =
        "取扱分野は対象外ですが、今回の個別依頼の結論は担当者確認が必要です。";
    } else if (missing.length || scopeStatus === "in_scope" || request.length) {
      reasonCode = "MISSING_CONDITIONS";
      reason =
        "取扱分野の根拠と、今回の仕様・依頼方式・希望条件を分けて確認する必要があります。";
    } else if (
      rules.some(
        (r) =>
          r.category === i.category &&
          r.validUntil &&
          Date.parse(r.validUntil) <= time,
      )
    ) {
      reasonCode = "EXPIRED_EVIDENCE";
    }
    if (
      status === "failed" ||
      (status === "partial" && verdict === "needs_review")
    ) {
      reasonCode = "RESEARCH_INCOMPLETE";
      reason = "調査が未完了です。入力内容を保持してメール相談できます。";
    }
    return {
      itemId: i.id,
      label: i.label,
      scopeAssessment: {
        status: scopeStatus,
        reason:
          scopeStatus === "in_scope"
            ? "承認済みの取扱分野に含まれます。"
            : scopeStatus === "out_of_scope"
              ? "承認済み資料で取扱分野の対象外です。"
              : "取扱分野も担当者確認が必要です。",
        evidence: scopeRules.slice(0, 8).map((r) => publicEvidence(r, time)),
      },
      verdict,
      reasonCode,
      reason,
      conditions: i.fields
        .filter((f) => f.hardConstraint && f.value)
        .map((f) => `${f.label}：${present(f)}`)
        .slice(0, 10),
      missingFields: [
        ...new Set([
          ...missing,
          ...hard
            .filter(
              (f) =>
                f.status !== "known" ||
                !supported.some((r) => r.coveredFields.includes(f.key)),
            )
            .map((f) => f.key),
        ]),
      ],
      evidence: resultRules.slice(0, 8).map((r) => publicEvidence(r, time)),
    };
  });
  const verdict =
    status === "failed"
      ? null
      : status === "partial"
        ? "needs_review"
        : items.every((i) => i.verdict === "can_handle")
          ? "can_handle"
          : items.every((i) => i.verdict === "out_of_scope")
            ? "out_of_scope"
            : "needs_review";
  return toPublicResult({
    kind: "public_result",
    caseId: b.caseId,
    jobId,
    inputRevision: b.revision,
    knowledgeRevision: b.knowledgeRevision,
    status,
    verdict,
    headline:
      status === "failed"
        ? "調査を完了できませんでした"
        : status === "partial"
          ? "一部の調査が未完了です"
          : verdict === "can_handle"
            ? "当社で取扱対応できます"
            : verdict === "out_of_scope"
              ? "今回の依頼は対応範囲外です"
              : "担当者確認が必要です",
    items,
    createdAt: new Date(time).toISOString(),
    stale: false,
    mailDraftAvailable: true,
  });
}
export function toPublicResult(r: PublicResult): PublicResult {
  // Construct an allowlist DTO; never spread an internal result.
  const evidence = (e: PublicEvidence) => ({
    id: e.id,
    label: e.label,
    url: e.url?.startsWith("https://") ? e.url : null,
    checkedAt: e.checkedAt,
  });
  const result: PublicResult = {
    kind: "public_result",
    caseId: r.caseId,
    jobId: r.jobId,
    inputRevision: r.inputRevision,
    knowledgeRevision: r.knowledgeRevision,
    status: r.status,
    verdict: r.verdict,
    headline: r.headline,
    items: r.items.map((i) => ({
      itemId: i.itemId,
      label: i.label,
      scopeAssessment: {
        status: i.scopeAssessment.status,
        reason: i.scopeAssessment.reason,
        evidence: i.scopeAssessment.evidence.map(evidence),
      },
      verdict: i.verdict,
      reasonCode: i.reasonCode,
      reason: i.reason,
      conditions: i.conditions,
      missingFields: i.missingFields,
      evidence: i.evidence.map(evidence),
    })),
    createdAt: r.createdAt,
    stale: r.stale,
    mailDraftAvailable: r.mailDraftAvailable,
  };
  if (!validatePublicResult(result)) throw new AppError("INVALID_RESULT", 500);
  return result;
}
