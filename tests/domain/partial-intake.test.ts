import { expect, it } from "vitest";
import { applyConversationProposal } from "../../src/domain/partial-intake";
import { applyExtractionProposal, type ExtractionProposal } from "../../src/domain/extraction-proposal";
import { chooseNextQuestion, makeSnapshot } from "../../src/domain/intake";
import { extractDemo } from "../../src/adapters/extraction";
import { recordDialogueAnswer } from "../../src/domain/dialogue";
import type { Snapshot } from "../../src/domain/model";

const start = () => extractDemo(makeSnapshot("partial"), "ガラスを購入したいです。");
const field = (s: Snapshot, key: string) => s.brief.items[0].fields.find((f) => f.key === key);
const quantity = (itemRef: string): ExtractionProposal["changes"][number] => ({
  itemRef, key: "quantity", status: "known", value: { text: "3枚", number: 3, unit: "枚" },
  quote: "数量3枚", operation: "set", hardConstraint: true,
});
const widthChange = (itemRef: string): ExtractionProposal["changes"][number] => ({
  itemRef, key: "width", status: "known", value: { text: "25mm", number: 25, unit: "mm" },
  quote: "幅50mm", operation: "set", hardConstraint: true,
});
const proposal = (
  changes: ExtractionProposal["changes"],
  unprocessedQuotes: string[] = [],
): ExtractionProposal => ({ schemaVersion: 1, changes, newItems: [], ambiguities: [], unprocessedQuotes });

it("元発言全体と出典を残し、別文で未解釈の項目ひとつを確認する", () => {
  const s = start();
  const id = s.brief.items[0].id;
  const text = "数量3枚です。幅50mmです。";
  const input = { ...proposal([quantity(id)]), ambiguities: ["幅50mm"] };
  expect(() => applyExtractionProposal(s, text, null, input)).toThrow("INVALID_EXTRACTION");
  const next = applyConversationProposal(s, text, null, input);
  expect(next.inputs.at(-1)?.text).toBe(text);
  expect(field(next, "quantity")).toMatchObject({ eventId: next.inputs.at(-1)?.id, quote: "数量3枚", status: "known" });
  expect(field(next, "width")).toBeUndefined();
  expect(next.unresolvedInputs).toMatchObject([{ text: "幅50mmです。", partialFor: { itemId: id, fieldKey: "width" } }]);
  const q = chooseNextQuestion(next, []);
  expect(q).toMatchObject({ itemId: id, fieldKey: "width", text: expect.stringContaining("幅50mmです。") });

  const answer = "幅は50mmです。";
  const after = applyConversationProposal(next, answer, q, proposal([{
    ...widthChange(id), value: { text: "50mm", number: 50, unit: "mm" }, quote: "幅は50mm",
  }]));
  recordDialogueAnswer(next, after, q, "text", answer);
  expect(after.unresolvedInputs).toEqual([]);
  expect(field(after, "quantity")).toEqual(field(next, "quantity"));
});

it("単一の不正値を根拠付きの別文に限定して保留し、以前の保留を維持する", () => {
  const s = start();
  const itemId = s.brief.items[0].id;
  const prior = { id: "prior", text: "仮に数量を3枚に変えたらどうですか", type: "customer_text" as const };
  s.unresolvedInputs = [prior];
  s.pendingChanges = [{ itemId, key: "quantity", eventId: prior.id }];
  const after = applyConversationProposal(s, "数量3枚です。幅50mmです。", null, proposal([
    quantity(itemId), widthChange(itemId),
  ]));
  expect(field(after, "quantity")?.value?.number).toBe(3);
  expect(after.unresolvedInputs?.[0]).toEqual(prior);
  expect(after.pendingChanges?.[0]).toEqual(s.pendingChanges[0]);
  expect(after.unresolvedInputs?.[1]?.text).toBe("幅50mmです。");
  expect(field(s, "quantity")).toBeUndefined();
});

it.each([
  ["数量3枚で幅50mmです。", "幅50mm"],
  ["数量3枚です。数量4枚です。", "数量4枚"],
  ["数量3枚です。幅50mmから60mmです。", "幅50mm"],
  ["数量3枚です。幅を変更してください。", "幅を変更"],
  ["数量3枚です。仮に幅50mmです。", "幅50mm"],
  ["数量3枚です。別の部品は幅50mmです。", "幅50mm"],
  ["数量3枚です。幅50mmです。", "幅90mm"],
])("独立性を確認できない発言は原子的に扱う (%s)", (text, fragment) => {
  const s = start();
  const before = structuredClone(s);
  expect(() => applyConversationProposal(s, text, null, proposal([
    quantity(s.brief.items[0].id),
  ], [fragment]))).toThrow("INVALID_EXTRACTION");
  expect(s).toEqual(before);
});

it("品目に紐づく独立した保留文の確認を、以前の入力全体の確認より先に出す", () => {
  const s = start();
  const prior = { id: "prior", text: "別途相談です。", type: "customer_text" as const };
  s.unresolvedInputs = [prior];
  const itemId = s.brief.items[0].id;
  const recovery = chooseNextQuestion(s, []);
  const text = "数量3枚です。ガラスの端面は鏡面仕上げです。";
  expect(recovery?.id).toBe("input-recovery");
  const after = applyConversationProposal(s, text, recovery,
    proposal([quantity(itemId)], ["端面は鏡面仕上げ"]));
  recordDialogueAnswer(s, after, recovery, "text", text);
  expect(after.unresolvedInputs?.[0]).toEqual(prior);
  expect(chooseNextQuestion(after, [])).toMatchObject({
    itemId,
    fieldKey: "description",
    text: expect.stringContaining("ガラスの端面は鏡面仕上げです。"),
  });
});

it("初回に根拠ある品目名と数量だけを登録できる", () => {
  const s = makeSnapshot("partial-opening");
  const input = {
    ...proposal([quantity("part")], ["幅50mm"]),
    newItems: [{ ref: "part", label: "ガラス", quote: "ガラス", profile: "unknown" as const, category: null }],
  };
  const after = applyConversationProposal(s, "ガラスの相談です。数量3枚です。幅50mmです。", null, input);
  expect(after.brief.items).toHaveLength(1);
  expect(after.brief.items[0].label).toBe("ガラス");
  expect(field(after, "quantity")?.value?.number).toBe(3);
  expect(chooseNextQuestion(after, [])?.fieldKey).toBe("width");
});

it("報告済みの引用では品目を特定できないときは確定しない", () => {
  const s = start();
  const input = proposal([quantity(s.brief.items[0].id)], ["端面は鏡面仕上げ"]);
  expect(() => applyConversationProposal(s, "数量3枚です。端面は鏡面仕上げです。", null, input))
    .toThrow("INVALID_EXTRACTION");
});

it("保留文を繰り返しても抽出で対応項目が更新されなければ確認を残す", () => {
  const s = start();
  const itemId = s.brief.items[0].id;
  const before = applyConversationProposal(s, "数量3枚です。幅50mmです。", null,
    proposal([quantity(itemId)], ["幅50mm"]));
  const q = chooseNextQuestion(before, []);
  const echo = "幅50mmです。";
  const after = applyConversationProposal(before, echo, q, proposal([]));
  recordDialogueAnswer(before, after, q, "text", echo);
  expect(after.unresolvedInputs).toEqual(before.unresolvedInputs);
  expect(after.pendingChanges).toEqual(before.pendingChanges);
  expect(chooseNextQuestion(after, [])?.fieldKey).toBe("width");
});
