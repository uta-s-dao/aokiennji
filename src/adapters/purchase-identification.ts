import { applyInput } from "../domain/intake";
import { AppError, id, type Change, type Question, type Snapshot } from "../domain/model";

const identifier = { メーカー: "manufacturer", 型番: "model" } as const;
const noDesignation = /^(?:(メーカー|型番)(?:(?:や|と|・|および|及び)(メーカー|型番))?(?:の|は|が)?)?指定(?:は|が)?(?:ありません|なし(?:です)?|していません|していない)$/u;
const identifierUnknown = /^(メーカー|型番)(?:(?:や|と|・|および|及び)(メーカー|型番))?(?:は|が)?(?:不明(?:です)?|分かりません|わかりません)$/u;
const glass = "(?:耐熱|石英|強化|ホウケイ酸)?(?:ガラス|硝子)";
const vessel = new RegExp(
  `^(?:((?:手元で(?:使う|使用する))?交換用)の?)?(${glass}(?:製(?:の)?|の)?(?:容器|ボトル|瓶|びん|ビーカー))(?:です|になります)?$`,
  "u",
);
const glassGeneric = new RegExp(`^${glass}(?:製品|製(?:の)?部品|部品|製)?$`, "u");
const genericName = /^(?:容器|製品|部品|交換部品|交換用部品)$/u;

export function recoverPurchaseIdentification(
  s: Snapshot,
  text: string,
  q: Question | null,
  eventId?: string,
): Snapshot | null {
  if (!q?.itemId || !["manufacturer", "model"].includes(q.fieldKey) ||
      s.brief.items.length !== 1 || s.overflow.length || text.length > 2000 ||
      (eventId && s.inputs.some((event) => event.id === eventId))) return null;
  const item = s.brief.items[0];
  if (item.id !== q.itemId ||
      item.fields.find((field) => field.key === "request_scope")?.value?.text !== "purchase") return null;

  const clauses = text.trim().split(/[。！!\n]/).map((clause) => clause.trim()).filter(Boolean);
  const changes: Change[] = [];
  let identified = false;
  const find = (key: string) => item.fields.find((field) => field.key === key);
  for (const quote of clauses) {
    const absent = quote.match(noDesignation) ?? quote.match(identifierUnknown);
    if (absent) {
      const keys = [absent[1], absent[2]].filter(Boolean).map((name) => identifier[name as keyof typeof identifier]);
      for (const key of keys.length ? keys : [q.fieldKey]) {
        if (["known", "conflict"].includes(find(key)?.status ?? "") ||
            changes.some((change) => change.key === key)) return null;
        changes.push({ itemId: item.id, key, status: "unknown", hardConstraint: false, quote });
      }
      continue;
    }
    const name = quote.match(vessel);
    if (!name || identified) return null;
    const [, purpose, product] = name;
    const material = find("material")?.value?.text ?? "";
    if (item.label !== product && !glassGeneric.test(item.label) &&
        !(genericName.test(item.label) && glassGeneric.test(material))) return null;
    if (find("product_name")?.status === "conflict" ||
        find("material")?.status === "conflict" || (material && !glassGeneric.test(material))) return null;
    identified = true;
    if (find("product_name")?.value?.text !== product)
      changes.push({ itemId: item.id, key: "product_name", text: product, quote });
    if (purpose && !["known", "conflict"].includes(find("purpose")?.status ?? ""))
      changes.push({ itemId: item.id, key: "purpose", text: purpose, quote });
    if (!material) {
      const statedMaterial = product.match(new RegExp(`^${glass}`, "u"))![0];
      changes.push({ itemId: item.id, key: "material", text: statedMaterial, quote });
    }
  }
  if (!changes.some((change) => change.key === q.fieldKey)) return null;
  try {
    const after = applyInput(s, {
      id: eventId ?? id(),
      text,
      type: "customer_text",
    }, changes);
    after.extractionFailed = false;
    after.extractionError = undefined;
    return after;
  } catch (error) {
    if (error instanceof AppError) return null;
    throw error;
  }
}
