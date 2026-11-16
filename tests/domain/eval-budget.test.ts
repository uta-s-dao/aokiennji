import { createRequire } from "node:module";
import { it, expect } from "vitest";
const require = createRequire(import.meta.url);
const { reserveBudget } = require("../../scripts/lib/eval-budget.cjs") as {
  reserveBudget: (
    r: { calls: { id: string; reservedMicroUsd: number; state?: string }[] },
    c: {
      id: string;
      inputTokens: number;
      maxOutputTokens: number;
      model?: string;
    },
  ) => { reservedMicroUsd: number; inputUpperBound: number };
};
it("不明・失敗・未完了の予約も費用枠と40回枠へ算入する", () => {
  const report = {
    calls: Array.from({ length: 40 }, (_, i) => ({
      id: String(i),
      reservedMicroUsd: 10000,
      state: i % 2 ? "unknown" : "failed",
    })),
  };
  expect(() =>
    reserveBudget(report, {
      id: "new",
      inputTokens: 100,
      maxOutputTokens: 100,
    }),
  ).toThrow("CALL_LIMIT");
});
it("以前の34回・費用予約を維持して軽量モデルを最大40回までに制限する", () => {
  const report = {
    calls: Array.from({ length: 34 }, (_, i) => ({
      id: String(i),
      reservedMicroUsd: i === 0 ? 922447 : 0,
    })),
  };
  for (let i = 0; i < 6; i++)
    reserveBudget(report, {
      id: "luna-" + i,
      inputTokens: 1800,
      maxOutputTokens: 1024,
      model: "gpt-6-luna",
    });
  expect(report.calls).toHaveLength(40);
  expect(
    report.calls.reduce((n, c) => n + c.reservedMicroUsd, 0),
  ).toBeLessThanOrEqual(1000000);
  expect(() =>
    reserveBudget(report, {
      id: "overflow",
      inputTokens: 100,
      maxOutputTokens: 10,
      model: "gpt-6-luna",
    }),
  ).toThrow("CALL_LIMIT");
  expect(() =>
    reserveBudget(
      { calls: [] },
      {
        id: "unpriced",
        inputTokens: 100,
        maxOutputTokens: 10,
        model: "different-model",
      },
    ),
  ).toThrow("UNPRICED_MODEL");
});
it("1ドルを超える前に拒否し、不正な値や同一IDを再予約しない", () => {
  const report = { calls: [{ id: "used", reservedMicroUsd: 999000 }] };
  expect(() =>
    reserveBudget(report, {
      id: "new",
      inputTokens: 100,
      maxOutputTokens: 100,
    }),
  ).toThrow("COST_LIMIT");
  expect(report.calls).toHaveLength(1);
  expect(() =>
    reserveBudget(report, { id: "used", inputTokens: 1, maxOutputTokens: 1 }),
  ).toThrow("CALL_ALREADY_RESERVED");
  expect(() =>
    reserveBudget(
      { calls: [] },
      { id: "new", inputTokens: -1, maxOutputTokens: 100 },
    ),
  ).toThrow("INVALID_TOKEN_BOUND");
  expect(() =>
    reserveBudget(
      { calls: [] },
      { id: "long-context", inputTokens: 250000, maxOutputTokens: 100 },
    ),
  ).toThrow("INVALID_TOKEN_BOUND");
});
it("出力上限と計数差分を含む保守的な金額を生成前に予約する", () => {
  const report: { calls: { id: string; reservedMicroUsd: number }[] } = {
    calls: [],
  };
  const r = reserveBudget(report, {
    id: "one",
    inputTokens: 1000,
    maxOutputTokens: 1024,
  });
  expect(r.inputUpperBound).toBe(1164);
  expect(r.reservedMicroUsd).toBe(1164 * 2.5 + 1024 * 12);
  expect(report.calls).toHaveLength(1);
});
