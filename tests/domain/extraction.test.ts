import { describe, it, expect, vi } from "vitest";
import {
  applyExtractionProposal,
  type ExtractionProposal,
} from "../../src/domain/extraction-proposal";
import {
  makeSnapshot,
  makeResearchBrief,
  chooseNextQuestion,
} from "../../src/domain/intake";
import { extractDemo, extractOnce } from "../../src/adapters/extraction";
import {
  OpenAIIntakeExtractor,
  intakeConfig,
  makeIntakeRequest,
  type IntakeConfig,
} from "../../src/adapters/openai-intake";
import { decideAvailability } from "../../src/domain/decision";
import { makeMailDraft } from "../../src/domain/mail";
import type { CapabilityRule, Source } from "../../src/domain/model";
import f from "../../fixtures/demo/knowledge.json";
const config: IntakeConfig = {
  key: "test-secret",
  model: "configured-test-model",
  maxOutputTokens: 1024,
  maxCallsPerCase: 2,
  maxCallsTotal: 3,
};
const proposal = (): ExtractionProposal => ({
  schemaVersion: 1,
  newItems: [
    {
      ref: "new1",
      label: "AX-100",
      quote: "AX-100を購入したい",
      profile: "known_model",
      category: "demo_switch",
    },
  ],
  changes: [
    {
      itemRef: "new1",
      key: "model",
      status: "known",
      value: { text: "AX-100", number: null, unit: null },
      quote: "AX-100",
      operation: "set",
      hardConstraint: true,
    },
    {
      itemRef: "new1",
      key: "request_scope",
      status: "known",
      value: { text: "purchase", number: null, unit: null },
      quote: "購入したい",
      operation: "set",
      hardConstraint: true,
    },
  ],
  ambiguities: [],
  unprocessedQuotes: [],
});
const base = () => extractDemo(makeSnapshot("case-test"), "AX-100を購入したい");
function response(
  p: unknown = proposal(),
  extra: Record<string, unknown> = {},
) {
  return new Response(
    JSON.stringify({
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify(p) }],
        },
      ],
      usage: { input_tokens: 100, output_tokens: 50 },
      ...extra,
    }),
    { status: 200 },
  );
}
describe("引用付きの変更案", () => {
  it("新規品目はサーバー発行IDで保存し、モデルに案件状態を渡さない", () => {
    const s = makeSnapshot("c");
    const p = proposal();
    const result = applyExtractionProposal(s, "AX-100を購入したい", null, p, [
      "demo_switch",
    ]);
    expect(result.brief.items[0].id).not.toBe("new1");
    expect(
      result.brief.items[0].fields.find((f) => f.key === "model")?.value?.text,
    ).toBe("AX-100");
    expect(s.brief.items).toHaveLength(0);
  });
  it.each(["verdict", "revision", "owner", "question"] as const)(
    "禁止されたrootフィールド%sを拒否",
    (key) => {
      expect(() =>
        applyExtractionProposal(
          makeSnapshot("c"),
          "AX-100を購入したい",
          null,
          { ...proposal(), [key]: "injected" },
          ["demo_switch"],
        ),
      ).toThrow();
    },
  );
  it.each(["item", "key", "quote", "category", "enum", "duplicate"] as const)(
    "%sの不正変更を拒否",
    (kind) => {
      const p = proposal();
      if (kind === "item") p.changes[0].itemRef = "unowned";
      if (kind === "key") p.changes[0].key = "system_prompt";
      if (kind === "quote") p.changes[0].quote = "AX-200";
      if (kind === "category") p.newItems[0].category = "internal-only";
      if (kind === "enum") p.changes[1].value!.text = "manufacture";
      if (kind === "duplicate") p.changes.push(p.changes[0]);
      expect(() =>
        applyExtractionProposal(
          makeSnapshot("c"),
          "AX-100を購入したい",
          null,
          p,
          ["demo_switch"],
        ),
      ).toThrow();
    },
  );
  it("通常温度と最高温度の取り違え・単位の捏造を拒否", () => {
    const s = base(),
      itemRef = s.brief.items[0].id;
    const make = (
      quote: string,
      text = "680℃",
      number = 680,
      unit = "℃",
    ): ExtractionProposal => ({
      schemaVersion: 1,
      newItems: [],
      changes: [
        {
          itemRef,
          key: "normal_temperature",
          status: "known",
          value: { text, number, unit },
          quote,
          operation: "set",
          hardConstraint: true,
        },
      ],
      ambiguities: [],
      unprocessedQuotes: [],
    });
    const text = "通常温度680℃、最高温度820℃";
    expect(() =>
      applyExtractionProposal(s, text, null, make("最高温度820℃", "820℃", 820)),
    ).toThrow();
    expect(() =>
      applyExtractionProposal(s, text, null, make(text, "820℃", 820)),
    ).toThrow();
    expect(() =>
      applyExtractionProposal(
        s,
        text,
        null,
        make("通常温度680℃", "680mm", 680, "mm"),
      ),
    ).toThrow();
    expect(
      applyExtractionProposal(
        s,
        text,
        null,
        make("通常温度680℃"),
      ).brief.items[0].fields.find((f) => f.key === "normal_temperature")?.value
        ?.number,
    ).toBe(680);
  });
  it("既存値を変えるには引用上の明示訂正が必要", () => {
    const s = base(),
      itemRef = s.brief.items[0].id;
    const p: ExtractionProposal = {
      schemaVersion: 1,
      newItems: [],
      changes: [
        {
          itemRef,
          key: "model",
          status: "known",
          value: { text: "AX-200", number: null, unit: null },
          quote: "AX-200",
          operation: "correct",
          hardConstraint: true,
        },
      ],
      ambiguities: [],
      unprocessedQuotes: [],
    };
    expect(() =>
      applyExtractionProposal(s, "AX-200ならどう？", null, p),
    ).toThrow();
    p.changes[0].quote = "型番をAX-200に訂正";
    expect(
      applyExtractionProposal(
        s,
        p.changes[0].quote,
        null,
        p,
      ).brief.items[0].fields.find((f) => f.key === "model")?.value?.text,
    ).toBe("AX-200");
  });
  it("複数部品の対象を捏造しない", () => {
    const s = extractDemo(makeSnapshot("c"), "ガラス4枚、パッキン8個"),
      itemRef = s.brief.items[0].id;
    const p: ExtractionProposal = {
      schemaVersion: 1,
      newItems: [],
      changes: [
        {
          itemRef,
          key: "material",
          status: "known",
          value: { text: "鉄", number: null, unit: null },
          quote: "鉄",
          operation: "set",
          hardConstraint: true,
        },
      ],
      ambiguities: [],
      unprocessedQuotes: [],
    };
    expect(() => applyExtractionProposal(s, "材質は鉄です", null, p)).toThrow();
  });
  it("仮定を現在条件にせず、不明を保持し、未処理条件を落とさない", () => {
    const s = base(),
      itemRef = s.brief.items[0].id;
    const p: ExtractionProposal = {
      schemaVersion: 1,
      newItems: [],
      changes: [
        {
          itemRef,
          key: "material",
          status: "known",
          value: { text: "SUS316", number: null, unit: null },
          quote: "SUS316ならどう？",
          operation: "hypothetical",
          hardConstraint: true,
        },
      ],
      ambiguities: [],
      unprocessedQuotes: [],
    };
    expect(
      applyExtractionProposal(
        s,
        "SUS316ならどう？",
        null,
        p,
      ).brief.items[0].fields.find((f) => f.key === "material"),
    ).toBeUndefined();
    p.changes = [
      {
        itemRef,
        key: "material",
        status: "unknown",
        value: null,
        quote: "材質は分からない",
        operation: "set",
        hardConstraint: false,
      },
    ];
    expect(
      applyExtractionProposal(
        s,
        "材質は分からない",
        null,
        p,
      ).brief.items[0].fields.find((f) => f.key === "material")?.status,
    ).toBe("unknown");
    p.unprocessedQuotes = ["非公開の条件あり"];
    expect(() =>
      applyExtractionProposal(s, "材質は分からない。非公開の条件あり", null, p),
    ).toThrow();
  });
});
describe("OpenAI接続と停止", () => {
  it("明示設定不足は接続前に拒否", () => {
    expect(() =>
      intakeConfig({
        INTAKE_PROVIDER: "openai",
        EXTERNAL_ENABLED: "true",
        OPENAI_API_KEY: "test",
        INTAKE_MODEL: "model",
      }),
    ).toThrow("CONFIG_MISSING");
    expect(() =>
      intakeConfig({ INTAKE_PROVIDER: "openai", EXTERNAL_ENABLED: "false" }),
    ).toThrow("CONFIG_MISSING");
  });
  it("現在値と直前入力だけを送り、原資料・Cookie・全履歴・API鍵を本文に含めない", () => {
    const s = base();
    s.inputs.unshift({
      id: "secret",
      text: "古い発言-secret",
      type: "customer_text",
    });
    s.attachmentNames = ["private.pdf"];
    const b = makeIntakeRequest(s, "新しい入力", null, config, ["demo_switch"]);
    const text = JSON.stringify(b);
    expect(text).not.toContain("古い発言-secret");
    expect(text).not.toContain("private.pdf");
    expect(text).not.toContain("test-secret");
    expect(b.store).toBe(false);
    expect(b.text.format.strict).toBe(true);
  });
  it("1回のHTTP呼出しで構造化出力と利用量を検証する", async () => {
    const usage = vi.fn(async () => {}),
      transport = vi.fn(async () => response());
    const a = new OpenAIIntakeExtractor(
      config,
      ["demo_switch"],
      transport,
      usage,
    );
    const s = await a.extract(makeSnapshot("c"), "AX-100を購入したい", null);
    expect(s.brief.items).toHaveLength(1);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(usage).toHaveBeenCalledWith({ inputTokens: 100, outputTokens: 50 });
    const [url, init] = transport.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(init.redirect).toBe("manual");
  });
  it.each([401, 403, 429, 500])(
    "HTTP %i は再生成せず入力保持",
    async (status) => {
      const t = vi.fn(async () => new Response("{}", { status }));
      const a = new OpenAIIntakeExtractor(config, [], t);
      const s = await extractOnce(a, base(), "追加の必須条件", null);
      expect(s.extractionFailed).toBe(true);
      expect(s.unresolvedInputs?.[0].text).toBe("追加の必須条件");
      expect(t).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["incomplete", "refusal", "invalid-json", "bad-schema"])(
    "%sを成功扱いしない",
    async (kind) => {
      const t = vi.fn(async () =>
        kind === "incomplete"
          ? response(proposal(), { status: "incomplete" })
          : kind === "refusal"
            ? response(null, {
                output: [
                  {
                    type: "message",
                    content: [{ type: "refusal", refusal: "no" }],
                  },
                ],
              })
            : kind === "invalid-json"
              ? new Response("not-json")
              : response({ verdict: "can_handle" }),
      );
      const s = await extractOnce(
        new OpenAIIntakeExtractor(config, [], t),
        base(),
        "必須条件の追加",
        null,
      );
      expect(s.extractionFailed).toBe(true);
      expect(t).toHaveBeenCalledTimes(1);
    },
  );
  it("期限でAbortSignalを中止し、遅着結果は採用せず旧条件だけで肯定しない", async () => {
    let signal: AbortSignal | undefined;
    const t = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    });
    const s = await extractOnce(
      new OpenAIIntakeExtractor(config, [], t),
      base(),
      "来月上旬が必須です",
      null,
      10,
    );
    expect(signal?.aborted).toBe(true);
    expect(s.extractionFailed).toBe(true);
    const brief = makeResearchBrief(s, 2, 1);
    expect(
      decideAvailability(
        brief,
        f.rules as CapabilityRule[],
        f.sources as Source[],
        "j",
      ).verdict,
    ).toBe("needs_review");
    expect(makeMailDraft(s, null).body).toContain("来月上旬が必須");
    expect(chooseNextQuestion(s, f.rules as CapabilityRule[])?.id).toBe(
      "input-recovery",
    );
  });
});

it("型番末尾や材質記号の一部だけを確定値にしない", () => {
  const p = proposal();
  p.newItems[0].quote = "AX-100Bを購入したい";
  p.changes[0].quote = "AX-100B";
  expect(() =>
    applyExtractionProposal(makeSnapshot("c"), "AX-100Bを購入したい", null, p, [
      "demo_switch",
    ]),
  ).toThrow();
});

it("材料も御社で調達という明示変更を、旧支給方式へ戻さず保存する", () => {
  const s = extractDemo(
    makeSnapshot("c"),
    "リング材を支給するので穴加工してほしい",
  );
  const p: ExtractionProposal = {
    schemaVersion: 1,
    newItems: [],
    changes: [
      {
        itemRef: s.brief.items[0].id,
        key: "material_supply",
        status: "known",
        value: { text: "company_sourced", number: null, unit: null },
        quote: "材料も御社で調達できますか",
        operation: "correct",
        hardConstraint: true,
      },
    ],
    ambiguities: [],
    unprocessedQuotes: [],
  };
  expect(
    applyExtractionProposal(
      s,
      "材料も御社で調達できますか",
      null,
      p,
    ).brief.items[0].fields.find((f) => f.key === "material_supply")?.value
      ?.text,
  ).toBe("company_sourced");
});
