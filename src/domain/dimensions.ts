import { fields } from "./fields";
import { applyInput } from "./intake";
import { id, type Snapshot, type Question, type Item } from "./model";

export const dimensionKeys = ["overall_length", "outer_diameter", "inner_diameter", "opening_diameter", "hole_diameter", "width", "height", "depth", "thickness"];
export const dimensionAliases = (key: string) => key === "overall_length" ? ["全長", "長さ"] : key === "hole_diameter" ? ["穴径", "穴の直径", "穴の径"] : key === "opening_diameter" ? ["見える穴の径", "見える穴", "開口径"] : [fields[key]?.label ?? key];

/** Legacy opening-axis questions may call an opening 穴径; machining holes stay distinct. */
function designationKey(item: Item, q: Question, designation: string): string | null {
  const name = designation.replace(/(?:です|のことです|でした)$/, "");
  // A diameter alone does not identify the outside, a machined hole, or the visible opening.
  if (name === "直径") return null;
  if (["穴径", "穴の直径", "穴の径"].includes(name)) {
    const process = item.fields.find((f) => f.key === "process" && f.status === "known")?.value?.text ?? "";
    if (/穴|孔|ドリル/.test(process)) return "hole_diameter";
    const holeAxis = q.text.includes(fields.hole_diameter.label);
    const openingAxis = q.text.includes(fields.opening_diameter.label) || q.text.includes("開口径");
    if (holeAxis !== openingAxis) return holeAxis ? "hole_diameter" : "opening_diameter";
    const context = [item.label, ...item.fields.filter((f) => f.status === "known").map((f) => f.value?.text ?? "")].join(" ");
    if (/見える穴|開口|点検窓|確認窓/.test(context)) return "opening_diameter";
    const scope = item.fields.find((f) => f.key === "request_scope" && f.status === "known")?.value?.text;
    if (["processing", "fabrication"].includes(scope ?? "")) return "hole_diameter";
    return null;
  }
  const keys = dimensionKeys.filter((key) => dimensionAliases(key).includes(name));
  return keys.length === 1 ? keys[0] : null;
}

/** A designation answer supplies the axis; its numeric evidence stays in the original input. */
export function resolveDimensionDesignation(s: Snapshot, text: string, q: Question | null): Snapshot | null {
  if (!q || q.fieldKey !== "dimension_unspecified" || !q.itemId) return null;
  const item = s.brief.items.find((i) => i.id === q.itemId);
  const pending = item?.fields.find((f) => f.key === "dimension_unspecified");
  const candidate = s.dimensionCandidates?.find((d) => d.itemId === item?.id);
  if (pending?.status !== "known" || !candidate) return null;
  // Resolve only the designation clause; other supplied attributes still need extraction.
  const designation = text.trim().split(/[。！!、,\n]/)[0].trim();
  const key = designationKey(item!, q, designation);
  if (!key) return null;
  const existing = item!.fields.find((f) => f.key === key);
  if (existing && existing.status !== "not_asked") return null;
  const evidence = s.inputs.find((e) => e.id === candidate.eventId);
  if (!evidence || !evidence.text.includes(candidate.quote) || pending.eventId !== candidate.eventId ||
    pending.value?.number !== candidate.number || pending.value?.unit !== candidate.unit ||
    ![...candidate.quote.matchAll(/(\d+(?:\.\d+)?)\s*(mm|cm|m)(?![A-Za-z])/g)].some((m) => Number(m[1]) === candidate.number && m[2] === candidate.unit)) return null;
  const next = structuredClone(s);
  const target = next.brief.items.find((i) => i.id === item!.id)!;
  target.fields = target.fields.filter((f) => f.key !== "dimension_unspecified");
  target.fields.push({ ...structuredClone(pending), key, label: fields[key].label });
  target.notes = target.notes.filter((note) => !note.startsWith("寸法種別は未確認："));
  next.dimensionCandidates = next.dimensionCandidates?.filter((d) => d.itemId !== target.id);
  next.extractionFailed = false;
  next.extractionError = undefined;
  return next;
}

/** A designation-only reply is handled without an external extraction call. */
export function resolveDimensionAnswer(s: Snapshot, text: string, q: Question | null): Snapshot | null {
  if (text.trim().split(/[。！!、,\n]/).filter((c) => c.trim()).length !== 1) return null;
  const resolved = resolveDimensionDesignation(s, text, q);
  return resolved ? applyInput(resolved, { id: id(), text, type: "customer_text" }, []) : null;
}
