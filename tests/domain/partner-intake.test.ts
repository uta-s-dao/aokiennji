import { expect, it, vi } from "vitest";
import { extractDemo, extractOnce } from "../../src/adapters/extraction";
import { OpenAIIntakeExtractor } from "../../src/adapters/openai-intake";
import { applyInput, chooseNextQuestion, makeSnapshot, makeResearchBrief, newItem } from "../../src/domain/intake";
import { applyExtractionProposal } from "../../src/domain/extraction-proposal";
import { decodeCompactProposal } from "../../src/domain/compact-extraction";
import { supplierInquiryGeometry } from "../../src/domain/dialogue";
import type { Change, Snapshot } from "../../src/domain/model";

const field = (s: Snapshot, key: string) => s.brief.items[0].fields.find((f) => f.key === key);
const next = (s: Snapshot) => chooseNextQuestion(s, [], false, [], true);
const start = (text: string) => extractDemo(makeSnapshot("partner-intake"), text);
const skip = (s: Snapshot, status: "unknown" | "skipped" = "skipped") => {
  const q = next(s)!;
  return applyInput(s, { id: crypto.randomUUID(), text: "分からない", type: "selection" }, [{ itemId: q.itemId!, key: q.fieldKey, status, quote: "分からない" }]);
};

it("正確な型番を既存品目に保存したら数量・納期だけを一問ずつ聞く", () => {
  let s = start("パッキンを購入したいです");
  expect(next(s)?.fieldKey).toBe("model");
  s = extractDemo(s, "型番はPK-100です", next(s));
  expect(s.brief.items).toHaveLength(1);
  expect(field(s, "model")?.value?.text).toBe("PK-100");
  expect(next(s)?.fieldKey).toBe("quantity");
  s = extractDemo(s, "5個です", next(s));
  expect(next(s)?.fieldKey).toBe("required_date");
  s = extractDemo(s, "納期は未定です", next(s));
  expect(field(s, "required_date")?.status).toBe("unknown");
  expect(field(s, "required_date")?.quote).toBe("納期は未定です");
  expect(next(s)).toBeNull();
});

it("加工別の軸で、寸法の種別回答に添えた外径も受け取り納期へ進む", () => {
  let s = start("SUS304の丸棒を旋盤加工してほしい。300mm、5個です");
  expect(next(s)?.fieldKey).toBe("dimension_unspecified");
  const original = field(s, "dimension_unspecified");
  s = extractDemo(s, "全長です。外径は40mmです", next(s));
  expect(s.brief.items).toHaveLength(1);
  expect(field(s, "overall_length")?.value?.number).toBe(300);
  expect(field(s, "overall_length")?.quote).toBe(original?.quote);
  expect(field(s, "outer_diameter")?.value?.number).toBe(40);
  expect(field(s, "quantity")?.value?.number).toBe(5);
  expect(next(s)?.fieldKey).toBe("required_date");
  s = extractDemo(s, "指定なし", next(s));
  expect(field(s, "required_date")?.status).toBe("unknown");
  expect(next(s)?.fieldKey).toBe("material_supply");
  s = skip(s, "unknown");
  expect(next(s)).toBeNull();
  expect(makeResearchBrief(s, 2, 0).items[0].fields).toContainEqual(expect.objectContaining({ key: "required_date", status: "unknown", quote: "指定なし" }));
});

it("型番不明パッキンは用途・材質・必要な寸法を少しずつ聞き、unknown/skipを繰り返さない", () => {
  let s = start("パッキンを購入したい。型番は不明です");
  expect(next(s)?.fieldKey).toBe("purpose");
  s = extractDemo(s, "ポンプの漏れ止めに使います。ゴム、外径40mm、内径20mm、厚さ3mm、数量5個、納期は来月上旬です", next(s));
  expect(next(s)).toBeNull();
  for (const key of ["purpose", "material", "outer_diameter", "inner_diameter", "thickness", "quantity", "required_date"])
    expect(field(s, key)?.status, key).toBe("known");
  s = start("パッキンを購入したい");
  const asked: string[] = [];
  while (next(s)) { asked.push(next(s)!.fieldKey); s = skip(s, asked.length % 2 ? "unknown" : "skipped"); }
  expect(new Set(asked).size).toBe(asked.length);
  expect(asked).toContain("required_date");
});

it("板の加工は厚さ・縦横、穴加工は穴径と穴数を数量とは別に保存する", () => {
  let s = start("ステンレス板を穴加工してください。厚さ2mm、横300mm、縦200mm、穴径6mm、穴は4か所、数量5枚、納期は来週中です。材料はこちらで用意します");
  for (const [key, number] of [["thickness", 2], ["width", 300], ["height", 200], ["hole_diameter", 6], ["hole_count", 4], ["quantity", 5]] as const)
    expect(field(s, key)?.value?.number, key).toBe(number);
  expect(next(s)).toBeNull();
  const before = structuredClone(s);
  s = extractDemo(s, "数量を8枚に訂正します", null);
  expect(field(s, "quantity")?.value?.number).toBe(8);
  for (const key of ["hole_diameter", "hole_count", "material", "process", "required_date"])
    expect(field(s, key)).toEqual(field(before, key));
});

it.each(["full", "compact"] as const)("OpenAI %s経路でも複合寸法回答を落とさず保存する", async (format) => {
  const s = start("SUS304の丸棒を旋盤加工してほしい。300mm、5個です");
  const text = "全長です。外径は40mmです";
  const proposal = format === "full" ? { schemaVersion: 1, newItems: [], changes: [{ itemRef: s.brief.items[0].id, key: "outer_diameter", status: "known", value: { text: "40mm", number: 40, unit: "mm" }, quote: "外径は40mm", operation: "set", hardConstraint: true }], ambiguities: [], unprocessedQuotes: [] } : { n: [], c: [{ i: "0", k: "od", v: "40mm", q: "外径は40mm", o: "s", h: true }], u: [] };
  const transport = vi.fn(async () => new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(proposal) }] }] })));
  const extractor = new OpenAIIntakeExtractor({ key: "offline", model: "offline", format, maxOutputTokens: 1000, maxCallsTotal: 5, maxCallsPerCase: 5 }, [], transport);
  const after = await extractor.extract(s, text, next(s));
  expect(field(after, "overall_length")?.value?.number).toBe(300);
  expect(field(after, "outer_diameter")?.value?.number).toBe(40);
  expect(next(after)?.fieldKey).toBe("required_date");
  expect(transport).toHaveBeenCalledTimes(1);
});

it.each(["full", "compact"] as const)("%s抽出で明示された納期未定・指定なしをunknownとして保存する", (format) => {
  for (const text of ["納期は未定です", "希望納期は指定なしです"]) {
    const s = start("AX-100を5個購入したい");
    const raw = format === "full" ? { schemaVersion: 1, newItems: [], changes: [{ itemRef: s.brief.items[0].id, key: "required_date", status: "unknown", value: null, quote: text, operation: "set", hardConstraint: false }], ambiguities: [], unprocessedQuotes: [] } : decodeCompactProposal(s, { n: [], c: [{ i: "0", k: "dt", v: null, q: text, o: "s", h: false }], u: [] });
    const after = applyExtractionProposal(s, text, next(s), raw);
    expect(field(after, "required_date")?.status).toBe("unknown");
    expect(field(after, "quantity")?.value?.number).toBe(5);
    expect(next(after)).toBeNull();
  }
});

it("希望納期は希望条件として保存し、必着だけを必須期限とする", () => {
  const wish = start("AX-100を5個購入、希望納期は来月上旬です");
  expect(field(wish, "required_date")?.hardConstraint).toBe(false);
  expect(field(wish, "required_date")?.value?.text).toBe("来月上旬");
  const strict = start("AX-100を5個購入、来月上旬必着です");
  expect(field(strict, "required_date")?.hardConstraint).toBe(true);
  expect(field(strict, "required_date")?.quote).toContain("必着");
  const flexible = start("AX-100を5個希望だが調整可、納期は来月上旬です");
  expect(field(flexible, "quantity")?.hardConstraint).toBe(false);
  expect(field(flexible, "quantity")?.quote).toContain("調整可");
});

it("基本事項の後にも有効ルール・実マスタの不足軸を落とさず、既知寸法を重複質問しない", () => {
  const s = start("SUS304の丸棒を旋盤加工、外径40mm、全長300mm、5個、納期は来月上旬です。材料はこちらで用意します");
  const category = s.brief.items[0].category;
  const rules = [{ category, approvalStatus: "approved", validUntil: "2099-12-31", requiredFields: ["normal_temperature"], predicates: [] }] as unknown as Parameters<typeof chooseNextQuestion>[1];
  expect(chooseNextQuestion(s, rules, false, [{ itemId: s.brief.items[0].id, fieldKeys: ["outer_diameter", "normal_temperature"] }], true)?.fieldKey).toBe("normal_temperature");
  const pending = start("SUS304の丸棒を旋盤加工、300mm、5個");
  const q = chooseNextQuestion(pending, [], false, [{ itemId: pending.brief.items[0].id, fieldKeys: ["thickness"] }], true)!;
  expect(q.fieldKey).toBe("dimension_unspecified");
  expect(q.text).toContain("外径・全長・厚さ");
});

it("数量のm単位を寸法へ取り違えず、対象訂正も他の値を保つ", () => {
  let s = start("AX-100を購入したい");
  s = extractDemo(s, "10m", next(s));
  expect(field(s, "quantity")?.value).toEqual({ text: "10m", number: 10, unit: "m" });
  expect(field(s, "dimension_unspecified")).toBeUndefined();
  const before = structuredClone(s);
  s = extractDemo(s, "型番はPK-100に訂正します", next(s));
  expect(s.brief.items).toHaveLength(1);
  expect(field(s, "model")?.value?.text).toBe("PK-100");
  expect(field(s, "quantity")).toEqual(field(before, "quantity"));
});

it.each(["full", "compact"] as const)("%s抽出でも希望期限と必着、調整可能数量を区別する", (format) => {
  for (const [text, hard] of [["希望納期は2週間くらいです", false], ["来月上旬必着です", true]] as const) {
    const s = start("AX-100を購入したい");
    const date = text.includes("2週間") ? "2週間くらい" : "来月上旬";
    const raw = format === "full" ? { schemaVersion: 1, newItems: [], changes: [{ itemRef: s.brief.items[0].id, key: "required_date", status: "known", value: { text: date, number: null, unit: null }, quote: text, operation: "set", hardConstraint: true }], ambiguities: [], unprocessedQuotes: [] } : decodeCompactProposal(s, { n: [], c: [{ i: "0", k: "dt", v: date, q: text, o: "s", h: true }], u: [] });
    expect(field(applyExtractionProposal(s, text, next(s), raw), "required_date")?.hardConstraint).toBe(hard);
  }
  const s = start("AX-100を購入したい");
  const text = "5個希望だが調整可";
  const raw = format === "full" ? { schemaVersion: 1, newItems: [], changes: [{ itemRef: s.brief.items[0].id, key: "quantity", status: "known", value: { text: "5個", number: 5, unit: "個" }, quote: text, operation: "set", hardConstraint: false }], ambiguities: [], unprocessedQuotes: [] } : decodeCompactProposal(s, { n: [], c: [{ i: "0", k: "qt", v: "5個", q: text, o: "s", h: false }], u: [] });
  expect(field(applyExtractionProposal(s, text, next(s), raw), "quantity")?.hardConstraint).toBe(false);
});

it("曖昧な相対納期を勝手に日付へ変換せず保存する", () => {
  const s = start("AX-100を5個購入、希望納期はできれば2週間くらいです");
  expect(field(s, "required_date")?.value?.text).toBe("できれば2週間くらいです");
  expect(field(s, "required_date")?.hardConstraint).toBe(false);
  expect(next(s)).toBeNull();
});

it.each(["demo", "full", "compact"] as const)("%sで加工穴径と見える開口径を質問軸・文脈に沿って区別する", async (format) => {
  const cases = [
    { initial: "ステンレス板を穴加工、300mm、5枚", axes: ["hole_diameter"], answer: "穴径です", target: "hole_diameter" },
    { initial: "ステンレス板を穴加工、300mm、5枚", axes: ["opening_diameter"], answer: "穴径です", target: "hole_diameter" },
    { initial: "ガラスを購入、300mm、5枚", axes: ["opening_diameter"], answer: "見える穴の径です", target: "opening_diameter" },
    { initial: "ガラスを購入、300mm、5枚", axes: ["opening_diameter"], answer: "穴径です", target: "opening_diameter" },
    { initial: "ガラスを購入、300mm、5枚", axes: ["opening_diameter", "hole_diameter"], answer: "開口径です", target: "opening_diameter" },
  ];
  for (const test of cases) {
    const s = start(test.initial);
    const q = chooseNextQuestion(s, [], false, [{ itemId: s.brief.items[0].id, fieldKeys: test.axes }])!;
    expect(q.fieldKey).toBe("dimension_unspecified");
    const transport = vi.fn(async () => { throw new Error("External extraction must not run"); });
    const extractor = new OpenAIIntakeExtractor({ key: "offline", model: "offline", format: format === "demo" ? "full" : format, maxOutputTokens: 1000, maxCallsTotal: 5, maxCallsPerCase: 5 }, [], transport);
    const after = format === "demo" ? extractDemo(s, test.answer, q) : await extractor.extract(s, test.answer, q);
    expect(field(after, test.target)?.value?.number, test.answer).toBe(300);
    expect(field(after, test.target === "hole_diameter" ? "opening_diameter" : "hole_diameter"), test.answer).toBeUndefined();
    expect(field(after, "dimension_unspecified")).toBeUndefined();
    expect(field(after, "quantity")?.value?.number).toBe(5);
    expect(transport).not.toHaveBeenCalled();
  }
});

it.each(["demo", "full", "compact"] as const)("%sで単なる直径や競合する穴径の軸を推測確定しない", async (format) => {
  for (const [answer, axes] of [["直径です", ["opening_diameter"]], ["直径です", ["outer_diameter", "hole_diameter"]], ["穴径です", ["hole_diameter", "opening_diameter"]]] as const) {
    const s = start("ガラスを購入、300mm、5枚");
    const q = chooseNextQuestion(s, [], false, [{ itemId: s.brief.items[0].id, fieldKeys: [...axes] }])!;
    const raw = format === "compact" ? decodeCompactProposal(s, { n: [], c: [], u: [answer] }) : { schemaVersion: 1, newItems: [], changes: [], ambiguities: [answer], unprocessedQuotes: [] };
    const after = format === "demo" ? extractDemo(s, answer, q) : await extractOnce({ extract: async () => applyExtractionProposal(s, answer, q, raw) }, s, answer, q);
    expect(field(after, "dimension_unspecified")?.value?.number).toBe(300);
    for (const key of ["outer_diameter", "hole_diameter", "opening_diameter"])
      expect(field(after, key), answer).toBeUndefined();
  }
});

function productSnapshot(
  name: string,
  scope: "purchase" | "processing" | "fabrication",
  specifications: Omit<Change, "itemId">[] = [],
) {
  const item = newItem(name, scope === "fabrication" ? "fabrication" : "unknown");
  const request = { purchase: "購入", processing: "加工", fabrication: "製作" }[scope];
  return applyInput(makeSnapshot("supplier-geometry"), {
    id: crypto.randomUUID(),
    type: "customer_text",
    text: [name, request, ...specifications.map((spec) => spec.quote)].join("。"),
  }, [
    { itemId: item.id, key: "product_name", text: name, quote: name },
    { itemId: item.id, key: "request_scope", text: scope, quote: request },
    ...specifications.map((spec) => ({ ...spec, itemId: item.id })),
  ], [item]);
}

it("断熱ブランケットは型番付きでも、厚さ・幅・長さを必要な順に一問ずつ確認する", () => {
  let s = productSnapshot("断熱ブランケット", "purchase", [
    { key: "model", text: "TG-100", quote: "型番TG-100" },
    { key: "thickness", text: "10mm", number: 10, unit: "mm", quote: "厚さ10mm" },
  ]);
  expect(supplierInquiryGeometry(s.brief.items[0])).toEqual(["thickness", "width", "overall_length"]);
  expect(next(s)?.fieldKey).toBe("width");
  s = skip(s, "unknown");
  expect(next(s)?.fieldKey).toBe("overall_length");
  s = skip(s);
  expect(next(s)?.fieldKey).toBe("quantity");
  expect(field(s, "thickness")?.value?.number).toBe(10);
  expect(field(s, "width")?.status).toBe("unknown");
  expect(field(s, "overall_length")?.status).toBe("skipped");
});

it("製作架台は図面ありと答えていても、未確認の幅・高さ・奥行を聞く", () => {
  let s = productSnapshot("設備架台", "fabrication", [
    { key: "drawing_available", text: "あり", quote: "図面あり" },
    { key: "width", text: "500mm", number: 500, unit: "mm", quote: "幅500mm" },
  ]);
  expect(supplierInquiryGeometry(s.brief.items[0])).toEqual(["width", "height", "depth"]);
  expect(next(s)?.fieldKey).toBe("height");
  s = skip(s, "unknown");
  expect(next(s)?.fieldKey).toBe("depth");
  s = skip(s);
  expect(next(s)?.fieldKey).toBe("work_scope");
  s = skip(s);
  expect(next(s)?.fieldKey).toBe("material");
  expect(field(s, "drawing_available")?.value?.text).toBe("あり");
  expect(field(s, "width")?.value?.number).toBe(500);
});

it("架台の組立範囲を受け取っていれば同じ製作範囲を聞き直さない", () => {
  const s = productSnapshot("設備架台", "fabrication", [
    { key: "work_scope", text: "組立まで", quote: "組立まで" },
    { key: "width", text: "500mm", number: 500, unit: "mm", quote: "幅500mm" },
    { key: "height", text: "800mm", number: 800, unit: "mm", quote: "高さ800mm" },
    { key: "depth", text: "700mm", number: 700, unit: "mm", quote: "奥行700mm" },
  ]);
  expect(next(s)?.fieldKey).toBe("material");
  expect(field(s, "work_scope")?.value?.text).toBe("組立まで");
});

it("リングの穴加工で穴径・穴数を入力済みなら位置とピッチを聞く", () => {
  let s = productSnapshot("リング材", "processing", [
    { key: "process", text: "穴加工", quote: "穴加工" },
    { key: "hole_diameter", text: "6mm", number: 6, unit: "mm", quote: "穴径6mm" },
    { key: "hole_count", text: "4か所", number: 4, unit: "か所", quote: "穴は4か所" },
  ]);
  expect(supplierInquiryGeometry(s.brief.items[0])).toEqual(["hole_diameter", "hole_count", "hole_layout"]);
  expect(next(s)).toMatchObject({ fieldKey: "hole_layout", inputType: "text", text: expect.stringContaining("ピッチ") });
  s = skip(s, "unknown");
  expect(next(s)?.fieldKey).toBe("material");
  expect(field(s, "hole_diameter")?.value?.number).toBe(6);
  expect(field(s, "hole_count")?.value?.number).toBe(4);
});

it("交換用ガラス容器で型番が不明なら容量を聞き、指定型番があれば容量を聞かない", () => {
  let s = productSnapshot("交換用ガラス容器", "purchase");
  expect(next(s)?.fieldKey).toBe("model");
  s = skip(s, "unknown");
  expect(next(s)?.fieldKey).toBe("purpose");
  s = skip(s);
  expect(next(s)?.fieldKey).toBe("material");
  s = skip(s);
  expect(next(s)).toMatchObject({ fieldKey: "capacity", text: expect.stringContaining("容量") });
  s = skip(s);
  expect(next(s)?.fieldKey).toBe("quantity");

  const specified = productSnapshot("交換用ガラス容器", "purchase", [
    { key: "model", text: "G-150", quote: "型番G-150" },
  ]);
  expect(supplierInquiryGeometry(specified.brief.items[0])).toEqual([]);
  expect(chooseNextQuestion(specified, [], false, [
    { itemId: specified.brief.items[0].id, fieldKeys: ["width", "capacity"] },
  ], true)?.fieldKey).toBe("quantity");
});

it.each([
  ["毛布", "purchase", "断熱ブランケットと一緒に使う"],
  ["工具", "processing", "リングを穴加工する際に使う"],
  ["リング用工具", "processing", "穴加工に使う"],
  ["架台用塗料", "fabrication", "架台の製作に使う"],
  ["塗料", "fabrication", "架台に塗って使う"],
  ["ガラス容器用の蓋", "purchase", "ガラス容器の交換に使う"],
] as const)("%s を寸法聞き取りの別品種に分類しない", (name, scope, purpose) => {
  const s = productSnapshot(name, scope, [{ key: "purpose", text: purpose, quote: purpose }]);
  expect(supplierInquiryGeometry(s.brief.items[0])).toEqual([]);
});

it("穴加工を頼んでいないリングに穴の寸法を適用しない", () => {
  const s = productSnapshot("リング材", "processing", [
    { key: "process", text: "切断のみ、穴加工なし", quote: "切断のみ、穴加工なし" },
  ]);
  expect(supplierInquiryGeometry(s.brief.items[0])).toEqual([]);
});

it.each(["field_edit", "customer_text"] as const)("品名の訂正後は旧説明に残る断熱ブランケットの寸法を聞かない (%s)", (type) => {
  const before = productSnapshot("断熱ブランケット", "purchase", [
    { key: "description", text: "断熱ブランケット", quote: "断熱ブランケット" },
  ]);
  const itemId = before.brief.items[0].id;
  const text = type === "field_edit" ? "毛布" : "品名を毛布に訂正します";
  const after = applyInput(before, { id: crypto.randomUUID(), type, text }, [
    { itemId, key: "product_name", text: "毛布", quote: text },
  ]);
  expect(field(after, "description")?.value?.text).toBe("断熱ブランケット");
  expect(supplierInquiryGeometry(after.brief.items[0])).toEqual([]);
});
