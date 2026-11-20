import { expect, it, vi } from "vitest";
import { extractDemo } from "../../src/adapters/extraction";
import { applyInput, chooseNextQuestion, makeResearchBrief, makeSnapshot } from "../../src/domain/intake";
import { applyExtractionProposal } from "../../src/domain/extraction-proposal";
import { decodeCompactProposal } from "../../src/domain/compact-extraction";
import { OpenAIIntakeExtractor } from "../../src/adapters/openai-intake";
import type { Snapshot } from "../../src/domain/model";

const value = (s: Snapshot, key: string, index = 0) => s.brief.items[index].fields.find((f) => f.key === key);
const start = () => extractDemo(makeSnapshot("manufacturing"), "SUS304を旋盤加工、300mm、5個、希望納期は来月上旬");
const axes = (s: Snapshot) => [{ itemId: s.brief.items[0].id, fieldKeys: ["outer_diameter", "overall_length"] }];

it("加工・材質・数量・納期と未分類寸法を原文付きで引き継ぎ、照合軸に必要な一問を先に聞く", () => {
  const s = start();
  expect(value(s, "process")?.value?.text).toBe("旋盤加工");
  expect(value(s, "material")?.value?.text).toBe("SUS304");
  expect(value(s, "quantity")?.value?.number).toBe(5);
  expect(value(s, "required_date")?.value?.text).toBe("来月上旬");
  expect(value(s, "outer_diameter")).toBeUndefined();
  expect(value(s, "overall_length")).toBeUndefined();
  expect(value(s, "dimension_unspecified")?.value).toEqual({ text: "300mm", number: 300, unit: "mm" });
  expect(value(s, "dimension_unspecified")?.quote).toBe("300mm");
  const q = chooseNextQuestion(s, [], false, axes(s))!;
  expect(q.fieldKey).toBe("dimension_unspecified");
  expect(q.text).toContain("外径・全長");
  expect(q.text.length).toBeLessThan(100);
  const after = extractDemo(s, "全長です", q);
  expect(after.brief.items[0].id).toBe(s.brief.items[0].id);
  expect(value(after, "overall_length")?.value?.number).toBe(300);
  expect(value(after, "overall_length")?.quote).toBe("300mm");
  expect(value(after, "overall_length")?.eventId).toBe(value(s, "dimension_unspecified")?.eventId);
  expect(value(after, "dimension_unspecified")).toBeUndefined();
  expect(after.dimensionCandidates).toEqual([]);
  const edited = extractDemo(after, "数量を5個ではなく8個に訂正します", chooseNextQuestion(after, [], false, axes(after)));
  expect(value(edited, "quantity")?.value?.number).toBe(8);
  expect(value(edited, "overall_length")).toEqual(value(after, "overall_length"));
  expect(value(edited, "material")).toEqual(value(after, "material"));
  expect(makeResearchBrief(edited, 2, 0).items[0].fields.some((f) => f.key === "dimension_unspecified")).toBe(false);
});

it("明示された全長・長さと単位は未分類にせず保持する", () => {
  for (const label of ["全長", "長さ"]) {
    const s = extractDemo(makeSnapshot("length"), `部品Aを旋盤加工、${label}30cm、外径20mm、数量5個`);
    expect(value(s, "overall_length")?.value?.number).toBe(30);
    expect(value(s, "overall_length")?.value?.unit).toBe("cm");
    expect(value(s, "outer_diameter")?.value?.number).toBe(20);
    expect(value(s, "dimension_unspecified")).toBeUndefined();
  }
});

it("空の適用軸は優先質問をせず、未指定はルールから軸を得る", () => {
  const s = start();
  expect(chooseNextQuestion(s, [], false, [])?.fieldKey).not.toBe("dimension_unspecified");
  expect(chooseNextQuestion(s, [])?.fieldKey).not.toBe("dimension_unspecified");
  // Only the axis fields of the matched category are used for the default.
  const rules = [{ category: null, requiredFields: ["overall_length"], predicates: [] }] as never;
  expect(chooseNextQuestion(s, rules)?.fieldKey).toBe("dimension_unspecified");
});

it.each(["unknown", "skipped"] as const)("寸法種別を%sとして進めても再質問せず原文と候補を残す", (status) => {
  const s = start();
  const q = chooseNextQuestion(s, [], false, axes(s))!;
  const text = status === "unknown" ? "不明" : "スキップ";
  const after = applyInput(s, { id: "defer", text, type: "selection" }, [{ itemId: q.itemId!, key: q.fieldKey, status, quote: text }]);
  expect(chooseNextQuestion(after, [], false, axes(after))?.fieldKey).not.toBe(q.fieldKey);
  expect(after.dimensionCandidates?.[0].number).toBe(300);
  expect(after.inputs[0].text).toContain("300mm");
  expect(makeResearchBrief(after, 2, 1).items[0].notes).toContain(`寸法種別は未確認：300mm（申告原文：300mm。種別の回答：${text}）`);
});

it("複数品目は質問対象だけの未分類寸法を確定し、既知の寸法は上書きしない", () => {
  const s = extractDemo(makeSnapshot("multi"), "部品Aを旋盤加工、300mm、5個\n部品Bを旋盤加工、200mm、2個");
  const q = chooseNextQuestion(s, [], false, axes(s))!;
  const after = extractDemo(s, "全長です", q);
  expect(value(after, "overall_length", 0)?.value?.number).toBe(300);
  expect(value(after, "overall_length", 1)).toBeUndefined();
  expect(value(after, "dimension_unspecified", 1)?.value?.number).toBe(200);
  const existing = extractDemo(start(), "全長は100mmです");
  const q2 = chooseNextQuestion(existing, [], false, axes(existing))!;
  const refused = extractDemo(existing, "全長です", q2);
  expect(value(refused, "overall_length")?.value?.number).toBe(100);
  expect(value(refused, "dimension_unspecified")?.value?.number).toBe(300);
});

const proposal = (key = "dimension_unspecified") => ({
  schemaVersion: 1, newItems: [{ ref: "n1", label: "部品A", profile: "unknown", category: null, quote: "部品Aを旋盤加工、300mm、5個" }],
  changes: [{ itemRef: "n1", key, status: "known", value: { text: "300mm", number: 300, unit: "mm" }, quote: "300mm", operation: "set", hardConstraint: true }], ambiguities: [], unprocessedQuotes: [],
});
it.each(["dimension_unspecified", "outer_diameter", "overall_length"])("構造出力の%sでも根拠のない寸法軸を確定しない", (key) => {
  const s = applyExtractionProposal(makeSnapshot("full"), "部品Aを旋盤加工、300mm、5個", null, proposal(key));
  expect(value(s, "dimension_unspecified")?.value?.number).toBe(300);
  expect(value(s, "overall_length")).toBeUndefined();
  expect(value(s, "outer_diameter")).toBeUndefined();
});
it("compactの未分類寸法・全長コードを復元し、OpenAI経路も原文を使って種別回答を確定する", async () => {
  const raw = { n: [{ i: "n1", n: "部品A", q: "部品Aを旋盤加工、300mm、5個", p: "u" }], c: [{ i: "n1", k: "ud", v: "300mm", q: "300mm", o: "s", h: true }], u: [] };
  const s = applyExtractionProposal(makeSnapshot("compact"), "部品Aを旋盤加工、300mm、5個", null, decodeCompactProposal(makeSnapshot("compact"), raw));
  const q = chooseNextQuestion(s, [], false, axes(s))!;
  const transport = vi.fn();
  const extractor = new OpenAIIntakeExtractor({ key: "offline", model: "offline", maxOutputTokens: 1000, maxCallsTotal: 1, maxCallsPerCase: 1 }, [], transport);
  const after = await extractor.extract(s, "全長です", q);
  expect(value(after, "overall_length")?.value?.number).toBe(300);
  expect(transport).not.toHaveBeenCalled();
  expect(decodeCompactProposal(after, { n: [], c: [{ i: "0", k: "ol", v: "40cm", q: "全長40cmに訂正", o: "c", h: true }], u: [] }).changes[0].key).toBe("overall_length");
});
it("モデルの未分類寸法にも品目帰属と原文検証を要求する", () => {
  const raw = proposal();
  raw.changes[0].quote = "400mm";
  expect(() => applyExtractionProposal(makeSnapshot("bad"), "部品Aを旋盤加工、300mm、5個", null, raw)).toThrow();
  const s = extractDemo(makeSnapshot("multi"), "部品Aを旋盤加工\n部品Bを旋盤加工");
  expect(() => applyExtractionProposal(s, "300mm", null, { ...proposal(), newItems: [], changes: [{ ...proposal().changes[0], itemRef: s.brief.items[0].id }] })).toThrow();
});

it.each([
  ["パッキンを購入したい", "purchase", "パッキン", null, null],
  ["耐熱金物を購入したい", "purchase", "耐熱金物", null, null],
  ["ステンレス板を購入したい", "purchase", "ステンレス板", "ステンレス", null],
  ["SUS304を旋盤加工、300mm、5個", "processing", "SUS304", "SUS304", "旋盤加工"],
])("通常demo entryから依頼範囲と品目語を保存する: %s", (text, scope, term, material, process) => {
  const s = extractDemo(makeSnapshot("entry"), text);
  expect(value(s, "request_scope")?.value?.text).toBe(scope);
  expect(s.brief.items[0].label + value(s, "description")?.value?.text).toContain(term);
  if (material) expect(value(s, "material")?.value?.text).toBe(material);
  if (process) expect(value(s, "process")?.value?.text).toBe(process);
  expect(makeResearchBrief(s, 2, 1).items[0].id).toBe(s.brief.items[0].id);
});
it("照合軸が外径だけでも別の寸法を回答できる文面を示す", () => {
  const s = start();
  const q = chooseNextQuestion(s, [], false, [{ itemId: s.brief.items[0].id, fieldKeys: ["outer_diameter"] }])!;
  expect(q.text).toContain("外径の寸法でしょうか、それとも別の寸法ですか");
  expect(value(extractDemo(s, "全長です", q), "overall_length")?.value?.number).toBe(300);
});
it.each(["full", "compact"] as const)("OpenAI %sのmock構造応答から300mmを保持して正しい品目の全長へ確定する", async (format) => {
  const raw = format === "full" ? proposal() : { n: [{ i: "n1", n: "部品A", q: "部品Aを旋盤加工、300mm、5個", p: "u" }], c: [{ i: "n1", k: "ud", v: "300mm", q: "300mm", o: "s", h: true }], u: [] };
  const transport = vi.fn(async () => new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(raw) }] }] })));
  const extractor = new OpenAIIntakeExtractor({ key: "offline", model: "offline", format, maxOutputTokens: 1000, maxCallsTotal: 2, maxCallsPerCase: 2 }, [], transport);
  const s = await extractor.extract(makeSnapshot("mock"), "部品Aを旋盤加工、300mm、5個", null);
  expect(value(s, "dimension_unspecified")?.quote).toBe("300mm");
  const after = await extractor.extract(s, "全長です", chooseNextQuestion(s, [], false, axes(s)));
  expect(value(after, "overall_length")?.value?.number).toBe(300);
  expect(transport).toHaveBeenCalledTimes(1);
});
it.each(["ambiguities", "unprocessedQuotes"] as const)("モデルの%sに残った寸法値も軸を推測せず保持する", (list) => {
  const raw = { ...proposal(), changes: [], [list]: ["300mm"] };
  const s = applyExtractionProposal(makeSnapshot("retained"), "部品Aを旋盤加工、300mm、5個", null, raw);
  expect(value(s, "dimension_unspecified")?.value?.number).toBe(300);
});
it("外径と書かれた数値を全長へ取り違えた構造応答は拒否する", () => {
  const raw = proposal("overall_length");
  raw.newItems[0].quote = "部品Aを旋盤加工、外径300mm、5個";
  expect(() => applyExtractionProposal(makeSnapshot("wrong-axis"), raw.newItems[0].quote, null, raw)).toThrow();
});
it.each(["full", "compact"] as const)("%sの数量訂正は既存の全長・材質・加工を変えない", (format) => {
  const initial = start();
  const s = extractDemo(initial, "全長です", chooseNextQuestion(initial, [], false, axes(initial)));
  const text = "数量8個に訂正";
  const raw = format === "full" ? { schemaVersion: 1, newItems: [], changes: [{ itemRef: s.brief.items[0].id, key: "quantity", status: "known", value: { text: "8個", number: 8, unit: "個" }, quote: text, operation: "correct", hardConstraint: true }], ambiguities: [], unprocessedQuotes: [] } : decodeCompactProposal(s, { n: [], c: [{ i: "0", k: "qt", v: "8個", q: text, o: "c", h: true }], u: [] });
  const after = applyExtractionProposal(s, text, chooseNextQuestion(s, [], false, axes(s)), raw);
  expect(value(after, "quantity")?.value?.number).toBe(8);
  for (const key of ["overall_length", "material", "process"]) expect(value(after, key)).toEqual(value(s, key));
});

it("複数の加工種別を一つに落とさず原文の範囲で保持する", () => {
  const s = extractDemo(makeSnapshot("processes"), "SUS304を旋盤加工と溶接でお願いします");
  expect(value(s, "process")?.value?.text).toBe("旋盤加工と溶接");
});
