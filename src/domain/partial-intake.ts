import { validateExtractionProposal } from "../generated/validators.js";
import { unresolvedKeys } from "./dialogue";
import { dimensionAliases, dimensionKeys } from "./dimensions";
import { applyExtractionProposal, type ExtractionProposal } from "./extraction-proposal";
import { fields } from "./fields";
import { isTentative, unsafeToRecover } from "./grounding";
import { AppError, id, type Question, type Snapshot } from "./model";

function sentenceKeys(sentence: string): string[] {
  const keys = unresolvedKeys(sentence);
  for (const key of dimensionKeys)
    if (dimensionAliases(key).some((alias) => sentence.includes(alias))) keys.push(key);
  if (/納期|納入日|希望日/.test(sentence)) keys.push("required_date");
  if (/個数|枚数|台数|本数|[0-9一二三四五六七八九十百]+\s*(?:個|枚|台|本|組|つ)(?!所)/.test(sentence)) keys.push("quantity");
  if (/空洞|中空|無垢|中実/.test(sentence)) keys.push("body_structure", "inner_diameter");
  return [...new Set(keys)];
}

const rejection = (error: unknown) =>
  error instanceof AppError && ["INVALID_EXTRACTION", "INVALID_INPUT"].includes(error.code);

function recoverSeparateSentences(
  s: Snapshot,
  text: string,
  q: Question | null,
  proposal: ExtractionProposal,
  categories: string[],
): Snapshot | null {
  if (
    s.overflow.length || text.length > 2000 ||
    s.brief.items.length + proposal.newItems.length !== 1 ||
    !proposal.changes.length || proposal.changes.some((c) => c.operation !== "set") ||
    isTentative(text) ||
    /別の|別件|別品|もう一(?:つ|点|種類|品)|それぞれ|各々|もし|ですか|でしょうか|かどうか/.test(text) ||
    unsafeToRecover(text
      .replace(/(?:今日|明日|今月末|来月末|来週末|\d{1,2}月\d{1,2}日)まで/g, "希望日")
      .replace(/分かりません|わかりません|不明|未定/g, "未確認事項"))
  ) return null;

  const addition = proposal.newItems[0];
  const owner = addition?.ref ?? s.brief.items[0].id;
  const itemName = addition?.label ?? s.brief.items[0].label;
  if (q?.itemId && q.itemId !== owner) return null;
  if (proposal.changes.some((c) => c.itemRef !== owner || !Object.hasOwn(fields, c.key))) return null;
  const keys = proposal.changes.map((c) => c.key);
  if (new Set(keys).size !== keys.length) return null;

  const sentences = text.match(/[^。！？!?\n]+[。！？!?]?/g)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [];
  const sentenceIndex = (quote: string) =>
    quote && text.split(quote).length === 2
      ? sentences.findIndex((sentence) => sentence.includes(quote))
      : -1;
  const locations = proposal.changes.map((c) => sentenceIndex(c.quote));
  const identityLocation = addition ? sentenceIndex(addition.quote) : -1;
  if (locations.includes(-1) || (addition && identityLocation < 0)) return null;

  const omitted = [...proposal.ambiguities, ...proposal.unprocessedQuotes];
  const fragments = new Set(omitted.map(sentenceIndex));
  if (fragments.has(-1)) return null;

  if (!fragments.size) {
    // Diagnose a single invalid value only after all its ownership and evidence
    // checks above, and validate the final retained proposal as a whole below.
    const rejected = proposal.changes.flatMap((change, index) => {
      try {
        applyExtractionProposal(s, text, q, {
          ...proposal,
          changes: [change],
        }, categories);
        return [];
      } catch (error) {
        if (!rejection(error)) throw error;
        return [index];
      }
    });
    if (rejected.length !== 1) return null;
    const [index] = rejected;
    if (!sentenceKeys(sentences[locations[index]]).includes(keys[index])) return null;
    fragments.add(locations[index]);
  }

  if (fragments.has(identityLocation)) return null;
  const retained = proposal.changes.filter((_change, index) => !fragments.has(locations[index]));
  if (!retained.length || (omitted.length && retained.length !== proposal.changes.length) ||
      (!omitted.length && retained.length !== proposal.changes.length - 1)) return null;
  const confirmed = new Set([identityLocation, ...locations.filter((location) => !fragments.has(location))]);
  if (sentences.some((_sentence, index) => !confirmed.has(index) && !fragments.has(index))) return null;

  const open = [...fragments].sort((a, b) => a - b).map((index) => ({
    text: sentences[index],
    keys: sentenceKeys(sentences[index]),
  }));
  const confirmedKeys = new Set([
    ...retained.map((change) => change.key),
    ...[...confirmed].flatMap((index) => sentenceKeys(sentences[index] ?? "")),
  ]);
  const openKeys = open.flatMap((fragment) => fragment.keys);
  if (
    openKeys.length !== new Set(openKeys).size ||
    openKeys.some((key) => confirmedKeys.has(key)) ||
    open.some((fragment) => !fragment.keys.length && !fragment.text.includes(itemName)) ||
    retained.some((change) => change.status === "unknown" &&
      s.brief.items[0]?.fields.some((field) => field.key === change.key && field.status === "known")
    )
  ) return null;

  const result = applyExtractionProposal({
    ...s,
    unresolvedInputs: [],
    pendingChanges: [],
  }, text, q, {
    ...proposal,
    changes: retained,
    ambiguities: [],
    unprocessedQuotes: [],
  }, categories);
  const event = result.inputs.at(-1);
  if (!event || event.text !== text || result.unresolvedInputs?.length ||
      result.brief.items.some((item) => item.fields.some((field) =>
        field.eventId === event.id && field.quote &&
        ![...confirmed].some((index) => sentences[index]?.includes(field.quote!))
      ))) return null;

  const itemId = result.brief.items[0].id;
  result.unresolvedInputs = [...(s.unresolvedInputs ?? [])];
  result.pendingChanges = [...(s.pendingChanges ?? [])];
  for (const fragment of open) {
    const eventId = id();
    const fieldKey = fragment.keys.length === 1 ? fragment.keys[0] : "description";
    result.unresolvedInputs.push({
      id: eventId,
      type: "customer_text",
      text: fragment.text,
      partialFor: { itemId, fieldKey },
    });
    for (const key of fragment.keys)
      result.pendingChanges.push({ eventId, itemId, key });
  }
  return result;
}

function preserveUnansweredEcho(s: Snapshot, result: Snapshot, text: string) {
  const eventId = result.inputs.at(-1)?.id;
  for (const fragment of s.unresolvedInputs ?? []) {
    const target = fragment.partialFor;
    if (!target || fragment.text !== text ||
        result.unresolvedInputs?.some((event) => event.id === fragment.id)) continue;
    const fields = result.brief.items.find((item) => item.id === target.itemId)?.fields ?? [];
    const pending = s.pendingChanges?.filter((change) => change.eventId === fragment.id) ?? [];
    const keys = pending.length ? pending.map((change) => change.key) : [target.fieldKey];
    if (keys.every((key) => fields.some((field) => field.key === key && field.eventId === eventId))) continue;
    result.unresolvedInputs = [...(result.unresolvedInputs ?? []), fragment];
    const unresolved = pending.filter((change) =>
      !fields.some((field) => field.key === change.key && field.eventId === eventId),
    );
    result.pendingChanges = [...(result.pendingChanges ?? []), ...unresolved];
  }
  return result;
}

export function applyConversationProposal(
  s: Snapshot,
  text: string,
  q: Question | null,
  raw: unknown,
  categories: string[] = [],
): Snapshot {
  try {
    return preserveUnansweredEcho(s, applyExtractionProposal(s, text, q, raw, categories), text);
  } catch (error) {
    if (!rejection(error) || !validateExtractionProposal(raw)) throw error;
    try {
      const recovered = recoverSeparateSentences(s, text, q, raw as ExtractionProposal, categories);
      if (recovered) return recovered;
    } catch (recoveryError) {
      if (!rejection(recoveryError)) throw recoveryError;
    }
    throw error;
  }
}
