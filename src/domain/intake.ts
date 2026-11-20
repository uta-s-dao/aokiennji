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
  type IntakeAxes,
} from "./model";
import { capacityTokens, fields, flexibleCondition, parseCapacity, requiredDateIsHard } from "./fields";
import { nextDialogueQuestion } from "./dialogue";
import { ambiguousCapacity, explicitHoleLayout, groundedBodyStructure } from "./grounding";
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
      questionPolicyVersion: "v1.2-chat-first-1",
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
  for (let c of changes) {
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
      !["purpose", "description", "destination", "required_date"].includes(c.key) &&
      !flexibleCondition.test(c.quote)
    )
      throw new AppError("INVALID_INPUT");
    if (
      status === "conflict" &&
      (!c.conflicts || c.conflicts.length < 2 || c.conflicts.length > 4)
    )
      throw new AppError("INVALID_INPUT");
    if (c.key === "body_structure" && status === "known" &&
        groundedBodyStructure(event.text, c.quote.replace(/[。！.!]$/, "")) !== c.text)
      throw new AppError("INVALID_INPUT");
    if (c.key === "capacity" && status === "known") {
      const parsed = parseCapacity(c.text ?? "");
      const stated = capacityTokens(c.quote);
      const evidence = stated.length === 1 ? parseCapacity(stated[0][0]) : null;
      const supplied = c.number == null && c.unit == null
        ? parsed
        : c.number == null || !c.unit ? null : parseCapacity(`${c.number}${c.unit}`);
      if (!parsed || supplied?.text !== parsed.text || evidence?.text !== parsed.text || ambiguousCapacity(c.quote))
        throw new AppError("INVALID_INPUT");
      c = { ...c, ...parsed };
    }
    if (c.key === "hole_layout" && status === "known" && !explicitHoleLayout(c.quote, true))
      throw new AppError("INVALID_INPUT");
    if (status === "known") {
      if (typeof c.text !== "string" || !c.text || c.text.length > 300)
        throw new AppError("INVALID_INPUT");
      if (def.values && !def.values.includes(c.text))
        throw new AppError("INVALID_INPUT");
      if (
        !def.values && c.key !== "capacity" &&
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
        item.fields.find((f) => f.key === "request_scope")?.value?.text === "purchase"
      )
    )
      throw new AppError("INVALID_INPUT");
    if (["overall_length", "outer_diameter", "inner_diameter", "opening_diameter", "hole_diameter", "width", "height", "depth", "thickness"].includes(c.key) && status === "known" &&
      s.dimensionCandidates?.some((d) => d.itemId === item.id && d.number === c.number && d.unit === c.unit)) {
      item.fields = item.fields.filter((f) => f.key !== "dimension_unspecified");
      item.notes = item.notes.filter((note) => !note.startsWith("寸法種別は未確認："));
      s.dimensionCandidates = s.dimensionCandidates.filter((d) => d.itemId !== item.id);
    }
    if (c.key === "dimension_unspecified" && ["unknown", "skipped"].includes(status)) {
      const candidate = s.dimensionCandidates?.find((d) => d.itemId === item.id);
      if (candidate) {
        item.notes = item.notes.filter((note) => !note.startsWith("寸法種別は未確認："));
        item.notes.push(`寸法種別は未確認：${candidate.text}（申告原文：${candidate.quote}。種別の回答：${c.quote}）`);
      }
    }
    if (c.key === "dimension_unspecified" && status === "known") {
      item.notes = item.notes.filter((note) => !note.startsWith("寸法種別は未確認："));
      s.dimensionCandidates = (s.dimensionCandidates ?? []).filter((d) => d.itemId !== item.id);
      s.dimensionCandidates.push({ itemId: item.id, eventId: event.id, quote: c.quote, text: c.text!, number: c.number!, unit: c.unit! });
    }
    if (c.key === "product_name" && status === "known") item.label = c.text!.slice(0, 100);
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
      hardConstraint: c.hardConstraint ??
        (status === "known" && (c.key === "required_date"
          ? requiredDateIsHard(c.quote)
          : !["purpose", "description", "destination"].includes(c.key))),
      ...(status === "conflict" ? { conflicts: c.conflicts } : {}),
    });
  }
  for (const item of s.brief.items) {
    const body = item.fields.find((field) => field.key === "body_structure");
    const inner = item.fields.find((field) => field.key === "inner_diameter");
    if (body?.value?.text === "solid") {
      if (inner?.value || inner?.status === "conflict")
        throw new AppError("INVALID_INPUT");
      if (inner?.status !== "not_applicable") {
        item.fields = item.fields.filter((field) => field.key !== "inner_diameter");
        item.fields.push({
          ...body,
          key: "inner_diameter",
          label: fields.inner_diameter.label,
          status: "not_applicable",
          value: null,
          hardConstraint: false,
        });
      }
    } else if (body?.value?.text === "hollow" && inner?.status === "not_applicable") {
      item.fields = item.fields.filter((field) => field.key !== "inner_diameter");
    }
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
  const pending = s.pendingChanges ?? [];
  s.pendingChanges = pending.filter(
    (p) => !changes.some((c) => c.itemId === p.itemId && c.key === p.key),
  );
  const resolved = pending
    .filter((p) => !s.pendingChanges!.some((v) => v.eventId === p.eventId))
    .map((p) => p.eventId);
  s.unresolvedInputs = (s.unresolvedInputs ?? []).filter(
    (e) => !resolved.includes(e.id),
  );
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
export function chooseNextQuestion(
  s: Snapshot,
  rules: CapabilityRule[],
  force = false,
  axes?: IntakeAxes,
  partnerIntake = false,
): Question | null {
  return nextDialogueQuestion(s, rules, force, axes, partnerIntake);
}
export function makeResearchBrief(
  s: Snapshot,
  revision: number,
  knowledgeRevision: number,
): ResearchBrief {
  if (!hasClue(s) || s.overflow.length)
    throw new AppError(s.overflow.length ? "SPLIT_REQUIRED" : "INVALID_INPUT");
  const b = { ...structuredClone(s.brief), revision, knowledgeRevision };
  for (const item of b.items) {
    item.notes = item.notes.filter((n) => !n.startsWith("未確認の顧客入力："));
    if (s.unresolvedInputs?.length)
      item.notes.push(
        "未確認の顧客入力：" +
          s.unresolvedInputs
            .map((e) => e.text)
            .join(" / ")
            .slice(0, 450),
      );
  }
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
