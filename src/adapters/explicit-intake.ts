import { dimensionAliases, dimensionKeys } from "../domain/dimensions";
import {
  capacityCues,
  fields,
  normalized,
  parseCapacity,
} from "../domain/fields";
import {
  explicitBodyStructure,
  explicitHoleLayout,
  hollowBore,
  ownedDrillingRequest,
  unsafeToRecover,
} from "../domain/grounding";
import { applyInput, newItem } from "../domain/intake";
import {
  AppError,
  id,
  type Change,
  type Question,
  type Snapshot,
} from "../domain/model";

import { recoverPurchaseIdentification } from "./purchase-identification";

type Condition = Omit<Change, "itemId">;

const noun = "[\\p{Script=Han}\\p{Script=Katakana}A-Za-z0-9ー-]{1,40}";
const singleNoun = (text: string) =>
  !/及び|並び|及|別途|各種|複数|また|および/.test(text);
const recognizableMaterial =
  /^(?:(?:耐熱|石英|ホウケイ酸|強化)?ガラス|アルミ(?:ニウム)?(?:合金)?|ステンレス(?:鋼)?|鉄|鋳鉄|炭素鋼|鋼|銅|真鍮|黄銅|チタン(?:合金)?|樹脂|アクリル(?:樹脂)?|ポリカーボネート|ナイロン|ポリエチレン|ポリプロピレン|セラミック(?:ス)?|ゴム|シリコン(?:ゴム)?|SUS[0-9]{3}[A-Z]*|S[0-9]{2}C|SPCC|SS400|A[0-9]{4}|ABS|PVC|PTFE|PEEK|POM)$/i;
const fabricationRequest = new RegExp(
  `^(材質(?:は|[:：])\\s*)?(${noun})(?:で|の)\\s*((?:(?:${noun})(?:状|型|形)の)?(${noun}))を\\s*(?:製作(?:したい|してほしい)(?:です)?|(?:製作|作成)(?:を)?お願いします|作りたい(?:です)?|作ってください|製作してください)$`,
  "u",
);
const purchaseRequest = new RegExp(
  `^(${noun})を\\s*(?:購入したい(?:です)?|購入をお願いします)$`,
  "u",
);
const explicitMaterial = new RegExp(`^材質(?:は|[:：])?\\s*(${noun})$`, "u");
const dateValue = String.raw`((?:今月|来月|再来月)(?:末|上旬|中旬|下旬)|(?:20[0-9]{2}年|今年|来年)?(?:1[0-2]|[1-9])月(?:末|上旬|中旬|下旬|(?:3[01]|[12][0-9]|[1-9])日))`;
const explicitDate = new RegExp(
  String.raw`^(?:希望納期|希望日|納期)(?:は|[:：])?\s*${dateValue}$`,
);
const dateRequest = new RegExp(
  String.raw`^(?:(?:希望納期|希望日|納期)(?:は|[:：])?\s*)?${dateValue}までに(?:お願いします|必要です)$`,
);

const capacityLabel = new RegExp(
  `^(?:${capacityCues.join("|")})(?:は|[:：])?\\s*`,
);
const numericKeys = [...dimensionKeys, "hole_count", "quantity"];
const numericPatterns = numericKeys.map((key) => {
  const labels =
    key === "quantity"
      ? ["数量", "個数"]
      : key === "hole_count"
        ? ["穴数", "穴の数", "穴は"]
        : dimensionAliases(key);
  return {
    key,
    labelled: new RegExp(`^(?:${labels.join("|")})(?:は|[:：])?\\s*`),
    value: new RegExp(
      `^([0-9]+(?:\\.[0-9]+)?)\\s*(${fields[key].units!.join("|")})$`,
    ),
  };
});

function parseCondition(
  quote: string,
  questionKey: string | undefined,
  hasFollowingClause: boolean,
  allowBareQuantity: boolean,
): Condition | null {
  const clause = quote
    .replace(
      hasFollowingClause ? /(?:となります|です|で)$/ : /(?:となります|です)$/,
      "",
    )
    .trimEnd();
  const material = clause.match(explicitMaterial)?.[1];
  if (material && singleNoun(material))
    return { key: "material", text: material, quote };
  const requiredDate = (clause.match(explicitDate) ??
    quote.match(dateRequest))?.[1];
  if (requiredDate) return { key: "required_date", text: requiredDate, quote };
  const layout = explicitHoleLayout(clause, questionKey === "hole_layout");
  if (layout) return { key: "hole_layout", text: layout, quote };
  const capacityPrefix = clause.match(capacityLabel)?.[0];
  if (capacityPrefix || questionKey === "capacity") {
    const capacity = parseCapacity(clause.slice(capacityPrefix?.length ?? 0));
    if (capacity) return { key: "capacity", ...capacity, quote };
  }
  const body = explicitBodyStructure(quote);
  if (body) return { key: "body_structure", text: body, quote };

  for (const { key, labelled, value } of numericPatterns) {
    const prefix = clause.match(labelled)?.[0];
    const bareQuantity =
      allowBareQuantity && key === "quantity" && /[個枚組台本]$/.test(clause);
    if (!prefix && questionKey !== key && !bareQuantity) continue;
    const match = clause.slice(prefix?.length ?? 0).match(value);
    if (!match) continue;
    const number = Number(match[1]);
    const unit = match[2];
    if (number <= 0 || !Number.isFinite(normalized(number, unit).value))
      return null;
    return { key, text: `${number}${unit}`, number, unit, quote };
  }
  return null;
}

/** Recover a fully understood single-item turn using exact excerpts of the input. */
export function recoverExplicitTurn(
  s: Snapshot,
  text: string,
  q: Question | null,
  eventId?: string,
): Snapshot | null {
  const identification = recoverPurchaseIdentification(s, text, q, eventId);
  if (identification) return identification;
  if (
    text.length > 2000 ||
    s.overflow.length ||
    s.brief.items.length > 1 ||
    (eventId !== undefined && s.inputs.some((event) => event.id === eventId))
  )
    return null;
  const clauses = text
    .trim()
    .replace(/^[「『]|[」』]$/g, "")
    .split(/[。、，,\n]/)
    .map((clause) => clause.trim())
    .filter(Boolean);
  if (
    !clauses.length ||
    unsafeToRecover(
      clauses
        .map((clause) => {
          // A recognized requested date is a deadline expression, not a numeric range.
          if (explicitHoleLayout(clause, q?.fieldKey === "hole_layout"))
            return clause.replace(
              /(?:端|隅|中心)から(?=\s*[0-9０-９])/g,
              (position) => position.slice(0, -2),
            );
          return clause.match(dateRequest)?.[1] ?? clause;
        })
        .join("、"),
    )
  )
    return null;

  const existing = s.brief.items[0];
  const conditions: Condition[] = [];
  let addition: ReturnType<typeof newItem> | undefined;
  let purchaseOpening = false;
  if (!existing) {
    const request = clauses.shift()!;
    const purchasedName = request.match(purchaseRequest)?.[1];
    const drilling = ownedDrillingRequest(request);
    if (
      purchasedName &&
      singleNoun(purchasedName) &&
      !/(?:用|向け|用途|候補)$/.test(purchasedName)
    ) {
      purchaseOpening = true;
      addition = newItem(purchasedName);
      conditions.push(
        { key: "product_name", text: purchasedName, quote: request },
        { key: "request_scope", text: "purchase", quote: request },
      );
    } else if (drilling) {
      addition = newItem(drilling.item);
      conditions.push(
        { key: "product_name", text: drilling.item, quote: drilling.owned },
        { key: "request_scope", text: "processing", quote: request },
        { key: "process", text: drilling.operation, quote: request },
        { key: "material_supply", text: "customer_supplied", quote: request },
      );
    } else {
      const match = request.match(fabricationRequest);
      if (!match) return null;
      const [, materialLabel, material, workScope, productName] = match;
      if (!materialLabel && !recognizableMaterial.test(material)) return null;
      if (![material, workScope, productName].every(singleNoun)) return null;
      addition = newItem(productName, "fabrication");
      conditions.push(
        { key: "product_name", text: productName, quote: request },
        { key: "work_scope", text: workScope, quote: request },
        { key: "material", text: material, quote: request },
        { key: "request_scope", text: "fabrication", quote: request },
      );
    }
  }
  const target = existing ?? addition!;
  if (q?.itemId && q.itemId !== target.id) return null;

  for (const [position, clause] of clauses.entries()) {
    const hasFollowingClause = position < clauses.length - 1;
    const bore = clause.match(hollowBore)?.[1];
    if (bore) {
      if (purchaseOpening) return null;
      if (clause.endsWith("で") && !hasFollowingClause) return null;
      const inner = parseCondition(bore, undefined, false, false);
      if (!inner) return null;
      conditions.push(inner);
    }
    const condition = parseCondition(
      clause,
      q?.fieldKey ?? undefined,
      hasFollowingClause,
      Boolean(addition),
    );
    if (!condition) return null;
    if (
      purchaseOpening &&
      condition.key !== "required_date" &&
      (condition.key !== "quantity" || condition.unit === "m")
    )
      return null;
    conditions.push(condition);
  }

  const keys = new Set<string>();
  for (const condition of conditions) {
    const { key, text: value, number, unit } = condition;
    if (
      keys.has(key) ||
      s.pendingChanges?.some((p) => p.itemId === target.id && p.key === key)
    )
      return null;
    keys.add(key);
    const previous = target.fields.find((field) => field.key === key);
    if (
      previous?.status === "conflict" ||
      (previous?.status === "not_applicable" &&
        condition.status !== "not_applicable") ||
      (previous?.value &&
        ((number === undefined && previous.value.text !== value) ||
          previous.value.number !== (number ?? null) ||
          previous.value.unit !== (unit ?? null)))
    )
      return null;
  }
  if (!conditions.length) return null;
  try {
    const recovered = applyInput(
      s,
      { id: eventId ?? id(), text, type: "customer_text" },
      conditions.map((condition) => ({ ...condition, itemId: target.id })),
      addition ? [addition] : [],
    );
    recovered.extractionFailed = false;
    recovered.extractionError = undefined;
    return recovered;
  } catch (error) {
    if (error instanceof AppError) return null;
    throw error;
  }
}

/** A successful one-item proposal can omit a plainly labelled value from the same message. */
export function completeExplicitFields(
  before: Snapshot,
  after: Snapshot,
  text: string,
  q: Question | null,
): Snapshot {
  const item = after.brief.items[0];
  const event = after.inputs.at(-1);
  if (event?.text === text) {
    const identification = recoverPurchaseIdentification(
      before,
      text,
      q,
      event.id,
    );
    if (identification) return identification;
  }
  if (
    after.brief.items.length !== 1 ||
    after.unresolvedInputs?.length ||
    !event ||
    event.text !== text ||
    (before.brief.items.length === 1 && before.brief.items[0].id !== item.id)
  )
    return after;
  const explicit = recoverExplicitTurn(before, text, q);
  if (!explicit) return after;
  const inferred = explicit.brief.items[0];
  // The purchase opening parser is for recovery. A valid model turn keeps its
  // existing dialogue progression, including questions for missing conditions.
  if (
    !before.brief.items.length &&
    inferred.fields.some(
      (field) =>
        field.key === "request_scope" && field.value?.text === "purchase",
    )
  )
    return after;
  const changes: Change[] = [];
  for (const field of inferred.fields) {
    if (
      field.status !== "known" ||
      !field.value ||
      !field.quote ||
      field.eventId !== explicit.inputs.at(-1)?.id
    )
      continue;
    const stored = item.fields.find((f) => f.key === field.key);
    if (
      (stored && stored.status !== "not_asked") ||
      field.key === "product_name" ||
      field.key === "description"
    )
      continue;
    changes.push({
      itemId: item.id,
      key: field.key,
      text: field.value.text,
      number: field.value.number,
      unit: field.value.unit,
      quote: field.quote,
      hardConstraint: field.hardConstraint,
    });
  }
  if (!changes.length) return after;
  try {
    return applyInput(
      { ...after, inputs: after.inputs.slice(0, -1) },
      event,
      changes,
    );
  } catch (err) {
    if (err instanceof AppError) return after;
    throw err;
  }
}
