import { dimensionKeys, dimensionAliases, resolveDimensionAnswer, resolveDimensionDesignation } from "./dimensions";
import type { ExtractionProposal } from "../generated/extraction";
import { validateExtractionProposal } from "../generated/validators.js";
import { capacityCues, capacityNumberPattern, fields, labels, normalized, parseCapacity, flexibleCondition, requiredDateIsHard } from "./fields";
import {
  AppError,
  id,
  type Snapshot,
  type Question,
  type Change,
  type Item,
} from "./model";
import { applyInput, newItem } from "./intake";
import {
  ambiguousCapacity,
  attributeClause,
  drillingOperation,
  ownedDrillingRequest,
  explicitHoleLayout,
  groundedBodyStructure,
  isTentative,
  quoteContext,
  hasUniqueItemContext,
  unsafeToRecover,
} from "./grounding";
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
  hollow: /空洞|中空/,
  solid: /無垢|中実|詰まって/,
};
const cues: Record<string, string[]> = {
  overall_length: ["全長", "長さ"],
  outer_diameter: ["外径"],
  inner_diameter: ["内径"],
  opening_diameter: ["見える穴の径", "見える穴", "穴径", "開口径"],
  hole_diameter: ["穴径", "穴の直径", "穴の径"],
  hole_count: ["穴数", "穴", "か所", "箇所"],
  normal_temperature: ["通常温度", "通常"],
  peak_temperature: ["最高温度", "最高", "ピーク"],
  quantity: ["数量", "個", "枚", "組", "台", "本"],
  capacity: [...capacityCues],
};
const numericQuotePattern = new RegExp(
  String.raw`${capacityNumberPattern}|(-?\d+(?:\.\d+)?)\s*(mm|cm|m(?![lLｌＬℓ])|℃|°C|MPa|kPa|Pa|秒|分|時間|か所|箇所|穴|個|枚|組|台|本|kg)`,
  "gu",
);
const numericQuotes = (text: string) =>
  [...text.matchAll(numericQuotePattern)].map((match) => [
    match[0], match[1] ?? match[3], match[2] ?? match[4],
  ]);
const correction =
  /訂正|ではなく|変更|正しく|最新|じゃなく|ではない|から.{0,30}に/;
const explicitCorrection = (text: string) =>
  correction.test(text) &&
  !/(?:変更|訂正)(?:は)?(?:しない|しません|していません)/.test(text);
function attributeSpecific(quote: string, key: string) {
  const expected = cues[key] ?? [fields[key].label];
  return !Object.entries(fields).some(
    ([other, def]) =>
      other !== key &&
      def.units &&
      (other === "quantity" ? [def.label] : (cues[other] ?? [def.label])).some(
        (label) =>
          !expected.some((own) => own.includes(label)) && quote.includes(label),
      ),
  );
}

function restoreExplicitModels(
  text: string,
  proposal: ExtractionProposal,
  existingLabels: string[],
) {
  if (unsafeToRecover(text)) return;
  const matches = [
    ...text.matchAll(/型番(?:は)?\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9_./-]*)/gu),
  ];
  for (const item of proposal.newItems) {
    if (
      item.profile !== "known_model" ||
      proposal.changes.length >= 120 ||
      !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(item.label) ||
      proposal.changes.some((c) => c.itemRef === item.ref && c.key === "model")
    )
      continue;
    const found = matches.filter((m) => m[1] === item.label);
    if (found.length !== 1) continue;
    const quote = found[0][0];
    const after = text[found[0].index! + quote.length];
    // A non-ASCII suffix/separator may still belong to the model number.
    if (after && !/^[\s、,。！？!?をはがのでにへ]$/u.test(after)) continue;
    if (
      !hasUniqueItemContext(text, quote, item.label, [
        ...existingLabels,
        ...proposal.newItems
          .filter((i) => i.ref !== item.ref)
          .map((i) => i.label),
      ])
    )
      continue;
    proposal.changes.push({
      itemRef: item.ref,
      key: "model",
      status: "known",
      value: { text: item.label, number: null, unit: null },
      quote,
      operation: "set",
      hardConstraint: true,
    });
  }
}

function recoverQuantityQuote(
  text: string,
  c: ExtractionProposal["changes"][number],
  item: Item,
  others: Item[],
) {
  // Only a redundant quantity label may be removed. Do not search for another
  // value, manufacture source text, repair corrections, or change existing items.
  if (
    c.key !== "quantity" ||
    c.status !== "known" ||
    c.operation !== "set" ||
    !c.hardConstraint ||
    !c.value ||
    c.quote !== "数量" + c.value.text
  )
    return null;
  const matches = numericQuotes(text).filter((m) => m[0] === c.value!.text);
  if (matches.length !== 1) return null;
  const quote = matches[0][0];
  if (
    unsafeToRecover(text) ||
    !hasUniqueItemContext(
      text,
      quote,
      item.label,
      others.map((i) => i.label),
    )
  )
    return null;
  return quote;
}
export function applyExtractionProposal(
  s: Snapshot,
  text: string,
  q: Question | null,
  raw: unknown,
  categories: string[] = [],
): Snapshot {
  if (!validateExtractionProposal(raw)) throw bad();
  const proposal = structuredClone(raw) as ExtractionProposal;
  if (!text.trim() || text.length > 2000)
    throw bad();
  for (const quote of [...proposal.ambiguities, ...proposal.unprocessedQuotes])
    if (!text.includes(quote)) throw bad();
  // A dimension without an axis is a valid retained condition, not an extraction failure.
  for (const list of [proposal.ambiguities, proposal.unprocessedQuotes]) {
    for (const quote of [...list]) {
      const token = quote.match(/^(\d+(?:\.\d+)?)\s*(mm|cm|m)$/);
      if (!token || explicitHoleLayout(quoteContext(text, quote), q?.fieldKey === "hole_layout")) continue;
      const candidates = [
        ...s.brief.items.map((i) => ({ ref: i.id, label: i.label })),
        ...proposal.newItems.map((i) => ({ ref: i.ref, label: i.label })),
      ];
      const owners = candidates.filter((i) => candidates.length === 1 || hasUniqueItemContext(text, quote, i.label, candidates.filter((o) => o.ref !== i.ref).map((o) => o.label)));
      if (owners.length !== 1 || proposal.changes.some((c) => c.itemRef === owners[0].ref && c.key === "dimension_unspecified")) continue;
      proposal.changes.push({ itemRef: owners[0].ref, key: "dimension_unspecified", status: "known", value: {text: Number(token[1]) + token[2], number: Number(token[1]), unit: token[2]}, quote, operation: "set", hardConstraint: true });
      list.splice(list.indexOf(quote), 1);
    }
  }
  if (proposal.ambiguities.length) throw bad();
  const resolved = resolveDimensionAnswer(s, text, q);
  if (resolved) return resolved;
  if (proposal.unprocessedQuotes.length) {
    // An incomplete extraction must not silently drop any customer condition.
    throw bad();
  }
  s = resolveDimensionDesignation(s, text, q) ?? s;
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
  restoreExplicitModels(
    text,
    proposal,
    s.brief.items.map((i) => i.label),
  );
  const allItems = [...s.brief.items, ...additions];
  const changes: Change[] = [];
  const tentative: { itemId: string; key: string }[] = [];
  const targets = new Set<string>();
  for (const original of proposal.changes) {
    const c = structuredClone(original);
    // A model cannot turn an unlabelled length into a specific dimension.
    if (dimensionKeys.includes(c.key) && c.value?.unit && ["mm", "cm", "m"].includes(c.value.unit) &&
      !(q?.itemId === refs.get(c.itemRef) && q?.fieldKey === c.key) &&
      !dimensionKeys.some((key) => dimensionAliases(key).some((label) => quoteContext(text, c.quote).includes(label)))) {
      c.key = "dimension_unspecified";
    }
    const itemId = refs.get(c.itemRef),
      def = fields[c.key];
    if (!itemId || !def) throw bad();
    const item = allItems.find((i) => i.id === itemId)!;
    const otherItems = allItems.filter((i) => i.id !== itemId);
    if (!text.includes(c.quote)) {
      const recovered = additions.includes(item)
        ? recoverQuantityQuote(text, c, item, otherItems)
        : null;
      if (!recovered) throw bad();
      c.quote = recovered;
    }
    const context = quoteContext(text, c.quote);
    // Extend only to an actual, unique clause. Do not invent a quote or join separate attributes.
    if (
      def.units &&
      attributeSpecific(context, c.key) &&
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
      !hasUniqueItemContext(
        text,
        c.quote,
        item.label,
        otherItems.map((i) => i.label),
      ) &&
      !(q?.itemId === itemId && q.fieldKey === c.key)
    )
      throw bad();
    if (c.status === "unknown") {
      const preference = context.split(/[、，,]/u).at(-1)?.trim()
        .match(/^(.*?)(?:の)?指定(?:は|が)?ありません[。！!]?$/u);
      const acknowledgesNoPreference =
        !!preference &&
        /指定(?:は|が)?ありません[。！!]?$/u.test(c.quote) &&
        !item.fields.some((field) => field.key === c.key && field.status === "known") &&
        (preference[1].split(/や|と|・|及び|および/u).includes(def.label) ||
          (q?.itemId === itemId && q.fieldKey === c.key && /^(?:特に)?$/u.test(preference[1])));
      const acknowledgesUnknown =
        /分か(?:ら|りません)|わか(?:ら|りません)|不明|未定|指定(?:は|が)?なし|指定(?:は|が)?無|決まっていない|決めていない|後で決め|未確認|非開示|開示.{0,3}(?:できない|できません|しない|しません)|(?:答え|回答)(?:られない|られません|できない|できません)/.test(
          c.quote,
        );
      if (c.value !== null || (!acknowledgesUnknown && !acknowledgesNoPreference))
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
    const direct = q?.itemId === itemId && q.fieldKey === c.key;
    const v = c.value;
    if (!v) throw bad();
    if (c.key === "body_structure" && c.operation !== "hypothetical" &&
        groundedBodyStructure(text, c.quote.replace(/[。！.!]$/, "")) !== v.text)
      throw bad();
    if (c.key === "capacity") {
      const parsed = parseCapacity(v.text);
      const supplied = v.number === null || !v.unit ? null : parseCapacity(`${v.number}${v.unit}`);
      const numbers = numericQuotes(c.quote);
      const evidence = numbers.length === 1 ? parseCapacity(numbers[0][0]) : null;
      if (!parsed || !supplied || parsed.text !== supplied.text || evidence?.text !== parsed.text ||
          !attributeSpecific(c.quote, c.key) ||
          (c.operation !== "hypothetical" && ambiguousCapacity(attributeClause(text, c.quote))) ||
          (!direct && !capacityCues.some((label) => c.quote.includes(label))))
        throw bad();
      Object.assign(v, parsed);
    } else if (def.values) {
      const owned = v.text === "customer_supplied"
        ? ownedDrillingRequest(attributeClause(text, c.quote))
        : null;
      const ownedWorkpiece = !!owned && (
        c.quote.includes(owned.owned) ||
        (/^(?:手持ち|手元|当方所有)/.test(c.quote) && owned.owned.startsWith(c.quote))
      );
      if (v.text === "processing" && c.operation !== "hypothetical" &&
          drillingOperation.test(c.quote) &&
          /(?:あけ|開け|加工).{0,7}(?:ない|ません|不要|なし|無し|せず)/.test(attributeClause(text, c.quote)))
        throw bad();
      if (c.key === "material_supply" && v.text === "customer_supplied" &&
          /塗料|ペンキ/.test(c.quote) && !/材料(?:全体|一式|全部)?(?:を|も).{0,8}支給/.test(c.quote))
        throw bad();
      if (
        v.number !== null ||
        v.unit !== null ||
        !def.values.includes(v.text) ||
        !(
          enumCues[v.text]?.test(c.quote) ||
          (v.text === "processing" && drillingOperation.test(c.quote)) ||
          ownedWorkpiece ||
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
      if (!attributeSpecific(c.quote, c.key)) throw bad();
      if (c.key !== "dimension_unspecified" && !direct && !expected.some((label) => c.quote.includes(label)))
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
    if (c.key === "hole_layout" && c.operation !== "hypothetical" &&
        (!explicitHoleLayout(c.quote, direct) || !explicitHoleLayout(attributeClause(text, c.quote), direct)))
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
          !(
            explicitCorrection(c.quote) ||
            (attributeSpecific(context, c.key) && explicitCorrection(context))
          ) &&
          !(
            c.key === "material_supply" &&
            /(?:材料も|材料を|御社で).{0,12}調達/.test(c.quote)
          ))
      )
        throw bad();
    }
    if (
      !c.hardConstraint &&
      !["purpose", "description", "destination", "required_date"].includes(c.key) &&
      !flexibleCondition.test(c.quote)
    )
      throw bad();
    if (c.key === "required_date" && requiredDateIsHard(context)) c.quote = context;
    changes.push({
      itemId,
      key: c.key,
      status: "known",
      text: v.text,
      number: v.number,
      unit: v.unit,
      quote: c.quote,
      hardConstraint: c.key === "required_date" ? requiredDateIsHard(context) : c.hardConstraint,
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
