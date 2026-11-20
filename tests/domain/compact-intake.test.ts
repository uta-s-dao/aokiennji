import { it, expect, vi } from "vitest";
import { decodeCompactProposal } from "../../src/domain/compact-extraction";
import { compactFields } from "../../src/domain/compact-fields";
import { fields } from "../../src/domain/fields";
import { applyExtractionProposal } from "../../src/domain/extraction-proposal";
import { makeSnapshot, makeResearchBrief } from "../../src/domain/intake";
import { extractDemo, extractOnce } from "../../src/adapters/extraction";
import {
  intakeConfig,
  makeIntakeRequest,
  OpenAIIntakeExtractor,
  type IntakeConfig,
  type IntakeTiming,
} from "../../src/adapters/openai-intake";
import { makeMailDraft } from "../../src/domain/mail";
const cfg: IntakeConfig = {
  key: "offline-secret",
  model: "gpt-6-luna",
  maxOutputTokens: 1024,
  maxCallsPerCase: 1,
  maxCallsTotal: 3,
  format: "compact",
  reasoning: "none",
};
const sample = () => ({
  n: [{ i: "n1", n: "AX-100", q: "AX-100を2台購入したい", p: "m" }],
  c: [
    { i: "n1", k: "mo", v: "AX-100", q: "AX-100", o: "s", h: true },
    { i: "n1", k: "qt", v: "2台", q: "2台", o: "s", h: true },
    { i: "n1", k: "rs", v: "purchase", q: "購入したい", o: "s", h: true },
  ],
  u: [],
});
it("短い形式は辞書を網羅し、現在値を短い参照へ置換して秘密や履歴を送らない", () => {
  expect(new Set(Object.values(compactFields))).toEqual(
    new Set(Object.keys(fields)),
  );
  const s = extractDemo(makeSnapshot("c"), "AX-100を購入したい");
  s.inputs.unshift({
    id: "private",
    type: "customer_text",
    text: "過去の秘密",
  });
  const p = makeIntakeRequest(s, "2台に変更", null, cfg, ["demo_switch"]),
    full = makeIntakeRequest(s, "2台に変更", null, { ...cfg, format: "full" }, [
      "demo_switch",
    ]);
  expect(JSON.stringify(p)).not.toContain(s.brief.items[0].id);
  expect(JSON.stringify(p)).not.toContain("offline-secret");
  expect(JSON.stringify(p)).not.toContain("過去の秘密");
  expect(p.input[0].role).toBe("developer");
  expect(p.reasoning).toEqual({ effort: "none" });
  expect(p.store).toBe(false);
  expect(p.tools).toEqual([]);
  expect(JSON.stringify(p).length).toBeLessThan(JSON.stringify(full).length);
});
it.each([
  "unknown-item",
  "wrong-unit",
  "wrong-attribute",
  "truncated-model",
  "unknown-key",
  "extra-root",
  "duplicate-ref",
  "empty",
])("%sの短縮応答を安全に拒否する", (kind) => {
  const raw = sample();
  let text = "AX-100を2台購入したい";
  if (kind === "unknown-item") raw.c[0].i = "n2";
  if (kind === "wrong-unit")
    raw.c[1] = { ...raw.c[1], k: "od", v: "100℃", q: "外径100℃" };
  if (kind === "wrong-attribute")
    raw.c[1] = { ...raw.c[1], k: "nt", v: "820℃", q: "最高温度820℃" };
  if (kind === "truncated-model") {
    raw.n[0].q = "AX-100B";
    raw.c[0].q = "AX-100B";
  }
  if (kind === "unknown-key") raw.c[0].k = "verdict";
  if (kind === "extra-root") Object.assign(raw, { verdict: "can_handle" });
  if (kind === "duplicate-ref") raw.n.push(raw.n[0]);
  if (kind === "empty") {
    raw.n = [];
    raw.c = [];
  }
  text += " 外径100℃ 最高温度820℃ AX-100B";
  expect(() =>
    applyExtractionProposal(
      makeSnapshot("c"),
      text,
      null,
      decodeCompactProposal(makeSnapshot("c"), raw),
    ),
  ).toThrow();
});
it("1回のモデル呼出しで短い変更を復元し、区間計測も記録する", async () => {
  const transport = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          status: "completed",
          output: [
            {
              type: "message",
              content: [
                { type: "output_text", text: JSON.stringify(sample()) },
              ],
            },
          ],
          usage: { input_tokens: 100, output_tokens: 80 },
        }),
      ),
  );
  const times: IntakeTiming[] = [];
  const usage = vi.fn(async () => {});
  const result = await extractOnce(
    new OpenAIIntakeExtractor(cfg, [], transport, usage, (t) => times.push(t)),
    makeSnapshot("c"),
    "AX-100を2台購入したい",
    null,
  );
  expect(result.extractionFailed).toBe(false);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(usage).toHaveBeenCalledWith({ inputTokens: 100, outputTokens: 80 });
  expect(
    result.brief.items[0].fields.find((f) => f.key === "quantity")?.value,
  ).toEqual({ text: "2台", number: 2, unit: "台" });
  expect(times).toHaveLength(1);
  expect(times[0].bodyMs).toBeGreaterThanOrEqual(times[0].headersMs!);
  expect(times[0].totalMs).toBeGreaterThanOrEqual(times[0].bodyMs!);
  expect(makeResearchBrief(result, 2, 1).schemaVersion).toBe(2);
});
it("未定の変更を短い形式でも原文付きで保持する", () => {
  const s = extractDemo(makeSnapshot("c"), "リング材はSUS304を購入したい");
  const text = "SUS316ならどうでしょうか";
  const raw = {
    n: [],
    c: [{ i: "0", k: "ma", v: "SUS316", q: text, o: "h", h: false }],
    u: [],
  };
  const result = applyExtractionProposal(
    s,
    text,
    null,
    decodeCompactProposal(s, raw),
  );
  expect(
    result.brief.items[0].fields.find((f) => f.key === "material")?.value?.text,
  ).toBe("SUS304");
  expect(makeMailDraft(result, null).body).toContain(text);
});
it("不正な形式や推論設定は接続予約前に拒否する", () => {
  expect(() => intakeConfig({ INTAKE_FORMAT: "unsupported" })).toThrow(
    "CONFIG_MISSING",
  );
  expect(() => intakeConfig({ INTAKE_REASONING: "unbounded" })).toThrow(
    "CONFIG_MISSING",
  );
});

it.each(["full", "compact"] as const)(
  "モデルの%s応答で既存品目の形状説明を保持しつつ中空と内径を保存する",
  async (format) => {
    const original = makeSnapshot("c");
    const firstText = "耐熱ガラスで円筒状の部品を製作したいです。";
    const proposal = {
      schemaVersion: 1,
      newItems: [
        {
          ref: "new",
          label: "円筒状の部品",
          quote: firstText,
          profile: "fabrication",
          category: null,
        },
      ],
      changes: [],
      ambiguities: [],
      unprocessedQuotes: [],
    };
    const initial = applyExtractionProposal(
      original,
      firstText,
      null,
      proposal,
    );
    const item = initial.brief.items[0];
    const bodyQuote = "中は空洞です";
    const innerQuote = "内径は30mmです";
    const secondText = `${bodyQuote}。${innerQuote}。`;
    const response =
      format === "compact"
        ? {
            n: [],
            c: [
              { i: "0", k: "bs", v: "hollow", q: bodyQuote, o: "s", h: true },
              { i: "0", k: "id", v: "30mm", q: innerQuote, o: "s", h: true },
            ],
            u: [],
          }
        : {
            ...proposal,
            newItems: [],
            changes: [
              {
                itemRef: item.id,
                key: "body_structure",
                status: "known",
                value: { text: "hollow", number: null, unit: null },
                quote: bodyQuote,
                operation: "set",
                hardConstraint: true,
              },
              {
                itemRef: item.id,
                key: "inner_diameter",
                status: "known",
                value: { text: "30mm", number: 30, unit: "mm" },
                quote: innerQuote,
                operation: "set",
                hardConstraint: true,
              },
            ],
          };
    const transport = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: "completed",
            output: [
              {
                type: "message",
                content: [
                  { type: "output_text", text: JSON.stringify(response) },
                ],
              },
            ],
          }),
        ),
    );
    const captured = await extractOnce(
      new OpenAIIntakeExtractor({ ...cfg, format }, [], transport),
      initial,
      secondText,
      null,
    );
    expect(transport).toHaveBeenCalledTimes(1);
    expect(captured.extractionFailed).toBe(false);
    expect(captured.brief.items).toHaveLength(1);
    expect(captured.brief.items[0].fields).toEqual(
      expect.arrayContaining([
        item.fields.find((field) => field.key === "description"),
        expect.objectContaining({
          key: "body_structure",
          value: { text: "hollow", number: null, unit: null },
          quote: bodyQuote,
        }),
        expect.objectContaining({
          key: "inner_diameter",
          value: { text: "30mm", number: 30, unit: "mm" },
          quote: innerQuote,
        }),
      ]),
    );
  },
);

it.each([
  ["仮に無垢です", "無垢"],
  ["無垢ではありません", "無垢"],
  ["空洞か、無垢です", "無垢です"],
  ["空洞です。無垢です", "無垢です"],
  ["無垢です。内径は30mmです", "無垢です"],
])("モデルの提案から確定できない中実を拒否する: %s", (text, quote) => {
  const initial = extractDemo(
    makeSnapshot("c"),
    "耐熱ガラスで円筒状の部品を製作したいです。",
  );
  const proposal = decodeCompactProposal(initial, {
    n: [],
    c: [{ i: "0", k: "bs", v: "solid", q: quote, o: "s", h: true }],
    u: [],
  });
  expect(() => applyExtractionProposal(initial, text, null, proposal)).toThrow(
    "INVALID_EXTRACTION",
  );
});
