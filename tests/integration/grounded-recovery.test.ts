import { it, expect } from "vitest";
import {
  Miniflare,
  convertV4MiniflareOptions,
  Response as MFResponse,
} from "miniflare";
import { migrate } from "../helpers/migrate";
import recorded from "../../docs/LIVE-FAST-INTAKE-20261117.json";
import dataset from "../../fixtures/evaluation/live-cases-20261116.json";
import type { Item } from "../../src/domain/model";
it("保存済みLuna応答の型番/引用/品目を実Worker/D1へ保存し、誤った帰属は原文を保留する", async () => {
  const rows = recorded.calls as unknown as {
    phase: string;
    format: string;
    caseId: string;
    rawWireProposal: unknown;
  }[];
  const output = (id: string) =>
    structuredClone(
      rows.find(
        (c) => c.phase === "fast" && c.format === "compact" && c.caseId === id,
      )!.rawWireProposal,
    );
  const first = output("E01"),
    second = output("E14"),
    wrong = output("E14") as { c: { k: string; i: string; v: string }[] };
  wrong.c.find((c) => c.k === "to" && c.v === "大阪")!.i = "n2";
  const responses = [first, second, wrong];
  let calls = 0;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: "dist/worker/worker.js",
      compatibilityDate: "2026-11-16",
      bindings: {
        APP_MODE: "local-demo",
        LOCAL_ADMIN_TOKEN: "test-admin",
        INTAKE_PROVIDER: "openai",
        EXTERNAL_ENABLED: "true",
        OPENAI_API_KEY: "offline-only",
        INTAKE_MODEL: "gpt-6-luna",
        INTAKE_FORMAT: "compact",
        INTAKE_REASONING: "none",
        INTAKE_MAX_OUTPUT_TOKENS: "1024",
        INTAKE_MAX_CALLS_TOTAL: "3",
        INTAKE_MAX_CALLS_PER_CASE: "1",
      },
      d1Databases: { DB: "grounded-recovery" },
      r2Buckets: ["FILES"],
      queueProducers: { RESEARCH_QUEUE: "research" },
      outboundService: async (req) => {
        expect(req.url).toBe("https://api.openai.com/v1/responses");
        expect(calls).toBeLessThan(3);
        return new MFResponse(
          JSON.stringify({
            status: "completed",
            output: [
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify(responses[calls++]),
                  },
                ],
              },
            ],
          }),
        );
      },
    }),
  );
  try {
    const db = await mf.getD1Database("DB");
    await migrate(db);
    const origin = "http://127.0.0.1",
      sessionResponse = await mf.dispatchFetch(origin + "/api/v2/session"),
      session = (await sessionResponse.json()) as { csrf: string },
      cookie = sessionResponse.headers.get("Set-Cookie")!.split(";")[0];
    let caseIndex = 0;
    async function call(route: string, method = "GET", body?: unknown) {
      const response = await mf.dispatchFetch(origin + "/api/v2" + route, {
        method,
        headers: {
          Cookie: cookie,
          Origin: origin,
          "X-CSRF-Token": session.csrf,
          "Content-Type": "application/json",
          "Idempotency-Key": "grounded-case-" + caseIndex,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      expect(response.status).toBeLessThan(300);
      return (await response.json()) as Record<string, unknown>;
    }
    for (const id of ["E01", "E14", "wrong"]) {
      caseIndex++;
      const created = await call("/cases", "POST", {}),
        cid = String(created.caseId),
        text = dataset.cases.find(
          (c) => c.id === (id === "wrong" ? "E14" : id),
        )!.input;
      const answer = {
        mutationId: "first",
        expectedRevision: 0,
        questionId: "initial",
        answer: { type: "text", text },
      };
      const result = await call(`/cases/${cid}/answers`, "POST", answer);
      expect(await call(`/cases/${cid}/answers`, "POST", answer)).toEqual(
        result,
      );
      const view = await call(`/cases/${cid}`),
        items = view.items as Item[];
      const field = (label: string, key: string) =>
        items
          .find((i) => i.label.includes(label))
          ?.fields.find((f) => f.key === key);
      if (id === "E01") {
        expect(view.unresolvedInputs).toEqual([]);
        expect(field("AX-100", "model")?.value?.text).toBe("AX-100");
        expect(field("AX-100", "quantity")?.value?.number).toBe(2);
        expect(text).toContain(field("AX-100", "quantity")!.quote);
      } else if (id === "E14") {
        expect(view.unresolvedInputs).toEqual([]);
        expect(field("カバー", "quantity")?.value?.number).toBe(4);
        expect(field("ネック", "quantity")?.value?.number).toBe(8);
        expect(field("カバー", "destination")?.value?.text).toBe("大阪");
        expect(field("ネック", "destination")?.value?.text).toBe("神戸");
        const draft = await call(`/cases/${cid}/mail-draft`, "POST", {});
        expect(draft.body).toContain("大阪");
        expect(draft.body).toContain("神戸");
      } else {
        expect(items).toHaveLength(0);
        expect(view.unresolvedInputs).toEqual([text]);
        const draft = await call(`/cases/${cid}/mail-draft`, "POST", {});
        expect(draft.body).toContain(text);
        expect(draft.body).not.toContain("今回の依頼：");
      }
    }
    expect(calls).toBe(3);
    expect(
      (
        await db
          .prepare("SELECT calls FROM intake_totals WHERE id=1")
          .first<{ calls: number }>()
      )?.calls,
    ).toBe(3);
  } finally {
    await mf.dispose();
  }
});
