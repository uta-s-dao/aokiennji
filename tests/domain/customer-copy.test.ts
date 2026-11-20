import { expect, it } from "vitest";
import {
  savedReply,
  customerQuestion,
  customerNextStep,
  customerItemName,
} from "../../src/domain/customer-copy";
import { extractDemo } from "../../src/adapters/extraction";
import {
  applyInput,
  makeSnapshot,
  makeResearchBrief,
} from "../../src/domain/intake";
import { decideAvailability } from "../../src/domain/decision";
import { makeMailDraft } from "../../src/domain/mail";
import type { CapabilityRule, Source, Snapshot } from "../../src/domain/model";
import fixture from "../../fixtures/demo/knowledge.json";

const rules = fixture.rules as CapabilityRule[],
  sources = fixture.sources as Source[];
const start = (text: string) => extractDemo(makeSnapshot("customer"), text);
const decide = (
  s: Snapshot,
  rs = rules,
  status: "completed" | "failed" = "completed",
) =>
  decideAvailability(
    makeResearchBrief(s, 2, 1),
    rs,
    sources,
    "copy-test",
    status,
  );

it("訂正通知は保存した新値を示し、旧値や別部品の変更を言わない", () => {
  const before = start("ガラス 通常温度780℃");
  const after = extractDemo(before, "ガラス 通常温度680℃、最高温度820℃");
  const text = savedReply(before, after);
  expect(text).toContain("通常温度を680℃に変更しました");
  expect(text).not.toContain("として保存しました");
  expect(
    after.brief.items[0].fields.find((f) => f.key === "peak_temperature")?.value
      ?.number,
  ).toBe(820);
  expect(text).not.toContain("780℃");
  const result = decide(after);
  expect(result.items[0].missingFields).not.toContain("normal_temperature");
  expect(result.items[0].missingFields).not.toContain("peak_temperature");
  expect(result.items[0].reason).toContain("通常温度（680℃）");
  expect(result.items[0].reason).toContain("最高温度（820℃）");
  expect(makeMailDraft(after, result).body).toContain(result.items[0].reason);
});

it("部品別数量の訂正を他の品目へ広げない", () => {
  const before = start("ガラス4枚、パッキン8個");
  const after = extractDemo(before, "パッキン10個");
  const text = savedReply(before, after);
  expect(text).toContain("パッキンの数量を10個に変更しました");
  expect(text).not.toContain("ガラスの数量");
  expect(
    after.brief.items[0].fields.find((f) => f.key === "quantity")?.value
      ?.number,
  ).toBe(4);
});

it("デモ画面でも句点で分かれた部品別の塗装・配送先を混ぜない", () => {
  const s = start(
    "カバーは4組、塗装不要、配送先は大阪です。ネックは8組、外装塗装、配送先は神戸です。",
  );
  expect(s.brief.items).toHaveLength(2);
  const cover = s.brief.items.find((i) => i.label === "カバー")!;
  const neck = s.brief.items.find((i) => i.label === "ネック")!;
  expect(cover.fields.find((f) => f.key === "quantity")?.value?.number).toBe(4);
  expect(neck.fields.find((f) => f.key === "quantity")?.value?.number).toBe(8);
  expect(cover.fields.find((f) => f.key === "coating")?.value?.text).toBe(
    "塗装不要",
  );
  expect(neck.fields.find((f) => f.key === "coating")?.value?.text).toBe(
    "外装塗装",
  );
  expect(cover.fields.find((f) => f.key === "destination")?.value?.text).toBe(
    "大阪です",
  );
  expect(neck.fields.find((f) => f.key === "destination")?.value?.text).toBe(
    "神戸です",
  );
  const result = decide(s);
  expect(result.items[0].conditions).toContain("納入先：大阪です");
  expect(result.items[0].conditions).not.toContain("納入先：神戸です");
});

it("用途を聞いている間の温度訂正を用途の回答へ流用しない", () => {
  const before = start("ガラス 通常温度780℃");
  const item = before.brief.items[0];
  const q = {
    id: `${item.id}:purpose`,
    itemId: item.id,
    fieldKey: "purpose",
    text: "ガラスは何に使いますか？",
    inputType: "text" as const,
    options: [],
    allowUnknown: true as const,
    allowSkip: true as const,
  };
  const after = extractDemo(before, "ガラス 通常温度680℃、最高温度820℃", q);
  expect(after.brief.items[0].fields.some((f) => f.key === "purpose")).toBe(
    false,
  );
  const answered = extractDemo(after, "用途は点検窓です", q);
  expect(
    answered.brief.items[0].fields.find((f) => f.key === "purpose")?.value
      ?.text,
  ).toBe("点検窓です");
  expect(makeMailDraft(answered, null).body).not.toContain(
    "用途：ガラス 通常温度",
  );
});

it.each(["unknown", "skipped"] as const)(
  "%sは記録し、処理の復唱は出さない",
  (status) => {
    const before = start("名前不明の部品");
    const after = applyInput(
      before,
      { id: "unknown", text: "分からない", type: "selection" },
      [
        {
          itemId: before.brief.items[0].id,
          key: "material",
          status,
          quote: "分からない",
        },
      ],
    );
    expect(savedReply(before, after)).toBe("");
    expect(
      after.brief.items[0].fields.find((f) => f.key === "material")?.status,
    ).toBe(status);
  },
);

it.each(["failed", "pending"])("%sを保存成功として復唱しない", (state) => {
  const before = start("リング材を支給するので穴加工してほしい");
  const after = structuredClone(before);
  after.unresolvedInputs = [
    {
      id: "pending",
      text: "材料も御社で調達できますか",
      type: "customer_text",
    },
  ];
  if (state === "failed") after.extractionFailed = true;
  const text = savedReply(before, after);
  expect(text).not.toContain("保存しました");
  expect(text).toBe("");
  expect(after.unresolvedInputs[0].text).toBe("材料も御社で調達できますか");
  const result = decide(after);
  expect(result.verdict).toBe("needs_review");
  expect(result.items[0].reason).toContain("まだ条件として確定できていません");
  expect(makeMailDraft(after, result).body).not.toContain("対応範囲外");
});

it("資料で未確認の希望日は、顧客の未入力として再要求しない", () => {
  const s = start("AX-100を購入したい");
  const updated = applyInput(
    s,
    { id: "date", text: "2027年2月1日", type: "field_edit" },
    [
      {
        itemId: s.brief.items[0].id,
        key: "required_date",
        text: "2027年2月1日",
        quote: "2027年2月1日",
        hardConstraint: true,
      },
    ],
  );
  const result = decide(updated);
  expect(result.verdict).toBe("needs_review");
  expect(result.items[0].scopeAssessment.status).toBe("unconfirmed");
  expect(result.items[0].missingFields).not.toContain("required_date");
  expect(result.items[0].reason).toContain("希望日（2027年2月1日）");
  expect(result.items[0].reason).toContain("資料だけでは確認できません");
});

it("本当に未入力の必須属性だけを追記対象にする", () => {
  const rs = structuredClone(rules);
  rs[0].requiredFields.push("material");
  const result = decide(start("AX-100を購入したい"), rs);
  expect(result.items[0].missingFields).toEqual(["material"]);
  expect(result.items[0].reason).toContain("材質がまだ分かっていません");
  expect(customerNextStep(result.items[0])).toContain("分かる条件を追記");
});

it("成功・方式限定の否定・調査失敗を同じ確認待ち文で隠さない", () => {
  const positive = decide(start("AX-100を購入したい"));
  expect(positive.verdict).toBe("can_handle");
  expect(positive.items[0].reason).toContain("取扱範囲に合っています");
  const excluded = decide(start("リング材を支給するので穴加工してほしい"));
  expect(excluded.verdict).toBe("out_of_scope");
  expect(excluded.items[0].reason).toContain("この方式に限って");
  const failed = decide(start("AX-100を購入したい"), rules, "failed");
  expect(failed.verdict).toBeNull();
  expect(failed.items[0].reason).toContain("調査を完了できなかった");
  expect(customerNextStep(failed.items[0])).toContain("再調査");
});

it.each([
  "AX-100を購入したい",
  "リング材を支給するので穴加工してほしい",
  "図面の架台を製作したい。塗料は支給。来月上旬を希望",
])("初回の保存・分類は復唱せず、%sの保存内容を保持する", (input) => {
  const before = makeSnapshot("customer");
  const after = extractDemo(before, input);
  const stored = JSON.stringify(after);
  expect(savedReply(before, after)).toBe("");
  expect(after.inputs[0].text).toBe(input);
  expect(after.brief.items[0].fields.length).toBeGreaterThan(1);
  expect(JSON.stringify(after)).toBe(stored);
});

it("長い回答を訂正通知で全文読み上げせず、保存値は省略しない", () => {
  const before = start("ガラス 用途は点検窓");
  const text =
    "設備の窓として使い、温度や取り付け方法は現場に確認が必要です。".repeat(3);
  const after = applyInput(
    before,
    { id: "purpose", text, type: "field_edit" },
    [
      {
        itemId: before.brief.items[0].id,
        key: "purpose",
        text,
        quote: text,
      },
    ],
  );
  expect(savedReply(before, after)).toBe("用途を変更しました。");
  expect(
    after.brief.items[0].fields.find((f) => f.key === "purpose")?.value?.text,
  ).toBe(text);
});

it.each([
  ["手元にあるリングを支給して、穴あけ加工をお願いできますか？", "リング"],
  ["ポンプの交換部品を買いたいのですが、名前が分かりません", "交換部品"],
  [
    "ポンプから外した丸いゴムの部品を買いたいのですが、名前が分かりません",
    "部品",
  ],
])(
  "質問の表示名だけを短くし、原文の品目名を書き換えない：%s",
  (input, name) => {
    const s = start(input);
    const item = s.brief.items[0],
      label = item.label;
    expect(customerItemName(item)).toBe(name);
    expect(customerQuestion(item, "purpose")).toBe(`${name}は何に使いますか？`);
    expect(item.label).toBe(label);
  },
);

it("期限切れと資料の矛盾を具体的な理由にする", () => {
  const expired = structuredClone(rules);
  expired[0].validUntil = "2026-11-16T01:00:00Z";
  expect(
    decide(start("AX-100を購入したい"), expired).items[0].reason,
  ).toContain("資料の期限");
  const conflicting = structuredClone(rules);
  conflicting.push({ ...conflicting[0], id: "conflict", decision: "excluded" });
  expect(
    decide(start("AX-100を購入したい"), conflicting).items[0].reason,
  ).toContain("食い違い");
});

it("長い入力でも通知・質問・結果の契約上限を超えない", () => {
  const before = makeSnapshot("long");
  const after = start("AX-100を購入したい");
  after.brief.items[0].label = "長い商品名".repeat(15);
  expect(savedReply(before, after).length).toBeLessThanOrEqual(160);
  expect(
    customerQuestion(after.brief.items[0], "material_supply").length,
  ).toBeLessThanOrEqual(120);
  expect(decide(after).items[0].reason.length).toBeLessThanOrEqual(300);
  const text = "特注材".repeat(100);
  const long = applyInput(
    after,
    { id: "long-material", text, type: "field_edit" },
    [{ itemId: after.brief.items[0].id, key: "material", text, quote: text }],
  );
  const result = decide(long);
  expect(result.items[0].conditions.every((c) => c.length <= 160)).toBe(true);
  expect(makeMailDraft(long, result).body).toContain(text);
});
