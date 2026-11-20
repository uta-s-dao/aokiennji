// These are relationships between product names, not a list of companies.
// Only an explicit family in the supplier's own product column is evidence.
const families = [
  {
    name: "ノズル",
    product: /(?:スプレー)?ノズル[・･]?チップ|スプレーノズル/u,
  },
  { name: "断熱材", product: /断熱(?:用)?ブランケット/u },
  {
    name: "ガラス製品",
    product: /(?:ガラス|硝子)(?:製の?|の)?(?:容器|ボトル|瓶|びん|ビーカー)/u,
  },
] as const;
export type PurchaseProductFamily = (typeof families)[number]["name"];

function namesProduct(text: string, noun: RegExp): boolean {
  const normalized = text.normalize("NFKC").replace(/\s+/gu, "");
  const match = noun.exec(normalized);
  if (!match) return false;
  const suffix = normalized.slice(match.index + match[0].length);
  // Allow request prose and specifications after the item, but do not turn
  // 「ノズル清掃用ブラシ」「断熱材入り毛布」 into the product being purchased.
  return (
    /^(?:$|[、。,.(（:：×0-9A-Z]|を(?:購入|注文|調達|探|手配|希望|お願い|[0-9])|が(?:必要|欲し|ほし|[0-9])|の(?:購入|注文|調達|手配|型番|見積|交換|在庫|仕様)|希望|について|です)/u.test(
      suffix,
    ) &&
    !/(?:ではなく|ではない|以外|除く|(?:清掃|掃除|洗浄|交換用|収納|保管|保護).{0,4}(?:用品|ブラシ|ケース|カバー))/u.test(
      suffix,
    )
  );
}

/** Specific purchased item identified in intake; a matching catalog family still needs review. */
export function purchaseProductFamily(
  text: string,
): PurchaseProductFamily | null {
  for (const family of families) {
    if (
      family.name === "断熱材" &&
      /寝具|日用品|ひざ掛け|膝掛け|毛布/u.test(text)
    )
      continue;
    if (
      family.name === "ガラス製品" &&
      /(?:容器|ボトル|瓶|びん|ビーカー)[^。！？]{0,30}(?:用|向け|の|を閉める)(?:の)?(?:蓋|ふた|フタ|キャップ)/u.test(
        text,
      )
    )
      continue;
    if (namesProduct(text, family.product)) return family.name;
  }
  return null;
}

export function listedPurchaseFamily(
  text: string,
): PurchaseProductFamily | null {
  const listed = text
    .normalize("NFKC")
    .replace(/\s+/gu, "")
    .replace(/(?:など|一式|他|等|類)$/u, "");
  if (listed === "ガラス製品" || listed === "硝子製品") return "ガラス製品";
  const name = listed.replace(/製品$/u, "");
  return families.find((family) => family.name === name)?.name ?? null;
}

export function requestsFamilyItself(
  text: string,
  family: PurchaseProductFamily,
): boolean {
  const noun =
    family === "ガラス製品" ? "(?:ガラス|硝子)製品" : `${family}(?:製品)?`;
  return namesProduct(
    text,
    new RegExp(`(?:^|[、。])${noun}(?:等|他|類)?`, "u"),
  );
}
