import type { ExtractionProposal } from "../generated/extraction";
import { validateExtractionProposal } from "../generated/validators.js";
import { fields, labels, normalized } from "./fields";
import {
  AppError,
  id,
  type Snapshot,
  type Question,
  type Change,
  type Item,
} from "./model";
import { applyInput, newItem } from "./intake";
import { isTentative, quoteContext } from "./grounding";
export type { ExtractionProposal } from "../generated/extraction";
const bad = () => new AppError("INVALID_EXTRACTION");
const enumCues: Record<string, RegExp> = {
  purchase: /購入|買[いうい]|探して|手配|purchase/,
  processing: /加工|穴.{0,3}開|processing/,
  fabrication: /製作|作[りるっ]|fabrication/,
  customer_supplied: /客先支給|材料.{0,8}支給|支給材|customer_supplied/,
  company_sourced:
    /当社調達|御社.{0,5}調達|材料.{0,5}調達|材料も|company_sourced/,
  mixed: /一部支給|mixed/,
};
const cues: Record<string, string[]> = {
  outer_diameter: ["外径"],
  inner_diameter: ["内径"],
  opening_diameter: ["見える穴", "穴径", "開口径"],
  normal_temperature: ["通常温度", "通常"],
  peak_temperature: ["最高温度", "最高", "ピーク"],
  quantity: ["数量", "個", "枚", "組", "台", "本"],
};
const numericQuotes = (text: string) => [
  ...text.matchAll(
    /(-?\d+(?:\.\d+)?)\s*(mm|cm|m|℃|°C|MPa|kPa|Pa|秒|分|時間|個|枚|組|台|本|kg)/g,
  ),
];
const correction =
  /訂正|ではなく|変更|正しく|最新|じゃなく|ではない|から.{0,30}に/;
const explicitCorrection = (text: string) =>
  correction.test(text) &&
  !/(?:変更|訂正)(?:は)?(?:しない|しません|していません)/.test(text);
export function applyExtractionProposal(
  s: Snapshot,
  text: string,
  q: Question | null,
  raw: unknown,
  categories: string[] = [],
): Snapshot {
  if (!validateExtractionProposal(raw)) throw bad();
  const proposal = raw as ExtractionProposal;
  if (!text.trim() || text.length > 2000 || proposal.ambiguities.length)
    throw bad();
  for (const quote of [...proposal.ambiguities, ...proposal.unprocessedQuotes])
    if (!text.includes(quote)) throw bad();
  if (proposal.unprocessedQuotes.length) {
    // An incomplete extraction must not silently drop any customer condition.
    throw bad();
  }
  const refs = new Map(s.brief.items.map((i) => [i.id, i.id]));
  const additions: Item[] = [];
  for (const item of proposal.newItems) {
    if (
      refs.has(item.ref) ||
      !text.includes(item.quote) ||
      !item.quote.includes(item.label) ||
      (item.category !== null && !categories.includes(item.category))
    )
      throw bad();
    const next = newItem(item.label, item.profile, item.category);
    refs.set(item.ref, next.id);
    additions.push(next);
  }
  if (s.brief.items.length + additions.length > 3) throw bad();
  const changes: Change[] = [];
  const tentative: { itemId: string; key: string }[] = [];
  const targets = new Set<string>();
  for (const original of proposal.changes) {
    const c = structuredClone(original);
    const itemId = refs.get(c.itemRef),
      def = fields[c.key];
    if (!itemId || !def || !text.includes(c.quote)) throw bad();
    const context = quoteContext(text, c.quote);
    // Extend only to an actual, unique clause. Do not invent a quote or join separate attributes.
    if (
      def.units &&
      numericQuotes(context).length === 1 &&
      (numericQuotes(c.quote).length === 0 ||
        (c.operation === "correct" &&
          !correction.test(c.quote) &&
          correction.test(context)))
    )
      c.quote = context;
    const token = itemId + ":" + c.key;
    if (targets.has(token)) throw bad();
    targets.add(token);
    const item =
      s.brief.items.find((i) => i.id === itemId) ??
      additions.find((i) => i.id === itemId)!;
    const addition = proposal.newItems.find((i) => refs.get(i.ref) === itemId);
    if (
      [...s.brief.items, ...additions].some(
        (other) =>
          other.id !== itemId &&
          other.label !== item.label &&
          c.quote.includes(other.label),
      )
    )
      throw bad();
    // For multiple items, ownership must be visible in the latest utterance or in its item-specific question.
    if (
      s.brief.items.length + additions.length > 1 &&
      !c.quote.includes(item.label) &&
      !(
        addition?.quote.includes(c.quote) &&
        !proposal.newItems.some(
          (other) =>
            other.ref !== c.itemRef && addition.quote.includes(other.label),
        )
      ) &&
      !(q?.itemId === itemId && q.fieldKey === c.key)
    )
      throw bad();
    if (c.status === "unknown") {
      if (
        c.value !== null ||
        !/分か(?:ら|りません)|わか(?:ら|りません)|不明|未確認|非開示|開示.{0,3}(?:できない|できません|しない|しません)|(?:答え|回答)(?:られない|られません|できない|できません)/.test(
          c.quote,
        )
      )
        throw bad();
      if (c.operation === "hypothetical") {
        tentative.push({ itemId, key: c.key });
        continue;
      }
      changes.push({
        itemId,
        key: c.key,
        status: "unknown",
        quote: c.quote,
        hardConstraint: false,
      });
      continue;
    }
    const v = c.value;
    if (!v) throw bad();
    if (def.values) {
      if (
        v.number !== null ||
        v.unit !== null ||
        !def.values.includes(v.text) ||
        !(
          enumCues[v.text]?.test(c.quote) ||
          c.quote.includes(labels[v.text] ?? v.text)
        )
      )
        throw bad();
    } else if (def.units) {
      if (
        v.number === null ||
        !v.unit ||
        !def.units.includes(v.unit) ||
        v.text !== `${v.number}${v.unit}`
      )
        throw bad();
      const expected = cues[c.key] ?? [def.label];
      const direct = q?.itemId === itemId && q.fieldKey === c.key;
      if (!direct && !expected.some((label) => c.quote.includes(label)))
        throw bad();
      const numbers = numericQuotes(c.quote);
      const exact = numbers.some(
        (m) => Number(m[1]) === v.number && m[2] === v.unit,
      );
      // Use a short attribute-specific quote instead of accepting a swap among several numbers in one sentence.
      if (!exact || numbers.length !== 1) throw bad();
      if (!Number.isFinite(normalized(v.number, v.unit).value)) throw bad();
    } else if (
      v.number !== null ||
      v.unit !== null ||
      !c.quote.includes(v.text)
    )
      throw bad();
    if (
      ["model", "material", "manufacturer"].includes(c.key) &&
      /^[A-Za-z0-9_./-]+$/.test(v.text)
    ) {
      const position = c.quote.indexOf(v.text);
      const before = c.quote[position - 1] ?? "",
        after = c.quote[position + v.text.length] ?? "";
      if (/[A-Za-z0-9_./-]/.test(before) || /[A-Za-z0-9_./-]/.test(after))
        throw bad();
    }
    const previous = item.fields.find((f) => f.key === c.key);
    if (
      c.operation === "hypothetical" ||
      (isTentative(context) &&
        (previous?.value || /仮に|ならどう|候補として|としたら/.test(context)))
    ) {
      tentative.push({ itemId, key: c.key });
      continue;
    }
    if (
      previous?.value &&
      JSON.stringify(previous.value) !== JSON.stringify(v)
    ) {
      if (
        c.operation !== "correct" ||
        (!(q?.itemId === itemId && q.fieldKey === c.key) &&
          !explicitCorrection(context) &&
          !(
            c.key === "material_supply" &&
            /(?:材料も|材料を|御社で).{0,12}調達/.test(c.quote)
          ))
      )
        throw bad();
    }
    if (
      !c.hardConstraint &&
      !["purpose", "description", "destination"].includes(c.key) &&
      !/任意|変更可/.test(c.quote)
    )
      throw bad();
    changes.push({
      itemId,
      key: c.key,
      status: "known",
      text: v.text,
      number: v.number,
      unit: v.unit,
      quote: c.quote,
      hardConstraint: c.hardConstraint,
    });
  }
  // A validated label is a customer-grounded identity; it cannot supply specifications or a business verdict.
  for (const addition of additions)
    if (
      !changes.some(
        (c) =>
          c.itemId === addition.id &&
          ["model", "product_name", "description", "purpose"].includes(c.key) &&
          c.status === "known",
      )
    ) {
      const grounded = proposal.newItems.find(
        (i) => refs.get(i.ref) === addition.id,
      )!;
      const identityKey = ["description", "product_name"].find(
        (key) =>
          !changes.some((c) => c.itemId === addition.id && c.key === key),
      );
      if (!identityKey) throw bad();
      changes.push({
        itemId: addition.id,
        key: identityKey,
        text: addition.label,
        quote: grounded.quote,
        hardConstraint: false,
      });
    }
  changes.sort(
    (a, b) =>
      (a.key === "request_scope" ? 0 : a.key === "material_supply" ? 2 : 1) -
      (b.key === "request_scope" ? 0 : b.key === "material_supply" ? 2 : 1),
  );
  const event = { id: id(), text, type: "customer_text" as const };
  const result = applyInput(s, event, changes, additions);
  result.extractionFailed = false;
  result.unresolvedInputs = (result.unresolvedInputs ?? []).filter(
    (e) => e.text !== text,
  );
  result.pendingChanges = (result.pendingChanges ?? []).filter((p) =>
    result.unresolvedInputs!.some((e) => e.id === p.eventId),
  );
  if (tentative.length) {
    result.unresolvedInputs.push(event);
    result.pendingChanges = [
      ...(result.pendingChanges ?? []),
      ...tentative.map((p) => ({ ...p, eventId: event.id })),
    ];
    result.recoveryOffered = false;
  }
  return result;
}
