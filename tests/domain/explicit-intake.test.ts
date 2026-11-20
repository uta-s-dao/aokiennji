import { restoreOpeningTurn } from "../../src/adapters/restore-intake";
import { expect, it } from "vitest";
import {
  completeExplicitFields,
  recoverExplicitTurn,
} from "../../src/adapters/explicit-intake";
import {
  applyInput,
  chooseNextQuestion,
  makeSnapshot,
  newItem,
} from "../../src/domain/intake";
import { extractDemo } from "../../src/adapters/extraction";
import type { Question } from "../../src/domain/model";

const request =
  "耐熱ガラスで円筒状の部品を製作したいです。外径50mm、全長100mmで、数量は3個、希望納期は来月末です。";

it("一品目の製作条件と後の内径を、各発言の引用とともに蓄積する", () => {
  const start = makeSnapshot("case");
  const first = recoverExplicitTurn(start, request, null)!;
  const second = recoverExplicitTurn(
    first,
    "中は空洞です。内径は30mmです",
    null,
  )!;
  expect(start.inputs).toEqual([]);
  expect(first.brief.items).toHaveLength(1);
  expect(second.brief.items).toHaveLength(1);
  expect(second.brief.items[0]).toMatchObject({
    id: first.brief.items[0].id,
    label: "部品",
    profile: "fabrication",
  });
  expect(
    Object.fromEntries(
      second.brief.items[0].fields.map((f) => [f.key, f.value?.text]),
    ),
  ).toEqual({
    product_name: "部品",
    work_scope: "円筒状の部品",
    material: "耐熱ガラス",
    request_scope: "fabrication",
    outer_diameter: "50mm",
    overall_length: "100mm",
    quantity: "3個",
    required_date: "来月末",
    body_structure: "hollow",
    inner_diameter: "30mm",
  });
  expect(second.extractionFailed).toBe(false);
  expect(second.extractionError).toBeUndefined();
  expect(second.unresolvedInputs).toEqual([]);
  expect(second.inputs).toHaveLength(2);
  for (const f of second.brief.items[0].fields) {
    const event = second.inputs.find((e) => e.id === f.eventId);
    expect(f.quote).toBeTruthy();
    expect(event?.text).toContain(f.quote);
  }
});

it("製作対象や値が変わっても明示条件を保存する", () => {
  const captured = recoverExplicitTurn(
    makeSnapshot("case"),
    "アルミで箱型のケースを製作してください。幅12.5cm、厚さ2mm、個数4枚、希望納期は12月10日。",
    null,
  )!;
  expect(captured.brief.items[0]).toMatchObject({
    label: "ケース",
    profile: "fabrication",
  });
  expect(captured.brief.items[0].fields).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        key: "width",
        value: { text: "12.5cm", number: 12.5, unit: "cm" },
      }),
      expect.objectContaining({
        key: "material",
        value: expect.objectContaining({ text: "アルミ" }),
      }),
      expect.objectContaining({
        key: "required_date",
        value: expect.objectContaining({ text: "12月10日" }),
      }),
    ]),
  );
});

it.each([
  request.replace("50mm", "約50mm"),
  request.replace("製作したいです", "製作しません"),
  request.replace("製作したいです", "製作できますか"),
  request.replace("円筒状の部品", "カバー及びフランジ"),
  request.replace("円筒状の部品", "カバーとフランジ"),
  request + "もう一つ、穴あきのカバーもお願いします。",
  request + "公差は±0.1mmです。",
  request + "外径は60mmです。",
  request + "訂正します。",
])("条件をすべて確定できない製作文は復元しない: %s", (text) => {
  expect(recoverExplicitTurn(makeSnapshot("case"), text, null)).toBeNull();
});

it("既存品目の値や未解決の変更を上書きしない", () => {
  const start = recoverExplicitTurn(makeSnapshot("case"), request, null)!;
  expect(recoverExplicitTurn(start, "外径は60mmです。", null)).toBeNull();
  start.pendingChanges = [
    {
      itemId: start.brief.items[0].id,
      key: "inner_diameter",
      eventId: "pending",
    },
  ];
  expect(recoverExplicitTurn(start, "内径は30mmです。", null)).toBeNull();
});

it.each([`「${request}」`, `${request}」`])(
  "外側の引用符を解析から外しても保存原文とイベントIDは維持する: %s",
  (text) => {
    const captured = recoverExplicitTurn(
      makeSnapshot("case"),
      text,
      null,
      "original",
    )!;
    expect(captured.inputs).toEqual([
      { id: "original", text, type: "customer_text" },
    ]);
    expect(
      captured.brief.items[0].fields.every((f) => f.eventId === "original"),
    ).toBe(true);
    expect(recoverExplicitTurn(captured, text, null, "original")).toBeNull();
  },
);

it.each(["無垢（中は詰まっている）", "中実です", "中は詰まっています"])(
  "内径を聞かれた品目が無垢なら対象外として保存する: %s",
  (text) => {
    const start = recoverExplicitTurn(makeSnapshot("case"), request, null)!;
    const question: Question = {
      id: "inner",
      itemId: start.brief.items[0].id,
      fieldKey: "inner_diameter",
      text: "中は空洞ですか、それとも無垢ですか？",
      inputType: "text",
      options: [],
      allowUnknown: true,
      allowSkip: true,
    };
    const solid = recoverExplicitTurn(start, text, {
      ...question,
      options: [],
    })!;
    expect(
      solid.brief.items[0].fields.find((f) => f.key === "inner_diameter"),
    ).toMatchObject({
      status: "not_applicable",
      value: null,
      quote: text,
    });
    expect(recoverExplicitTurn(solid, "中は空洞です。", null)).toBeNull();
    const hollow = recoverExplicitTurn(start, "中は空洞です。", null)!;
    expect(recoverExplicitTurn(hollow, text, question)).toBeNull();
    expect(
      recoverExplicitTurn(start, text + "。内径は30mmです。", {
        ...question,
        options: [],
      }),
    ).toBeNull();
  },
);

it("モデルが初回に形状をdescriptionへ保存した品目でも、構造と内径を追記できる", () => {
  const start = recoverExplicitTurn(makeSnapshot("case"), request, null)!;
  const item = start.brief.items[0];
  item.label = "円筒状の部品";
  item.fields = item.fields.filter((field) => field.key !== "product_name");
  const original = item.fields.find((field) => field.key === "work_scope")!;
  original.key = "description";
  original.label = "対象の説明";
  const second = recoverExplicitTurn(
    start,
    "中は空洞です。内径は30mmです。",
    null,
  )!;
  const next = second.brief.items[0];
  expect(next.label).toBe("円筒状の部品");
  expect(next.fields.find((field) => field.key === "description")).toEqual(
    original,
  );
  expect(
    next.fields.find((field) => field.key === "body_structure")?.value?.text,
  ).toBe("hollow");
  expect(
    next.fields.find((field) => field.key === "inner_diameter")?.value?.number,
  ).toBe(30);
  const question: Question = {
    id: "inner",
    itemId: item.id,
    fieldKey: "inner_diameter",
    text: "内径を教えてください。",
    inputType: "text",
    options: [],
    allowUnknown: true,
    allowSkip: true,
  };
  const direct = recoverExplicitTurn(start, "30mmです。", question)!;
  expect(
    direct.brief.items[0].fields.find((field) => field.key === "inner_diameter")
      ?.value?.number,
  ).toBe(30);
  expect(recoverExplicitTurn(second, "無垢です。", question)).toBeNull();
});

it.each(["大阪", "旋盤", "工場"])(
  "製作場所や加工手段を材質として保存しない: %s",
  (word) => {
    const text = request.replace("耐熱ガラス", word);
    expect(recoverExplicitTurn(makeSnapshot("case"), text, null)).toBeNull();
  },
);

it("材質と明記された規格は既知の材料語以外でも保存する", () => {
  const text = request.replace("耐熱ガラス", "材質はZK400");
  const captured = recoverExplicitTurn(makeSnapshot("case"), text, null)!;
  expect(
    captured.brief.items[0].fields.find((field) => field.key === "material")
      ?.value?.text,
  ).toBe("ZK400");
});

it("AIの単一品目の回答に抜けた明示数量と希望納期を同じ入力イベントで補う", () => {
  const before = makeSnapshot("one-turn");
  const after = recoverExplicitTurn(before, request, null)!;
  after.brief.items[0].fields = after.brief.items[0].fields.filter(
    (f) => !["quantity", "required_date"].includes(f.key),
  );
  const enriched = completeExplicitFields(before, after, request, null);
  expect(enriched.inputs).toEqual(after.inputs);
  expect(enriched.brief.items[0].id).toBe(after.brief.items[0].id);
  expect(
    enriched.brief.items[0].fields.find((f) => f.key === "quantity"),
  ).toMatchObject({ eventId: after.inputs[0].id, value: { text: "3個" } });
  expect(
    enriched.brief.items[0].fields.find((f) => f.key === "required_date")?.value
      ?.text,
  ).toBe("来月末");
  expect(after.brief.items[0].fields.some((f) => f.key === "quantity")).toBe(
    false,
  );
});

const inlineRequest =
  "耐熱ガラスの円筒を製作してほしいです。外径50mm、全長100mm、内径30mmの中空で、3個、来月末までにお願いします。";

it.each([
  [
    inlineRequest,
    "円筒",
    "耐熱ガラス",
    "50mm",
    "100mm",
    "30mm",
    "3個",
    "来月末",
  ],
  [
    "SUS304のスリーブを製作してほしいです。全長65 mm、外径80mm、内径：42.5mmの空洞構造で、6本、12月10日までにお願いします。",
    "スリーブ",
    "SUS304",
    "80mm",
    "65mm",
    "42.5mm",
    "6本",
    "12月10日",
  ],
])(
  "複合節から数量・材質・寸法・中空・納期を保存する: %s",
  (text, label, material, outer, length, inner, quantity, deadline) => {
    const captured = recoverExplicitTurn(makeSnapshot("case"), text, null)!;
    expect(captured.brief.items).toHaveLength(1);
    const item = captured.brief.items[0];
    expect(item.label).toBe(label);
    expect(
      Object.fromEntries(item.fields.map((f) => [f.key, f.value?.text])),
    ).toMatchObject({
      material,
      outer_diameter: outer,
      overall_length: length,
      inner_diameter: inner,
      body_structure: "hollow",
      quantity,
      required_date: deadline,
    });
    for (const field of item.fields)
      expect(captured.inputs[0].text).toContain(field.quote);
    expect(
      item.fields.find((f) => f.key === "inner_diameter")?.quote,
    ).not.toContain("中空");
    expect(
      item.fields.find((f) => f.key === "required_date")?.hardConstraint,
    ).toBe(false);
  },
);

it.each([
  ["外径50mm", "外径50mmまで"],
  ["外径50mm", "外径50mmから60mm"],
  ["内径30mm", "内径約30mm"],
  ["内径30mmの中空で", "内径30mmの中空ではなく"],
  ["3個", "3個または4個"],
  ["3個", "3m"],
  ["円筒を", "円筒とカバーを"],
  ["来月末までに", "来月末から再来月末までに"],
])(
  "複合節の近似・範囲・否定・複数品を推定しない: %s → %s",
  (source, replacement) => {
    expect(
      recoverExplicitTurn(
        makeSnapshot("case"),
        inlineRequest.replace(source, replacement),
        null,
      ),
    ).toBeNull();
  },
);

it("型番質問への指定なしとガラス容器への絞り込みを、元の購入条件と同じ品目に保持する", () => {
  const first = extractDemo(
    makeSnapshot("glass-purchase"),
    "ガラス製品を購入したいです。3個、来月末までに必要です。",
  );
  const q = chooseNextQuestion(first, [], false, [], true);
  const text =
    "メーカーや型番の指定はありません。手元で使う交換用のガラス容器です。";
  const after = recoverExplicitTurn(first, text, q)!;
  expect(after.brief.items).toHaveLength(1);
  expect(after.brief.items[0]).toMatchObject({
    id: first.brief.items[0].id,
    label: "ガラス容器",
  });
  for (const key of ["manufacturer", "model"])
    expect(
      after.brief.items[0].fields.find((field) => field.key === key),
    ).toMatchObject({
      status: "unknown",
      quote: "メーカーや型番の指定はありません",
    });
  expect(after.brief.items[0].fields).toEqual(
    expect.arrayContaining(first.brief.items[0].fields),
  );
  expect(chooseNextQuestion(after, [], false, [], true)?.fieldKey).toBe(
    "capacity",
  );

  const event = { id: "model-turn", text, type: "customer_text" as const };
  const omission = applyInput(first, event, []);
  const completed = completeExplicitFields(first, omission, text, q);
  expect(completed.inputs.at(-1)).toEqual(event);
  expect(chooseNextQuestion(completed, [], false, [], true)?.fieldKey).toBe(
    "capacity",
  );
});

it("指定なしだけでは容器を補完せず、容器の蓋や二品目の回答は厳密処理へ渡す", () => {
  const first = extractDemo(
    makeSnapshot("glass-purchase"),
    "ガラス製品を購入したいです。3個、来月末までに必要です。",
  );
  const q = chooseNextQuestion(first, [], false, [], true);
  const after = recoverExplicitTurn(first, "型番は不明です。", q)!;
  expect(after.brief.items[0].label).toBe(first.brief.items[0].label);
  expect(chooseNextQuestion(after, [], false, [], true)?.fieldKey).not.toBe(
    "capacity",
  );
  for (const description of [
    "交換用のガラス容器の蓋です。",
    "ガラス容器とその蓋です。",
    "ガラス容器です。パッキンも購入したいです。",
  ])
    expect(
      recoverExplicitTurn(first, "型番の指定はありません。" + description, q),
    ).toBeNull();
});

const purchaseOpening =
  "ガラス製品を購入したいです。3個、来月末までに必要です。";

it.each([
  [purchaseOpening, "ガラス製品", "3個", "来月末"],
  [
    "アルミケースを購入したい。数量5台、12月10日までにお願いします。",
    "アルミケース",
    "5台",
    "12月10日",
  ],
])(
  "明記された一品目の購入、数量、希望納期を復元する: %s",
  (text, label, quantity, date) => {
    const result = recoverExplicitTurn(makeSnapshot("case"), text, null)!;
    expect(result.brief.items).toHaveLength(1);
    const [item] = result.brief.items;
    expect(item.label).toBe(label);
    expect(
      Object.fromEntries(
        item.fields.map((field) => [field.key, field.value?.text]),
      ),
    ).toMatchObject({
      product_name: label,
      request_scope: "purchase",
      quantity,
      required_date: date,
    });
    for (const field of item.fields) expect(text).toContain(field.quote);
  },
);

it.each([
  purchaseOpening.replace("ガラス製品を", "ガラス製品とパッキンを"),
  purchaseOpening.replace("ガラス製品を", "ガラス製品及びパッキンを"),
  purchaseOpening.replace("3個", "3個、5個"),
  purchaseOpening.replace("3個", "3m"),
  purchaseOpening.replace("3個", "数量3m"),
  purchaseOpening.replace("3個", "実験に使いたいです、3個"),
  purchaseOpening.replace("ガラス製品", "実験用"),
  purchaseOpening.replace("3個", "仮に3個"),
  purchaseOpening.replace("購入したいです", "購入しません"),
])("購入条件が複数・曖昧・否定なら確定しない: %s", (text) => {
  expect(recoverExplicitTurn(makeSnapshot("case"), text, null)).toBeNull();
});

it("モデル結果不明の購入依頼を元のイベントIDで復元する", () => {
  const saved = {
    id: "saved-purchase",
    text: purchaseOpening,
    type: "customer_text" as const,
  };
  const s = {
    ...makeSnapshot("case"),
    extractionFailed: true,
    extractionError: "MODEL_RESULT_UNKNOWN",
    inputs: [saved],
    unresolvedInputs: [saved],
  };
  const result = restoreOpeningTurn(s)!;
  expect(result.inputs).toEqual([saved]);
  expect(result.unresolvedInputs).toEqual([]);
  expect(
    result.brief.items[0].fields.every((field) => field.eventId === saved.id),
  ).toBe(true);
});

it("購入初回はモデル失敗時だけ回復し、成功時の聞き取りを保つ", () => {
  const before = makeSnapshot("case");
  const item = newItem("ガラス製品");
  const model = applyInput(
    before,
    { id: "model-turn", type: "customer_text", text: purchaseOpening },
    [
      {
        itemId: item.id,
        key: "product_name",
        text: "ガラス製品",
        quote: "ガラス製品",
      },
    ],
    [item],
  );
  expect(completeExplicitFields(before, model, purchaseOpening, null)).toBe(
    model,
  );
  const recovered = recoverExplicitTurn(before, purchaseOpening, null)!;
  expect(
    recovered.brief.items[0].fields.find((field) => field.key === "quantity")
      ?.value?.number,
  ).toBe(3);
  expect(
    recovered.brief.items[0].fields.find(
      (field) => field.key === "required_date",
    )?.value?.text,
  ).toBe("来月末");
});
