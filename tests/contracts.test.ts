import { it, expect } from "vitest";
import {
  validateCapabilityRule,
  validatePublicResult,
  validateResearchBrief,
  validateAnswerMutation,
} from "../src/generated/validators.js";
import { decideAvailability } from "../src/domain/decision";
import { makeSnapshot, makeResearchBrief } from "../src/domain/intake";
import { extractDemo } from "../src/adapters/extraction";
import type { CapabilityRule, Source } from "../src/domain/model";
import f from "../fixtures/demo/knowledge.json";
it("設計版1.1の契約を使用し、旧版・不正な肯定・内部フィールドを拒否する", () => {
  for (const r of f.rules)
    expect(
      validateCapabilityRule(r),
      JSON.stringify(validateCapabilityRule.errors),
    ).toBe(true);
  const b = makeResearchBrief(
    extractDemo(makeSnapshot("c"), "AX-100を購入したい"),
    1,
    1,
  );
  expect(validateResearchBrief(b)).toBe(true);
  expect(validateResearchBrief({ ...b, schemaVersion: 1 })).toBe(false);
  const r = decideAvailability(
    b,
    f.rules as CapabilityRule[],
    f.sources as Source[],
    "j",
  );
  expect(validatePublicResult(r)).toBe(true);
  const bad = structuredClone(r);
  bad.items[0].scopeAssessment.evidence = [];
  expect(validatePublicResult(bad)).toBe(false);
  const bad2 = structuredClone(r);
  bad2.items[0].scopeAssessment.status = "unconfirmed";
  expect(validatePublicResult(bad2)).toBe(false);
  expect(validatePublicResult({ ...r, internalJson: "private" })).toBe(false);
  expect(
    validateAnswerMutation({
      kind: "answer_mutation",
      mutationId: "m",
      expectedRevision: 0,
      questionId: "initial",
      answer: { type: "unknown" },
    }),
  ).toBe(true);
});
