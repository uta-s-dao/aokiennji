import { savedReply } from "../../src/domain/customer-copy";
import { it, expect } from "vitest";
import { extractDemo } from "../../src/adapters/extraction";
import {
  applyInput,
  chooseNextQuestion,
  makeSnapshot,
  makeResearchBrief,
} from "../../src/domain/intake";
import { recordDialogueAnswer } from "../../src/domain/dialogue";
import { makeMailDraft } from "../../src/domain/mail";
import fixture from "../../fixtures/demo/knowledge.json";
import type { CapabilityRule, Snapshot } from "../../src/domain/model";
const rules = fixture.rules as CapabilityRule[];
const start = (text: string) => extractDemo(makeSnapshot("dialogue"), text);
const field = (s: Snapshot, name: string, key: string) =>
  s.brief.items
    .find((i) => i.label.includes(name))
    ?.fields.find((f) => f.key === key);

it("品目ごとに残る条件を聞き、2回答や6問後も次の品目へ進む", () => {
  let s = start("ガラスを購入したいです。\nカバーも購入したいです。");
  const visited: string[] = [];
  for (let count = 0; count < 80; count++) {
    const q = chooseNextQuestion(s, rules);
    if (!q) break;
    visited.push(q.itemId + ":" + q.fieldKey);
    s = applyInput(
      s,
      { id: "skip-" + count, text: "スキップ", type: "selection" },
      [
        {
          itemId: q.itemId!,
          key: q.fieldKey,
          status: "skipped",
          quote: "スキップ",
        },
      ],
    );
    s.brief.questionsAsked++;
    s.fallbackCount++;
  }
  expect(visited.length).toBeGreaterThan(6);
  expect(new Set(visited).size).toBe(visited.length);
  for (const item of s.brief.items)
    expect(visited).toContain(item.id + ":quantity");
  expect(chooseNextQuestion(s, rules)).toBeNull();
  expect(makeResearchBrief(s, 2, 1).questionsAsked).toBe(visited.length);
});
it("用途と数量を一緒に答えても用途を取りこぼさず次の質問へ進む", () => {
  const s = start("ポンプの交換部品を購入したいです。型番は分かりません。");
  const q = chooseNextQuestion(s, rules)!;
  expect(q.fieldKey).toBe("purpose");
  const after = extractDemo(
    s,
    "工場のポンプの交換用です。丸いゴムで2個です。",
    q,
  );
  expect(field(after, "交換部品", "purpose")?.value?.text).toContain("交換用");
  expect(field(after, "交換部品", "quantity")?.value?.number).toBe(2);
  expect(chooseNextQuestion(after, rules)?.fieldKey).not.toBe("purpose");
});
it("途中の外径・温度・数量の訂正では新しい数値を採用し、元発言も保持", () => {
  let s = start("ガラス 外径100mm、温度180℃、3枚を購入したいです。");
  const text =
    "設備の確認窓です。外径は100mmではなく120mm、温度は180℃ではなく250℃、数量は3枚ではなく2枚です。";
  s = extractDemo(s, text, chooseNextQuestion(s, rules));
  expect(field(s, "ガラス", "outer_diameter")?.value?.number).toBe(120);
  expect(field(s, "ガラス", "normal_temperature")?.value?.number).toBe(250);
  expect(field(s, "ガラス", "quantity")?.value?.number).toBe(2);
  expect(field(s, "ガラス", "purpose")?.value?.text).toContain("確認窓");
  expect(s.inputs.at(-1)?.text).toBe(text);
  const mail = makeMailDraft(s, null).body;
  expect(mail).toContain("外径：120mm");
  expect(mail).not.toContain("100mm");
});
it("架台とカバーを別品目として作り、追加の数量・塗装・納入先を取り違えない", () => {
  let s = start("架台とカバーの製作を、まとめて相談できますか？");
  expect(s.brief.items.map((i) => i.label)).toEqual(["架台", "カバー"]);
  s = extractDemo(
    s,
    "架台は全体を2台、グレー塗装、大阪工場へお願いします。カバーは5枚で塗装なし、名古屋倉庫へお願いします。",
    chooseNextQuestion(s, rules),
  );
  expect(field(s, "架台", "quantity")?.value?.number).toBe(2);
  expect(field(s, "カバー", "quantity")?.value?.number).toBe(5);
  expect(field(s, "架台", "coating")?.value?.text).toBe("グレー塗装");
  expect(field(s, "カバー", "coating")?.value?.text).toBe("塗装なし");
  expect(field(s, "架台", "destination")?.value?.text).toBe("大阪工場");
  expect(field(s, "カバー", "destination")?.value?.text).toBe("名古屋倉庫");
});
it("途中で追加した別の品目を現在の質問の品目へ混ぜない", () => {
  const s = start("架台の製作をお願いしたいです。");
  const a = extractDemo(
    s,
    "架台は2台です。カバーも5枚お願いしたいです。",
    chooseNextQuestion(s, rules),
  );
  expect(a.brief.items).toHaveLength(2);
  expect(field(a, "架台", "quantity")?.value?.number).toBe(2);
  expect(field(a, "カバー", "quantity")?.value?.number).toBe(5);
});
it("支給リングを材料手配へ保持し、塗料支給を材料全体の支給にしない", () => {
  expect(
    field(
      start("手元のリングを支給して穴加工をお願いしたいです"),
      "リング",
      "material_supply",
    )?.value?.text,
  ).toBe("customer_supplied");
  expect(
    field(
      start("図面の架台を製作したい。塗料は支給"),
      "架台",
      "material_supply",
    ),
  ).toBeUndefined();
});
it("既に分からないと答えた型番やメーカーは再質問しない", () => {
  let s = start("部品を購入したいです。型番もメーカーも分かりません。");
  s = extractDemo(s, "用途は設備の交換用です。", chooseNextQuestion(s, rules));
  expect(field(s, "部品", "model")?.status).toBe("unknown");
  expect(field(s, "部品", "manufacturer")?.status).toBe("unknown");
  expect(["model", "manufacturer"]).not.toContain(
    chooseNextQuestion(s, rules)?.fieldKey,
  );
});
it("曖昧な返答を用途として確定せず、説明し直しても読めない項目だけを保留する", () => {
  let s = start("交換部品を購入したいです。");
  const q = chooseNextQuestion(s, rules)!;
  let a = extractDemo(s, "はい", q);
  recordDialogueAnswer(s, a, q, "text", "はい");
  expect(chooseNextQuestion(a, rules)?.text).toContain("確認できませんでした");
  const q2 = chooseNextQuestion(a, rules)!;
  s = a;
  a = extractDemo(s, "たぶん", q2);
  recordDialogueAnswer(s, a, q2, "text", "たぶん");
  expect(field(a, "交換部品", "purpose")).toBeUndefined();
  expect(chooseNextQuestion(a, rules)?.fieldKey).not.toBe("purpose");
  expect(a.unresolvedInputs?.[0].text).toBe("たぶん");
});
it("未確定の代替案は勝手に適用せず、残りの具体的な質問を続ける", () => {
  const before = start("SUS304のリング材を支給して加工したいです");
  const after = extractDemo(
    before,
    "設備の固定用です。まだ変更は決めていませんが、アルミ材なら材料調達もお願いできますか？",
    chooseNextQuestion(before, rules),
  );
  expect(field(after, "リング材", "material")?.value?.text).toBe("SUS304");
  expect(after.unresolvedInputs?.length).toBeGreaterThan(0);
  expect(chooseNextQuestion(after, rules)?.id).not.toBe("input-recovery");
  const mail = makeMailDraft(after, null).body;
  expect(mail).toContain("追加相談前の発言（現在の確定条件ではありません）");
  expect(mail).toContain("SUS304");
  expect(mail).toContain("アルミ材");
  expect(mail).not.toContain("今回の依頼：");
});

it("未確定の材質・調達変更と、変更していない数量や納入先を分けて引き継ぐ", () => {
  let s = start("SUS304のリング材を支給して加工したいです");
  s = extractDemo(
    s,
    "数量は5個、配送先は埼玉工場です。",
    chooseNextQuestion(s, rules),
  );
  const a = extractDemo(
    s,
    "アルミに変えたらどうですか。材料もそちらで用意できますか。まだ変更は決めていません",
    chooseNextQuestion(s, rules),
  );
  expect(field(a, "リング材", "material")?.value?.text).toBe("SUS304");
  expect(a.pendingChanges?.map((p) => p.key)).toEqual(
    expect.arrayContaining(["material", "material_supply"]),
  );
  const mail = makeMailDraft(a, null).body;
  expect(mail).toContain("数量：5個");
  expect(mail).toContain("納入先：埼玉工場です");
  expect(mail).not.toContain("材質：SUS304");
  expect(mail).not.toContain("材料手配：客先支給");
  expect(mail).toContain("SUS304のリング材");
  expect(mail).toContain("アルミに変えたら");
});

it("旧値の単位を省いた訂正と通常・最高の温度を分けて保持する", () => {
  let s = start("ガラス 外径100mm、通常温度780℃、数量3枚を購入したいです");
  s = extractDemo(
    s,
    "外径は100ではなく120mmです。通常温度は780ではなく680℃、最高820℃でした。数量は3ではなく2枚です。",
    chooseNextQuestion(s, rules),
  );
  expect(field(s, "ガラス", "outer_diameter")?.value?.number).toBe(120);
  expect(field(s, "ガラス", "normal_temperature")?.value?.number).toBe(680);
  expect(field(s, "ガラス", "peak_temperature")?.value?.number).toBe(820);
  expect(field(s, "ガラス", "quantity")?.value?.number).toBe(2);
  const mail = makeMailDraft(s, null).body;
  expect(mail).not.toContain("780℃");
  expect(mail).toContain("120mm");
});
it("最初の用途・刻印なしと穴加工の説明を再質問しない", () => {
  let s = start(
    "ポンプの漏れ止めに使う、丸いゴムのパッキンを探しています。刻印もないです。",
  );
  expect(field(s, "パッキン", "purpose")?.value?.text).toContain("漏れ止め");
  expect(field(s, "パッキン", "marking")?.value?.text).toContain("刻印もない");
  expect(chooseNextQuestion(s, rules)?.fieldKey).not.toBe("purpose");
  s = start("リング材の材料調達と穴加工を、まとめてお願いしたいです。");
  expect(field(s, "リング材", "material_supply")?.value?.text).toBe(
    "company_sourced",
  );
  s = extractDemo(
    s,
    "直径6mmの穴を2か所開けてほしいです。",
    chooseNextQuestion(s, rules),
  );
  expect(field(s, "リング材", "process")?.value?.text).toContain("穴を2か所");
});
it("塗料はこちらで支給と図面の改訂Bを他条件と一緒に保持する", () => {
  let s = start("図面の架台を製作したいです。材料は会社で用意してください。");
  s = extractDemo(
    s,
    "グレーで塗装してください。塗料はこちらで支給します。今添付した図面は改訂Bです。",
    chooseNextQuestion(s, rules),
  );
  expect(field(s, "架台", "supplied_parts")?.value?.text).toContain(
    "塗料はこちらで支給",
  );
  expect(field(s, "架台", "drawing_revision")?.value?.text).toBe("B");
  expect(field(s, "架台", "material_supply")?.value?.text).toBe(
    "company_sourced",
  );
});
it("訂正の確認中、別の数量を答えただけでは旧温度を確定し直さない", () => {
  const s = start("ガラス 通常温度780℃");
  s.unresolvedInputs = [
    { id: "pending-temp", text: "通常温度680℃へ訂正", type: "customer_text" },
  ];
  s.pendingChanges = [
    {
      eventId: "pending-temp",
      itemId: s.brief.items[0].id,
      key: "normal_temperature",
    },
  ];
  const q = chooseNextQuestion(s, rules)!;
  const a = extractDemo(s, "数量は2枚です。", q);
  recordDialogueAnswer(s, a, q, "text", "数量は2枚です。");
  expect(a.pendingChanges).toEqual(s.pendingChanges);
  expect(a.unresolvedInputs?.[0].id).toBe("pending-temp");
  expect(chooseNextQuestion(a, rules)?.fieldKey).toBe("normal_temperature");
});
it("写真で部品名を特定できるかの質問には機能の限界を明示する", () => {
  const s = start("パッキンを購入したいです。");
  const a = extractDemo(s, "写真があればここで名前を絞れますか。", null);
  expect(savedReply(s, a)).toContain("写真から部品名を自動で特定できません");
});

it("塗装の回答に添えた幅の測り直しも反映する", () => {
  const s = start("カバー 幅200mmを購入したいです。");
  const a = extractDemo(
    s,
    "塗装なしです。幅も測り直して220mmでした。",
    chooseNextQuestion(s, rules),
  );
  expect(field(a, "カバー", "width")?.value?.number).toBe(220);
});

it("塗装を後で決める返答は確定仕様にせず原文の意向を引き継ぐ", () => {
  let s = start("ガラスを購入したいです。");
  const q = { ...chooseNextQuestion(s, rules)!, fieldKey: "coating" };
  s = extractDemo(s, "塗装するかどうかは、後で決めたいです。", q);
  expect(field(s, "ガラス", "coating")?.status).toBe("unknown");
  expect(makeMailDraft(s, null).body).toContain(
    "未定（塗装するかどうかは、後で決めたいです）",
  );
});

it("現在伝わっている材料を尋ねられたら変更前と未確定を区別して返す", () => {
  const s = start("SUS304のリングをこちらで支給して穴加工をお願いしたいです。");
  const a = extractDemo(
    s,
    "アルミに変えたらどうですか。材料もそちらで用意できますか。まだ変更は決めていません。",
    chooseNextQuestion(s, rules),
  );
  const b = extractDemo(
    a,
    "今の依頼は何の材料として伝わっていますか。まだ変更を確定したつもりはありません。",
    chooseNextQuestion(a, rules),
  );
  expect(savedReply(a, b)).toContain(
    "変更前の条件はSUS304、材料手配は客先支給",
  );
  expect(savedReply(a, b)).toContain("まだ未確定");
});

it("取付方法の質問中に温度を訂正しても温度の文を取付方法に保存しない", () => {
  const s = start("ガラス 通常温度780℃を購入したいです");
  const q = { ...chooseNextQuestion(s, rules)!, fieldKey: "mounting" };
  const a = extractDemo(
    s,
    "確認したら、普通は680℃で、最高820℃でした。最初に言った780℃は違いました。",
    q,
  );
  expect(field(a, "ガラス", "normal_temperature")?.value?.number).toBe(680);
  expect(field(a, "ガラス", "peak_temperature")?.value?.number).toBe(820);
  expect(field(a, "ガラス", "mounting")).toBeUndefined();
});

it("他の回答に添えた寸法不明・刻印が読めない・配送未定も保持する", () => {
  const s = start("交換部品を購入したいです。");
  const a = extractDemo(
    s,
    "モーターを固定する金具です。幅も高さも分かりません。刻印は読めません。配送先も未定です。",
    chooseNextQuestion(s, rules),
  );
  for (const key of ["width", "height", "marking", "destination"])
    expect(field(a, "交換部品", key)?.status).toBe("unknown");
});

it.each([true, false])("円筒の製作では入力済みの条件を引き継いで内径を確認する (partner=%s)", (partnerIntake) => {
  const initial = "耐熱ガラスの円筒状の部品を製作。外径50mm、全長100mm、数量3個、希望納期は来月末。";
  const seed = start("部品を製作したいです。");
  const itemId = seed.brief.items[0].id;
  const before = applyInput(seed, { id: "cylinder-spec", text: initial, type: "customer_text" }, [
    { itemId, key: "work_scope", text: "円筒状の部品", quote: "円筒状の部品" },
    { itemId, key: "material", text: "耐熱ガラス", quote: "耐熱ガラス" },
    { itemId, key: "outer_diameter", text: "50mm", number: 50, unit: "mm", quote: "外径50mm" },
    { itemId, key: "overall_length", text: "100mm", number: 100, unit: "mm", quote: "全長100mm" },
    { itemId, key: "quantity", text: "3個", number: 3, unit: "個", quote: "数量3個" },
    { itemId, key: "required_date", text: "来月末", quote: "希望納期は来月末" },
  ]);
  const item = before.brief.items[0];
  const next = (snapshot: Snapshot) => chooseNextQuestion(snapshot, [], false, [], partnerIntake);
  expect(item.fields.find((f) => f.key === "inner_diameter")).toBeUndefined();
  const q = next(before)!;
  expect(q).toMatchObject({
    fieldKey: "inner_diameter",
    itemId: item.id,
    inputType: "text",
    options: [{ id: "not_applicable", label: "無垢（中は詰まっている）" }],
  });
  expect(q.text).toContain("空洞ですか、それとも無垢ですか？");

  const hollow = applyInput(before, {
    id: "hollow-description",
    text: "中は空洞です。",
    type: "customer_text",
  }, [{
    itemId: item.id,
    key: "description",
    text: "中は空洞です",
    quote: "中は空洞です",
  }]);
  expect(next(hollow)).toMatchObject({ fieldKey: "inner_diameter", options: [] });
  expect(next(hollow)?.text).toBe("部品の内径は分かりますか？ mmなど単位も教えてください。");
  const after = applyInput(hollow, {
    id: "hollow-dimensions",
    text: "中は空洞です。内径30mmです。",
    type: "customer_text",
  }, [{
    itemId: item.id,
    key: "inner_diameter",
    text: "30mm",
    number: 30,
    unit: "mm",
    quote: "内径30mm",
  }]);
  expect(next(after)?.fieldKey).not.toBe("inner_diameter");
  expect(after.brief.items[0].fields).toEqual(expect.arrayContaining(hollow.brief.items[0].fields));
});
