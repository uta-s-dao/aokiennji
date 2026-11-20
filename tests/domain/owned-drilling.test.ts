import { expect, it } from "vitest";
import { recoverExplicitTurn } from "../../src/adapters/explicit-intake";
import { restoreOpeningTurn } from "../../src/adapters/restore-intake";
import { decodeCompactProposal } from "../../src/domain/compact-extraction";
import { applyExtractionProposal } from "../../src/domain/extraction-proposal";
import { chooseNextQuestion, makeSnapshot } from "../../src/domain/intake";
import type { Snapshot } from "../../src/domain/model";

const opening = "手持ちのリングに穴をあけてほしいです。";
const restated = "手持ちのリングに穴あけ加工をお願いします。";
const ask = (state: Snapshot) =>
  chooseNextQuestion(state, [], false, undefined, true);

it.each([opening, restated])(
  "手持ちの加工対象と穴あけ依頼を原文から復元する: %s",
  (text) => {
    const result = recoverExplicitTurn(makeSnapshot("case"), text, null)!;
    expect(result.brief.items).toHaveLength(1);
    const [ring] = result.brief.items;
    expect(ring.label).toBe("リング");
    expect(
      Object.fromEntries(ring.fields.map((f) => [f.key, f.value?.text])),
    ).toMatchObject({
      product_name: "リング",
      request_scope: "processing",
      process: expect.stringMatching(/穴/),
      material_supply: "customer_supplied",
    });
    for (const field of ring.fields) expect(text).toContain(field.quote);
    expect(ring.fields.some((f) => f.key === "material")).toBe(false);

    const diameter = ask(result)!;
    expect(diameter.fieldKey).toBe("hole_diameter");
    const measured = recoverExplicitTurn(result, "8mm", diameter)!;
    const count = ask(measured)!;
    expect(count.fieldKey).toBe("hole_count");
    const counted = recoverExplicitTurn(measured, "4か所", count)!;
    const layout = ask(counted)!;
    expect(layout.fieldKey).toBe("hole_layout");
    const finished = recoverExplicitTurn(counted, "穴位置は四隅", layout)!;
    expect(
      finished.brief.items[0].fields.find((f) => f.key === "hole_layout")?.value
        ?.text,
    ).toBe("穴位置は四隅");
  },
);

it.each([
  ["手持ちのリングに穴をあけません。"],
  ["手持ちのリングに穴をあけるとしたらどうですか？"],
  ["手持ちのリングとカバーに穴あけ加工をお願いします。"],
  ["手持ちのリングに穴あけ加工をお願いします。別の部品もあります。"],
  ["塗料だけ支給するのでリングに穴あけ加工をお願いします。"],
])("否定、候補、複数対象や塗料支給を確定しない: %s", (text) => {
  expect(recoverExplicitTurn(makeSnapshot("case"), text, null)).toBeNull();
});

it.each([opening, restated])(
  "モデル提案も原文の加工と手持ちの対象を根拠にできる: %s",
  (text) => {
    const s = makeSnapshot("case");
    const process = text === opening ? "穴をあけ" : "穴あけ加工";
    const proposal = decodeCompactProposal(s, {
      n: [{ i: "n1", n: "リング", q: text, p: "u" }],
      c: [
        { i: "n1", k: "rs", v: "processing", q: process, o: "s", h: true },
        { i: "n1", k: "pr", v: process, q: process, o: "s", h: true },
        {
          i: "n1",
          k: "ms",
          v: "customer_supplied",
          q: "手持ちのリング",
          o: "s",
          h: true,
        },
      ],
      u: [],
    });
    expect(
      ask(applyExtractionProposal(s, text, null, proposal))?.fieldKey,
    ).toBe("hole_diameter");
  },
);

it.each(["塗料を支給します", "塗料は客先支給です"])(
  "塗料支給だけから材料支給を保存しない: %s",
  (text) => {
    const s = recoverExplicitTurn(makeSnapshot("case"), opening, null)!;
    s.brief.items[0].fields = s.brief.items[0].fields.filter(
      (f) => f.key !== "material_supply",
    );
    const proposal = decodeCompactProposal(s, {
      n: [],
      c: [
        { i: "0", k: "ms", v: "customer_supplied", q: text, o: "s", h: true },
      ],
      u: [],
    });
    expect(() => applyExtractionProposal(s, text, null, proposal)).toThrow(
      "INVALID_EXTRACTION",
    );
  },
);

it("同じ加工の言い換えで失敗した既存案件を、元入力を残して一品目へ復元する", () => {
  const inputs = [opening, restated].map((text, index) => ({
    id: String(index),
    type: "customer_text" as const,
    text,
  }));
  const s = {
    ...makeSnapshot("case"),
    extractionFailed: true,
    extractionError: "INVALID_EXTRACTION",
    inputs,
    unresolvedInputs: inputs,
  };
  const restored = restoreOpeningTurn(s)!;
  expect(restored.inputs).toEqual(inputs);
  expect(restored.unresolvedInputs).toEqual([]);
  expect(restored.brief.items).toHaveLength(1);
  expect(ask(restored)?.fieldKey).toBe("hole_diameter");
  expect(restoreOpeningTurn(restored)).toBeNull();
  const different = [
    inputs[0],
    { ...inputs[1], text: restated.replace("リング", "カバー") },
  ];
  expect(
    restoreOpeningTurn({
      ...s,
      inputs: different,
      unresolvedInputs: different,
    }),
  ).toBeNull();
});

it("穴をあけない指示から加工依頼を確定しない", () => {
  const s = makeSnapshot("case");
  const text = "手持ちのリングに穴をあけないでください。";
  const proposal = decodeCompactProposal(s, {
    n: [{ i: "n1", n: "リング", q: text, p: "u" }],
    c: [{ i: "n1", k: "rs", v: "processing", q: "穴をあけ", o: "s", h: true }],
    u: [],
  });
  expect(() => applyExtractionProposal(s, text, null, proposal)).toThrow(
    "INVALID_EXTRACTION",
  );
});
