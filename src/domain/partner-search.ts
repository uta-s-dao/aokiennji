import type { Item, ResearchBrief, Value } from "./model";
import { normalized, parseCapacity } from "./fields";
import {
  listedPurchaseFamily,
  purchaseProductFamily,
  requestsFamilyItself,
} from "./product-family";

export type DimensionKey =
  | "overall_length"
  | "outer_diameter"
  | "inner_diameter"
  | "opening_diameter"
  | "hole_diameter"
  | "width"
  | "height"
  | "depth"
  | "thickness";
export type NumericRange = { min?: number; max?: number; unit: string };
export type PartnerSourceRef = {
  fileName: string;
  sheet: string;
  row: number;
  sourceId?: string;
  sourceKey?: string;
  rawValues?: Record<string, string>;
  columns?: Record<string, string>;
  columnLabels?: Record<string, string>;
};
export type PartnerCapability = {
  id: string;
  kind: "processing" | "purchase";
  equipment?: string[];
  processes?: string[];
  materials?: string[];
  products?: string[];
  dimensions?: Partial<Record<DimensionKey, NumericRange>>;
  quantity?: NumericRange;
  holeCount?: NumericRange;
  requiredDate?: { earliest?: string; latest?: string };
  evidence: string[];
  facts?: {
    field: string;
    text: string;
    unit?: string;
    axis?: string;
    bound?: string;
  }[];
  source?: PartnerSourceRef;
  sourceRefs?: PartnerSourceRef[];
};
export type PartnerRecord = {
  id: string;
  name: string;
  normalizedName: string;
  website: string | null;
  capabilityState: "documented" | "list_only";
  groups: PartnerCapability[];
  sourceRefs: PartnerSourceRef[];
};
export type PartnerMaster = {
  status: "ready" | "unavailable";
  versionId: string | null;
  revision: number;
  partners: PartnerRecord[];
  reasonCode?: "not_imported" | "import_failed" | "read_failed";
  reason?: string;
};
export type MatchAssessment = {
  field: string;
  status: "confirmed" | "unconfirmed" | "mismatch";
  reason: string;
};
export type PartnerCandidate = {
  itemId: string;
  partnerId: string;
  partnerName: string;
  website: string | null;
  kind: PartnerCapability["kind"];
  /** Purchase evidence for a processing/fabrication enquiry, scoped to this group. */
  sourcingBasis?: "product" | "material";
  groupId: string;
  status: "match" | "review" | "mismatch";
  assessments: MatchAssessment[];
  evidence: string[];
  sourceRefs: PartnerSourceRef[];
};
export type PartnerItemSearch = {
  itemId: string;
  status: "completed" | "failed" | "incomplete";
  match: PartnerCandidate[];
  review: PartnerCandidate[];
  mismatch: PartnerCandidate[];
};
export type PartnerSearchResult = {
  status: "completed" | "unavailable" | "failed" | "incomplete";
  masterVersionId: string | null;
  items: PartnerItemSearch[];
  webAllowed: boolean;
  reason?: string;
};
export const dimensionKeys: DimensionKey[] = [
  "overall_length",
  "outer_diameter",
  "inner_diameter",
  "opening_diameter",
  "hole_diameter",
  "width",
  "height",
  "depth",
  "thickness",
];
const terms: Record<string, string[]> = {
  旋盤: ["旋盤", "ターニング", "turning"],
  フライス: ["フライス", "milling"],
  切削: ["切削"],
  穴あけ: ["穴あけ", "穴開け", "穴加工", "ドリル加工"],
  溶接: ["溶接"],
  曲げ: ["曲げ", "ベンダー"],
  研削: ["研削"],
  研磨: ["研磨"],
  ステンレス: ["ステンレス", "SUS"],
  SUS304: ["SUS304"],
  SUS316: ["SUS316"],
  アルミ: ["アルミ", "ALUMINUM"],
  鉄: ["鉄", "SS400"],
  ゴム: ["ゴム"],
  樹脂: ["樹脂", "プラスチック"],
  真鍮: ["真鍮", "黄銅"],
  パッキン: ["パッキン", "ガスケット"],
  板: ["板", "プレート"],
  丸棒: ["丸棒", "丸鋼"],
  パイプ: ["パイプ", "鋼管"],
  リング: ["リング"],
  ボルト: ["ボルト"],
  ガラス: ["ガラス"],
  ポンプ: ["ポンプ"],
  断熱材: ["断熱材"],
  耐熱金物: ["耐熱金物"],
  マシニング: ["マシニング", "マシニングセンタ"],
  放電加工: ["放電加工", "型彫り放電"],
  ワイヤーカット: ["ワイヤーカット", "ワイヤー放電", "ワイヤ放電"],
  レーザー加工: [
    "レーザー加工",
    "レーザ加工",
    "レーザー切断",
    "レーザーカット",
  ],
  プレス: ["プレス"],
  切断: ["切断"],
  板金: ["板金", "鈑金"],
  熱処理: ["熱処理", "焼入れ", "焼き入れ"],
  表面処理: ["表面処理"],
  めっき: ["めっき", "メッキ"],
  塗装: ["塗装"],
  製缶: ["製缶"],
  鋳造: ["鋳造"],
  鍛造: ["鍛造"],
  バルブ: ["バルブ"],
  ベアリング: ["ベアリング"],
  工具: ["工具"],
  ノズル: ["ノズル"],
  継手: ["継手"],
  ホース: ["ホース"],
  耐火材: ["耐火材"],
  金網: ["金網"],
  測定器: ["測定器"],
  ボイラー: ["ボイラー"],
  配管: ["配管"],
  モーター: ["モーター"],
  ヒーター: ["ヒーター"],
  断熱板: ["断熱板"],
  シール: ["シール"],
  オイルシール: ["オイルシール"],
  Oリング: ["Oリング"],
  ナット: ["ナット"],
  ワッシャー: ["ワッシャー"],
  ネジ: ["ネジ"],
  ねじ: ["ねじ"],
  フィルター: ["フィルター"],
  センサー: ["センサー"],
  電線: ["電線"],
  ケーブル: ["ケーブル"],
  ロープ: ["ロープ"],
  ベルト: ["ベルト"],
  チェーン: ["チェーン"],
  スプロケット: ["スプロケット"],
  ギヤ: ["ギヤ"],
  歯車: ["歯車"],
  軸受: ["軸受"],
  鋼材: ["鋼材"],
  形鋼: ["形鋼"],
  アングル: ["アングル"],
  チャンネル: ["チャンネル"],
  鋼板: ["鋼板"],
  アルミ板: ["アルミ板"],
  ステンレス板: ["ステンレス板"],
  銅板: ["銅板"],
  セラミック: ["セラミック"],
  耐火煉瓦: ["耐火煉瓦"],
  キャスタブル: ["キャスタブル"],
  炉材: ["炉材"],
  ファン: ["ファン"],
  ブロワー: ["ブロワー"],
  コンプレッサー: ["コンプレッサー"],
  油圧機器: ["油圧機器"],
  空圧機器: ["空圧機器"],
  シリンダー: ["シリンダー"],
  タンク: ["タンク"],
  熱交換器: ["熱交換器"],
  圧力計: ["圧力計"],
  温度計: ["温度計"],
  流量計: ["流量計"],
  ボルトナット: ["ボルトナット"],
  保温材: ["保温材"],
  保冷材: ["保冷材"],
  ゴム板: ["ゴム板"],
  樹脂板: ["樹脂板"],
  丸鋼: ["丸鋼"],
  フランジ: ["フランジ"],
  ガスバーナー: ["ガスバーナー"],
  バーナー: ["バーナー"],
  トラップ: ["トラップ"],
  金具: ["金具"],
  耐熱鋼: ["耐熱鋼"],
  メッシュ: ["メッシュ"],
  スクリーン: ["スクリーン"],
  電動機: ["電動機"],
  減速機: ["減速機"],
};
const processTerms = [
  "旋盤",
  "フライス",
  "切削",
  "穴あけ",
  "溶接",
  "曲げ",
  "研削",
  "研磨",
  "マシニング",
  "放電加工",
  "ワイヤーカット",
  "レーザー加工",
  "プレス",
  "切断",
  "板金",
  "熱処理",
  "表面処理",
  "めっき",
  "塗装",
  "製缶",
  "鋳造",
  "鍛造",
];
const materialTerms = [
  "ステンレス",
  "SUS304",
  "SUS316",
  "アルミ",
  "鉄",
  "ゴム",
  "樹脂",
  "真鍮",
];
const productTerms = [
  "パッキン",
  "板",
  "丸棒",
  "パイプ",
  "リング",
  "ボルト",
  "ガラス",
  "ポンプ",
  "断熱材",
  "耐熱金物",
  "バルブ",
  "ベアリング",
  "工具",
  "ノズル",
  "継手",
  "ホース",
  "耐火材",
  "金網",
  "測定器",
  "ボイラー",
  "配管",
  "モーター",
  "ヒーター",
  "断熱板",
  "シール",
  "オイルシール",
  "Oリング",
  "ナット",
  "ワッシャー",
  "ネジ",
  "ねじ",
  "フィルター",
  "センサー",
  "電線",
  "ケーブル",
  "ロープ",
  "ベルト",
  "チェーン",
  "スプロケット",
  "ギヤ",
  "歯車",
  "軸受",
  "鋼材",
  "形鋼",
  "アングル",
  "チャンネル",
  "鋼板",
  "アルミ板",
  "ステンレス板",
  "銅板",
  "セラミック",
  "耐火煉瓦",
  "キャスタブル",
  "炉材",
  "ファン",
  "ブロワー",
  "コンプレッサー",
  "油圧機器",
  "空圧機器",
  "シリンダー",
  "タンク",
  "熱交換器",
  "圧力計",
  "温度計",
  "流量計",
  "ボルトナット",
  "保温材",
  "保冷材",
  "ゴム板",
  "樹脂板",
  "丸鋼",
  "フランジ",
  "ガスバーナー",
  "バーナー",
  "トラップ",
  "金具",
  "耐熱鋼",
  "メッシュ",
  "スクリーン",
  "電動機",
  "減速機",
];
const canonical = (s: string) =>
  s.normalize("NFKC").replace(/\s+/g, "").toUpperCase();
function recognized(text: string, keys: string[]) {
  const input = canonical(text);
  return keys.filter((key) =>
    terms[key].some((term) => {
      const token = canonical(term),
        at = input.indexOf(token);
      if (at < 0) return false;
      if (/^SUS\d/.test(token))
        return !/[A-Z0-9]/.test(input[at + token.length] ?? " ");
      return true;
    }),
  );
}
function equivalent(a: string, b: string, keys: string[]) {
  if (canonical(a) === canonical(b)) return true;
  const x = recognized(a, keys),
    y = recognized(b, keys);
  // A specific supported alloy establishes a general stainless request; the converse lacks grade evidence.
  if (keys === materialTerms) {
    const requestedGrade = canonical(a).match(/SUS\d+[A-Z]?/)?.[0];
    const supportedGrade = canonical(b).match(/SUS\d+[A-Z]?/)?.[0];
    if (requestedGrade) return requestedGrade === supportedGrade;
    if (supportedGrade && x.includes("ステンレス")) return true;
  }
  return x.some((s) => y.includes(s));
}
function known(item: Item, key: string) {
  return item.fields.find((f) => f.key === key && f.status === "known")?.value;
}
/** The original model remains in the brief; only explicit follow-up consent broadens the search. */
export function allowsEquivalentModels(item: Item): boolean {
  const consent = item.fields.find((f) => f.key === "equivalent_allowed");
  const scope = item.fields.find((f) => f.key === "equivalent_for_model");
  return (
    consent?.status === "known" &&
    consent.value?.text === "yes" &&
    consent.source === "selection" &&
    !!consent.eventId &&
    !!consent.quote &&
    scope?.status === "known" &&
    scope.eventId === consent.eventId &&
    scope.value?.text === known(item, "model")?.text &&
    item.fields.some(
      (f) => f.key === "model" && f.status === "known" && !f.hardConstraint,
    )
  );
}
export function requestKind(item: Item): PartnerCapability["kind"] | null {
  const scope = known(item, "request_scope")?.text;
  return scope === "purchase"
    ? "purchase"
    : scope === "processing" || scope === "fabrication"
      ? "processing"
      : null;
}
function productMatches(request: string, supported: string) {
  const clean = (s: string) =>
    canonical(s).replace(/(?:等|など|類|一式)$/g, "");
  const sourceTokens = supported
    .split(/[,、，/／|\n]+/)
    .map(clean)
    .filter(Boolean);
  return sourceTokens.some((value) => {
    if (value.length >= 2 && clean(request).includes(value)) return true;
    // A one-character suffix is not a product family: 鏡板 and 銘板 do not mean 板.
    // Alias expansion is limited to a whole source token and never broadens プレート into every compound ending in 板.
    return productTerms
      .filter((key) => key !== "板")
      .some(
        (key) =>
          terms[key].some((alias) => canonical(alias) === value) &&
          recognized(request, [key]).length > 0,
      );
  });
}
const sourceNegation =
  /不可|禁止|未対応|非対応|対応外|対象外|取り?扱い?(?:なし|無し|ません)|販売終了|受注停止|除く|以外|できません|していません/;
const sourceQualification =
  /要相談|応相談|要確認|条件付|別途相談|都度確認|未確認|保証なし|納期未定/;
const trailingSourceCondition = new RegExp(
  `(?:[のはをが])?(?:販売|取り?扱い?)?(?:[はをが])?(?:${sourceNegation.source}|${sourceQualification.source})[\\s\\S]*$`,
  "u",
);
function sourceClauses(values: string[]) {
  return values
    .flatMap((value) => value.split(/[,、，;；\n]+/))
    .map((text) => ({
      text,
      plain: text
        .replace(/[（(][^）)]*[）)]/g, (part) =>
          sourceNegation.test(part) || sourceQualification.test(part)
            ? ""
            : part,
        )
        .replace(trailingSourceCondition, "")
        .trim(),
    }));
}

function purchaseProductEvidence(
  item: Item,
  clauses: ReturnType<typeof sourceClauses>,
) {
  const productField = item.fields.find(
    (f) => f.key === "product_name" && f.status === "known",
  );
  const name = productField?.value?.text;
  const genericName = /^(?:部品|商品|品物|製品|この品目)$/u;
  const identity = name && !genericName.test(name) ? name : item.label;
  const names = [identity];
  const detail = item.fields.find(
    (f) => f.key === "description" && f.status === "known",
  );
  const detailText = detail?.value?.text;
  const identityFamily = listedPurchaseFamily(identity);
  // A detailed description may refine the same family. A new, concrete name
  // or an explicit correction must not revive the previous item's description.
  const correctedName =
    productField &&
    productField.eventId !== detail?.eventId &&
    (productField.source === "field_edit" ||
      /訂正|ではなく|じゃなく|変更|正しく/u.test(productField.quote ?? ""));
  if (
    detailText &&
    !correctedName &&
    (genericName.test(identity) ||
      (identityFamily !== null &&
        identityFamily === purchaseProductFamily(detailText)))
  )
    names.push(detailText);
  const families = names.map(purchaseProductFamily);
  const material = known(item, "material")?.text;
  const direct = [];
  const broader = [];
  const products = clauses.flatMap((clause) =>
    clause.plain
      .split(/[/／|]/u)
      .map((plain) => ({ text: clause.text, plain: plain.trim() })),
  );
  for (const clause of products) {
    const catalogFamily = listedPurchaseFamily(clause.plain);
    if (catalogFamily) {
      if (
        catalogFamily === "ガラス製品" &&
        material &&
        !/(?:ガラス|硝子)(?:製)?$/u.test(canonical(material))
      )
        continue;
      if (families.includes(catalogFamily)) broader.push(clause);
      else if (names.some((text) => requestsFamilyItself(text, catalogFamily)))
        direct.push(clause);
      continue;
    }
    const specificFamily = purchaseProductFamily(clause.plain);
    if (specificFamily) {
      if (
        families.includes(specificFamily) &&
        names.some((text) => productMatches(text, clause.plain))
      )
        direct.push(clause);
    } else if (
      !families.some(Boolean) ||
      !/^(?:チップ|ブランケット|部品|部品全般|製品|商品|汎用品|資材)(?:など|等|類|他)?$/u.test(
        canonical(clause.plain),
      )
    ) {
      if (productMatches(identity, clause.plain)) direct.push(clause);
    }
  }
  // A specific listing or exclusion speaks directly to this item. A broad
  // listing cannot cancel it. Retain explicit family prohibitions as well.
  if (direct.length)
    return {
      clauses: [
        ...direct,
        ...broader.filter((v) => sourceNegation.test(v.text)),
      ],
      familyOnly: false,
    };
  return { clauses: broader, familyOnly: broader.length > 0 };
}

function assessCapacity(
  request: Value,
  facts: NonNullable<PartnerCapability["facts"]>,
): MatchAssessment {
  const requested =
    request.number != null && request.unit
      ? normalized(request.number, request.unit)
      : null;
  const offered = facts.map((fact) => {
    if (fact.bound || (fact.axis && fact.axis !== "capacity")) return null;
    const parsed =
      parseCapacity(fact.text) ?? parseCapacity(fact.text + (fact.unit ?? ""));
    if (
      !parsed ||
      (fact.unit &&
        normalized(1, fact.unit).value !== normalized(1, parsed.unit).value) ||
      (fact.unit && normalized(1, fact.unit).dimension !== "volume")
    )
      return null;
    return normalized(parsed.number, parsed.unit).value;
  });
  let status: MatchAssessment["status"] = "unconfirmed";
  if (
    requested?.dimension === "volume" &&
    Number.isFinite(requested.value) &&
    requested.value > 0
  ) {
    const matches = offered.some(
      (amount) =>
        amount !== null &&
        Math.abs(amount - requested.value) <=
          Number.EPSILON * Math.max(amount, requested.value),
    );
    if (matches) status = "confirmed";
    else if (offered.length && offered.every((amount) => amount !== null))
      status = "mismatch";
  }
  const source = facts
    .map((fact) =>
      parseCapacity(fact.text)
        ? fact.text
        : [fact.text, fact.unit].filter(Boolean).join(""),
    )
    .join("、");
  return {
    field: "capacity",
    status,
    reason: `依頼容量=${request.text} / 同一取扱条件の容量=${source || "未記載"}`,
  };
}

// Only an explicitly named material or its catalog family can establish a
// raw-material lead. A shared adjective (耐熱) or a different finished product
// made from that material (ガラス窓) does not establish supply of the blank.
const supplyFamilies = [
  {
    name: "ガラス",
    pattern: /(?:耐熱|強化|石英|ソーダ|ホウケイ酸|ほうけい酸|硼珪酸)?ガラス/u,
  },
  { name: "ステンレス", pattern: /SUS\d{3}[A-Z\d]*|ステンレス(?:鋼)?/u },
  {
    name: "アルミ",
    pattern: /A[12567]\d{3}(?:-[A-Z0-9]+)?|アルミ(?:ニウム)?/u,
  },
  ...["樹脂", "ゴム", "チタン", "真鍮", "セラミック"].map((name) => ({
    name,
    pattern: new RegExp(name, "u"),
  })),
];

const supplyName = (text: string) =>
  canonical(text)
    .replace(/(?:対応可|対応|取扱い|取扱|のみ)$/u, "")
    .replace(/(?:など|等|他|類)$/, "");
const materialName = (text: string) =>
  supplyName(text).replace(/(?:製品|素材|材料)$/, "");
function supplyMaterial(text: string): string {
  const name = canonical(text);
  for (const { pattern } of supplyFamilies) {
    const match = pattern.exec(name);
    if (!match) continue;
    const rest = name.slice(match.index + match[0].length);
    if (
      !rest ||
      /^(?:製|の|で|円筒|丸棒|パイプ|リング|板|管|棒|部品)/u.test(rest)
    )
      return match[0];
  }
  return "";
}
function sourceMaterialStatus(
  request: string,
  source: string,
): MatchAssessment["status"] {
  const requested = materialName(request);
  const offered = materialName(source);
  if (requested === offered) return "confirmed";
  for (const { name, pattern } of supplyFamilies) {
    if (
      pattern.exec(requested)?.[0] !== requested ||
      pattern.exec(offered)?.[0] !== offered
    )
      continue;
    if (offered === name) return "unconfirmed";
    if (requested === name) return "confirmed";
  }
  return "mismatch";
}
function sourcingEvidence(
  names: string[],
  material: string,
  group: PartnerCapability,
) {
  const clauses = sourceClauses(group.products ?? []);
  const requestedProducts = names.map((text) =>
    canonical(text).replace(
      /(?:[がをの](?:新規)?(?:加工|製作|手配|調達|購入).*|[。！!])$/u,
      "",
    ),
  );
  const evidence = clauses.flatMap(({ text, plain }) => {
    const offered = supplyName(plain);
    if (
      !offered ||
      /^(?:部品|加工品|製作品|商品|製品|品物|資材|材料|部材|工具|部品全般|汎用品)$/u.test(
        offered,
      )
    )
      return [];
    const sourceMaterial = materialName(plain);
    const isRaw =
      !!material &&
      sourceMaterialStatus(material, sourceMaterial) !== "mismatch";
    const productFamily = offered.replace(/製品$/, "");
    const aliases = Object.values(terms).find((values) =>
      values.some((alias) => canonical(alias) === productFamily),
    ) ?? [productFamily];
    const isProduct =
      !isRaw &&
      requestedProducts.some((request) =>
        aliases.some((alias) => {
          const token = canonical(alias);
          if (request === token) return true;
          // A material prefix, e.g. SUS304製の丸棒, does not change the product.
          if (!material || !request.endsWith(token)) return false;
          return (
            request.slice(0, -token.length).replace(/(?:製の|製|の)$/, "") ===
            canonical(material)
          );
        }),
      );
    if (!isProduct && !isRaw) return [];
    return [
      {
        text,
        basis: isProduct ? ("product" as const) : ("material" as const),
        sourceMaterial,
      },
    ];
  });
  const positive = evidence.filter((entry) => !sourceNegation.test(entry.text));
  // An excluded requested specification takes precedence over a broad family listing.
  if (
    evidence.some(
      (entry) =>
        sourceNegation.test(entry.text) &&
        !positive.some(
          (p) =>
            p.basis === entry.basis &&
            p.sourceMaterial === entry.sourceMaterial,
        ),
    )
  )
    return undefined;
  return (
    positive.find((entry) => entry.basis === "product") ??
    positive.find(
      (entry) =>
        sourceMaterialStatus(material, entry.sourceMaterial) === "confirmed",
    ) ??
    positive[0]
  );
}
export function assessPartnerGroup(
  item: Item,
  partner: PartnerRecord,
  group: PartnerCapability,
): PartnerCandidate {
  const assessments: MatchAssessment[] = [];
  const add = (
    field: string,
    status: MatchAssessment["status"],
    reason: string,
  ) => assessments.push({ field, status, reason });
  const kind = requestKind(item);
  const supplyGroup = kind === "processing" && group.kind === "purchase";
  const canSource =
    supplyGroup && known(item, "material_supply")?.text !== "customer_supplied";
  const names = [item.label, known(item, "product_name")?.text ?? ""];
  const workNames = [
    ...names,
    known(item, "work_scope")?.text ?? "",
    known(item, "description")?.text ?? "",
  ];
  const product = (kind === "processing" ? workNames : names)
    .filter(Boolean)
    .join(" ");
  const process =
    known(item, "process")?.text ?? recognized(product, processTerms).join(" ");
  const material =
    known(item, "material")?.text ||
    (supplyGroup
      ? (workNames.map(supplyMaterial).find(Boolean) ?? "")
      : recognized(product, materialTerms).join(" "));
  const model = allowsEquivalentModels(item)
    ? undefined
    : known(item, "model")?.text;
  const modelAnchor =
    !!model &&
    group.facts?.some(
      (f) => f.field === "model" && canonical(f.text) === canonical(model),
    );
  const supply = canSource
    ? sourcingEvidence(workNames, material, group)
    : undefined;
  const modelSupply =
    canSource && modelAnchor && (!!supply || !group.products?.length);
  const sourcingBasis = modelSupply ? "product" : supply?.basis;
  add(
    "request_scope",
    !kind || sourcingBasis
      ? "unconfirmed"
      : kind === group.kind
        ? "confirmed"
        : "mismatch",
    sourcingBasis
      ? `${sourcingBasis === "product" ? "依頼品の仕入候補" : "関連材料の調達候補"}。加工・製作の担当先と当社の受注可否は担当者が確認します`
      : `依頼=${kind ?? "未確認"} / 資料=${group.kind}`,
  );
  const clauses = sourceClauses(group.products ?? []);
  const purchased =
    kind === "purchase" && group.kind === "purchase"
      ? purchaseProductEvidence(item, clauses)
      : undefined;
  const productClauses =
    purchased?.clauses ??
    clauses.filter((v) => productMatches(product, v.plain));
  const productAnchor = productClauses.length > 0;
  const processAnchor =
    !!process &&
    (group.processes ?? []).some((v) => equivalent(process, v, processTerms));
  if (
    !sourcingBasis &&
    !productAnchor &&
    !processAnchor &&
    !(kind === "purchase" && modelAnchor)
  )
    add(
      "relevance",
      "mismatch",
      `商品=${product} / 加工=${process || "指定なし"} に関連する資料がありません`,
    );
  if (sourcingBasis) {
    const source = modelSupply
      ? `指定型番「${model}」`
      : `取扱い品「${supply!.text}」`;
    if (sourcingBasis === "material")
      add(
        "取扱い品",
        sourceQualification.test(source) ? "unconfirmed" : "confirmed",
        `資料記載：${supply!.text}`,
      );
    add(
      "product_name",
      sourcingBasis === "product" && !sourceQualification.test(source)
        ? "confirmed"
        : "unconfirmed",
      sourcingBasis === "product"
        ? `${source}の記載が依頼と一致します。個別仕様は各条件で照合します`
        : `${source}は依頼材質「${material}」に関連します。完成品・指定仕様の供給は未確認です`,
    );
  }
  if (
    kind === "purchase" &&
    (!modelAnchor || known(item, "product_name") || purchased?.familyOnly)
  )
    add(
      "product_name",
      !group.products?.length || purchased?.familyOnly
        ? "unconfirmed"
        : productAnchor
          ? "confirmed"
          : "mismatch",
      purchased?.familyOnly
        ? `取扱い品「${productClauses.map((v) => v.text).join("、")}」は依頼品の上位分類です。指定品の取扱いと個別仕様は担当者が確認します`
        : `依頼=${product} / 取扱品=${group.products?.join("、") || "未記載"}`,
    );
  if (process && kind !== "purchase") {
    const supported = supplyGroup ? [] : (group.processes ?? []);
    const requestedTerms = recognized(process, processTerms);
    const exact = supported.some((v) => canonical(v) === canonical(process));
    const allTerms =
      requestedTerms.length > 0 &&
      requestedTerms.every((t) =>
        supported.some((v) => equivalent(t, v, processTerms)),
      );
    const residual = requestedTerms
      .reduce(
        (v, term) =>
          terms[term].reduce(
            (w, alias) => w.split(canonical(alias)).join(""),
            v,
          ),
        canonical(process),
      )
      .replace(/[加工のと、・及びをでしてほしい依頼相談]+/g, "");
    add(
      "process",
      !supported.length
        ? "unconfirmed"
        : exact || (allTerms && !residual)
          ? "confirmed"
          : !allTerms && requestedTerms.length
            ? "mismatch"
            : "unconfirmed",
      `依頼加工=${process} / 同一設備の加工=${supported.join("、") || "未記載"}`,
    );
  }
  if (material) {
    if (sourcingBasis) {
      const documented = sourceClauses(group.materials ?? []);
      const productMaterial =
        supply?.basis === "material"
          ? supply.sourceMaterial
          : supplyMaterial(supply?.text ?? "");
      const supported = documented.length
        ? documented
        : productMaterial
          ? [{ text: supply!.text, plain: productMaterial }]
          : [];
      const statuses = supported.map((v) =>
        sourceMaterialStatus(material, v.plain),
      );
      add(
        "material",
        statuses.includes("confirmed")
          ? "confirmed"
          : !statuses.length || statuses.includes("unconfirmed")
            ? "unconfirmed"
            : "mismatch",
        `依頼材質=${material} / 同一取扱条件の記載=${supported.map((v) => v.text).join("、") || "未記載"}`,
      );
    } else {
      const supported = [
        ...(group.materials ?? []),
        ...recognized((group.products ?? []).join(" "), materialTerms),
      ];
      const requested = recognized(material, materialTerms);
      const same = supported.some((v) =>
        equivalent(material, v, materialTerms),
      );
      const requestedGrade = requested.find((v) => v.startsWith("SUS"));
      const genericOnly =
        !same &&
        requestedGrade &&
        supported.some(
          (v) =>
            recognized(v, materialTerms).includes("ステンレス") &&
            !/SUS\s*\d/i.test(v),
        );
      add(
        "material",
        !supported.length || genericOnly
          ? "unconfirmed"
          : same
            ? "confirmed"
            : "mismatch",
        `依頼材質=${material} / 対応材質=${supported.join("、") || "未記載"}${genericOnly ? "（鋼種未確認）" : ""}`,
      );
    }
  }
  if (
    item.fields.some(
      (f) =>
        f.key === "dimension_unspecified" &&
        f.status !== "not_applicable" &&
        f.status !== "not_asked",
    ) ||
    item.notes.some((n) => n.startsWith("寸法種別は未確認："))
  )
    add("dimension_unspecified", "unconfirmed", "寸法の種類が未確認");
  for (const key of [...dimensionKeys, "quantity", "hole_count"] as const) {
    const value = known(item, key);
    if (!value) continue;
    const range =
      key === "quantity"
        ? group.quantity
        : key === "hole_count"
          ? group.holeCount
          : group.dimensions?.[key];
    if (
      value.number == null ||
      !Number.isFinite(value.number) ||
      !value.unit ||
      !range ||
      (range.min === undefined && range.max === undefined) ||
      (range.min !== undefined && !Number.isFinite(range.min)) ||
      (range.max !== undefined && !Number.isFinite(range.max)) ||
      (range.min ?? -Infinity) > (range.max ?? Infinity) ||
      (key === "hole_count" &&
        (!Number.isInteger(value.number) ||
          value.number <= 0 ||
          !["か所", "箇所", "個", "穴"].includes(value.unit) ||
          !["か所", "箇所", "個", "穴"].includes(range.unit) ||
          [range.min, range.max].some(
            (bound) =>
              bound !== undefined && (!Number.isInteger(bound) || bound < 0),
          )))
    ) {
      add(
        key,
        "unconfirmed",
        `依頼=${value.text} / 同一条件組の範囲・単位が未記載`,
      );
      continue;
    }
    const normalizeRange = (number: number, unit: string) =>
      key === "hole_count"
        ? { dimension: "hole_count", value: number }
        : normalized(number, unit);
    const actual = normalizeRange(value.number, value.unit),
      lo = normalizeRange(range.min ?? -Infinity, range.unit),
      hi = normalizeRange(range.max ?? Infinity, range.unit);
    add(
      key,
      actual.dimension !== lo.dimension
        ? "unconfirmed"
        : actual.value < lo.value || actual.value > hi.value
          ? "mismatch"
          : "confirmed",
      `依頼=${value.number}${value.unit} / 範囲=${range.min ?? "下限記載なし"}〜${range.max ?? "上限記載なし"}${range.unit}`,
    );
  }
  const date = known(item, "required_date")?.text;
  if (date) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !group.requiredDate ||
      (!group.requiredDate.earliest && !group.requiredDate.latest)
    )
      add(
        "required_date",
        "unconfirmed",
        `希望=${date} / 受付納期範囲は未確認`,
      );
    else
      add(
        "required_date",
        (group.requiredDate.earliest && date < group.requiredDate.earliest) ||
          (group.requiredDate.latest && date > group.requiredDate.latest)
          ? "mismatch"
          : "confirmed",
        `希望=${date} / 範囲=${group.requiredDate.earliest ?? "下限記載なし"}〜${group.requiredDate.latest ?? "上限記載なし"}`,
      );
  }
  for (const field of item.fields) {
    if (
      field.hardConstraint &&
      field.status !== "known" &&
      field.status !== "not_applicable"
    ) {
      add(
        field.key,
        "unconfirmed",
        `${field.label}は必須条件ですが${field.status === "conflict" ? "値が競合しています" : "値が未確定です"}`,
      );
    }
  }
  const handled = new Set<string>([
    "request_scope",
    "product_name",
    "process",
    "material",
    "required_date",
    "quantity",
    "hole_count",
    "dimension_unspecified",
    ...dimensionKeys,
  ]);
  for (const field of item.fields) {
    const modelRequiresConsent =
      field.key === "model" && !allowsEquivalentModels(item);
    if (
      handled.has(field.key) ||
      (field.hardConstraint === false &&
        !modelRequiresConsent &&
        field.key !== "capacity") ||
      field.status === "not_applicable"
    )
      continue;
    if (field.status !== "known" || !field.value) {
      if (field.hardConstraint)
        add(field.key, "unconfirmed", `${field.label}の指定が未確定`);
      continue;
    }
    const facts = (group.facts ?? []).filter((f) => f.field === field.key);
    if (field.key === "capacity") {
      assessments.push(assessCapacity(field.value, facts));
      continue;
    }
    add(
      field.key,
      !facts.length
        ? "unconfirmed"
        : facts.some(
              (f) =>
                canonical(f.text) === canonical(field.value!.text) &&
                (!field.value!.unit || f.unit === field.value!.unit),
            )
          ? "confirmed"
          : "mismatch",
      `依頼=${field.value.text} / 資料=${facts.map((f) => f.text).join("、") || "未記載"}`,
    );
  }
  const qualifications: {
    field: string;
    clauses: { text: string; plain: string }[];
  }[] = [
    {
      field: "process",
      clauses: sourceClauses(group.processes ?? []).filter(
        (v) => !!process && equivalent(process, v.plain, processTerms),
      ),
    },
    {
      field: "material",
      clauses: sourceClauses([
        ...(group.materials ?? []),
        ...(group.products ?? []),
      ]).filter(
        (v) =>
          !!material &&
          (equivalent(material, v.plain, materialTerms) ||
            (!!sourcingBasis &&
              sourceMaterialStatus(material, v.plain) !== "mismatch")),
      ),
    },
    {
      field: "product_name",
      clauses: productClauses,
    },
  ];
  for (const entry of qualifications) {
    const negative = entry.clauses.filter((v) => sourceNegation.test(v.text));
    const qualified = entry.clauses.filter((v) =>
      sourceQualification.test(v.text),
    );
    if (!negative.length && !qualified.length) continue;
    const positive = entry.clauses.some(
      (v) => !sourceNegation.test(v.text) && !sourceQualification.test(v.text),
    );
    const assessment = assessments.find((v) => v.field === entry.field);
    const status =
      negative.length && !positive && !qualified.length
        ? "mismatch"
        : "unconfirmed";
    const reason = `資料の${negative.length ? "否定・矛盾" : "留保"}記載：${[...negative, ...qualified].map((v) => v.text).join("、")}`;
    if (assessment) {
      assessment.status = status;
      assessment.reason = reason;
    } else add(entry.field, status, reason);
  }
  if (!group.evidence.some((v) => v.trim()))
    add("evidence", "unconfirmed", "条件の根拠資料がありません");
  if (
    item.fields.some((f) => f.status === "conflict") ||
    item.notes.some((n) => n.startsWith("未確認の顧客入力："))
  )
    add("input", "unconfirmed", "依頼に未確定の条件があります");
  // Flexible preferences stay visible for review when the supplier cannot meet them.
  for (const assessment of assessments) {
    if (
      assessment.status === "mismatch" &&
      [
        ...dimensionKeys,
        "material",
        "process",
        "quantity",
        "hole_count",
        "required_date",
        "capacity",
      ].includes(assessment.field) &&
      item.fields.some(
        (field) =>
          field.key === assessment.field &&
          field.status === "known" &&
          !field.hardConstraint,
      )
    ) {
      assessment.status = "unconfirmed";
      assessment.reason = `変更可能な希望条件は未達・要確認：${assessment.reason}`;
    }
  }
  return {
    itemId: item.id,
    partnerId: partner.id,
    partnerName: partner.name,
    website: partner.website,
    kind: group.kind,
    ...(sourcingBasis ? { sourcingBasis } : {}),
    groupId: group.id,
    status: assessments.some((a) => a.status === "mismatch")
      ? "mismatch"
      : assessments.some((a) => a.status === "unconfirmed")
        ? "review"
        : "match",
    assessments,
    evidence: [...group.evidence],
    sourceRefs:
      group.sourceRefs ?? (group.source ? [group.source] : partner.sourceRefs),
  };
}
export function maySearchWeb(
  result: PartnerSearchResult,
  expectedItemIds: string[],
): boolean {
  return (
    result.status === "completed" &&
    expectedItemIds.length > 0 &&
    new Set(expectedItemIds).size === expectedItemIds.length &&
    result.items.length === expectedItemIds.length &&
    new Set(result.items.map((i) => i.itemId)).size ===
      expectedItemIds.length &&
    expectedItemIds.every((id) =>
      result.items.some(
        (i) =>
          i.itemId === id &&
          i.status === "completed" &&
          i.match.length === 0 &&
          i.review.length === 0,
      ),
    )
  );
}
export function searchPartnerMaster(
  brief: ResearchBrief,
  master: PartnerMaster,
  complete = true,
): PartnerSearchResult {
  const result: PartnerSearchResult = {
    status:
      master.status !== "ready"
        ? "unavailable"
        : !complete
          ? "incomplete"
          : "completed",
    masterVersionId: master.versionId,
    items: [],
    webAllowed: false,
    ...(master.reason ? { reason: master.reason } : {}),
  };
  if (result.status !== "completed") return result;
  try {
    result.items = brief.items.map((item) => {
      const candidates = master.partners
        .filter((p) => p.capabilityState === "documented")
        .flatMap((p) => p.groups.map((g) => assessPartnerGroup(item, p, g)));
      return {
        itemId: item.id,
        status: "completed",
        match: candidates.filter((c) => c.status === "match"),
        review: candidates.filter((c) => c.status === "review"),
        mismatch: candidates.filter((c) => c.status === "mismatch"),
      };
    });
    result.webAllowed = maySearchWeb(
      result,
      brief.items.map((i) => i.id),
    );
  } catch {
    result.status = "failed";
    result.items = [];
  }
  return result;
}
/** Deliberately excludes IDs, names, notes, attachments, destinations and free-form utterances. */
export function publicSearchConditions(item: Item) {
  const names = [
    item.label,
    known(item, "product_name")?.text,
    known(item, "work_scope")?.text,
    known(item, "description")?.text,
  ]
    .filter(Boolean)
    .join(" ");
  const material = known(item, "material")?.text;
  const result: {
    kind: "processing" | "purchase" | null;
    model?: string;
    products: string[];
    processes: string[];
    materials: string[];
    dimensions: { key: DimensionKey; value: number; unit: string }[];
    quantity?: { value: number; unit: string };
    holeCount?: { value: number; unit: string };
    requiredDate?: string;
  } = {
    kind: requestKind(item),
    products: [
      ...new Set([
        ...recognized(names, productTerms),
        ...recognized(material ?? "", ["ガラス", "セラミック"]),
      ]),
    ],
    processes: recognized(known(item, "process")?.text ?? names, processTerms),
    materials: recognized(material ?? names, materialTerms),
    dimensions: [],
  };
  for (const key of dimensionKeys) {
    const v = known(item, key);
    if (
      v?.number != null &&
      Number.isFinite(v.number) &&
      v.unit &&
      ["mm", "cm", "m"].includes(v.unit)
    )
      result.dimensions.push({ key, value: v.number, unit: v.unit });
  }
  const model = allowsEquivalentModels(item)
    ? undefined
    : known(item, "model")?.text;
  if (model && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,59}$/.test(model))
    result.model = model;
  const q = known(item, "quantity");
  if (
    q?.number != null &&
    Number.isFinite(q.number) &&
    q.unit &&
    ["個", "枚", "組", "台", "本", "m", "kg"].includes(q.unit)
  )
    result.quantity = { value: q.number, unit: q.unit };
  const holes = known(item, "hole_count");
  if (
    holes?.number != null &&
    Number.isInteger(holes.number) &&
    holes.number > 0 &&
    holes.unit &&
    ["か所", "箇所", "個", "穴"].includes(holes.unit)
  )
    result.holeCount = { value: holes.number, unit: holes.unit };
  const date = known(item, "required_date")?.text;
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) result.requiredDate = date;
  return result;
}
export type PublicSearchConditions = ReturnType<typeof publicSearchConditions>;
