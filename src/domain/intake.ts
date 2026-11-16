import {
  AppError,
  id,
  type Snapshot,
  type Item,
  type Change,
  type InputEvent,
  type Question,
  type CapabilityRule,
  type ResearchBrief,
} from "./model";
import { fields } from "./fields";
import {
  validateResearchBrief,
  validateField,
  validateItem,
} from "../generated/validators.js";
export function makeSnapshot(caseId: string): Snapshot {
  return {
    brief: {
      kind: "research_brief",
      schemaVersion: 2,
      caseId,
      revision: 1,
      items: [],
      attachmentRefs: [],
      questionsAsked: 0,
      knowledgeRevision: 0,
      questionPolicyVersion: "v1.1-local-1",
    },
    inputs: [],
    overflow: [],
    fallbackCount: 0,
    attachmentNames: [],
  };
}
export function applyInput(
  input: Snapshot,
  event: InputEvent,
  changes: Change[],
  additions: Item[] = [],
): Snapshot {
  const s = structuredClone(input);
  if (!event.text.trim() || event.text.length > 2000)
    throw new AppError("INVALID_INPUT");
  if (new Set(additions.map((i) => i.id)).size !== additions.length)
    throw new AppError("INVALID_INPUT");
  for (const i of additions) {
    if (!validateItem(i)) throw new AppError("INVALID_INPUT");
    if (s.brief.items.some((x) => x.id === i.id))
      throw new AppError("INVALID_INPUT");
    s.brief.items.push(i);
  }
  if (s.brief.items.length > 3) throw new AppError("SPLIT_REQUIRED");
  for (const c of changes) {
    const item = s.brief.items.find((i) => i.id === c.itemId);
    const def = fields[c.key];
    if (
      !item ||
      !def ||
      typeof c.quote !== "string" ||
      !c.quote ||
      !event.text.includes(c.quote)
    )
      throw new AppError("INVALID_INPUT");
    const status = c.status ?? "known";
    if (
      c.hardConstraint === false &&
      status === "known" &&
      !["purpose", "description", "destination"].includes(c.key) &&
      !/任意|変更可/.test(c.quote)
    )
      throw new AppError("INVALID_INPUT");
    if (
      status === "conflict" &&
      (!c.conflicts || c.conflicts.length < 2 || c.conflicts.length > 4)
    )
      throw new AppError("INVALID_INPUT");
    if (status === "known") {
      if (typeof c.text !== "string" || !c.text || c.text.length > 300)
        throw new AppError("INVALID_INPUT");
      if (def.values && !def.values.includes(c.text))
        throw new AppError("INVALID_INPUT");
      if (
        !def.values &&
        !c.quote.includes(c.text) &&
        !(c.number != null && c.quote.includes(String(c.number)))
      )
        throw new AppError("INVALID_INPUT");
      if (c.unit && !def.units?.includes(c.unit))
        throw new AppError("INVALID_INPUT");
      if (
        def.units &&
        (c.number == null || !Number.isFinite(c.number) || !c.unit)
      )
        throw new AppError("INVALID_INPUT");
      if (
        c.key === "material_supply" &&
        item.fields.find((f) => f.key === "request_scope")?.value?.text ===
          "purchase"
      )
        throw new AppError("INVALID_INPUT");
    }
    if (
      status === "not_applicable" &&
      !(
        c.key === "material_supply" &&
        item.fields.find((f) => f.key === "request_scope")?.value?.text ===
          "purchase"
      )
    )
      throw new AppError("INVALID_INPUT");
    item.fields = item.fields.filter((f) => f.key !== c.key);
    item.fields.push({
      key: c.key,
      label: def.label,
      status,
      value:
        status === "known"
          ? { text: c.text!, number: c.number ?? null, unit: c.unit ?? null }
          : null,
      source: event.type,
      eventId: event.id,
      quote: c.quote,
      hardConstraint:
        c.hardConstraint ??
        (status === "known" &&
          !["purpose", "description", "destination"].includes(c.key)),
      ...(status === "conflict" ? { conflicts: c.conflicts } : {}),
    });
  }
  for (const item of s.brief.items) {
    const scope = item.fields.find((f) => f.key === "request_scope");
    const supply = item.fields.find((f) => f.key === "material_supply");
    if (
      scope?.value?.text === "purchase" &&
      supply?.status !== "not_applicable"
    ) {
      item.fields = item.fields.filter((f) => f.key !== "material_supply");
      item.fields.push({
        key: "material_supply",
        label: fields.material_supply.label,
        status: "not_applicable",
        value: null,
        source: event.type,
        eventId: event.id,
        quote: scope.quote,
        hardConstraint: false,
      });
    } else if (
      scope?.value &&
      scope.value.text !== "purchase" &&
      supply?.status === "not_applicable"
    ) {
      item.fields = item.fields.filter((f) => f.key !== "material_supply");
    }
  }
  for (const item of s.brief.items)
    for (const field of item.fields)
      if (!validateField(field)) throw new AppError("INVALID_INPUT");
  s.inputs.push(event);
  if (s.inputs.length > 100) throw new AppError("RATE_LIMITED", 429);
  return s;
}
export function hasClue(s: Snapshot) {
  return (
    s.brief.items.some((i) =>
      i.fields.some(
        (f) =>
          ["model", "product_name", "description", "purpose"].includes(f.key) &&
          f.status === "known",
      ),
    ) || s.brief.attachmentRefs.length > 0
  );
}
const prompts: Record<string, string> = {
  manufacturer: "メーカー名は分かりますか？",
  model: "型番は分かりますか？",
  purpose: "何に使うものですか？",
  description: "どのようなものをお探しですか？",
  request_scope: "商品・材料の購入、加工、製作のどれをご希望ですか？",
  material_supply: "材料はお客様からの支給ですか？",
  work_scope: "どの部位・作業をご依頼ですか？",
};
export function chooseNextQuestion(
  s: Snapshot,
  rules: CapabilityRule[],
  force = false,
): Question | null {
  if (!hasClue(s))
    return {
      id: "initial",
      itemId: null,
      fieldKey: "description",
      text: "名称・用途・写真のいずれかを教えてください。",
      inputType: "text",
      options: [],
      allowUnknown: true,
      allowSkip: true,
    };
  if (force || s.brief.questionsAsked >= 6 || s.overflow.length) return null;
  for (const item of s.brief.items) {
    const applicable = rules.filter(
      (r) =>
        r.approvalStatus === "approved" &&
        r.validUntil &&
        Date.parse(r.validUntil) > Date.now() &&
        r.category === item.category,
    );
    const supply = item.fields.find((f) => f.key === "request_scope")?.value
      ?.text;
    const keys = [
      ...new Set([
        ...item.fields.filter((f) => f.status === "conflict").map((f) => f.key),
        ...(applicable.some((r) =>
          r.predicates.some((p) => p.field === "request_scope"),
        )
          ? ["request_scope"]
          : []),
        ...(["processing", "fabrication"].includes(supply ?? "") &&
        applicable.some((r) =>
          r.predicates.some((p) => p.field === "material_supply"),
        )
          ? ["material_supply"]
          : []),
        ...applicable.flatMap((r) => r.requiredFields),
        ...(s.fallbackCount < 2
          ? item.profile === "known_model"
            ? item.fields.some((f) => f.key === "model" && f.status === "known")
              ? []
              : ["model"]
            : item.profile === "fabrication"
              ? ["work_scope", "purpose"]
              : ["purpose", "mounting"]
          : []),
      ]),
    ];
    for (const key of keys) {
      const f = item.fields.find((f) => f.key === key);
      if (f && f.status !== "not_asked" && f.status !== "conflict") continue;
      if (
        f?.status === "conflict" &&
        s.inputs.some((e) => e.id.startsWith("question-" + item.id + "-" + key))
      )
        continue;
      if (!fields[key]) continue;
      const opts = fields[key].values ?? [];
      const names: Record<string, string> = {
        purchase: "商品・材料の購入",
        processing: "加工",
        fabrication: "製作",
        customer_supplied: "客先支給",
        company_sourced: "当社調達",
        mixed: "一部支給",
      };
      return {
        id: `${item.id}:${key}`,
        itemId: item.id,
        fieldKey: key,
        text: prompts[key] ?? `${fields[key].label}は分かりますか？`,
        inputType: opts.length
          ? "select"
          : fields[key].units
            ? "number"
            : "text",
        options: opts.map((v) => ({ id: v, label: names[v] ?? v })),
        allowUnknown: true,
        allowSkip: true,
      };
    }
  }
  return null;
}
export function makeResearchBrief(
  s: Snapshot,
  revision: number,
  knowledgeRevision: number,
): ResearchBrief {
  if (!hasClue(s) || s.overflow.length)
    throw new AppError(s.overflow.length ? "SPLIT_REQUIRED" : "INVALID_INPUT");
  const b = { ...structuredClone(s.brief), revision, knowledgeRevision };
  if (!validateResearchBrief(b)) throw new AppError("INVALID_INPUT");
  if (new Set(b.items.map((i) => i.id)).size !== b.items.length)
    throw new AppError("INVALID_INPUT");
  for (const i of b.items)
    if (new Set(i.fields.map((f) => f.key)).size !== i.fields.length)
      throw new AppError("INVALID_INPUT");
  for (const a of b.attachmentRefs)
    if (a.itemId && !b.items.some((i) => i.id === a.itemId))
      throw new AppError("INVALID_INPUT");
  return b;
}
export function newItem(
  label: string,
  profile: Item["profile"] = "unknown",
  category: string | null = null,
): Item {
  return {
    id: id(),
    label: label.slice(0, 100),
    profile,
    category,
    fields: [],
    notes: [],
  };
}
