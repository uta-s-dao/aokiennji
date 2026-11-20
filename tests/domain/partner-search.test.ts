import { describe, expect, it } from "vitest";
import { newItem, makeSnapshot } from "../../src/domain/intake";
import type { Item } from "../../src/domain/model";
import { purchaseProductFamily } from "../../src/domain/product-family";
import {
  searchPartnerMaster,
  maySearchWeb,
  publicSearchConditions,
  type PartnerCapability,
  type PartnerMaster,
} from "../../src/domain/partner-search";
const field = (
  item: Item,
  key: string,
  text: string,
  number: number | null = null,
  unit: string | null = null,
) => {
  item.fields.push({
    key,
    label: key,
    status: "known",
    value: { text, number, unit },
    source: "customer_text",
    eventId: "input",
    quote: text,
    hardConstraint: true,
  });
  return item;
};
function item(label = "丸棒", kind = "processing") {
  const i = newItem(label);
  field(i, "request_scope", kind);
  return i;
}
function brief(items: Item[]) {
  const b = makeSnapshot("secret-case").brief;
  b.items = items;
  return b;
}
function master(groups: PartnerCapability[]): PartnerMaster {
  return {
    status: "ready",
    revision: 1,
    versionId: "v1",
    partners: [
      {
        id: "p1",
        name: "候補商事",
        normalizedName: "候補商事",
        website: null,
        capabilityState: "documented",
        groups,
        sourceRefs: [{ fileName: "test.xlsx", sheet: "加工", row: 2 }],
      },
    ],
  };
}
const turning = (): PartnerCapability => ({
  id: "lathe-1",
  kind: "processing",
  processes: ["旋盤"],
  materials: ["SUS304"],
  dimensions: {
    outer_diameter: { max: 100, unit: "mm" },
    overall_length: { max: 1000, unit: "mm" },
  },
  evidence: ["旋盤1号機の明示対応範囲"],
});
function turningItem() {
  const i = item();
  field(i, "process", "旋盤加工");
  field(i, "material", "SUS304");
  field(i, "outer_diameter", "外径5cm", 5, "cm");
  return i;
}
describe("協力会社マスタの条件照合", () => {
  it("穴径・開口径・外径を別軸として範囲照合し、穴数を依頼数量で代用しない", () => {
    const i = turningItem();
    field(i, "hole_diameter", "穴径6mm", 6, "mm");
    field(i, "opening_diameter", "開口径20mm", 20, "mm");
    field(i, "hole_count", "4穴", 4, "穴");
    field(i, "quantity", "10個", 10, "個");
    const g = turning();
    g.dimensions!.hole_diameter = { min: 2, max: 8, unit: "mm" };
    g.dimensions!.opening_diameter = { max: 25, unit: "mm" };
    g.quantity = { max: 20, unit: "個" };
    const withoutHoleCount = searchPartnerMaster(brief([i]), master([g]));
    expect(withoutHoleCount.items[0].review[0].assessments).toContainEqual(
      expect.objectContaining({ field: "hole_count", status: "unconfirmed" }),
    );
    g.holeCount = { max: 4, unit: "か所" };
    expect(
      searchPartnerMaster(brief([i]), master([g])).items[0].match,
    ).toHaveLength(1);
    g.holeCount.max = 3;
    expect(
      searchPartnerMaster(brief([i]), master([g])).items[0].mismatch[0]
        .assessments,
    ).toContainEqual(
      expect.objectContaining({ field: "hole_count", status: "mismatch" }),
    );
    const conditions = publicSearchConditions(i);
    expect(conditions.holeCount).toEqual({ value: 4, unit: "穴" });
    expect(conditions.quantity).toEqual({ value: 10, unit: "個" });
    expect(conditions.dimensions).toEqual(
      expect.arrayContaining([
        { key: "hole_diameter", value: 6, unit: "mm" },
        { key: "opening_diameter", value: 20, unit: "mm" },
      ]),
    );
  });
  it("開口径の範囲だけでは加工する穴径を確認済みにしない", () => {
    const i = turningItem();
    field(i, "hole_diameter", "穴径6mm", 6, "mm");
    const g = turning();
    g.dimensions!.opening_diameter = { max: 10, unit: "mm" };
    expect(
      searchPartnerMaster(brief([i]), master([g])).items[0].review[0]
        .assessments,
    ).toContainEqual(
      expect.objectContaining({
        field: "hole_diameter",
        status: "unconfirmed",
      }),
    );
    g.dimensions!.hole_diameter = { max: 0.5, unit: "cm" };
    expect(
      searchPartnerMaster(brief([i]), master([g])).items[0].mismatch[0]
        .assessments,
    ).toContainEqual(
      expect.objectContaining({ field: "hole_diameter", status: "mismatch" }),
    );
  });
  it.each([
    ["quantity", "20個", 20, "個"],
    ["overall_length", "2000mm", 2000, "mm"],
    ["required_date", "2027-01-01", null, null],
  ] as const)(
    "変更可能な希望条件%sの未達は候補から除外せず要確認で残す",
    (key, text, number, unit) => {
      const i = turningItem();
      field(i, key, text, number, unit);
      i.fields.find((value) => value.key === key)!.hardConstraint = false;
      const g = turning();
      g.quantity = { max: 10, unit: "個" };
      g.requiredDate = { earliest: "2027-02-01" };
      const result = searchPartnerMaster(brief([i]), master([g]));
      expect(result.items[0].match).toHaveLength(0);
      expect(result.items[0].review).toHaveLength(1);
      expect(result.items[0].mismatch).toHaveLength(0);
      expect(
        result.items[0].review[0].assessments.find(
          (assessment) => assessment.field === key,
        ),
      ).toEqual(
        expect.objectContaining({
          status: "unconfirmed",
          reason: expect.stringContaining("希望条件は未達"),
        }),
      );
      expect(result.webAllowed).toBe(false);
      i.fields.find((value) => value.key === key)!.hardConstraint = true;
      expect(
        searchPartnerMaster(brief([i]), master([g])).items[0].mismatch,
      ).toHaveLength(1);
    },
  );
  it("型番のhardConstraintフラグだけでは明示的な同等品許可にならない", () => {
    const i = item("ポンプ", "purchase");
    field(i, "model", "AX-100");
    i.fields.find((value) => value.key === "model")!.hardConstraint = false;
    const result = searchPartnerMaster(
      brief([i]),
      master([
        {
          id: "p",
          kind: "purchase",
          products: ["ポンプ"],
          facts: [{ field: "model", text: "BX-200" }],
          evidence: ["商品一覧"],
        },
      ]),
    );
    expect(result.items[0].mismatch).toHaveLength(1);
    expect(publicSearchConditions(i).model).toBe("AX-100");
  });
  it("指定した全条件の根拠が揃えば一致し、未指定数量や納期を要求しない", () => {
    const r = searchPartnerMaster(brief([turningItem()]), master([turning()]));
    expect(r.items[0].match).toHaveLength(1);
    expect(r.webAllowed).toBe(false);
    expect(
      r.items[0].match[0].assessments.find((a) => a.field === "outer_diameter")
        ?.reason,
    ).toContain("100mm");
  });
  it("同一設備内で長さと外径を検証し、別設備の範囲を合算しない", () => {
    const i = turningItem();
    field(i, "overall_length", "全長1200mm", 1200, "mm");
    const a = turning(),
      b = turning();
    a.id = "a";
    b.id = "b";
    b.dimensions = {
      outer_diameter: { max: 20, unit: "mm" },
      overall_length: { max: 1500, unit: "mm" },
    };
    const r = searchPartnerMaster(brief([i]), master([a, b]));
    expect(r.items[0].match).toEqual([]);
    expect(r.items[0].review).toEqual([]);
    expect(r.items[0].mismatch).toHaveLength(2);
    expect(r.webAllowed).toBe(true);
  });
  it("関連加工があって根拠のない寸法・数量・納期は要確認", () => {
    const i = turningItem();
    field(i, "quantity", "10個", 10, "個");
    field(i, "required_date", "2027-02-01");
    const r = searchPartnerMaster(brief([i]), master([turning()]));
    expect(r.items[0].review).toHaveLength(1);
    expect(r.webAllowed).toBe(false);
  });
  it("単位・軸が不明なら要確認、異なる軸を代用しない", () => {
    const i = turningItem();
    field(i, "dimension_unspecified", "100mm", 100, "mm");
    const g = turning();
    delete g.dimensions?.outer_diameter;
    expect(
      searchPartnerMaster(brief([i]), master([g])).items[0].review,
    ).toHaveLength(1);
  });
  it("数量の単位を区別し、納期明示範囲を照合する", () => {
    const i = turningItem();
    field(i, "quantity", "10枚", 10, "枚");
    field(i, "required_date", "2027-02-01");
    const g = turning();
    g.quantity = { min: 1, max: 50, unit: "個" };
    g.requiredDate = { earliest: "2027-03-01" };
    const r = searchPartnerMaster(brief([i]), master([g]));
    expect(
      r.items[0].mismatch[0].assessments.find((a) => a.field === "quantity")
        ?.status,
    ).toBe("unconfirmed");
    expect(
      r.items[0].mismatch[0].assessments.find(
        (a) => a.field === "required_date",
      )?.status,
    ).toBe("mismatch");
  });
  it("購入資料の丸棒は仕入候補になるが旋盤加工の対応は確認できない", () => {
    const g = turning();
    g.kind = "purchase";
    g.products = ["丸棒"];
    const r = searchPartnerMaster(brief([turningItem()]), master([g]));
    expect(r.items[0].match).toEqual([]);
    const [candidate] = r.items[0].review;
    expect(candidate?.sourcingBasis).toBe("product");
    expect(candidate?.assessments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "request_scope",
          status: "unconfirmed",
        }),
        expect.objectContaining({ field: "process", status: "unconfirmed" }),
        expect.objectContaining({ field: "product_name", status: "confirmed" }),
        expect.objectContaining({ field: "material", status: "confirmed" }),
        expect.objectContaining({
          field: "outer_diameter",
          status: "confirmed",
        }),
      ]),
    );
    expect(r.webAllowed).toBe(false);
  });

  const supplyGroup = (id: string, product: string): PartnerCapability => ({
    id,
    kind: "purchase",
    products: [product],
    evidence: [product],
    source: { fileName: "取扱い品.xlsx", sheet: "仕入", row: 8 },
  });
  it.each([
    ["スプレーノズルチップ", "ノズル製品他", "ノズル"],
    ["ノズルチップ", "ノズル類", "ノズル"],
    ["断熱ブランケット", "断熱材等", "断熱材"],
    ["ガラス容器", "ガラス製品", "ガラス製品"],
    ["交換用の硝子製ボトル", "硝子製品", "ガラス製品"],
  ])(
    "購入の%sに対する上位分類%sは製品の取扱いを要確認とする",
    (product, listing, family) => {
      const i = item(product, "purchase");
      field(i, "model", "TYPE-100");
      field(i, "width", "100mm", 100, "mm");
      const group = supplyGroup("related", listing);
      const r = searchPartnerMaster(
        brief([i]),
        master([group, supplyGroup("unrelated", "部品全般")]),
      );
      expect(purchaseProductFamily(product + "を購入したい")).toBe(family);
      expect(r.items[0].match).toEqual([]);
      expect(r.items[0].review.map((c) => c.groupId)).toEqual(["related"]);
      const candidate = r.items[0].review[0];
      expect(candidate.sourceRefs).toEqual([group.source]);
      expect(candidate.assessments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "product_name",
            status: "unconfirmed",
            reason: expect.stringContaining("上位分類"),
          }),
          expect.objectContaining({ field: "model", status: "unconfirmed" }),
          expect.objectContaining({ field: "width", status: "unconfirmed" }),
        ]),
      );
      expect(r.webAllowed).toBe(false);
    },
  );
  it("同じ条件組に具体的な品名がある場合に限り、上位分類に優先して一致とする", () => {
    const i = item("スプレーノズルチップ", "purchase");
    field(i, "model", "N-01");
    const a = {
      ...supplyGroup("specific", "スプレーノズルチップ、ノズル製品他"),
      facts: [{ field: "model", text: "N-01" }],
    };
    const b = supplyGroup("family", "ノズル製品他");
    const c = {
      ...b,
      id: "wrong-model",
      facts: [{ field: "model", text: "N-02" }],
    };
    const d = supplyGroup("unrelated", "ノズル清掃用ブラシ");
    const found = searchPartnerMaster(brief([i]), master([a, b, c, d]))
      .items[0];
    expect(found.match.map((x) => x.groupId)).toEqual(["specific"]);
    expect(found.review.map((x) => x.groupId)).toEqual(["family"]);
    expect(found.mismatch.map((x) => x.groupId)).toEqual([
      "wrong-model",
      "unrelated",
    ]);
  });
  it("商品名の上位分類を同じ品目の説明で具体化し、供給元の上位分類だけでは一致させない", () => {
    const i = item("断熱材", "purchase");
    field(i, "product_name", "断熱材");
    field(i, "description", "断熱ブランケット");
    i.fields.find((f) => f.key === "description")!.hardConstraint = false;
    const m = master([
      supplyGroup("family", "断熱材等"),
      supplyGroup("specific", "断熱ブランケット"),
    ]);
    const r = searchPartnerMaster(brief([i]), m).items[0];
    expect(r.match.map((c) => c.groupId)).toEqual(["specific"]);
    expect(r.review.map((c) => c.groupId)).toEqual(["family"]);
  });
  it("訂正後の新しい商品・用途や以前の説明から旧商品の上位分類を拾わない", () => {
    const i = item("ノズル類", "purchase");
    field(i, "product_name", "ホース");
    field(i, "description", "ノズルチップ");
    field(i, "purpose", "断熱ブランケットの施工に使う");
    for (const f of i.fields.filter((entry) =>
      ["purpose", "description"].includes(entry.key),
    ))
      f.hardConstraint = false;
    const m = master([
      supplyGroup("nozzle", "ノズル製品他"),
      supplyGroup("thermal", "断熱材等"),
      supplyGroup("hose", "ホース"),
    ]);
    const r = searchPartnerMaster(brief([i]), m).items[0];
    expect(r.match.map((c) => c.groupId)).toEqual(["hose"]);
    expect(r.review).toEqual([]);
    i.fields.find((f) => f.key === "product_name")!.value!.text = "ノズル";
    const name = i.fields.find((f) => f.key === "product_name")!;
    Object.assign(name, { eventId: "corrected", source: "field_edit" });
    const corrected = searchPartnerMaster(brief([i]), m).items[0];
    expect(corrected.match.map((c) => c.groupId)).toEqual(["nozzle"]);
    expect(corrected.review).toEqual([]);
  });
  it.each([
    ["ノズルチップ", "ノズル製品他、ノズルチップ取扱いなし"],
    ["ノズルチップ", "ノズル類（販売禁止）"],
    ["断熱ブランケット", "断熱材等（断熱ブランケットを除く）"],
    ["ノズル清掃用ブラシ", "ノズル類"],
    ["ノズルチップ用の清掃ブラシ", "ノズルチップ"],
    ["毛布", "断熱材等"],
    ["断熱材入り毛布", "断熱材"],
    ["寝具用断熱ブランケット", "断熱材等"],
    ["ノズルチップ", "チップ"],
    ["ガラス容器用の蓋", "ガラス製品"],
    ["ガラス容器（500mL）の交換用の蓋", "ガラス製品"],
    ["ガラスではない容器", "ガラス製品"],
    ["樹脂製容器", "ガラス製品"],
    ["500mLの容器", "ガラス製品"],
  ])(
    "依頼%sと禁止・別用途を含む取扱い品%sから候補を作らない",
    (name, listing) => {
      const r = searchPartnerMaster(
        brief([item(name, "purchase")]),
        master([supplyGroup("other", listing)]),
      );
      expect(r.items[0].match).toEqual([]);
      expect(r.items[0].review).toEqual([]);
      expect(r.webAllowed).toBe(true);
    },
  );
  it("旧品名・使用先・容量からガラス容器の調達を推測しない", () => {
    const m = master([supplyGroup("catalog", "ガラス製品")]);
    const i = item("容器", "purchase");
    field(i, "purpose", "ガラス容器の付属品");
    field(i, "capacity", "500mL", 500, "mL");
    expect(searchPartnerMaster(brief([i]), m).webAllowed).toBe(true);
    i.label = "ガラス容器";
    field(i, "material", "樹脂");
    expect(searchPartnerMaster(brief([i]), m).webAllowed).toBe(true);
  });
  it("一覧のみ・別条件組の寸法・Web送信語は上位分類で広げない", () => {
    const i = item("断熱ブランケット", "purchase");
    field(i, "width", "幅50mm", 50, "mm");
    const m = master([
      supplyGroup("a", "断熱材等"),
      {
        ...supplyGroup("b", "ノズル類"),
        dimensions: { width: { max: 100, unit: "mm" } },
      },
    ]);
    const found = searchPartnerMaster(brief([i]), m);
    expect(found.items[0].review[0].assessments).toContainEqual(
      expect.objectContaining({ field: "width", status: "unconfirmed" }),
    );
    expect(found.webAllowed).toBe(false);
    m.partners[0].capabilityState = "list_only";
    expect(searchPartnerMaster(brief([i]), m).webAllowed).toBe(true);
    expect(publicSearchConditions(i).products).toEqual([]);
  });
  it.each(["部品", "耐熱ガラスの円筒状の部品"])(
    "品名が%sでも耐熱ガラスを同じ取扱条件の調達候補にする",
    (label) => {
      const i = item(label, "fabrication");
      field(i, "material", "耐熱ガラス");
      field(i, "work_scope", "円筒状の部品");
      field(i, "outer_diameter", "外径50mm", 50, "mm");
      field(i, "quantity", "3個", 3, "個");
      const glass = supplyGroup("glass", "ガラス製品");
      const r = searchPartnerMaster(
        brief([i]),
        master([
          glass,
          supplyGroup("other-material", "耐熱材等"),
          supplyGroup("metal", "耐熱金物"),
          { ...supplyGroup("other", "工具"), equipment: ["耐熱ガラス"] },
          { ...supplyGroup("pump", "真空ポンプ"), materials: ["耐熱ガラス"] },
          supplyGroup("wool", "ガラスウール"),
          supplyGroup("quartz", "石英ガラス"),
          supplyGroup("part", "部品全般"),
          { ...turning(), materials: ["耐熱ガラス"] },
        ]),
      );
      expect(r.items[0].match).toEqual([]);
      expect(r.items[0].review.map((c) => c.groupId)).toEqual(["glass"]);
      const [candidate] = r.items[0].review;
      expect(candidate.sourcingBasis).toBe("material");
      expect(candidate.sourceRefs).toEqual([glass.source]);
      expect(candidate.assessments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "取扱い品",
            status: "confirmed",
            reason: expect.stringContaining("ガラス製品"),
          }),
          expect.objectContaining({
            field: "product_name",
            status: "unconfirmed",
            reason: expect.stringContaining("ガラス製品"),
          }),
          expect.objectContaining({
            field: "material",
            status: "unconfirmed",
            reason: expect.stringContaining("耐熱ガラス"),
          }),
          expect.objectContaining({
            field: "request_scope",
            status: "unconfirmed",
            reason: expect.stringContaining("当社の受注可否"),
          }),
          expect.objectContaining({
            field: "outer_diameter",
            status: "unconfirmed",
          }),
          expect.objectContaining({ field: "quantity", status: "unconfirmed" }),
        ]),
      );
      expect(r.webAllowed).toBe(false);
      expect(publicSearchConditions(i).products).toContain("ガラス");
    },
  );
  it.each(["description", "work_scope", "product_name"])(
    "品名が一般名でも%sの具体的な依頼品で仕入候補を見つける",
    (key) => {
      const i = item("部品", "fabrication");
      field(i, key, "バルブの製作");
      const r = searchPartnerMaster(
        brief([i]),
        master([supplyGroup("valve", "継手、バルブ等")]),
      );
      expect(r.items[0].review[0]?.sourcingBasis).toBe("product");
      expect(publicSearchConditions(i).products).toContain("バルブ");
    },
  );
  it.each(["ガラスウール", "ガラス用工具", "ガラスカッター", "ガラス加工機"])(
    "名称%sの用途から製品の材質を推定しない",
    (name) => {
      const r = searchPartnerMaster(
        brief([item(name, "fabrication")]),
        master([supplyGroup("glass", "ガラス製品")]),
      );
      expect(r.items[0].review).toEqual([]);
      expect(r.webAllowed).toBe(true);
    },
  );
  it("型番・取扱品が特定できる仕入候補でも製作対応は担当者に残す", () => {
    const i = item("ノズル", "fabrication");
    field(i, "model", "NZ-45");
    const g = {
      ...supplyGroup("nozzle", "ノズル製品他"),
      facts: [{ field: "model", text: "NZ-45" }],
    };
    const r = searchPartnerMaster(brief([i]), master([g]));
    expect(r.items[0].match).toEqual([]);
    const [candidate] = r.items[0].review;
    expect(candidate?.sourcingBasis).toBe("product");
    expect(candidate?.assessments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "model", status: "confirmed" }),
        expect.objectContaining({ field: "product_name", status: "confirmed" }),
        expect.objectContaining({
          field: "request_scope",
          status: "unconfirmed",
        }),
      ]),
    );
  });
  it.each([
    ["SUS304", "SUS316"],
    ["SUS304", "SUS304L"],
    ["A5052", "A6061"],
    ["耐熱ガラス", "耐熱ガラス非対応"],
    ["耐熱ガラス", "ガラス製品、耐熱ガラス不可"],
  ])(
    "取扱資料が依頼材質%sとは別種、または除外の%sなら調達候補を出さない",
    (material, reference) => {
      const i = item("部品", "processing");
      field(i, "material", material);
      const r = searchPartnerMaster(
        brief([i]),
        master([supplyGroup("p", reference)]),
      );
      expect(r.items[0].review).toEqual([]);
      expect(r.webAllowed).toBe(true);
    },
  );
  it("客先支給と同一条件組の明示的不一致を維持する", () => {
    const i = item("丸棒", "processing");
    field(i, "material", "SUS304");
    const generic = supplyGroup("generic", "ステンレス製品");
    const other = {
      ...supplyGroup("other-grade", "丸棒"),
      materials: ["SUS316"],
    };
    const m = master([generic, other]);
    const found = searchPartnerMaster(brief([i]), m).items[0];
    expect(found.review.map((c) => c.groupId)).toEqual(["generic"]);
    expect(found.mismatch.map((c) => c.groupId)).toEqual(["other-grade"]);
    field(i, "material_supply", "customer_supplied");
    const r = searchPartnerMaster(brief([i]), m);
    expect(r.items[0].review).toEqual([]);
    expect(r.webAllowed).toBe(true);
  });
  it("社名しかない行は候補から除外", () => {
    const m = master([turning()]);
    m.partners[0].capabilityState = "list_only";
    const r = searchPartnerMaster(brief([turningItem()]), m);
    expect(r.items[0].match).toEqual([]);
    expect(r.items[0].review).toEqual([]);
  });
  it.each([
    ["パッキン等", "パッキンを購入したい"],
    ["ノズル製品他", "ノズル製品"],
    ["ガラス製品", "ガラス製品"],
    ["硝子製品", "硝子製品"],
    ["ノズル類", "ノズルを購入したい"],
    ["ポンプ等", "ポンプを購入したい"],
    ["断熱材", "断熱材を購入したい"],
    ["耐熱金物", "耐熱金物を購入したい"],
  ])("具体的な取扱品%sを日本語相談と照合", (product, name) => {
    const r = searchPartnerMaster(
      brief([item(name, "purchase")]),
      master([
        {
          id: "buy",
          kind: "purchase",
          products: [product],
          evidence: ["取扱商品一覧"],
        },
      ]),
    );
    expect(r.items[0].match).toHaveLength(1);
  });
  it.each([
    [{ text: "0.5", unit: "L" }, "confirmed"],
    [{ text: "0.5リットル" }, "confirmed"],
    [{ text: "250mL" }, "mismatch"],
    [{ text: "500" }, "unconfirmed"],
    [{ text: "500", unit: "mm" }, "unconfirmed"],
    [{ text: "500mL", unit: "L" }, "unconfirmed"],
    [{ text: "最大1L", unit: "L", bound: "max" }, "unconfirmed"],
  ] as const)(
    "同一取扱組に明記された容量%jと500mLを軸・単位込みで照合する",
    (fact, status) => {
      const i = item("ガラス容器", "purchase");
      field(i, "capacity", "500mL", 500, "mL");
      const g = {
        ...supplyGroup("glass", "ガラス容器"),
        facts: [{ field: "capacity", ...fact }],
      };
      const found = searchPartnerMaster(brief([i]), master([g])).items[0];
      expect(
        [...found.review, ...found.match, ...found.mismatch][0].assessments,
      ).toContainEqual(expect.objectContaining({ field: "capacity", status }));
      expect(found.match).toHaveLength(status === "confirmed" ? 1 : 0);
    },
  );
  it("ステンレス板とアルミ板は板という共通語で一致しない", () => {
    const r = searchPartnerMaster(
      brief([item("ステンレス板", "purchase")]),
      master([
        {
          id: "buy",
          kind: "purchase",
          products: ["アルミ板"],
          evidence: ["商品一覧"],
        },
      ]),
    );
    expect(r.items[0].mismatch).toHaveLength(1);
  });
  it.each(["鏡板等", "銘板,プレート等"])(
    "単一漢字の板を共有する別製品%sを候補にしない",
    (product) => {
      const r = searchPartnerMaster(
        brief([item("ステンレス板を購入したい", "purchase")]),
        master([
          {
            id: "other",
            kind: "purchase",
            products: [product],
            evidence: ["商品一覧"],
          },
        ]),
      );
      expect(r.items[0].match).toEqual([]);
      expect(r.items[0].review).toEqual([]);
    },
  );
  it.each(["unknown", "skipped"] as const)(
    "軸不明寸法を%sにしても関連候補を要確認に残す",
    (status) => {
      const i = turningItem();
      i.fields.push({
        key: "dimension_unspecified",
        label: "寸法種別",
        status,
        value: null,
        source: "customer_text",
        eventId: "input",
        quote: "50mm",
        hardConstraint: true,
      });
      i.notes.push("寸法種別は未確認：50mm");
      expect(
        searchPartnerMaster(brief([i]), master([turning()])).items[0].review,
      ).toHaveLength(1);
    },
  );
  it("ステンレス一般の根拠ではSUS304は要確認、アルミとの矛盾は不一致", () => {
    const i = turningItem(),
      g = turning();
    g.materials = ["ステンレス"];
    expect(
      searchPartnerMaster(brief([i]), master([g])).items[0].review,
    ).toHaveLength(1);
    g.materials = ["アルミ"];
    expect(
      searchPartnerMaster(brief([i]), master([g])).items[0].mismatch,
    ).toHaveLength(1);
  });
  it("SUS304Lだけの根拠をSUS304と一致させない", () => {
    const g = turning();
    g.materials = ["SUS304L"];
    expect(
      searchPartnerMaster(brief([turningItem()]), master([g])).items[0].match,
    ).toEqual([]);
  });
  it("一般ステンレス指定には明示されたSUS304の材質根拠を使える", () => {
    const i = turningItem();
    i.fields.find((f) => f.key === "material")!.value!.text = "ステンレス";
    expect(
      searchPartnerMaster(brief([i]), master([turning()])).items[0].match,
    ).toHaveLength(1);
  });
  it("指定型番・メーカー・追加加工条件を無視して一致にしない", () => {
    const i = turningItem();
    field(i, "model", "MODEL-SECRET");
    field(i, "manufacturer", "指定メーカー");
    const g = turning();
    expect(
      searchPartnerMaster(brief([i]), master([g])).items[0].review,
    ).toHaveLength(1);
    g.facts = [
      { field: "model", text: "MODEL-SECRET" },
      { field: "manufacturer", text: "指定メーカー" },
    ];
    expect(
      searchPartnerMaster(brief([i]), master([g])).items[0].match,
    ).toHaveLength(1);
  });
  it("研削と研磨を同一加工としない", () => {
    const i = item();
    field(i, "process", "研削");
    const g = turning();
    g.processes = ["研磨"];
    g.products = ["丸棒"];
    expect(
      searchPartnerMaster(brief([i]), master([g])).items[0].mismatch,
    ).toHaveLength(1);
  });
  it.each(["SUS304不可", "SUS304を除く", "SUS304非対応"])(
    "否定された材質%sを一致にしない",
    (material) => {
      const g = turning();
      g.materials = [material];
      const r = searchPartnerMaster(brief([turningItem()]), master([g]));
      expect(r.items[0].match).toEqual([]);
      expect(r.items[0].mismatch).toHaveLength(1);
      expect(
        r.items[0].mismatch[0].assessments.find((a) => a.field === "material")
          ?.status,
      ).toBe("mismatch");
    },
  );
  it.each(["旋盤加工（要相談）", "旋盤加工 応相談", "旋盤加工（条件付き）"])(
    "加工の留保%sを一致にしない",
    (process) => {
      const g = turning();
      g.processes = [process];
      const r = searchPartnerMaster(brief([turningItem()]), master([g]));
      expect(r.items[0].match).toEqual([]);
      expect(r.items[0].review).toHaveLength(1);
      expect(
        r.items[0].review[0].assessments.find((a) => a.field === "process")
          ?.status,
      ).toBe("unconfirmed");
      expect(r.webAllowed).toBe(false);
    },
  );
  it("否定と肯定の両資料が同じ条件組にあるときは要確認", () => {
    const g = turning();
    g.materials = ["SUS304不可", "SUS304対応"];
    const r = searchPartnerMaster(brief([turningItem()]), master([g]));
    expect(r.items[0].match).toEqual([]);
    expect(r.items[0].review).toHaveLength(1);
  });
  it("別材質への否定を依頼材質への否定と混ぜない", () => {
    const g = turning();
    g.materials = ["SUS304不可、アルミ対応"];
    const i = turningItem();
    i.fields.find((f) => f.key === "material")!.value!.text = "アルミ";
    expect(
      searchPartnerMaster(brief([i]), master([g])).items[0].match,
    ).toHaveLength(1);
  });
  it("購入品の要相談記載も関連候補を要確認に残す", () => {
    const r = searchPartnerMaster(
      brief([item("パッキン", "purchase")]),
      master([
        {
          id: "buy",
          kind: "purchase",
          products: ["パッキン（要相談）"],
          evidence: ["商品一覧"],
        },
      ]),
    );
    expect(r.items[0].match).toEqual([]);
    expect(r.items[0].review).toHaveLength(1);
  });
  it.each([
    "quantity",
    "outer_diameter",
    "overall_length",
    "required_date",
    "material",
    "process",
  ])("必須のhandledフィールド%sがunknownでも黙って一致にしない", (key) => {
    const i = turningItem();
    i.fields = i.fields.filter((f) => f.key !== key);
    i.fields.push({
      key,
      label: key,
      status: "unknown",
      value: null,
      source: "customer_text",
      eventId: "input",
      quote: "未確認",
      hardConstraint: true,
    });
    const g = turning();
    g.products = ["丸棒"];
    const r = searchPartnerMaster(brief([i]), master([g]));
    expect(r.items[0].match).toEqual([]);
    expect(r.items[0].review).toHaveLength(1);
    expect(
      r.items[0].review[0].assessments.some(
        (a) => a.field === key && a.status === "unconfirmed",
      ),
    ).toBe(true);
  });
  it("数量がconflictなら数量自身を未確認理由として示す", () => {
    const i = turningItem();
    i.fields.push({
      key: "quantity",
      label: "数量",
      status: "conflict",
      value: null,
      source: "customer_text",
      eventId: "input",
      quote: "数量が競合",
      hardConstraint: true,
    });
    const r = searchPartnerMaster(brief([i]), master([turning()]));
    expect(r.items[0].match).toEqual([]);
    expect(
      r.items[0].review[0].assessments.some(
        (a) => a.field === "quantity" && a.status === "unconfirmed",
      ),
    ).toBe(true);
  });
  it("全品目が正常完了して両候補ゼロの場合だけWeb可", () => {
    const i = turningItem(),
      j = item("不明品", "purchase"),
      b = brief([i, j]);
    const r = searchPartnerMaster(b, master([turning()]));
    expect(r.webAllowed).toBe(false);
    const z = searchPartnerMaster(b, master([]));
    expect(z.webAllowed).toBe(true);
    z.items[1].status = "incomplete";
    expect(maySearchWeb(z, [i.id, j.id])).toBe(false);
    expect(maySearchWeb(z, [i.id, i.id])).toBe(false);
  });
  it.each(["unavailable", "incomplete"])(
    "未登録・取込エラー・未完了%sからWebしない",
    (status) => {
      const m = master([]);
      if (status === "unavailable") {
        m.status = "unavailable";
        m.reason = "IMPORT_FAILED";
      }
      const r = searchPartnerMaster(
        brief([turningItem()]),
        m,
        status !== "incomplete",
      );
      expect(r.webAllowed).toBe(false);
    },
  );
  it("外部送信条件から名称・履歴・メモ・宛先・添付を排除", () => {
    const i = turningItem();
    i.label = "秘密会社 john@example.org パッキン";
    i.notes = ["秘密の顧客名"];
    field(i, "destination", "秘密住所");
    field(i, "description", "秘密説明");
    const value = JSON.stringify(publicSearchConditions(i));
    expect(value).not.toContain("秘密");
    expect(value).not.toContain("john");
    expect(value).not.toContain(i.id);
    expect(value).toContain("パッキン");
  });
});
