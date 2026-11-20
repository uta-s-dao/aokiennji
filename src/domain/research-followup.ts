import {
  AppError,
  type Field,
  type Item,
  type ResearchBrief,
  type Value,
} from "./model";
import { fields } from "./fields";
import { supplierInquiryGeometry } from "./dialogue";
import {
  dimensionKeys,
  publicSearchConditions,
  requestKind,
  assessPartnerGroup,
  type PartnerCapability,
  type PartnerItemSearch,
  type PartnerMaster,
  type PartnerSearchResult,
} from "./partner-search";

export type ResearchFollowupAnswer = {
  status: "known" | "unknown" | "skipped";
  choice?: string;
  value?: Value;
};
export type ResearchFollowupOffer = {
  id: string;
  itemId: string;
  kind: "equivalent_allowed" | "clarify_field";
  fieldKey: string;
  reason: string;
  question: string;
  options: { value: string; label: string }[];
  /** Internal stale-answer guard; never return this in the public projection. */
  searchFingerprint: string;
};
export type ResearchFollowupAnswerRecord = {
  offerId: string;
  itemId: string;
  fieldKey: string;
  kind: ResearchFollowupOffer["kind"];
  answer: ResearchFollowupAnswer;
  eventId: string;
  searchFingerprint: string;
  restarted: boolean;
};
export type ResearchStaffTask = {
  itemId: string;
  fieldKey: string;
  reason: string;
  customerFieldStatus?: Field["status"];
};
export type ResearchFollowupWebState = {
  status:
    | "completed"
    | "disabled"
    | "blocked"
    | "failed"
    | "incomplete"
    | "not_needed";
  items: {
    itemId: string;
    status: "completed" | "failed" | "incomplete";
    candidates: { confirmed: { field: string }[]; unconfirmed: string[] }[];
  }[];
};
export type ResearchFollowupPlan = {
  offer: ResearchFollowupOffer | null;
  staffTasks: ResearchStaffTask[];
};

const terminalOptions = [
  { value: "unknown", label: "分からない" },
  { value: "skipped", label: "回答をスキップ" },
];
const clarificationKeys = [
  "material",
  "process",
  ...dimensionKeys,
  "hole_count",
  "quantity",
  "required_date",
];
const fieldFor = (item: Item, key: string) =>
  item.fields.find((field) => field.key === key);
const valueFor = (item: Item, key: string) => {
  const field = fieldFor(item, key);
  return field?.status === "known" ? field.value : null;
};
function fingerprint(item: Item): string {
  return JSON.stringify({
    id: item.id,
    label: item.label,
    fields: [...item.fields]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map(({ key, status, value, hardConstraint }) => ({
        key,
        status,
        value,
        hardConstraint,
      })),
    notes: item.notes,
  });
}
function answered(
  history: ResearchFollowupAnswerRecord[],
  item: Item,
  key: string,
) {
  return history.some((entry) => {
    if (entry.itemId !== item.id || entry.fieldKey !== key) return false;
    if (key !== "equivalent_allowed") return true;
    try {
      const original = JSON.parse(entry.searchFingerprint) as {
        fields?: Field[];
      };
      return (
        original.fields?.find(
          (field) => field.key === "model" && field.status === "known",
        )?.value?.text === valueFor(item, "model")?.text
      );
    } catch {
      return true;
    }
  });
}
function newField(
  key: string,
  value: Value | null,
  status: Field["status"],
  eventId: string,
): Field {
  return {
    key,
    label:
      fields[key]?.label ??
      (key === "equivalent_for_model"
        ? "同等品の可否を回答した指定型番"
        : "同等品の可否"),
    status,
    value,
    source: "selection",
    eventId,
    quote:
      (key === "equivalent_allowed" && status === "known"
        ? value?.text === "yes"
          ? "同等品も含めてよい"
          : "指定型番のみ"
        : value?.text) ??
      (status === "unknown" ? "分からない" : "回答をスキップ"),
    hardConstraint:
      status === "known" &&
      !key.startsWith("equivalent_") &&
      key !== "required_date",
  };
}
function putField(item: Item, field: Field) {
  const index = item.fields.findIndex((existing) => existing.key === field.key);
  if (index < 0) item.fields.push(field);
  else item.fields[index] = field;
}
function offer(
  item: Item,
  key: string,
  kind: ResearchFollowupOffer["kind"],
): ResearchFollowupOffer {
  const equivalent = kind === "equivalent_allowed";
  return {
    id: crypto.randomUUID(),
    itemId: item.id,
    kind,
    fieldKey: key,
    reason: equivalent
      ? "指定型番で候補を確認できていないため、同等品を含められるかで探す範囲が変わります。"
      : `${fields[key].label}によって、調査で見つかった候補の適合条件が変わります。`,
    question: equivalent
      ? "指定型番以外でも、他の指定条件を満たす同等品を候補に含めてよいですか？"
      : `${fields[key].label}を教えてください。`,
    options: equivalent
      ? [
          { value: "yes", label: "同等品も含めてよい" },
          { value: "no", label: "指定型番のみ" },
          ...terminalOptions,
        ]
      : [...terminalOptions],
    searchFingerprint: fingerprint(item),
  };
}

/** Only stable UI copy and opaque identifiers cross into customer-facing responses. */
export function toPublicResearchFollowup(value: ResearchFollowupOffer) {
  return {
    id: value.id,
    itemId: value.itemId,
    kind: value.kind,
    fieldKey: value.fieldKey,
    reason: value.reason,
    question: value.question,
    options: value.options.map((option) => ({ ...option })),
  };
}

function exampleValues(group: PartnerCapability, key: string): Value[] {
  const texts =
    key === "material"
      ? group.materials
      : key === "process"
        ? group.processes
        : undefined;
  if (texts?.length) {
    const supported = texts.filter(
      (text) =>
        text.length <= 300 &&
        !/不可|未対応|非対応|要相談|未確認|応相談/.test(text),
    );
    return supported.length
      ? [...supported.slice(0, 3), "別の未対応条件"].map((text) => ({
          text,
          number: null,
          unit: null,
        }))
      : [];
  }
  if (key === "required_date") {
    const date = group.requiredDate?.earliest ?? group.requiredDate?.latest;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
    return [
      { text: date, number: null, unit: null },
      { text: "1900-01-01", number: null, unit: null },
      { text: "9999-12-31", number: null, unit: null },
    ];
  }
  const range =
    key === "quantity"
      ? group.quantity
      : key === "hole_count"
        ? group.holeCount
        : group.dimensions?.[key as (typeof dimensionKeys)[number]];
  if (
    !range ||
    !Number.isFinite(range.min ?? range.max) ||
    (range.min ?? 0) > (range.max ?? Infinity)
  )
    return [];
  const inside = range.min ?? Math.min(1, range.max!);
  const outside =
    range.max !== undefined ? range.max + 1 : Math.max(0, inside - 1);
  return [inside, outside]
    .filter((number) => number >= 0 && Number.isFinite(number))
    .map((number) => ({
      text: `${number}${range.unit}`,
      number,
      unit: range.unit,
    }));
}
function changesCandidateClassification(
  item: Item,
  key: string,
  master: PartnerMaster,
  found: PartnerItemSearch,
) {
  const candidates = new Set(
    [...found.match, ...found.review].map((c) =>
      JSON.stringify([c.partnerId, c.groupId]),
    ),
  );
  const existing = fieldFor(item, key);
  for (const partner of master.partners) {
    for (const group of partner.groups) {
      if (!candidates.has(JSON.stringify([partner.id, group.id]))) continue;
      const statuses = new Set<string>();
      for (const value of exampleValues(group, key)) {
        const probe = newField(key, value, "known", "followup-probe");
        if (existing) probe.hardConstraint = existing.hardConstraint;
        const target = {
          ...item,
          fields: [...item.fields.filter((f) => f.key !== key), probe],
        };
        statuses.add(assessPartnerGroup(target, partner, group).status);
        if (statuses.size > 1) return true;
      }
    }
  }
  return false;
}

export function planResearchFollowup(
  brief: ResearchBrief,
  result: PartnerSearchResult,
  options: {
    master?: PartnerMaster;
    web?: ResearchFollowupWebState;
    history?: ResearchFollowupAnswerRecord[];
  } = {},
): ResearchFollowupPlan {
  const plan: ResearchFollowupPlan = { offer: null, staffTasks: [] };
  const history = options.history ?? [];
  if (options.master?.status === "ready") {
    for (const item of brief.items) {
      for (const key of supplierInquiryGeometry(item)) {
        const status = fieldFor(item, key)?.status ?? "not_asked";
        if (status === "known" || status === "not_applicable") continue;
        plan.staffTasks.push({
          itemId: item.id,
          fieldKey: key,
          customerFieldStatus: status,
          reason: {
            not_asked: "聞き取り前に調査を開始しました。仕入先への照会に使う仕様を確認してください。",
            unknown: "お客様の回答では仕様が未確定です。照会時に必要な仕様として引き継ぎます。",
            skipped: "お客様が回答をスキップしました。仕入先への照会時に必要なら確認してください。",
            conflict: "申告された仕様に食い違いがあります。照会前に確認してください。",
          }[status],
        });
      }
    }
  }
  // Completed, exact per-item coverage is required; another item's zero is never evidence.
  if (
    result.status !== "completed" ||
    !brief.items.length ||
    new Set(brief.items.map((item) => item.id)).size !== brief.items.length ||
    result.items.length !== brief.items.length ||
    new Set(result.items.map((item) => item.itemId)).size !==
      brief.items.length ||
    brief.items.some(
      (item) =>
        !result.items.some(
          (entry) => entry.itemId === item.id && entry.status === "completed",
        ),
    )
  )
    return plan;
  for (const item of brief.items) {
    const found = result.items.find((entry) => entry.itemId === item.id)!;
    for (const candidate of [...found.match, ...found.review]) {
      for (const assessment of candidate.assessments) {
        if (
          assessment.status !== "unconfirmed" ||
          !valueFor(item, assessment.field)
        )
          continue;
        if (
          !plan.staffTasks.some(
            (task) =>
              task.itemId === item.id && task.fieldKey === assessment.field,
          )
        )
          plan.staffTasks.push({
            itemId: item.id,
            fieldKey: assessment.field,
            reason:
              "顧客の指定条件は受領済みです。資料で確認できない対応可否を担当者が確認してください。",
          });
      }
    }
    const webItems = options.web?.items.filter(
      (entry) => entry.itemId === item.id,
    );
    const webItem = webItems?.length === 1 ? webItems[0] : undefined;
    if (webItem)
      for (const candidate of webItem.candidates) {
        if (
          candidate.unconfirmed.length &&
          !plan.staffTasks.some(
            (task) =>
              task.itemId === item.id &&
              task.fieldKey === "supplier_confirmation",
          )
        )
          plan.staffTasks.push({
            itemId: item.id,
            fieldKey: "supplier_confirmation",
            reason:
              "公開ページで確認できない在庫・数量対応・納期などを担当者が確認してください。",
          });
      }
    if (
      plan.offer ||
      item.fields.some((field) => field.status === "conflict") ||
      item.notes.some((note) => note.startsWith("未確認の顧客入力："))
    )
      continue;
    const scopedPermission =
      valueFor(item, "equivalent_for_model")?.text ===
      valueFor(item, "model")?.text;
    const permission = scopedPermission
      ? fieldFor(item, "equivalent_allowed")
      : undefined;
    const webUncertain =
      options.web &&
      !["not_needed", "disabled"].includes(options.web.status) &&
      (options.web.status !== "completed" ||
        !webItem ||
        webItem.status !== "completed");
    const webIdentityFound = webItem?.candidates.some((candidate) =>
      candidate.confirmed.some(
        (evidence) =>
          evidence.field === "model" || evidence.field === "product_name",
      ),
    );
    if (
      !found.match.length &&
      !found.review.length &&
      requestKind(item) === "purchase" &&
      valueFor(item, "model") &&
      publicSearchConditions(item).products.length &&
      (!permission || permission.status === "not_asked") &&
      !answered(history, item, "equivalent_allowed") &&
      !webUncertain &&
      !webIdentityFound
    ) {
      plan.offer = offer(item, "equivalent_allowed", "equivalent_allowed");
      continue;
    }
    if (
      !options.master ||
      options.master.status !== "ready" ||
      options.master.versionId !== result.masterVersionId
    )
      continue;
    for (const key of clarificationKeys) {
      if (
        ["hole_diameter", "hole_count"].includes(key) &&
        !/穴|孔|ドリル/.test(
          [
            item.label,
            valueFor(item, "process")?.text,
            valueFor(item, "work_scope")?.text,
          ].join(" "),
        )
      )
        continue;
      const field = fieldFor(item, key);
      if (
        (field && field.status !== "not_asked") ||
        answered(history, item, key)
      )
        continue;
      if (changesCandidateClassification(item, key, options.master, found)) {
        plan.offer = offer(item, key, "clarify_field");
        break;
      }
    }
  }
  return plan;
}

export function applyResearchFollowup(
  brief: ResearchBrief,
  pending: ResearchFollowupOffer,
  answer: ResearchFollowupAnswer,
  eventId: string,
) {
  const item = brief.items.find((entry) => entry.id === pending.itemId);
  if (!item || fingerprint(item) !== pending.searchFingerprint)
    throw new AppError("STALE_RESEARCH_FOLLOWUP", 409);
  if (
    !eventId ||
    eventId.length > 128 ||
    !["known", "unknown", "skipped"].includes(answer.status)
  )
    throw new AppError("INVALID_RESEARCH_FOLLOWUP");
  if (
    (pending.kind === "equivalent_allowed" &&
      pending.fieldKey !== "equivalent_allowed") ||
    (pending.kind === "clarify_field" &&
      !clarificationKeys.includes(pending.fieldKey))
  )
    throw new AppError("INVALID_RESEARCH_FOLLOWUP");
  if (
    answer.status === "known" &&
    pending.kind === "equivalent_allowed" &&
    !["yes", "no"].includes(answer.choice ?? "")
  )
    throw new AppError("INVALID_RESEARCH_FOLLOWUP");
  if (answer.status === "known" && pending.kind === "clarify_field") {
    const value = answer.value;
    if (
      !value ||
      typeof value.text !== "string" ||
      !value.text.trim() ||
      value.text.length > 300 ||
      (value.number !== null && !Number.isFinite(value.number)) ||
      (value.unit !== null &&
        (typeof value.unit !== "string" || value.unit.length > 30))
    )
      throw new AppError("INVALID_RESEARCH_FOLLOWUP");
    const units = fields[pending.fieldKey].units;
    if (units) {
      if (
        value.number === null ||
        value.number <= 0 ||
        !units.includes(value.unit ?? "") ||
        (pending.fieldKey === "hole_count" && !Number.isInteger(value.number))
      )
        throw new AppError("INVALID_RESEARCH_FOLLOWUP");
      const raw = value.text.normalize("NFKC").trim();
      const number = /[+-]?(?:\d+(?:\.\d*)?|\.\d+)/g;
      const all = [...raw.matchAll(number)];
      const token = all[0];
      const suffix =
        token && raw.slice(token.index + token[0].length).trimStart();
      const unit = fields[pending.fieldKey].units?.find(
        (candidate) =>
          suffix?.startsWith(candidate) &&
          !/^[A-Za-z]/.test(suffix.slice(candidate.length)),
      );
      if (
        all.length !== 1 ||
        Number(token[0]) !== value.number ||
        unit !== value.unit
      )
        throw new AppError("INVALID_RESEARCH_FOLLOWUP");
    }
    if (
      !fields[pending.fieldKey].units &&
      (value.number !== null || value.unit !== null)
    )
      throw new AppError("INVALID_RESEARCH_FOLLOWUP");
    if (
      pending.fieldKey === "required_date" &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(value.text) ||
        !Number.isFinite(Date.parse(value.text)) ||
        new Date(value.text).toISOString().slice(0, 10) !== value.text)
    )
      throw new AppError("INVALID_RESEARCH_FOLLOWUP");
  }
  const copy = structuredClone(brief);
  const target = copy.items.find((entry) => entry.id === item.id)!;
  let value =
    answer.status !== "known"
      ? null
      : pending.kind === "equivalent_allowed"
        ? { text: answer.choice!, number: null, unit: null }
        : { ...answer.value! };
  if (value?.number !== null && value?.number !== undefined && value.unit) {
    // Selection values are canonicalized once so saved text and numeric search conditions agree.
    value = { ...value, text: `${value.number}${value.unit}` };
  }
  const savedField = newField(pending.fieldKey, value, answer.status, eventId);
  const existing = fieldFor(item, pending.fieldKey);
  if (existing && answer.status === "known")
    savedField.hardConstraint = existing.hardConstraint;
  if (pending.kind === "clarify_field" && answer.status === "known") {
    savedField.quote = answer.value!.text;
    savedField.source = "customer_text";
  }
  putField(target, savedField);
  if (pending.kind === "equivalent_allowed") {
    const originalModel = valueFor(item, "model");
    if (!originalModel) throw new AppError("INVALID_RESEARCH_FOLLOWUP");
    putField(
      target,
      newField("equivalent_for_model", { ...originalModel }, "known", eventId),
    );
  }
  if (
    pending.kind === "equivalent_allowed" &&
    answer.status === "known" &&
    answer.choice === "yes"
  ) {
    const original = fieldFor(target, "model");
    if (original) original.hardConstraint = false;
  }
  const restart =
    answer.status === "known" &&
    (pending.kind === "clarify_field"
      ? JSON.stringify(valueFor(item, pending.fieldKey)) !==
        JSON.stringify(valueFor(target, pending.fieldKey))
      : JSON.stringify(publicSearchConditions(item)) !==
        JSON.stringify(publicSearchConditions(target)));
  const record: ResearchFollowupAnswerRecord = {
    offerId: pending.id,
    itemId: item.id,
    fieldKey: pending.fieldKey,
    kind: pending.kind,
    answer: structuredClone(answer),
    eventId,
    searchFingerprint: pending.searchFingerprint,
    restarted: restart,
  };
  return { brief: copy, record, restart };
}
