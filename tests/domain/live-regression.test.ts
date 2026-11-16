import { describe, it, expect } from "vitest";
import recorded from "../../docs/LIVE-EVALUATION-20261116.json";
import dataset from "../../fixtures/evaluation/live-cases-20261116.json";
import knowledge from "../../fixtures/demo/knowledge.json";
import { extractDemo, extractOnce } from "../../src/adapters/extraction";
import {
  applyExtractionProposal,
  type ExtractionProposal,
} from "../../src/domain/extraction-proposal";
import {
  makeSnapshot,
  makeResearchBrief,
  applyInput,
  chooseNextQuestion,
} from "../../src/domain/intake";
import { decideAvailability } from "../../src/domain/decision";
import { makeMailDraft } from "../../src/domain/mail";
import { resolveCategories } from "../../src/domain/category";
import type {
  CapabilityRule,
  Source,
  Item,
  Snapshot,
} from "../../src/domain/model";

const rules = knowledge.rules as CapabilityRule[];
const sources = knowledge.sources as Source[];
type WantedValue = string | { number: number; unit: string };
type Sample = {
  id: string;
  input: string;
  prior?: string;
  expected: {
    safeUnresolved?: boolean;
    items?: number;
    fields?: Record<string, WantedValue>;
    statuses?: Record<string, string>;
    requiredFieldContains?: Record<string, string>;
    additionalQuestions?: number;
    mustNotHandle?: boolean;
    verdict?: string;
    scope?: string;
    mustNotInferCustomerMaterial?: boolean;
    mailMustNotContain?: string[];
    parts?: {
      label: string;
      fields?: Record<string, WantedValue>;
      contains?: Record<string, string>;
    }[];
  };
};
function seed(sample: Sample) {
  const s = sample.prior
    ? extractDemo(makeSnapshot(sample.id), sample.prior)
    : makeSnapshot(sample.id);
  for (const item of s.brief.items) {
    const subject = item.label.match(/ガラス|パッキン|架台|リング材/)?.[0];
    if (subject) {
      item.label = subject;
      const f = item.fields.find((f) => f.key === "description");
      if (f?.value) f.value.text = subject;
    }
  }
  return s;
}
function proposal(sample: Sample, s: Snapshot) {
  const row = recorded.calls.find(
    (c) => c.phase === "suite" && c.caseId === sample.id,
  )!;
  const p = structuredClone(row.rawProposal) as ExtractionProposal;
  for (const change of p.changes) {
    const i = row.items!.findIndex((item) => item.id === change.itemRef);
    if (i >= 0 && s.brief.items[i]) change.itemRef = s.brief.items[i].id;
  }
  return p;
}
const field = (item: Item | undefined, key: string) =>
  item?.fields.find((f) => f.key === key);
function compare(item: Item | undefined, key: string, expected: WantedValue) {
  if (typeof expected === "string")
    expect(field(item, key)?.value?.text, key).toBe(expected);
  else expect(field(item, key)?.value, key).toMatchObject(expected);
}
const decide = (s: Snapshot) =>
  decideAvailability(makeResearchBrief(s, 2, 1), rules, sources, "replay");

describe("保存した20応答による修正回帰（通信0、独立評価ではない）", () => {
  for (const sample of dataset.cases as Sample[])
    it(sample.id, async () => {
      const s = seed(sample),
        p = proposal(sample, s);
      const result = await extractOnce(
        {
          extract: async () =>
            applyExtractionProposal(
              s,
              sample.input,
              chooseNextQuestion(s, rules),
              p,
              rules.map((r) => r.category),
            ),
        },
        s,
        sample.input,
        null,
      );
      const e = sample.expected;
      if (e.safeUnresolved) {
        expect(result.extractionFailed).toBe(true);
        expect(
          result.unresolvedInputs?.some((e) => e.text === sample.input),
        ).toBe(true);
        expect(result.brief.items).toEqual(s.brief.items);
        return;
      }
      expect(result.extractionFailed).toBe(false);
      if (e.items !== undefined)
        expect(result.brief.items).toHaveLength(e.items);
      if (sample.id === "E19") {
        // Original grade expected a confirmed supply change. A question is instead kept pending, with no old exclusion.
        expect(
          field(result.brief.items[0], "material_supply")?.value?.text,
        ).toBe("customer_supplied");
        expect(result.unresolvedInputs?.[0].text).toBe(sample.input);
        expect(decide(result).verdict).toBe("needs_review");
      } else
        for (const [k, v] of Object.entries(e.fields ?? {}))
          compare(result.brief.items[0], k, v);
      for (const [k, v] of Object.entries(e.statuses ?? {}))
        expect(field(result.brief.items[0], k)?.status).toBe(v);
      for (const [k, v] of Object.entries(e.requiredFieldContains ?? {}))
        expect(field(result.brief.items[0], k)?.value?.text).toContain(v);
      for (const part of e.parts ?? []) {
        const item = result.brief.items.find((i) =>
          i.label.includes(part.label),
        );
        expect(item).toBeDefined();
        for (const [k, v] of Object.entries(part.fields ?? {}))
          compare(item, k, v);
        for (const [k, v] of Object.entries(part.contains ?? {}))
          expect(field(item, k)?.value?.text).toContain(v);
      }
      if (e.additionalQuestions === 0)
        expect(chooseNextQuestion(result, rules)).toBeNull();
      const decision = decide(result),
        mail = makeMailDraft(result, decision);
      if (e.mustNotHandle) expect(decision.verdict).not.toBe("can_handle");
      if (e.verdict) expect(decision.verdict).toBe(e.verdict);
      if (e.scope)
        expect(decision.items[0].scopeAssessment.status).toBe(e.scope);
      if (e.mustNotInferCustomerMaterial)
        expect(
          field(result.brief.items[0], "material_supply")?.value?.text,
        ).not.toBe("customer_supplied");
      for (const old of e.mailMustNotContain ?? [])
        expect(mail.body).not.toContain(old);
      if (["E19", "E20"].includes(sample.id)) {
        expect(mail.body).toContain(sample.input);
        expect(mail.body).not.toContain("今回の依頼：");
      }
    });
});

it("抽出失敗時は旧値・旧判断をメールへ載せず、最新訂正の全文を残す", async () => {
  const s = seed(dataset.cases.find((c) => c.id === "E07") as Sample);
  const failed = await extractOnce(
    {
      extract: async () => {
        throw new Error("MODEL_TIMEOUT");
      },
    },
    s,
    "ガラスの通常温度を680℃に訂正します。最高温度は820℃です。",
    null,
  );
  const mail = makeMailDraft(failed, decide(failed));
  expect(mail.body).not.toContain("780℃");
  expect(mail.body).toContain("680℃");
  expect(mail.body).toContain("820℃");
  expect(mail.body).not.toContain("今回の依頼：");
});
it("未確定の調達相談を明示編集で確定すると保留と旧方式を解消する", () => {
  const sample = dataset.cases.find((c) => c.id === "E19") as Sample,
    s = seed(sample);
  const pending = applyExtractionProposal(
    s,
    sample.input,
    null,
    proposal(sample, s),
  );
  const changed = applyInput(
    pending,
    { id: "confirmed", type: "field_edit", text: "当社調達" },
    [
      {
        itemId: s.brief.items[0].id,
        key: "material_supply",
        text: "company_sourced",
        quote: "当社調達",
      },
    ],
  );
  expect(changed.unresolvedInputs).toEqual([]);
  expect(makeMailDraft(changed, decide(changed)).body).toContain("当社調達");
  expect(makeMailDraft(changed, decide(changed)).body).not.toContain(
    "客先支給",
  );
});
it("捏造カテゴリ・型番末尾・競合alias・未承認資料では分類を確定しない", () => {
  const s = extractDemo(makeSnapshot("c"), "AX-100Bを購入したい");
  s.brief.items[0].category = "demo_switch";
  expect(resolveCategories(s.brief.items, rules)[0].category).toBeNull();
  const exact = extractDemo(makeSnapshot("x"), "AX-100を購入したい");
  expect(resolveCategories(exact.brief.items, rules)[0].category).toBe(
    "demo_switch",
  );
  expect(
    resolveCategories(exact.brief.items, [
      { ...rules[0], approvalStatus: "revoked" },
    ])[0].category,
  ).toBeNull();
  expect(
    resolveCategories(exact.brief.items, [
      rules[0],
      { ...rules[0], id: "other", category: "other" },
    ])[0].category,
  ).toBeNull();
  expect(
    decideAvailability(
      makeResearchBrief(exact, 2, 1),
      rules,
      [{ ...sources[0], role: "buyer" }],
      "x",
    ).verdict,
  ).toBe("needs_review");
});

it("別部品の値を含む引用や『変更しません』から値を確定しない", () => {
  const s = seed(dataset.cases.find((c) => c.id === "E15") as Sample);
  const p: ExtractionProposal = {
    schemaVersion: 1,
    newItems: [],
    changes: [
      {
        itemRef: s.brief.items[0].id,
        key: "material",
        status: "known",
        value: { text: "ゴム", number: null, unit: null },
        quote: "ガラスは鉄、パッキンはゴム",
        operation: "set",
        hardConstraint: true,
      },
    ],
    ambiguities: [],
    unprocessedQuotes: [],
  };
  expect(() =>
    applyExtractionProposal(s, "ガラスは鉄、パッキンはゴム", null, p),
  ).toThrow();
  const one = seed(dataset.cases.find((c) => c.id === "E11") as Sample);
  p.changes = [
    {
      itemRef: one.brief.items[0].id,
      key: "width",
      status: "known",
      value: { text: "600mm", number: 600, unit: "mm" },
      quote: "幅600mmは変更しません",
      operation: "correct",
      hardConstraint: true,
    },
  ];
  expect(() =>
    applyExtractionProposal(one, p.changes[0].quote, null, p),
  ).toThrow();
});
