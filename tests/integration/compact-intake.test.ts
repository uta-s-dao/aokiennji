import { it, expect } from "vitest";
import {
  Miniflare,
  convertV4MiniflareOptions,
  Response as MFResponse,
} from "miniflare";
import { migrate } from "../helpers/migrate";
import type { Item } from "../../src/domain/model";
it("軽量モデルの短い変更案を実Worker/D1で会話2ターン保存し、温度訂正をメールへ渡す", async () => {
  let calls = 0;
  const requests: Record<string, unknown>[] = [];
  const output = (c: unknown[]) => ({
    n:
      calls === 1
        ? [{ i: "n1", n: "ガラス", q: "ガラスを探しています", p: "r" }]
        : [],
    c,
    u: [],
  });
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
        OPENAI_API_KEY: "test-dummy",
        INTAKE_MODEL: "gpt-6-luna",
        INTAKE_FORMAT: "compact",
        INTAKE_REASONING: "none",
        INTAKE_MAX_OUTPUT_TOKENS: "1024",
        INTAKE_MAX_CALLS_TOTAL: "2",
        INTAKE_MAX_CALLS_PER_CASE: "2",
      },
      d1Databases: { DB: "compact-conversation" },
      r2Buckets: ["FILES"],
      queueProducers: { RESEARCH_QUEUE: "research" },
      outboundService: async (req) => {
        expect(req.url).toBe("https://api.openai.com/v1/responses");
        calls++;
        requests.push(JSON.parse(await req.text()));
        const changes =
          calls === 1
            ? [
                {
                  i: "n1",
                  k: "rs",
                  v: "purchase",
                  q: "探しています",
                  o: "s",
                  h: true,
                },
                {
                  i: "n1",
                  k: "nt",
                  v: "780℃",
                  q: "通常温度780℃",
                  o: "s",
                  h: true,
                },
              ]
            : [
                {
                  i: "0",
                  k: "pu",
                  v: "点検窓",
                  q: "用途は点検窓",
                  o: "s",
                  h: false,
                },
                {
                  i: "0",
                  k: "nt",
                  v: "680℃",
                  q: "通常温度を680℃に訂正",
                  o: "c",
                  h: true,
                },
                {
                  i: "0",
                  k: "pt",
                  v: "820℃",
                  q: "最高温度は820℃",
                  o: "s",
                  h: true,
                },
              ];
        return new MFResponse(
          JSON.stringify({
            status: "completed",
            output: [
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify(output(changes)),
                  },
                ],
              },
            ],
            usage: { input_tokens: 100, output_tokens: 80 },
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
    async function call(route: string, method = "GET", body?: unknown) {
      const response = await mf.dispatchFetch(origin + "/api/v2" + route, {
        method,
        headers: {
          Cookie: cookie,
          Origin: origin,
          "X-CSRF-Token": session.csrf,
          "Content-Type": "application/json",
          "Idempotency-Key": "compact-case",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      expect(response.status).toBeLessThan(300);
      return (await response.json()) as Record<string, unknown>;
    }
    const created = await call("/cases", "POST", {}),
      cid = String(created.caseId);
    const first = await call(`/cases/${cid}/answers`, "POST", {
      mutationId: "first",
      expectedRevision: 0,
      questionId: "initial",
      answer: {
        type: "text",
        text: "ガラスを探しています。通常温度780℃です。",
      },
    });
    expect(first.action).toBe("ask");
    const answer = {
      mutationId: "second",
      expectedRevision: 1,
      questionId: (first.question as { id: string }).id,
      answer: {
        type: "text",
        text: "用途は点検窓です。通常温度を680℃に訂正します。最高温度は820℃です。",
      },
    };
    const second = await call(`/cases/${cid}/answers`, "POST", answer);
    expect(await call(`/cases/${cid}/answers`, "POST", answer)).toEqual(second);
    expect(calls).toBe(2);
    const view = await call(`/cases/${cid}`),
      item = (view.items as Item[])[0];
    expect(
      item.fields.find((f) => f.key === "normal_temperature")?.value?.number,
    ).toBe(680);
    expect(
      item.fields.find((f) => f.key === "peak_temperature")?.value?.number,
    ).toBe(820);
    expect(view.unresolvedInputs).toEqual([]);
    expect(requests[0].reasoning).toEqual({ effort: "none" });
    expect(JSON.stringify(requests[1])).not.toContain(item.id);
    expect(JSON.stringify(requests)).not.toContain("test-dummy");
    const draft = await call(`/cases/${cid}/mail-draft`, "POST", {});
    expect(draft.body).toContain("680℃");
    expect(draft.body).toContain("820℃");
    expect(draft.body).not.toContain("780℃");
    expect(
      (
        await db
          .prepare("SELECT calls FROM intake_totals WHERE id=1")
          .first<{ calls: number }>()
      )?.calls,
    ).toBe(2);
  } finally {
    await mf.dispose();
  }
});
