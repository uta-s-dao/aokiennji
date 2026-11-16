import { beforeAll, beforeEach, afterAll, it, expect } from "vitest";
import {
  Miniflare,
  convertV4MiniflareOptions,
  Response as MFResponse,
} from "miniflare";
import { readFile } from "node:fs/promises";
import type { ExtractionProposal } from "../../src/domain/extraction-proposal";
let mf: Miniflare,
  db: D1Database,
  calls = 0,
  status = 200,
  delay = 0;
let release: (() => void) | undefined;
let observedBody = "";
const proposal = (): ExtractionProposal => ({
  schemaVersion: 1,
  newItems: [
    {
      ref: "one",
      label: "AX-100",
      quote: "AX-100を購入したい",
      profile: "known_model",
      category: "demo_switch",
    },
  ],
  changes: [
    {
      itemRef: "one",
      key: "model",
      status: "known",
      value: { text: "AX-100", number: null, unit: null },
      quote: "AX-100",
      operation: "set",
      hardConstraint: true,
    },
  ],
  ambiguities: [],
  unprocessedQuotes: [],
});
const output = proposal();
const origin = "http://127.0.0.1";
let n = 0;
async function client() {
  const r = await mf.dispatchFetch(origin + "/api/v2/session"),
    s = (await r.json()) as { csrf: string },
    cookie = r.headers.get("Set-Cookie")!.split(";")[0];
  return async (path: string, method = "GET", body?: unknown) => {
    const r = await mf.dispatchFetch(origin + "/api/v2" + path, {
      method,
      headers: {
        Cookie: cookie,
        Origin: origin,
        "X-CSRF-Token": s.csrf,
        "Content-Type": "application/json",
        "X-Local-Admin-Token": "test-admin",
        "Idempotency-Key": "create-" + ++n,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: r.status,
      body: (await r.json()) as Record<string, unknown>,
    };
  };
}
async function setupCase() {
  const call = await client();
  const c = await call("/cases", "POST", {});
  return { call, cid: String(c.body.caseId) };
}
const answer = (mid: string) => ({
  kind: "answer_mutation",
  mutationId: mid,
  expectedRevision: 0,
  questionId: "initial",
  answer: { type: "text", text: "AX-100を購入したい" },
});
beforeAll(async () => {
  mf = new Miniflare(
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
        INTAKE_MODEL: "configured-test-model",
        INTAKE_MAX_OUTPUT_TOKENS: "1024",
        INTAKE_MAX_CALLS_TOTAL: "2",
        INTAKE_MAX_CALLS_PER_CASE: "2",
      },
      d1Databases: { DB: "intake-test" },
      r2Buckets: ["FILES"],
      queueProducers: { RESEARCH_QUEUE: "research" },
      outboundService: async (request) => {
        if (request.url !== "https://api.openai.com/v1/responses")
          throw new Error("unexpected outbound URL");
        calls++;
        observedBody = await request.text();
        if (delay)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return new MFResponse(
          JSON.stringify(
            status === 200
              ? {
                  status: "completed",
                  output: [
                    {
                      type: "message",
                      content: [
                        { type: "output_text", text: JSON.stringify(output) },
                      ],
                    },
                  ],
                  usage: { input_tokens: 123, output_tokens: 45 },
                }
              : { error: { message: "private provider error" } },
          ),
          { status },
        );
      },
    }),
  );
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  for (const file of [
    "0001.sql",
    "0002_event_payload.sql",
    "0003_intake_calls.sql",
    "0004_intake_totals.sql",
  ])
    await db.exec(
      (await readFile("migrations/" + file, "utf8"))
        .replace(/--[^\n]*/g, "")
        .replace(/\n/g, " "),
    );
  const c = await client();
  expect((await c("/admin/demo", "POST", {})).status).toBe(200);
});
beforeEach(async () => {
  calls = 0;
  status = 200;
  delay = 0;
  release = undefined;
  await db.exec(
    "DELETE FROM intake_calls; UPDATE intake_totals SET calls=0; UPDATE intake_controls SET blocked_reason=NULL;",
  );
});
afterAll(async () => {
  release?.();
  await mf?.dispose();
});
it("実Workerで変更案を保存し再送・選択式で呼出しを増やさない", async () => {
  const { call, cid } = await setupCase(),
    a = await call(`/cases/${cid}/answers`, "POST", answer("same"));
  expect(a.status).toBe(200);
  expect(calls).toBe(1);
  expect(observedBody).not.toContain("test-dummy");
  const replay = await call(`/cases/${cid}/answers`, "POST", answer("same"));
  expect(replay.body).toEqual(a.body);
  expect(calls).toBe(1);
  const q = a.body.question as { id: string };
  expect(q).toBeTruthy();
  const b = await call(`/cases/${cid}/answers`, "POST", {
    kind: "answer_mutation",
    mutationId: "option",
    expectedRevision: 1,
    questionId: q.id,
    answer: { type: "option", optionId: "purchase" },
  });
  expect(b.status).toBe(200);
  expect(calls).toBe(1);
  const row = await db
    .prepare(
      "SELECT input_tokens,output_tokens FROM intake_calls WHERE case_id=?",
    )
    .bind(cid)
    .first<{ input_tokens: number; output_tokens: number }>();
  expect(row).toEqual({ input_tokens: 123, output_tokens: 45 });
});
it("同時再送で予約を一つだけ作り外部呼出しを重複させない", async () => {
  delay = 1;
  const { call, cid } = await setupCase();
  const first = call(`/cases/${cid}/answers`, "POST", answer("parallel"));
  await expect.poll(() => calls).toBe(1);
  const second = await call(
    `/cases/${cid}/answers`,
    "POST",
    answer("parallel"),
  );
  expect(second.status).toBe(409);
  release?.();
  expect((await first).status).toBe(200);
  expect(calls).toBe(1);
  expect(
    (await db
      .prepare("SELECT COUNT(*) n FROM intake_calls")
      .first<{ n: number }>())!.n,
  ).toBe(1);
});
it("全体上限で追加送信を止め入力をメールへ保持する", async () => {
  for (let i = 0; i < 2; i++) {
    const { call, cid } = await setupCase();
    expect(
      (await call(`/cases/${cid}/answers`, "POST", answer("limit"))).status,
    ).toBe(200);
  }
  const { call, cid } = await setupCase();
  const a = await call(`/cases/${cid}/answers`, "POST", answer("blocked"));
  expect(a.status).toBe(200);
  expect(calls).toBe(2);
  const view = await call("/cases/" + cid);
  expect(view.body.unresolvedInputs).toEqual(["AX-100を購入したい"]);
  const mail = await call(`/cases/${cid}/mail-draft`, "POST", {});
  expect(mail.body.body).toContain("解釈・確認が未完了");
});
it.each([401, 429])(
  "HTTP %i で全体停止し再送や次案件で連打しない",
  async (code) => {
    status = code;
    const { call, cid } = await setupCase();
    const a = await call(`/cases/${cid}/answers`, "POST", answer("error"));
    expect(a.status).toBe(200);
    await call(`/cases/${cid}/answers`, "POST", answer("error"));
    expect(calls).toBe(1);
    const next = await setupCase();
    await next.call(`/cases/${next.cid}/answers`, "POST", answer("next"));
    expect(calls).toBe(1);
    const state = await call("/admin/intake-status");
    expect(state.body.control).toEqual({
      blocked_reason: code === 401 ? "MODEL_AUTH_FAILED" : "MODEL_RATE_LIMITED",
    });
    expect(JSON.stringify(a.body)).not.toContain("private provider error");
  },
);
it("停止後の不明な予約を再課金せず入力保持へ回復する", async () => {
  delay = 1;
  const { call, cid } = await setupCase();
  const pending = call(`/cases/${cid}/answers`, "POST", answer("unknown"));
  await expect.poll(() => calls).toBe(1);
  await db
    .prepare("UPDATE intake_calls SET created_at=? WHERE case_id=?")
    .bind(Date.now() - 5000, cid)
    .run();
  const recovered = await call(
    `/cases/${cid}/answers`,
    "POST",
    answer("unknown"),
  );
  expect(recovered.status).toBe(200);
  release?.();
  await pending;
  expect(calls).toBe(1);
  expect(
    (await db
      .prepare("SELECT state FROM intake_calls WHERE case_id=?")
      .bind(cid)
      .first<{ state: string }>())!.state,
  ).toBe("unknown");
});
it("削除後に私的キャッシュを消し累積呼出し数は維持する", async () => {
  const { call, cid } = await setupCase();
  await call(`/cases/${cid}/answers`, "POST", answer("private"));
  await call("/cases/" + cid, "DELETE");
  await call("/admin/maintenance", "POST", {});
  const row = await db
    .prepare("SELECT state,result_json FROM intake_calls WHERE case_id=?")
    .bind(cid)
    .first<{ state: string; result_json: string | null }>();
  expect(row?.result_json).toBeNull();
  expect(row?.state).toBe("completed");
  await db
    .prepare("UPDATE intake_calls SET created_at=? WHERE case_id=?")
    .bind(Date.now() - 91 * 86400000, cid)
    .run();
  await call("/admin/maintenance", "POST", {});
  expect(
    (await db
      .prepare("SELECT COUNT(*) n FROM intake_calls WHERE case_id=?")
      .bind(cid)
      .first<{ n: number }>())!.n,
  ).toBe(0);
  expect(
    (await db
      .prepare("SELECT calls FROM intake_totals WHERE id=1")
      .first<{ calls: number }>())!.calls,
  ).toBe(1);
});

it("明示設定不足は接続前に拒否し呼出し予約も作らない", async () => {
  const isolated = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: "dist/worker/worker.js",
      compatibilityDate: "2026-11-16",
      bindings: {
        APP_MODE: "local-demo",
        INTAKE_PROVIDER: "openai",
        EXTERNAL_ENABLED: "false",
        OPENAI_API_KEY: "test-dummy",
        INTAKE_MODEL: "model",
      },
      d1Databases: { DB: "disabled-test" },
      outboundService: async () => {
        throw new Error("must never call provider");
      },
    }),
  );
  try {
    const store = await isolated.getD1Database("DB");
    for (const file of [
      "0001.sql",
      "0002_event_payload.sql",
      "0003_intake_calls.sql",
      "0004_intake_totals.sql",
    ])
      await store.exec(
        (await readFile("migrations/" + file, "utf8"))
          .replace(/--[^\n]*/g, "")
          .replace(/\n/g, " "),
      );
    const response = await isolated.dispatchFetch(origin + "/api/v2/session"),
      session = (await response.json()) as { csrf: string },
      cookie = response.headers.get("Set-Cookie")!.split(";")[0];
    const headers = {
      Cookie: cookie,
      Origin: origin,
      "X-CSRF-Token": session.csrf,
      "Content-Type": "application/json",
      "Idempotency-Key": "create",
    };
    const created = await isolated.dispatchFetch(origin + "/api/v2/cases", {
        method: "POST",
        headers,
        body: "{}",
      }),
      c = (await created.json()) as { caseId: string };
    const result = await isolated.dispatchFetch(
      origin + `/api/v2/cases/${c.caseId}/answers`,
      { method: "POST", headers, body: JSON.stringify(answer("unconfigured")) },
    );
    expect(result.status).toBe(503);
    expect(
      (await store
        .prepare("SELECT COUNT(*) n FROM intake_calls")
        .first<{ n: number }>())!.n,
    ).toBe(0);
  } finally {
    await isolated.dispose();
  }
});
