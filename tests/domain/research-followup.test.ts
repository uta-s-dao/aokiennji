import { describe, expect, it } from "vitest";
import { makeSnapshot, newItem } from "../../src/domain/intake";
import type { Item, ResearchBrief } from "../../src/domain/model";
import {
  publicSearchConditions,
  searchPartnerMaster,
  type PartnerCapability,
  type PartnerMaster,
} from "../../src/domain/partner-search";
import {
  applyResearchFollowup,
  planResearchFollowup,
  toPublicResearchFollowup,
  type ResearchFollowupAnswer,
  type ResearchFollowupWebState,
} from "../../src/domain/research-followup";

function field(
  item: Item,
  key: string,
  text: string,
  number: number | null = null,
  unit: string | null = null,
) {
  item.fields = item.fields.filter((existing) => existing.key !== key);
  item.fields.push({
    key,
    label: key,
    status: "known",
    value: { text, number, unit },
    source: "customer_text",
    eventId: "initial",
    quote: text,
    hardConstraint: true,
  });
}
function setup(group?: Partial<PartnerCapability>, model = true) {
  const brief = makeSnapshot("case-private").brief;
  const item = newItem("ポンプ");
  field(item, "request_scope", "purchase");
  if (model) field(item, "model", "AX-100");
  brief.items = [item];
  const master: PartnerMaster = {
    status: "ready",
    versionId: "v1",
    revision: 1,
    partners: [
      {
        id: "private-partner-id",
        name: "非公開企業名",
        normalizedName: "非公開企業名",
        website: null,
        capabilityState: "documented",
        sourceRefs: [{ fileName: "機密名簿.xlsx", sheet: "内部価格", row: 2 }],
        groups: [
          {
            id: "buy",
            kind: "purchase",
            products: ["ポンプ"],
            facts: [{ field: "model", text: "BX-200" }],
            evidence: ["内部限定の根拠"],
            ...group,
          },
        ],
      },
    ],
  };
  return { brief, item, master };
}
function plan(brief: ResearchBrief, master: PartnerMaster) {
  return planResearchFollowup(brief, searchPartnerMaster(brief, master), {
    master,
  });
}

describe("調査後の顧客質問と再照合", () => {
  it.each<ResearchFollowupAnswer>([
    { status: "unknown" },
    { status: "skipped" },
  ])("未回答の追加確認は必須条件化せず候補を変えない: %j", (answer) => {
    const { brief, master } = setup({ materials: ["SUS304"] }, false);
    const before = searchPartnerMaster(brief, master);
    const pending = plan(brief, master).offer!;
    const updated = applyResearchFollowup(brief, pending, answer, "answer-1");
    expect(updated.restart).toBe(false);
    expect(
      updated.brief.items[0].fields.find((value) => value.key === "material")
        ?.hardConstraint,
    ).toBe(false);
    expect(searchPartnerMaster(updated.brief, master)).toEqual(before);
    expect(
      planResearchFollowup(updated.brief, before, {
        master,
        history: [updated.record],
      }).offer,
    ).toBeNull();
  });
  it("追加確認した希望日は明示された必着条件がなければ希望のまま保存する", () => {
    const { brief, master } = setup(
      { requiredDate: { earliest: "2027-02-01" } },
      false,
    );
    const pending = plan(brief, master).offer!;
    expect(pending.fieldKey).toBe("required_date");
    const updated = applyResearchFollowup(
      brief,
      pending,
      {
        status: "known",
        value: { text: "2027-01-01", number: null, unit: null },
      },
      "answer-1",
    );
    expect(
      updated.brief.items[0].fields.find(
        (value) => value.key === "required_date",
      )?.hardConstraint,
    ).toBe(false);
    expect(
      searchPartnerMaster(updated.brief, master).items[0].review,
    ).toHaveLength(1);
  });
  it("指定型番候補0で同等品可否を理由付き1問にし、同意したときだけ実検索を広げる", () => {
    const { brief, item, master } = setup();
    const pending = plan(brief, master).offer!;
    expect(pending.fieldKey).toBe("equivalent_allowed");
    expect(pending.reason).toContain("探す範囲");
    const updated = applyResearchFollowup(
      brief,
      pending,
      { status: "known", choice: "yes" },
      "answer-1",
    );
    expect(updated.restart).toBe(true);
    expect(
      publicSearchConditions(updated.brief.items[0]).model,
    ).toBeUndefined();
    expect(
      updated.brief.items[0].fields.find((value) => value.key === "model"),
    ).toEqual({
      ...item.fields.find((value) => value.key === "model"),
      hardConstraint: false,
    });
    expect(
      searchPartnerMaster(updated.brief, master).items[0].match,
    ).toHaveLength(1);
    expect(publicSearchConditions(item).model).toBe("AX-100");
    expect(
      planResearchFollowup(
        updated.brief,
        searchPartnerMaster(updated.brief, master),
        { master, history: [updated.record] },
      ).offer,
    ).toBeNull();
  });
  it.each<ResearchFollowupAnswer>([
    { status: "known", choice: "no" },
    { status: "unknown" },
    { status: "skipped" },
  ])("明示不可・不明・スキップは反復質問も再検索もしない: %j", (answer) => {
    const { brief, master } = setup();
    const updated = applyResearchFollowup(
      brief,
      plan(brief, master).offer!,
      answer,
      "answer-1",
    );
    expect(updated.restart).toBe(false);
    expect(publicSearchConditions(updated.brief.items[0]).model).toBe("AX-100");
    expect(
      planResearchFollowup(
        updated.brief,
        searchPartnerMaster(updated.brief, master),
        { master, history: [updated.record] },
      ).offer,
    ).toBeNull();
  });
  it("型番しかなく製品範囲が不明なら条件を空にする同等品質問をしない", () => {
    const { brief, item, master } = setup();
    item.label = "AX-100";
    expect(plan(brief, master).offer).toBeNull();
  });
  it("全社が指定数量・在庫・納期を確認できない場合は顧客に再質問せず担当者へ渡す", () => {
    const { brief, item, master } = setup({
      facts: [{ field: "model", text: "AX-100" }],
    });
    field(item, "quantity", "100個", 100, "個");
    field(item, "required_date", "2027-01-10");
    const result = plan(brief, master);
    expect(result.offer).toBeNull();
    expect(result.staffTasks.map((task) => task.fieldKey)).toEqual(
      expect.arrayContaining(["quantity", "required_date"]),
    );
  });
  it("Webで指定型番の商品が確認できた場合、数量不足を同等品質問に置き換えない", () => {
    const { brief, item, master } = setup();
    const web: ResearchFollowupWebState = {
      status: "completed",
      items: [
        {
          itemId: item.id,
          status: "completed",
          candidates: [
            { confirmed: [{ field: "model" }], unconfirmed: ["在庫・納期"] },
          ],
        },
      ],
    };
    const result = planResearchFollowup(
      brief,
      searchPartnerMaster(brief, master),
      { master, web },
    );
    expect(result.offer).toBeNull();
    expect(result.staffTasks).toEqual([
      expect.objectContaining({ fieldKey: "supplier_confirmation" }),
    ]);
  });
  it.each(["failed", "incomplete", "blocked"] as const)(
    "Web%sは0件扱いで質問を生まない",
    (status) => {
      const { brief, master } = setup();
      expect(
        planResearchFollowup(brief, searchPartnerMaster(brief, master), {
          master,
          web: { status, items: [] },
        }).offer,
      ).toBeNull();
    },
  );
  it("未検索・別品目・重複・マスタ失敗を0件と誤認しない", () => {
    const { brief, item, master } = setup();
    const result = searchPartnerMaster(brief, master);
    expect(
      planResearchFollowup(brief, { ...result, status: "failed" }).offer,
    ).toBeNull();
    expect(
      planResearchFollowup(brief, { ...result, items: [] }).offer,
    ).toBeNull();
    expect(
      planResearchFollowup(brief, {
        ...result,
        items: [{ ...result.items[0], itemId: "other" }],
      }).offer,
    ).toBeNull();
    expect(
      planResearchFollowup(brief, {
        ...result,
        items: [{ ...result.items[0], status: "incomplete" }],
      }).offer,
    ).toBeNull();
    brief.items.push({ ...item });
    expect(
      planResearchFollowup(brief, {
        ...result,
        items: [result.items[0], result.items[0]],
      }).offer,
    ).toBeNull();
  });
  it("型番以外でも候補分類が変わる材質の具体的な1問を出し、既知の条件を緩めない", () => {
    const { brief, master } = setup({ materials: ["SUS304"] }, false);
    const pending = plan(brief, master).offer!;
    expect(pending.kind).toBe("clarify_field");
    expect(pending.fieldKey).toBe("material");
    const updated = applyResearchFollowup(
      brief,
      pending,
      { status: "known", value: { text: "SUS316", number: null, unit: null } },
      "answer-1",
    );
    expect(updated.restart).toBe(true);
    expect(
      searchPartnerMaster(updated.brief, master).items[0].mismatch,
    ).toHaveLength(1);
    expect(
      updated.brief.items[0].fields.find((value) => value.key === "material")
        ?.hardConstraint,
    ).toBe(true);
  });
  it("候補の寸法範囲を変える回答だけを保存し数値と原文の食い違いを拒否する", () => {
    const { brief, master } = setup(
      { dimensions: { outer_diameter: { max: 100, unit: "mm" } } },
      false,
    );
    const pending = plan(brief, master).offer!;
    expect(pending.fieldKey).toBe("outer_diameter");
    expect(() =>
      applyResearchFollowup(
        brief,
        pending,
        {
          status: "known",
          value: { text: "外径100mm", number: 20, unit: "mm" },
        },
        "answer-1",
      ),
    ).toThrow("INVALID_RESEARCH_FOLLOWUP");
    const updated = applyResearchFollowup(
      brief,
      pending,
      {
        status: "known",
        value: { text: "外径120mm", number: 120, unit: "mm" },
      },
      "answer-1",
    );
    expect(updated.restart).toBe(true);
    expect(
      searchPartnerMaster(updated.brief, master).items[0].mismatch,
    ).toHaveLength(1);
  });
  it("既知の材質を変える質問や会社資料にない材質の質問をしない", () => {
    const { brief, item, master } = setup({}, false);
    expect(plan(brief, master).offer).toBeNull();
    master.partners[0].groups[0].materials = ["SUS304"];
    field(item, "material", "SUS316");
    expect(plan(brief, master).offer).toBeNull();
  });
  it("回答が公開Web条件の辞書外でも実マスタ条件が変わるなら再照合する", () => {
    const { brief, master } = setup({ materials: ["チタン"] }, false);
    const updated = applyResearchFollowup(
      brief,
      plan(brief, master).offer!,
      { status: "known", value: { text: "チタン", number: null, unit: null } },
      "answer-1",
    );
    expect(updated.restart).toBe(true);
    expect(
      searchPartnerMaster(updated.brief, master).items[0].match,
    ).toHaveLength(1);
  });
  it.each(["yes", "no"])(
    "型番を訂正した後は旧型番の%s履歴で検索を緩めたり新質問を遮断しない",
    (choice) => {
      const { brief, master } = setup();
      const updated = applyResearchFollowup(
        brief,
        plan(brief, master).offer!,
        { status: "known", choice },
        "answer-1",
      );
      const model = updated.brief.items[0].fields.find(
        (value) => value.key === "model",
      )!;
      model.value!.text = "CX-300";
      expect(publicSearchConditions(updated.brief.items[0]).model).toBe(
        "CX-300",
      );
      const search = searchPartnerMaster(updated.brief, master);
      expect(search.items[0].mismatch).toHaveLength(1);
      expect(
        planResearchFollowup(updated.brief, search, {
          master,
          history: [updated.record],
        }).offer?.fieldKey,
      ).toBe("equivalent_allowed");
    },
  );
  it("同じ回答の二重適用や古い質問への回答を拒否する", () => {
    const { brief, master } = setup();
    const pending = plan(brief, master).offer!;
    const updated = applyResearchFollowup(
      brief,
      pending,
      { status: "known", choice: "yes" },
      "answer-1",
    );
    expect(() =>
      applyResearchFollowup(
        updated.brief,
        pending,
        { status: "known", choice: "yes" },
        "answer-2",
      ),
    ).toThrow("STALE_RESEARCH_FOLLOWUP");
  });
  it("公開用の質問に内部資料・照合理由・会社名・fingerprintを含めない", () => {
    const { brief, item, master } = setup();
    item.notes.push("顧客内部メモ");
    const publicQuestion = JSON.stringify(
      toPublicResearchFollowup(plan(brief, master).offer!),
    );
    for (const secret of [
      "機密名簿",
      "非公開企業",
      "内部限定",
      "顧客内部メモ",
      "searchFingerprint",
      "case-private",
      "private-partner-id",
    ])
      expect(publicQuestion).not.toContain(secret);
  });
});

it("穴加工で未聴取の穴数だけが候補を変えるときは、発注数量を保持して穴数を確認する", () => {
  const { brief, item, master } = setup(
    {
      kind: "processing",
      processes: ["穴加工"],
      holeCount: { max: 4, unit: "穴" },
    },
    false,
  );
  field(item, "request_scope", "processing");
  field(item, "process", "穴加工");
  field(item, "quantity", "3個", 3, "個");
  master.partners[0].groups[0].quantity = { max: 10, unit: "個" };
  const offer = planResearchFollowup(
    brief,
    searchPartnerMaster(brief, master),
    { master },
  ).offer;
  expect(offer?.fieldKey).toBe("hole_count");
  const updated = applyResearchFollowup(
    brief,
    offer!,
    { status: "known", value: { text: "2か所", number: 2, unit: "か所" } },
    "reply",
  );
  expect(updated.restart).toBe(true);
  expect(publicSearchConditions(updated.brief.items[0])).toMatchObject({
    holeCount: { value: 2 },
    quantity: { value: 3 },
  });
});
