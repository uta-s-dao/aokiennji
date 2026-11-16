import { newItem, applyInput } from "../domain/intake";
import {
  id,
  AppError,
  type Snapshot,
  type Change,
  type Question,
  type InputEvent,
} from "../domain/model";
import { fields } from "../domain/fields";
export type Extractor = {
  extract: (
    s: Snapshot,
    text: string,
    q: Question | null,
    signal?: AbortSignal,
  ) => Promise<Snapshot>;
};
// Local demonstration only. This is not an LLM or an assertion of extraction accuracy.
export function extractDemo(
  s: Snapshot,
  text: string,
  q: Question | null = null,
): Snapshot {
  const event: InputEvent = { id: id(), text, type: "customer_text" };
  let state = structuredClone(s);
  state.extractionFailed = false;
  const additions = [];
  const changes: Change[] = [];
  if (/^(未確認だけ|まとめて|入力内容を確認|調べてください)/.test(text)) {
    state.inputs.push(event);
    return state;
  }
  const segments = text
    .split(/\n+|、(?=(?:ガラス|パッキン|カバー|ネック))/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (segments.length > 3) {
    state.overflow.push(text);
    state.inputs.push(event);
    return state;
  }
  for (const segment of segments) {
    let item =
      state.brief.items.find((i) => segment.includes(i.label)) ??
      (q?.itemId
        ? state.brief.items.find((i) => i.id === q.itemId)
        : undefined);
    if (!item && state.brief.items.length > 1) {
      state.extractionFailed = true;
      continue;
    }
    if (!item && state.brief.items.length === 1 && segments.length === 1)
      item = state.brief.items[0];
    if (!item) {
      if (state.brief.items.length + additions.length >= 3) {
        state.overflow.push(segment);
        continue;
      }
      const profile = /製作|架台|図面/.test(segment)
        ? "fabrication"
        : /交換|パッキン|ガラス|写真/.test(segment)
          ? "replacement"
          : /[A-Za-z]+-\d+/.test(segment)
            ? "known_model"
            : "unknown";
      const label =
        segment.match(/ガラス|パッキン|カバー|ネック|架台/)?.[0] ??
        segment.match(/[A-Z]+-\d+[A-Z0-9-]*/)?.[0] ??
        segment.split(/[、。\s]/)[0].slice(0, 60);
      item = newItem(
        label,
        profile,
        /AX-100/.test(segment)
          ? "demo_switch"
          : /架台/.test(segment)
            ? "demo_frame"
            : /リング/.test(segment)
              ? "demo_ring"
              : null,
      );
      additions.push(item);
    }
    const add = (
      key: string,
      value: string,
      quote = segment,
      number: number | null = null,
      unit: string | null = null,
    ) =>
      changes.push({ itemId: item!.id, key, text: value, quote, number, unit });
    const initial =
      !item.fields.length && !changes.some((c) => c.itemId === item!.id);
    if (initial) add("description", item.label, segment);
    const model = segment.match(/[A-Z]{1,10}-\d+[A-Z0-9-]*/);
    if (model) add("model", model[0]);
    const maker = segment.match(/(?:メーカー[：:は ]+)([^、\s。]+)/);
    if (maker) add("manufacturer", maker[1]);
    if (/購入|探して|AX-100/.test(segment)) add("request_scope", "purchase");
    else if (/製作|作って/.test(segment)) add("request_scope", "fabrication");
    else if (/加工|穴を開け/.test(segment)) add("request_scope", "processing");
    if (/材料も|材料を調達|御社で調達|当社調達/.test(segment))
      add("material_supply", "company_sourced");
    else if (/一部支給/.test(segment)) add("material_supply", "mixed");
    else if (/(?:材料|リング材|支給材).{0,6}支給|支給材/.test(segment))
      add("material_supply", "customer_supplied");
    if (!/なら|どう[？?]|仮に/.test(segment)) {
      const mat = segment.match(/SUS\d{3}|アルミ|鉄|ゴム/);
      if (mat) add("material", mat[0]);
    }
    for (const [key, name] of Object.entries(fields)) {
      if (!name.units || key === "quantity") continue;
      const match = segment.match(
        new RegExp(
          `${name.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[はを：: ]*([0-9]+(?:\\.[0-9]+)?)\\s*(mm|cm|m|℃|°C|MPa|kPa|Pa|秒|分|時間)`,
        ),
      );
      if (match)
        add(key, match[1] + match[2], match[0], Number(match[1]), match[2]);
    }
    const qty = segment.match(/(\d+(?:\.\d+)?)\s*(個|枚|組|台|本)/);
    if (qty) add("quantity", qty[0], qty[0], Number(qty[1]), qty[2]);
    for (const [key, re] of [
      ["coating", /(塗装不要|外装塗装|[^、。\n]{0,10}塗装)/],
      ["required_date", /(来月上旬|\d{4}-\d{2}-\d{2}|\d+月\d+日)/],
      ["supplied_parts", /(塗料.{0,3}支給)/],
      ["excluded_work", /(リブ.{0,3}除外)/],
    ] as const) {
      const m = segment.match(re);
      if (m) add(key, m[0]);
    }
    const purpose = segment.match(/用途[：:は ]+([^、。]+)/);
    if (purpose) add("purpose", purpose[1]);
    if (
      q?.itemId === item.id &&
      fields[q.fieldKey] &&
      !changes.some((c) => c.itemId === item!.id && c.key === q.fieldKey)
    ) {
      if (fields[q.fieldKey].units) {
        const m = segment.match(
          /(\d+(?:\.\d+)?)\s*(mm|cm|m|℃|°C|個|枚|組|台|本)/,
        );
        if (m) add(q.fieldKey, m[0], m[0], +m[1], m[2]);
      } else if (!fields[q.fieldKey].values)
        add(q.fieldKey, segment.slice(0, 300));
    }
  }
  const dedup = [
    ...new Map(changes.map((c) => [c.itemId + ":" + c.key, c])).values(),
  ];
  state = applyInput(state, event, dedup, additions);
  return state;
}
export class DisabledExtractor implements Extractor {
  async extract(): Promise<Snapshot> {
    throw new AppError("MODEL_DISABLED");
  }
}
export const demoExtractor: Extractor = {
  extract: async (s, text, q) => extractDemo(s, text, q),
};

/** One extraction attempt, bounded independently of the provider. Never regenerate on failure. */
export async function extractOnce(
  extractor: Extractor,
  s: Snapshot,
  text: string,
  q: Question | null,
  timeoutMs = 3000,
): Promise<Snapshot> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    const result = await Promise.race([
      extractor.extract(structuredClone(s), text, q, controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("MODEL_TIMEOUT"));
        }, timeoutMs);
      }),
    ]);
    if (result.extractionFailed)
      throw new AppError(result.extractionError ?? "INVALID_EXTRACTION");
    result.unresolvedInputs = (
      result.unresolvedInputs ??
      s.unresolvedInputs ??
      []
    ).filter((e) => e.text !== text);
    result.extractionError = undefined;
    return result;
  } catch (error) {
    const fallback = structuredClone(s);
    fallback.extractionFailed = true;
    const event: InputEvent = { id: id(), text, type: "customer_text" };
    fallback.inputs.push(event);
    fallback.unresolvedInputs = [...(s.unresolvedInputs ?? []), event];
    fallback.extractionError = controller.signal.aborted
      ? "MODEL_TIMEOUT"
      : error instanceof Error &&
          [
            "MODEL_DISABLED",
            "MODEL_TIMEOUT",
            "MODEL_RATE_LIMITED",
            "MODEL_AUTH_FAILED",
            "INVALID_EXTRACTION",
            "MODEL_REFUSED",
          ].includes(error.message)
        ? error.message
        : "MODEL_UNAVAILABLE";
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}
