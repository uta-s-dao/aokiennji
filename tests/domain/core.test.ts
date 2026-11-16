import { describe, it, expect } from "vitest";
import { extractDemo } from "../../src/adapters/extraction";
import {
  applyInput,
  makeSnapshot,
  chooseNextQuestion,
  makeResearchBrief,
  newItem,
} from "../../src/domain/intake";
import {
  decideAvailability,
  checkRule,
  toPublicResult,
} from "../../src/domain/decision";
import { makeMailDraft } from "../../src/domain/mail";
import type {
  CapabilityRule,
  Source,
  Snapshot,
  PublicResult,
} from "../../src/domain/model";
import fixture from "../../fixtures/demo/knowledge.json";
const rs = fixture.rules as CapabilityRule[],
  ss = fixture.sources as Source[];
const start = (t = "AX-100を購入したい") =>
  extractDemo(makeSnapshot("case-1"), t);
const decide = (
  s: Snapshot,
  r = rs,
  status: PublicResult["status"] = "completed",
) => decideAvailability(makeResearchBrief(s, 1, 1), r, ss, "job", status);
function change(
  s: Snapshot,
  key: string,
  value: string,
  itemId = s.brief.items[0].id,
) {
  return applyInput(s, { id: "e-" + key, text: value, type: "field_edit" }, [
    { itemId, key, text: value, quote: value },
  ]);
}
describe("聞き取りと訂正", () => {
  it("I01 完全型番は0問で調査し連絡先・数量を要求しない", () => {
    const s = start();
    expect(chooseNextQuestion(s, rs)).toBeNull();
    expect(makeResearchBrief(s, 1, 0).schemaVersion).toBe(2);
  });
  it.each(["unknown", "skipped"] as const)(
    "I03/I04 %sは再質問しない",
    (status) => {
      let s = start("名前不明の交換部品");
      const q = chooseNextQuestion(s, rs)!;
      s = applyInput(s, { id: "e", text: "分からない", type: "selection" }, [
        {
          itemId: s.brief.items[0].id,
          key: q.fieldKey,
          status,
          quote: "分からない",
        },
      ]);
      expect(chooseNextQuestion(s, rs)?.fieldKey).not.toBe(q.fieldKey);
    },
  );
  it("I06 未登録は補助2問、I09 6問上限", () => {
    const s = start("名前不明の交換部品");
    s.fallbackCount = 2;
    expect(chooseNextQuestion(s, [])).toBeNull();
    s.fallbackCount = 0;
    s.brief.questionsAsked = 6;
    expect(chooseNextQuestion(s, rs)).toBeNull();
  });
  it("I07 明示調査とI08 空調査拒否", () => {
    expect(chooseNextQuestion(start("名前不明の部品"), [], true)).toBeNull();
    expect(() => makeResearchBrief(makeSnapshot("empty"), 1, 0)).toThrow();
  });
  it("S01 温度訂正を現在値に反映し最高温度を維持する", () => {
    let s = start("ガラス 通常温度780℃");
    s = extractDemo(s, "ガラス 通常温度680℃、最高温度820℃");
    const f = s.brief.items[0].fields;
    expect(f.find((f) => f.key === "normal_temperature")?.value?.number).toBe(
      680,
    );
    expect(f.find((f) => f.key === "peak_temperature")?.value?.number).toBe(
      820,
    );
    const mail = makeMailDraft(s, null);
    expect(mail.body).not.toContain("780℃");
  });
  it("S02 穴径と外径を別属性にする", () => {
    const s = start("ガラス 見える穴の径80mm 外径100mm");
    expect(
      s.brief.items[0].fields
        .filter((f) => f.key.includes("diameter"))
        .map((f) => f.value?.number),
    ).toEqual([100, 80]);
  });
  it("S03 品目別数量を維持", () => {
    let s = start("ガラス4枚、パッキン8個");
    s = extractDemo(s, "パッキン10個");
    expect(
      s.brief.items.map(
        (i) => i.fields.find((f) => f.key === "quantity")?.value?.number,
      ),
    ).toEqual([4, 10]);
  });
  it("S05 仮定で材質を置き換えない", () => {
    let s = start("リング SUS304を購入");
    s = extractDemo(s, "SUS316ならどう？");
    expect(
      s.brief.items[0].fields.find((f) => f.key === "material")?.value?.text,
    ).toBe("SUS304");
  });
  it("I14 依頼方式を変更すると旧方式の否定を流用しない", () => {
    let s = start("リング材を支給するので穴加工してほしい");
    expect(decide(s).items[0].verdict).toBe("out_of_scope");
    s = extractDemo(
      s,
      "材料手配を御社調達に変更してください。加工も依頼します。",
    );
    expect(decide(s).items[0].verdict).toBe("needs_review");
    expect(makeMailDraft(s, decide(s)).body).toContain("当社調達");
    expect(makeMailDraft(s, decide(s)).body).not.toContain("客先支給");
  });
  it("S08 4品目を黙って削除しない", () => {
    const s = start("部品A\n部品B\n部品C\n部品D");
    expect(s.overflow.join()).toContain("部品D");
    expect(() => makeResearchBrief(s, 1, 0)).toThrow();
  });
  it("無効な属性・引用・品目・列挙値を拒否", () => {
    const s = start();
    for (const c of [
      { itemId: "missing", key: "material", text: "鉄", quote: "鉄" },
      { itemId: s.brief.items[0].id, key: "evil", text: "鉄", quote: "鉄" },
      {
        itemId: s.brief.items[0].id,
        key: "material",
        text: "ゴム",
        quote: "鉄",
      },
      {
        itemId: s.brief.items[0].id,
        key: "request_scope",
        text: "maybe",
        quote: "鉄",
      },
    ])
      expect(() =>
        applyInput(s, { id: "e", text: "鉄", type: "customer_text" }, [c]),
      ).toThrow();
  });
  it("不正単位と無断の必須条件解除を拒否", () => {
    const s = start();
    expect(() =>
      applyInput(s, { id: "e", text: "10kg", type: "field_edit" }, [
        {
          itemId: s.brief.items[0].id,
          key: "outer_diameter",
          text: "10kg",
          number: 10,
          unit: "kg",
          quote: "10kg",
        },
      ]),
    ).toThrow();
    expect(() =>
      applyInput(s, { id: "e", text: "SUS304", type: "field_edit" }, [
        {
          itemId: s.brief.items[0].id,
          key: "material",
          text: "SUS304",
          quote: "SUS304",
          hardConstraint: false,
        },
      ]),
    ).toThrow();
  });
  it("R17 分野内でも図面・納期で個別依頼は確認待ち", () => {
    const s = start("架台を製作したい。来月上旬希望");
    const r = decide(s);
    expect(r.items[0].scopeAssessment.status).toBe("in_scope");
    expect(r.verdict).toBe("needs_review");
  });
});
describe("根拠と判定", () => {
  it("R01 有効な個別承認が全必須条件に一致したとき肯定", () => {
    const r = decide(start());
    expect(r.verdict).toBe("can_handle");
    expect(r.items[0].scopeAssessment.status).toBe("in_scope");
  });
  it.each(["draft", "revoked"] as const)(
    "R10 %sルールを使用しない",
    (approvalStatus) => {
      expect(decide(start(), [{ ...rs[0], approvalStatus }]).verdict).toBe(
        "needs_review",
      );
    },
  );
  it("R10 期限切れは使用しない", () => {
    expect(
      decide(start(), [{ ...rs[0], validUntil: "2026-01-01T00:00:00Z" }])
        .verdict,
    ).toBe("needs_review");
  });
  it("R03/R04/R05 外部候補・検索0件・仕入先一覧では肯定も否定もしない", () => {
    expect(decide(start(), []).verdict).toBe("needs_review");
  });
  it("R07/R15 未確認の必須納期や材質を無視しない", () => {
    const s = change(start(), "required_date", "来月上旬");
    expect(decide(s).verdict).toBe("needs_review");
    expect(decide(s).items[0].missingFields).toContain("required_date");
  });
  it("R11 肯定・否定の競合を確認待ちにする", () => {
    expect(
      decide(start(), [
        rs[0],
        { ...rs[0], id: "exclude", decision: "excluded" },
      ]).verdict,
    ).toBe("needs_review");
  });
  it("R18 分野対象外と個別肯定の矛盾を拒否", () => {
    const neg = {
      ...rs[0],
      id: "business-excluded",
      assessmentScope: "business_scope",
      decision: "excluded",
    } as CapabilityRule;
    const r = decide(start(), [rs[0], neg]);
    expect(r.verdict).toBe("needs_review");
  });
  it("R14 混在結果は全体needs_review", () => {
    const a = start();
    const b = start("リング材を支給するので穴加工してほしい");
    a.brief.items.push(b.brief.items[0]);
    expect(decide(a).verdict).toBe("needs_review");
  });
  it("R12/R13 障害と業務判断を分離する", () => {
    expect(decide(start(), rs, "partial").verdict).toBe("needs_review");
    expect(decide(start(), [], "failed").verdict).toBeNull();
    expect(decide(start(), [], "failed").headline).toContain("完了できません");
  });
  it("R19/R20 買い手・過去照会を現在の承認根拠へ昇格しない", () => {
    expect(() => checkRule(rs[0], { ...ss[0], role: "buyer" })).toThrow();
    expect(() =>
      checkRule(rs[0], { ...ss[0], confirmation_stage: "inquiry" }),
    ).toThrow();
  });
  it("ルール条件の範囲・列挙値を検査", () => {
    expect(() =>
      checkRule(
        {
          ...rs[0],
          predicates: [{ field: "request_scope", op: "eq", value: "invalid" }],
        },
        ss[0],
      ),
    ).toThrow();
    expect(() =>
      checkRule(
        {
          ...rs[0],
          predicates: [
            {
              field: "outer_diameter",
              op: "range",
              min: 20,
              max: 10,
              unit: "mm",
            },
          ],
        },
        ss[0],
      ),
    ).toThrow();
  });
  it("rangeは閉区間で単位換算し、型番末尾違いを一致させない", () => {
    let s = start();
    s = applyInput(s, { id: "e", text: "外径1cm", type: "customer_text" }, [
      {
        itemId: s.brief.items[0].id,
        key: "outer_diameter",
        text: "1cm",
        number: 1,
        unit: "cm",
        quote: "外径1cm",
      },
    ]);
    const rule = {
      ...rs[0],
      coveredFields: [...rs[0].coveredFields, "outer_diameter"],
      predicates: [
        ...rs[0].predicates,
        { field: "outer_diameter", op: "range", min: 10, max: 10, unit: "mm" },
      ],
    } as CapabilityRule;
    expect(decide(s, [rule]).verdict).toBe("can_handle");
    expect(decide(start("AX-100Bを購入したい")).verdict).toBe("needs_review");
  });
  it("公開DTOは社内データをコピーしない", () => {
    const r = { ...decide(start()), secret: "private" };
    expect(JSON.stringify(toPublicResult(r))).not.toContain("private");
  });
});
describe("メール引継ぎ", () => {
  it("M01/M05 宛先未設定でも全文コピー可能", () => {
    const s = start();
    const d = makeMailDraft(s, decide(s));
    expect(d.mailto).toBeNull();
    expect(d.body).toContain("AX-100");
  });
  it("M02 UTF-8 URI上限は短縮し全文保持", () => {
    const s = start();
    s.brief.items[0].notes = ["長い相談文".repeat(100)];
    const d = makeMailDraft(s, decide(s), "demo@example.invalid");
    expect(d.shortened).toBe(true);
    expect(d.body.length).toBeGreaterThan(400);
    expect(new TextEncoder().encode(d.mailto!).length).toBeLessThan(1800);
  });
  it("M03 添付の秘密URLを含めない、S09部品別条件を維持", () => {
    const s = start("カバー4個\nネック8個");
    s.attachmentNames = ["図面.pdf"];
    const a = change(s, "coating", "塗装不要", s.brief.items[0].id);
    const b = change(a, "coating", "外装塗装", a.brief.items[1].id);
    const d = makeMailDraft(b, null);
    expect(d.body).toContain("塗装不要");
    expect(d.body).toContain("外装塗装");
    expect(d.body).toContain("メールにも添付");
    expect(d.body).not.toContain("https:");
  });
  it("失効結果と調査失敗をメールでも未確認とする", () => {
    const s = start(),
      r = decide(s);
    r.stale = true;
    expect(makeMailDraft(s, r).body).toContain("未確認");
    expect(makeMailDraft(s, decide(s, [], "failed")).body).toContain(
      "調査未完了",
    );
  });
  it("明示対象のない更新先を捏造しない", () => {
    const s = makeSnapshot("c");
    s.brief.items = [newItem("a"), newItem("b")];
    expect(() =>
      applyInput(s, { id: "e", text: "鉄", type: "customer_text" }, [
        { itemId: "", key: "material", text: "鉄", quote: "鉄" },
      ]),
    ).toThrow();
  });
});

it("S06 操作文を属性値へ混入しない、S04曖昧な部品の条件を変更しない", () => {
  let s = start("ガラス4枚、パッキン8個");
  const old = structuredClone(s.brief.items);
  s = extractDemo(s, "材質は鉄です");
  expect(s.brief.items).toEqual(old);
  s = extractDemo(s, "未確認だけまとめて", chooseNextQuestion(s, []));
  expect(s.brief.items).toEqual(old);
});
it("購入に変えたら材料手配は該当なし、加工へ戻したら未確認にする", () => {
  let s = start("リング材を支給するので穴加工してほしい");
  s = change(s, "request_scope", "purchase");
  expect(
    s.brief.items[0].fields.find((f) => f.key === "material_supply")?.status,
  ).toBe("not_applicable");
  s = change(s, "request_scope", "processing");
  expect(
    s.brief.items[0].fields.find((f) => f.key === "material_supply"),
  ).toBeUndefined();
});

it("F01/F02 抽出のタイムアウトと429で入力を保持し再生成しない", async () => {
  const { extractOnce } = await import("../../src/adapters/extraction");
  const s = start();
  let calls = 0;
  const timeout = await extractOnce(
    {
      extract: async () => {
        calls++;
        return new Promise(() => {});
      },
    },
    s,
    "新しい条件",
    null,
    5,
  );
  expect(timeout.extractionFailed).toBe(true);
  expect(timeout.inputs.at(-1)?.text).toBe("新しい条件");
  expect(calls).toBe(1);
  const failed = await extractOnce(
    {
      extract: async () => {
        calls++;
        throw new Error("429");
      },
    },
    s,
    "追加条件",
    null,
    5,
  );
  expect(failed.extractionFailed).toBe(true);
  expect(calls).toBe(2);
  expect(failed.brief.items).toEqual(s.brief.items);
});
