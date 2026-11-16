import { it, expect, vi } from "vitest";
import recorded from "../../docs/LIVE-FAST-INTAKE-20261117.json";
import dataset from "../../fixtures/evaluation/live-cases-20261116.json";
import knowledge from "../../fixtures/demo/knowledge.json";
import { OpenAIIntakeExtractor } from "../../src/adapters/openai-intake";
import { extractOnce, extractDemo } from "../../src/adapters/extraction";
import {
  applyExtractionProposal,
  type ExtractionProposal,
} from "../../src/domain/extraction-proposal";
import {
  makeSnapshot,
  makeResearchBrief,
  chooseNextQuestion,
} from "../../src/domain/intake";
import { decideAvailability } from "../../src/domain/decision";
import { makeMailDraft } from "../../src/domain/mail";
import type { CapabilityRule, Source, Snapshot } from "../../src/domain/model";

type Row = {
  id: string;
  caseId: string;
  format: "full" | "compact";
  phase: string;
  rawWireProposal: unknown;
  rawProposal: ExtractionProposal;
};
const rows = (recorded.calls as unknown as Row[]).filter(
  (c) => c.phase === "fast",
);
const rules = knowledge.rules as CapabilityRule[],
  sources = knowledge.sources as Source[];
const seeds = recorded.seeds as unknown as Record<string, Snapshot>;
const full = (id: string) =>
  structuredClone(
    rows.find((c) => c.caseId === id && c.format === "full")!.rawProposal,
  );
const field = (s: Snapshot, label: string, key: string) =>
  s.brief.items
    .find((i) => i.label.includes(label))
    ?.fields.find((f) => f.key === key);

for (const row of rows)
  it("保存した実応答をadapterから再生（通信0）: " + row.id, async () => {
    const sample = dataset.cases.find((c) => c.id === row.caseId)!,
      s = structuredClone(seeds[row.caseId]);
    const original = structuredClone(row.rawWireProposal);
    const transport = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: "completed",
            output: [
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify(row.rawWireProposal),
                  },
                ],
              },
            ],
          }),
        ),
    );
    const result = await extractOnce(
      new OpenAIIntakeExtractor(
        {
          key: "fake-key",
          model: "gpt-6-luna",
          format: row.format,
          reasoning: "none",
          maxOutputTokens: 1024,
          maxCallsTotal: 1,
          maxCallsPerCase: 1,
        },
        rules.map((r) => r.category),
        transport,
      ),
      s,
      sample.input,
      chooseNextQuestion(s, rules),
    );
    expect(transport).toHaveBeenCalledTimes(1);
    expect(row.rawWireProposal).toEqual(original);
    expect(result.extractionFailed).toBe(false);
    expect(result.unresolvedInputs).toEqual([]);
    const decision = decideAvailability(
        makeResearchBrief(result, 2, 1),
        rules,
        sources,
        "replay",
      ),
      mail = makeMailDraft(result, decision);
    if (row.caseId === "E01") {
      expect(field(result, "AX-100", "model")?.value?.text).toBe("AX-100");
      expect(field(result, "AX-100", "quantity")?.value).toMatchObject({
        number: 2,
        unit: "台",
      });
      expect(chooseNextQuestion(result, rules)).toBeNull();
      expect(decision.verdict).toBe("can_handle");
      expect(mail.body).toContain("AX-100");
    } else if (row.caseId === "E07") {
      expect(field(result, "ガラス", "normal_temperature")?.value?.number).toBe(
        680,
      );
      expect(field(result, "ガラス", "peak_temperature")?.value?.number).toBe(
        820,
      );
      expect(mail.body).not.toContain("780℃");
      expect(decision.verdict).not.toBe("can_handle");
    } else {
      expect(field(result, "カバー", "quantity")?.value?.number).toBe(4);
      expect(field(result, "ネック", "quantity")?.value?.number).toBe(8);
      expect(field(result, "カバー", "coating")?.value?.text).toBe("不要");
      expect(field(result, "ネック", "coating")?.value?.text).toBe("外装塗装");
      expect(field(result, "カバー", "destination")?.value?.text).toBe("大阪");
      expect(field(result, "ネック", "destination")?.value?.text).toBe("神戸");
      expect(decision.verdict).not.toBe("can_handle");
      expect(mail.body).toContain("大阪");
      expect(mail.body).toContain("神戸");
    }
    for (const item of result.brief.items)
      for (const f of item.fields)
        if (f.status === "known")
          expect(
            result.inputs.some(
              (input) =>
                typeof f.quote === "string" && input.text.includes(f.quote),
            ),
          ).toBe(true);
  });

const multiText = dataset.cases.find((c) => c.id === "E14")!.input;
it.each([
  "swapped-paint",
  "swapped-destination",
  "repeated-quote",
  "two-owners",
  "fabricated-paint",
])("品目対応を一意に証明できない応答は拒否: %s", (kind) => {
  const p = full("E14");
  let text = multiText;
  if (kind === "swapped-paint" || kind === "swapped-destination") {
    const key = kind === "swapped-paint" ? "coating" : "destination";
    const changes = p.changes.filter((c) => c.key === key);
    [changes[0].itemRef, changes[1].itemRef] = [
      changes[1].itemRef,
      changes[0].itemRef,
    ];
  }
  if (kind === "repeated-quote") {
    text =
      "カバーは4組、塗装不要、配送先は大阪です。ネックは8組、塗装不要、配送先は神戸です。";
    const c = p.changes.find(
      (c) => c.key === "coating" && c.value?.text === "外装塗装",
    )!;
    c.value!.text = "不要";
    c.quote = "塗装不要";
  }
  if (kind === "two-owners")
    text = multiText.replace("大阪です。ネック", "大阪です、ネック");
  if (kind === "fabricated-paint")
    p.changes.find((c) => c.key === "coating")!.quote = "カバーは塗装不要";
  expect(() =>
    applyExtractionProposal(makeSnapshot("s"), text, null, p),
  ).toThrow("INVALID_EXTRACTION");
});

function quantityOnly(): ExtractionProposal {
  return {
    schemaVersion: 1,
    newItems: [
      {
        ref: "new",
        label: "AX-100",
        quote: "AX-100",
        profile: "known_model",
        category: null,
      },
    ],
    changes: [
      {
        itemRef: "new",
        key: "quantity",
        status: "known",
        value: { text: "2台", number: 2, unit: "台" },
        quote: "数量2台",
        operation: "set",
        hardConstraint: true,
      },
    ],
    ambiguities: [],
    unprocessedQuotes: [],
  };
}
it.each([
  "型番AX-100を2台購入しません。",
  "型番AX-100は2台ならどうでしょうか。",
  "型番AX-100を約2台購入したい。",
  "型番AX-100を2台以上購入したい。",
  "型番AX-100を2台購入、別途2台必要です。",
  "型番AX-100を12台購入したい。",
  "型番AX-100です。別製品を2台購入したい。",
])(
  "数量引用の復元で否定・仮定・範囲・重複・部分一致・別対象を通さない: %s",
  (text) => {
    expect(() =>
      applyExtractionProposal(makeSnapshot("s"), text, null, quantityOnly()),
    ).toThrow("INVALID_EXTRACTION");
  },
);
it.each(["wrong-number", "wrong-unit", "arbitrary-quote", "existing-item"])(
  "数量復元でも不正値や既存品目の更新を許可しない: %s",
  (kind) => {
    const p = quantityOnly();
    let s = makeSnapshot("s");
    if (kind === "wrong-number") p.changes[0].value!.number = 3;
    if (kind === "wrong-unit") p.changes[0].value!.unit = "枚";
    if (kind === "arbitrary-quote") p.changes[0].quote = "数量は2台";
    if (kind === "existing-item") {
      s = extractDemo(s, "AX-100を購入したい");
      p.newItems = [];
      p.changes[0].itemRef = s.brief.items[0].id;
    }
    expect(() =>
      applyExtractionProposal(s, "型番AX-100を2台購入したい。", null, p),
    ).toThrow("INVALID_EXTRACTION");
  },
);
it.each([
  "型番AX-100Bを購入したい。",
  "型番AX-100／Bを購入したい。",
  "型番AX-100‐Bを購入したい。",
  "型番AX-100型を購入したい。",
  "型番AX-100αを購入したい。",
  "型番AX-100ではなくAX-200です。",
  "候補の型番AX-100です。",
  "旧型番AX-100です。",
  "型番AX-100ですか？",
  "AX-100を購入したい。",
  "型番AX-100は未定です。",
  "型番AX-100かAX-200です。",
  "型番AX-100とAX-200のどちらかです。",
  "型番AX-100のような製品です。",
  "候補です。型番AX-100です。",
])("明示された完全な確定型番以外をラベルから保存しない: %s", (text) => {
  const p = quantityOnly();
  p.changes = [];
  const result = applyExtractionProposal(makeSnapshot("s"), text, null, p);
  expect(field(result, "AX-100", "model")).toBeUndefined();
});
it("型番属性の不明・仮定をラベル補完で上書きしない", () => {
  const p = quantityOnly();
  p.changes = [
    {
      itemRef: "new",
      key: "model",
      status: "known",
      value: { text: "AX-100", number: null, unit: null },
      quote: "型番AX-100ならどうでしょうか",
      operation: "hypothetical",
      hardConstraint: true,
    },
  ];
  const result = applyExtractionProposal(
    makeSnapshot("s"),
    "型番AX-100ならどうでしょうか",
    null,
    p,
  );
  expect(field(result, "AX-100", "model")?.value).toBeFalsy();
  expect(result.unresolvedInputs?.[0].text).toContain("ならどう");
});
it("複数数値のある原文を数値引用に広げて通常/最高温度を混同しない", () => {
  const p = quantityOnly();
  p.changes = [
    {
      itemRef: "new",
      key: "normal_temperature",
      status: "known",
      value: { text: "820℃", number: 820, unit: "℃" },
      quote: "通常680℃、最高820℃",
      operation: "set",
      hardConstraint: true,
    },
  ];
  expect(() =>
    applyExtractionProposal(
      makeSnapshot("s"),
      "型番AX-100です。通常680℃、最高820℃。",
      null,
      p,
    ),
  ).toThrow("INVALID_EXTRACTION");
});
