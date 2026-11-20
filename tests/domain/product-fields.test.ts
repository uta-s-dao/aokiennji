import { expect, it } from "vitest";
import { extractDemo } from "../../src/adapters/extraction";
import { recoverExplicitTurn } from "../../src/adapters/explicit-intake";
import { decodeCompactProposal } from "../../src/domain/compact-extraction";
import {
  applyExtractionProposal,
  type ExtractionProposal,
} from "../../src/domain/extraction-proposal";
import { normalized, parseCapacity } from "../../src/domain/fields";
import { applyInput, makeSnapshot, newItem } from "../../src/domain/intake";
import type { Question, Snapshot } from "../../src/domain/model";

function intakeCase() {
  const snapshot = makeSnapshot("case");
  const item = newItem("ケース", "fabrication");
  return applyInput(
    snapshot,
    { id: "original", text: "ケース", type: "customer_text" },
    [{ itemId: item.id, key: "description", text: "ケース", quote: "ケース" }],
    [item],
  );
}

function question(s: Snapshot, key: string): Question {
  return {
    id: key,
    itemId: s.brief.items[0].id,
    fieldKey: key,
    text: "仕様を教えてください。",
    inputType: "text",
    options: [],
    allowUnknown: true,
    allowSkip: true,
  };
}

const field = (s: Snapshot, key: string) =>
  s.brief.items[0].fields.find((f) => f.key === key);

it.each([
  ["500ml", 500, "mL"],
  ["500ミリリットル", 500, "mL"],
  ["５００ ＭＬ", 500, "mL"],
  ["500㎖", 500, "mL"],
  ["1.5リットル", 1.5, "L"],
  ["1.5リッター", 1.5, "L"],
  ["2ℓ", 2, "L"],
  ["2l", 2, "L"],
  ["2㍑", 2, "L"],
])("自然な容量表記を正規化する: %s", (text, number, unit) => {
  expect(parseCapacity(text)).toEqual({
    text: `${number}${unit}`,
    number,
    unit,
  });
  expect(normalized(number, unit)).toEqual({
    dimension: "volume",
    value: unit === "L" ? number * 1000 : number,
  });
});

it.each(["500", "-500mL", "500mm", "0ml", "500mLfoo"])(
  "単位なし、長さ、不正値を容量に推測しない: %s",
  (text) => {
    expect(parseCapacity(text)).toBeNull();
    const snapshot = intakeCase();
    expect(
      recoverExplicitTurn(snapshot, text, question(snapshot, "capacity")),
    ).toBeNull();
  },
);

it.each(["full", "compact"] as const)(
  "%s提案で容量と穴配置と外径を同じ発言から一つの品目へ保存する",
  (format) => {
    const s = intakeCase();
    const capacity = "容量は1.5リットル",
      layout = "穴位置は左端から20mm",
      width = "外径は100mm";
    const text = [capacity, layout, width].join("、");
    const proposal: ExtractionProposal =
      format === "compact"
        ? decodeCompactProposal(s, {
            n: [],
            c: [
              {
                i: "0",
                k: "cp",
                v: "1.5リットル",
                q: capacity,
                o: "s",
                h: true,
              },
              { i: "0", k: "hl", v: layout, q: layout, o: "s", h: true },
              { i: "0", k: "od", v: "100mm", q: width, o: "s", h: true },
            ],
            u: [],
          })
        : {
            schemaVersion: 1,
            newItems: [],
            ambiguities: [],
            unprocessedQuotes: [],
            changes: [
              {
                key: "capacity",
                value: { text: "1.5リットル", number: 1.5, unit: "リットル" },
                quote: capacity,
              },
              {
                key: "hole_layout",
                value: { text: layout, number: null, unit: null },
                quote: layout,
              },
              {
                key: "outer_diameter",
                value: { text: "100mm", number: 100, unit: "mm" },
                quote: width,
              },
            ].map((change) => ({
              ...change,
              itemRef: s.brief.items[0].id,
              status: "known",
              operation: "set",
              hardConstraint: true,
            })),
          };
    const result = applyExtractionProposal(
      s,
      text,
      question(s, "capacity"),
      proposal,
    );
    expect(field(result, "capacity")).toMatchObject({
      quote: capacity,
      value: { text: "1.5L", number: 1.5, unit: "L" },
    });
    expect(field(result, "hole_layout")).toMatchObject({
      quote: layout,
      value: { text: layout },
    });
    expect(field(result, "outer_diameter")?.value?.number).toBe(100);
    expect(field(result, "dimension_unspecified")).toBeUndefined();
  },
);

it.each([
  ["capacity", "500", "容量は500", "500mL", "cp"],
  ["capacity", "容量は500〜600mL", "容量は500〜600mL", "600mL", "cp"],
  ["hole_layout", "図面あり", "図面あり", "図面あり", "hl"],
  ["hole_layout", "外径は50mm", "外径は50mm", "外径は50mm", "hl"],
])(
  "提案があっても根拠にない値は保存しない: %s %s",
  (key, text, quote, value, code) => {
    const s = intakeCase();
    const change = decodeCompactProposal(s, {
      n: [],
      c: [{ i: "0", k: code, v: value, q: quote, o: "s", h: true }],
      u: [],
    });
    expect(() =>
      applyExtractionProposal(s, text, question(s, key), change),
    ).toThrow("INVALID_EXTRACTION");
  },
);

it("手動編集は容量の原文を残して正規化し、単位なしの数値を拒否する", () => {
  const s = intakeCase();
  const itemId = s.brief.items[0].id;
  const text = "５００ミリリットル";
  const result = applyInput(s, { id: "edit", text, type: "field_edit" }, [
    { itemId, key: "capacity", text, quote: text },
  ]);
  expect(field(result, "capacity")).toMatchObject({
    quote: text,
    source: "field_edit",
    value: { text: "500mL", number: 500, unit: "mL" },
  });
  expect(() =>
    applyInput(s, { id: "edit", text: "500", type: "field_edit" }, [
      {
        itemId,
        key: "capacity",
        text: "500",
        number: 500,
        unit: "mL",
        quote: "500",
      },
    ]),
  ).toThrow("INVALID_INPUT");
  const layout = "対角の四隅に穴";
  const edited = applyInput(
    s,
    { id: "edit-layout", text: layout, type: "field_edit" },
    [{ itemId, key: "hole_layout", text: layout, quote: layout }],
  );
  expect(field(edited, "hole_layout")?.value?.text).toBe(layout);
});

it.each(["capacity", "hole_layout"])(
  "不明回答・スキップを値なしで保存する: %s",
  (key) => {
    const s = intakeCase();
    const itemId = s.brief.items[0].id;
    for (const [status, quote] of [
      ["unknown", "分からない"],
      ["skipped", "スキップ"],
    ] as const) {
      const result = applyInput(
        s,
        { id: status, text: quote, type: "selection" },
        [{ itemId, key, status, quote }],
      );
      expect(field(result, key)).toMatchObject({ status, value: null });
    }
  },
);

it("demoと局所回復でも容量とピッチを長さの未確定軸に落とさない", () => {
  const s = intakeCase();
  const text = "容量は500ml、穴ピッチは40mm、外径は100mm";
  for (const result of [
    recoverExplicitTurn(s, text, null)!,
    extractDemo(s, text),
  ]) {
    expect(field(result, "capacity")?.value?.text).toBe("500mL");
    expect(field(result, "hole_layout")?.value?.text).toBe("穴ピッチは40mm");
    expect(field(result, "outer_diameter")?.value?.number).toBe(100);
    expect(field(result, "dimension_unspecified")).toBeUndefined();
  }
  const direct = recoverExplicitTurn(
    s,
    "左端から20mm",
    question(s, "hole_layout"),
  )!;
  expect(field(direct, "hole_layout")?.value?.text).toBe("左端から20mm");
  const drawing = extractDemo(s, "図面あり", question(s, "hole_layout"));
  expect(field(drawing, "hole_layout")).toBeUndefined();
});
