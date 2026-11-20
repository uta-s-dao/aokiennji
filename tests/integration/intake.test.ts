import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import {
  Miniflare,
  convertV4MiniflareOptions,
  Response as MFResponse,
} from "miniflare";
import { migrate } from "../helpers/migrate";
import type { ExtractionProposal } from "../../src/domain/extraction-proposal";
import { extractDemo } from "../../src/adapters/extraction";
import { makeSnapshot } from "../../src/domain/intake";
import { runJob } from "../../src/research-worker";
import type { Item, Snapshot } from "../../src/domain/model";
import type { Env } from "../../src/adapters/store";
let mf: Miniflare,
  db: D1Database,
  calls = 0,
  status = 200,
  delay = 0;
let release: (() => void) | undefined;
let observedBody = "";
let responseType = "output_text";
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
let output = proposal();
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
async function startWorker(unlimitedLocal = false) {
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
        INTAKE_UNLIMITED_LOCAL: String(unlimitedLocal),
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
                        { type: responseType, text: JSON.stringify(output) },
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
  await migrate(db);
  const c = await client();
  expect((await c("/admin/demo", "POST", {})).status).toBe(200);
}
beforeAll(() => startWorker());
beforeEach(async () => {
  output = proposal();
  calls = 0;
  status = 200;
  responseType = "output_text";
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
it("従来の3秒を過ぎても同じ操作を保留し、実際の応答を一度だけ保存する", async () => {
  delay = 1;
  const { call, cid } = await setupCase();
  const path = `/cases/${cid}/answers`;
  const mutation = answer("parallel");
  const first = call(path, "POST", mutation);
  try {
    await expect.poll(() => release).toBeTypeOf("function");
    await new Promise((resolve) => setTimeout(resolve, 3600));
    const second = await call(path, "POST", mutation);
    expect(second.status).toBe(409);
  } finally {
    release?.();
  }
  const result = await first;
  expect(result.status).toBe(200);
  expect(await call(path, "POST", mutation)).toEqual(result);
  expect(calls).toBe(1);
  expect(
    (await db.prepare("SELECT state,error_code FROM intake_calls").all())
      .results,
  ).toEqual([{ state: "completed", error_code: null }]);
});
it.each([
  {
    httpStatus: 503,
    outputType: "output_text",
    code: "MODEL_UNAVAILABLE",
    recovers: true,
  },
  {
    httpStatus: 200,
    outputType: "unexpected",
    code: "INVALID_EXTRACTION",
    recovers: true,
  },
  {
    httpStatus: 200,
    outputType: "refusal",
    code: "MODEL_REFUSED",
    recovers: false,
  },
])(
  "OpenAIの $code を台帳に記録し、回復対象の失敗だけ明示数量を保存する",
  async ({ httpStatus, outputType, code, recovers }) => {
    const { call, cid } = await setupCase();
    const path = `/cases/${cid}/answers`;
    const initial = await call(path, "POST", answer("initial"));
    expect(initial.status).toBe(200);
    const question = initial.body.question as { id: string };

    status = httpStatus;
    responseType = outputType;
    const text = "数量は2個です";
    const mutation = {
      mutationId: "quantity",
      expectedRevision: 1,
      questionId: question.id,
      answer: { type: "text", text },
    };
    const result = await call(path, "POST", mutation);
    expect(result.status).toBe(200);
    expect(await call(path, "POST", mutation)).toEqual(result);
    expect(calls).toBe(2);
    const row = await db
      .prepare(
        "SELECT state,error_code FROM intake_calls WHERE case_id=? AND mutation_id=?",
      )
      .bind(cid, mutation.mutationId)
      .first();
    expect(row).toEqual({ state: "failed", error_code: code });
    const view = await call(`/cases/${cid}`);
    const quantity = (view.body.items as Item[])[0].fields.find(
      (field) => field.key === "quantity",
    );
    if (recovers) {
      expect(quantity?.value?.number).toBe(2);
      expect(view.body.unresolvedInputs).toEqual([]);
      expect((result.body.question as { id: string }).id).not.toBe(
        "input-recovery",
      );
    } else {
      expect(quantity?.value?.number).toBeUndefined();
      expect(view.body.unresolvedInputs).toEqual([text]);
    }
  },
);
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
it("モデルが分類を返さなくても登録型番をD1の承認ルールへ接続する", async () => {
  output.newItems[0].category = null;
  output.changes.push({
    itemRef: "one",
    key: "request_scope",
    status: "known",
    value: { text: "purchase", number: null, unit: null },
    quote: "購入したい",
    operation: "set",
    hardConstraint: true,
  });
  const { call, cid } = await setupCase();
  const accepted = await call(
    `/cases/${cid}/answers`,
    "POST",
    answer("classify"),
  );
  expect(accepted.status).toBe(200);
  expect(accepted.body.action).toBe("research_started");
  const env = { DB: db } as Env;
  await runJob(env, String(accepted.body.jobId));
  const result = await call(`/cases/${cid}/result`);
  expect(result.body.result).toMatchObject({ verdict: "can_handle" });
  expect(calls).toBe(1);
});
it("調達変更の相談をDBから画面とメールへ保持し、旧方式の判定を再利用しない", async () => {
  const { call, cid } = await setupCase();
  const prior = extractDemo(
    makeSnapshot(cid),
    "リング材を客先支給して穴加工を依頼します。",
  );
  await db
    .prepare("UPDATE cases SET snapshot=?,revision=1 WHERE id=?")
    .bind(JSON.stringify(prior), cid)
    .run();
  const initial = await call(`/cases/${cid}`),
    itemId = (initial.body.items as Item[])[0].id;
  const text =
    "材料も御社で調達できますか。リング材の加工も一緒に依頼したいです。";
  output = {
    schemaVersion: 1,
    newItems: [],
    changes: [
      {
        itemRef: itemId,
        key: "material_supply",
        status: "known",
        value: { text: "company_sourced", number: null, unit: null },
        quote: "材料も御社で調達できますか",
        operation: "hypothetical",
        hardConstraint: false,
      },
    ],
    ambiguities: [],
    unprocessedQuotes: [],
  };
  const response = await call(`/cases/${cid}/answers`, "POST", {
    mutationId: "pending",
    expectedRevision: 1,
    questionId: (initial.body.question as { id: string }).id,
    answer: { type: "text", text },
  });
  expect(response.status).toBe(200);
  expect((await call(`/cases/${cid}`)).body.unresolvedInputs).toEqual([text]);
  const research = await call(`/cases/${cid}/research`, "POST", {
    mutationId: "research-pending",
    expectedRevision: 2,
  });
  expect(research.status).toBe(200);
  await runJob({ DB: db } as Env, String(research.body.jobId));
  expect((await call(`/cases/${cid}/result`)).body.result).toMatchObject({
    verdict: "needs_review",
  });
  const draft = await call(`/cases/${cid}/mail-draft`, "POST", {});
  expect(draft.body.body).toContain(text);
  expect(draft.body.body).toContain(
    "追加相談前の発言（現在の確定条件ではありません）",
  );
  expect(draft.body.body).not.toContain("材料手配：客先支給");
  expect(draft.body.body).not.toContain("対応範囲外");
  const edited = await call(`/cases/${cid}/fields`, "PATCH", {
    mutationId: "confirm",
    expectedRevision: 3,
    text: "当社調達",
    change: { itemId, key: "material_supply", text: "company_sourced" },
  });
  expect(edited.status).toBe(200);
  expect((await call(`/cases/${cid}`)).body.unresolvedInputs).toEqual([]);
  expect(
    (await call(`/cases/${cid}/mail-draft`, "POST", {})).body.body,
  ).toContain("当社調達");
  expect(calls).toBe(1);
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
const storedOpening =
  "耐熱ガラスで円筒状の部品を製作したいです。外径50mm、全長100mmで、数量は3個、希望納期は来月末です。」";

async function setupTimedOutOpening(text: string) {
  const { call, cid } = await setupCase();
  const event = { id: "original-input", text, type: "customer_text" } as const;
  const failed = makeSnapshot(cid);
  failed.brief.revision = 1;
  failed.inputs = [event];
  failed.unresolvedInputs = [event];
  failed.extractionFailed = true;
  failed.extractionError = "MODEL_TIMEOUT";
  await db.batch([
    db
      .prepare("UPDATE cases SET revision=1, snapshot=? WHERE id=?")
      .bind(JSON.stringify(failed), cid),
    db
      .prepare(
        "INSERT INTO case_events(id,case_id,mutation_id,revision,response,created_at,event_json) VALUES(?,?,?,1,?,?,?)",
      )
      .bind(
        cid + "-initial",
        cid,
        "first",
        JSON.stringify({ revision: 1 }),
        Date.now(),
        JSON.stringify({ inputEventIds: [event.id], changes: [] }),
      ),
    db
      .prepare(
        "INSERT INTO intake_calls(id,case_id,mutation_id,expected_revision,fingerprint,provider,model,state,result_json,error_code,created_at) VALUES(?,?,?,0,'legacy','openai','configured-test-model','failed',?,'MODEL_TIMEOUT',?)",
      )
      .bind(cid + "-call", cid, "first", JSON.stringify(failed), Date.now()),
    db.prepare("UPDATE intake_totals SET calls=1 WHERE id=1"),
  ]);
  return { call, cid, event, failed };
}

it("旧タイムアウトを元の入力イベントから一度だけ復元して内径の確認へ進む", async () => {
  const { call, cid, event } = await setupTimedOutOpening(storedOpening);
  const path = `/cases/${cid}`;
  const previous = await call(path);
  expect(previous.body).toMatchObject({
    revision: 1,
    items: [],
    unresolvedInputs: [storedOpening],
    canRestoreIntake: true,
  });
  const payload = { expectedRevision: 1 };
  const [restored, simultaneous] = await Promise.all([
    call(path + "/restore-intake", "POST", payload),
    call(path + "/restore-intake", "POST", payload),
  ]);
  expect(simultaneous).toEqual(restored);
  expect(restored.status).toBe(200);
  expect(restored.body).toMatchObject({
    revision: 2,
    action: "ask",
    question: {
      fieldKey: "inner_diameter",
      options: [{ id: "not_applicable", label: "無垢（中は詰まっている）" }],
    },
  });
  expect(await call(path + "/restore-intake", "POST", payload)).toEqual(
    restored,
  );
  const view = await call(path);
  expect(view.body).toMatchObject({
    canRestoreIntake: false,
    unresolvedInputs: [],
    question: restored.body.question,
  });
  const snapshotRow = await db
    .prepare("SELECT snapshot FROM cases WHERE id=?")
    .bind(cid)
    .first<{ snapshot: string }>();
  const snapshot = JSON.parse(snapshotRow!.snapshot) as Snapshot;
  expect(snapshot.inputs).toEqual([event]);
  const [item] = snapshot.brief.items;
  expect(snapshot.brief.items).toHaveLength(1);
  expect(
    Object.fromEntries(item.fields.map(({ key, value }) => [key, value?.text])),
  ).toEqual({
    product_name: "部品",
    work_scope: "円筒状の部品",
    material: "耐熱ガラス",
    request_scope: "fabrication",
    outer_diameter: "50mm",
    overall_length: "100mm",
    quantity: "3個",
    required_date: "来月末",
  });
  for (const field of item.fields) {
    expect(field.eventId).toBe(event.id);
    expect(field.quote).toBeTruthy();
    expect(event.text).toContain(field.quote);
  }
  const history = await db
    .prepare(
      "SELECT revision,event_json FROM case_events WHERE case_id=? ORDER BY revision",
    )
    .bind(cid)
    .all<{ revision: number; event_json: string }>();
  expect(
    history.results.map(({ revision, event_json }) => ({
      revision,
      inputEventIds: JSON.parse(event_json).inputEventIds,
    })),
  ).toEqual([
    { revision: 1, inputEventIds: [event.id] },
    { revision: 2, inputEventIds: [] },
  ]);
  const next = await call(path + "/answers", "POST", {
    mutationId: "solid",
    expectedRevision: 2,
    questionId: (restored.body.question as { id: string }).id,
    answer: { type: "option", optionId: "not_applicable" },
  });
  expect(next.status).toBe(200);
  expect(next.body).toMatchObject({
    revision: 3,
    action: "ask",
    question: { fieldKey: "purpose" },
  });
  const resolvedItem = ((await call(path)).body.items as Item[])[0];
  expect(
    resolvedItem.fields.find((field) => field.key === "inner_diameter"),
  ).toMatchObject({
    status: "not_applicable",
    value: null,
  });
  expect(
    (await db.prepare("SELECT state,error_code FROM intake_calls").all())
      .results,
  ).toEqual([{ state: "failed", error_code: "MODEL_TIMEOUT" }]);
  expect(
    await db.prepare("SELECT calls FROM intake_totals WHERE id=1").first(),
  ).toEqual({ calls: 1 });
  expect(calls).toBe(0);
});

it("未確認の外径を含む旧入力は推測して復元しない", async () => {
  const { call, cid, failed } = await setupTimedOutOpening(
    storedOpening.replace("外径50mm", "外径は約50mm"),
  );
  const path = `/cases/${cid}`;
  const before = await call(path);
  expect(before.body).toMatchObject({
    canRestoreIntake: false,
    revision: 1,
    items: [],
    unresolvedInputs: [failed.inputs[0].text],
  });
  expect(
    (await call(path + "/restore-intake", "POST", { expectedRevision: 1 }))
      .status,
  ).toBe(409);
  expect(await call(path)).toEqual(before);
  expect(calls).toBe(0);
});

it("停止後の不明な予約を再課金せず入力保持へ回復する", async () => {
  delay = 1;
  const { call, cid } = await setupCase();
  const pending = call(`/cases/${cid}/answers`, "POST", answer("unknown"));
  await expect.poll(() => calls).toBe(1);
  await db
    .prepare("UPDATE intake_calls SET created_at=? WHERE case_id=?")
    .bind(Date.now() - 31_000, cid)
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
    await migrate(store);
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

describe("ローカルの回数制限解除", () => {
  beforeAll(async () => {
    await mf.dispose();
    await startWorker(true);
  });
  it("累計上限に達していても同じ案件で上限を超えて抽出し記録する", async () => {
    await db.exec("UPDATE intake_totals SET calls=100001");
    const { call, cid } = await setupCase();
    let response = await call(`/cases/${cid}/answers`, "POST", answer("first"));
    expect(response.status).toBe(200);
    const view = await call(`/cases/${cid}`);
    const itemId = (view.body.items as Item[])[0].id;
    for (const count of [2, 3]) {
      const text = count === 2 ? "数量は2個です" : "数量を3個に変更";
      output = {
        schemaVersion: 1,
        newItems: [],
        changes: [
          {
            itemRef: itemId,
            key: "quantity",
            status: "known",
            value: { text: `${count}個`, number: count, unit: "個" },
            quote: text,
            operation: count === 2 ? "set" : "correct",
            hardConstraint: true,
          },
        ],
        ambiguities: [],
        unprocessedQuotes: [],
      };
      const mutation = {
        mutationId: `quantity-${count}`,
        expectedRevision: count - 1,
        questionId: (response.body.question as { id: string }).id,
        answer: { type: "text", text },
      };
      response = await call(`/cases/${cid}/answers`, "POST", mutation);
      expect(response.status).toBe(200);
      expect(await call(`/cases/${cid}/answers`, "POST", mutation)).toEqual(
        response,
      );
    }
    expect(calls).toBe(3);
    const rows = await db
      .prepare(
        "SELECT state,error_code,input_tokens,output_tokens FROM intake_calls WHERE case_id=?",
      )
      .bind(cid)
      .all();
    expect(rows.results).toHaveLength(3);
    for (const row of rows.results)
      expect(row).toEqual({
        state: "completed",
        error_code: null,
        input_tokens: 123,
        output_tokens: 45,
      });
    const final = await call(`/cases/${cid}`);
    expect(
      (final.body.items as Item[])[0].fields.find((f) => f.key === "quantity")
        ?.value?.number,
    ).toBe(3);
    const state = await call("/admin/intake-status");
    expect(state.body).toMatchObject({
      unlimitedLocal: true,
      calls: { count: 100004 },
    });
  });
  it("解除中も同時再送では外部呼出しを一回だけにする", async () => {
    delay = 1;
    const { call, cid } = await setupCase();
    const first = call(`/cases/${cid}/answers`, "POST", answer("parallel"));
    try {
      await expect.poll(() => calls).toBe(1);
      expect(
        (await call(`/cases/${cid}/answers`, "POST", answer("parallel")))
          .status,
      ).toBe(409);
    } finally {
      release?.();
      await first;
    }
    expect(calls).toBe(1);
  });
  it.each([401, 429])(
    "解除中もHTTP %sの後は追加呼出しを停止する",
    async (code) => {
      status = code;
      const { call, cid } = await setupCase();
      expect(
        (await call(`/cases/${cid}/answers`, "POST", answer("blocked"))).status,
      ).toBe(200);
      status = 200;
      const other = await setupCase();
      await other.call(`/cases/${other.cid}/answers`, "POST", answer("after"));
      expect(calls).toBe(1);
      expect((await call("/admin/intake-status")).body).toMatchObject({
        unlimitedLocal: true,
        calls: { count: 1 },
        control: {
          blocked_reason:
            code === 401 ? "MODEL_AUTH_FAILED" : "MODEL_RATE_LIMITED",
        },
      });
    },
  );
});

it("抽出できなかった製作文を通常の回答APIで受け、複合節を省かず保存する", async () => {
  const { call, cid } = await setupCase();
  const text =
    "耐熱ガラスの円筒を製作してほしいです。外径50mm、全長100mm、内径30mmの中空で、3個、来月末までにお願いします。";
  output = {
    schemaVersion: 1,
    newItems: [],
    changes: [],
    ambiguities: [],
    unprocessedQuotes: ["内径30mmの中空で"],
  };
  const path = `/cases/${cid}`;
  const response = await call(path + "/answers", "POST", {
    ...answer("compound-fabrication"),
    answer: { type: "text", text },
  });
  expect(response.status).toBe(200);
  expect(calls).toBe(1);
  const view = await call(path);
  expect(view.body.unresolvedInputs).toEqual([]);
  const items = view.body.items as Item[];
  expect(items).toHaveLength(1);
  expect(items[0].label).toBe("円筒");
  expect(
    Object.fromEntries(
      items[0].fields.map(({ key, value }) => [key, value?.text]),
    ),
  ).toMatchObject({
    material: "耐熱ガラス",
    request_scope: "fabrication",
    outer_diameter: "50mm",
    overall_length: "100mm",
    inner_diameter: "30mm",
    body_structure: "hollow",
    quantity: "3個",
    required_date: "来月末",
  });
  expect(
    await db
      .prepare("SELECT error_code FROM intake_calls WHERE case_id=?")
      .bind(cid)
      .first(),
  ).toEqual({ error_code: "INVALID_EXTRACTION" });
});

it("容量と穴配置を同時に受け付け、条件編集でも同じ構造で保存する", async () => {
  const { call, cid } = await setupCase();
  const path = `/cases/${cid}`;
  const identity = "アルミのケースを製作してほしいです";
  const capacity = "容量は1.5リットル",
    layout = "穴の位置は四隅";
  const text = `${identity}。${capacity}、${layout}。`;
  output = {
    schemaVersion: 1,
    newItems: [
      {
        ref: "one",
        label: "ケース",
        quote: identity,
        profile: "fabrication",
        category: null,
      },
    ],
    changes: [
      {
        itemRef: "one",
        key: "capacity",
        status: "known",
        value: { text: "1.5リットル", number: 1.5, unit: "リットル" },
        quote: capacity,
        operation: "set",
        hardConstraint: true,
      },
      {
        itemRef: "one",
        key: "hole_layout",
        status: "known",
        value: { text: layout, number: null, unit: null },
        quote: layout,
        operation: "set",
        hardConstraint: true,
      },
    ],
    ambiguities: [],
    unprocessedQuotes: [],
  };
  expect(
    (
      await call(path + "/answers", "POST", {
        ...answer("product-fields"),
        answer: { type: "text", text },
      })
    ).status,
  ).toBe(200);
  const initial = await call(path);
  const [item] = initial.body.items as Item[];
  expect(item.fields).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        key: "capacity",
        quote: capacity,
        value: { text: "1.5L", number: 1.5, unit: "L" },
      }),
      expect.objectContaining({
        key: "hole_layout",
        quote: layout,
        value: { text: layout, number: null, unit: null },
      }),
    ]),
  );
  const editedCapacity = "750ミリリットル";
  expect(
    (
      await call(path + "/fields", "PATCH", {
        mutationId: "change-capacity",
        expectedRevision: initial.body.revision,
        text: editedCapacity,
        change: {
          itemId: item.id,
          key: "capacity",
          text: editedCapacity,
          number: 750,
          unit: "ミリリットル",
        },
      })
    ).status,
  ).toBe(200);
  const [edited] = (await call(path)).body.items as Item[];
  expect(edited.fields.find((field) => field.key === "capacity")).toMatchObject(
    {
      quote: editedCapacity,
      source: "field_edit",
      value: { text: "750mL", number: 750, unit: "mL" },
    },
  );
});

it("開頭の手持ちリングへの穴あけ依頼を抽出エラーから回復する", async () => {
  const version = "drilling-fixture";
  const partner = {
    id: "test-partner",
    name: "テスト仕入先",
    normalizedName: "テスト仕入先",
    capabilityState: "list_only",
    groups: [],
    sourceRefs: [{ fileName: "fixture.xlsx", sheet: "試験", row: 1 }],
  };
  await db.batch([
    db
      .prepare(
        "INSERT INTO partner_master_versions VALUES(?,'ready',?,'offline','{}','{}',?)",
      )
      .bind(version, Date.now(), JSON.stringify({ counts: { partners: 1 } })),
    db
      .prepare("INSERT INTO partner_master_rows VALUES(?,?,?,?)")
      .bind(
        version,
        partner.id,
        partner.normalizedName,
        JSON.stringify(partner),
      ),
    db
      .prepare(
        "UPDATE partner_master_state SET current_version_id=?,revision=revision+1,last_import_status='ready',last_error=NULL WHERE id=1",
      )
      .bind(version),
  ]);
  try {
    const { call, cid } = await setupCase();
    const path = `/cases/${cid}`;
    const text = "手持ちのリングに穴をあけてほしいです。";
    output = {
      schemaVersion: 1,
      newItems: [],
      changes: [],
      ambiguities: [],
      unprocessedQuotes: [text],
    };
    const response = await call(path + "/answers", "POST", {
      ...answer("drill-owned-ring"),
      answer: { type: "text", text },
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      action: "ask",
      question: { fieldKey: "hole_diameter" },
    });
    const view = await call(path);
    expect(view.body.unresolvedInputs).toEqual([]);
    const items = view.body.items as Item[];
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe("リング");
    expect(
      Object.fromEntries(
        items[0].fields.map(({ key, value }) => [key, value?.text]),
      ),
    ).toMatchObject({
      request_scope: "processing",
      process: "穴をあけ",
      material_supply: "customer_supplied",
    });
    expect(
      await db
        .prepare("SELECT error_code FROM intake_calls WHERE case_id=?")
        .bind(cid)
        .first(),
    ).toEqual({ error_code: "INVALID_EXTRACTION" });
    expect(calls).toBe(1);
  } finally {
    await db
      .prepare(
        "UPDATE partner_master_state SET current_version_id=NULL,last_import_status='empty' WHERE current_version_id=?",
      )
      .bind(version)
      .run();
  }
});

it("結果不明の購入初回を再課金せず回復し、再送でも同じ結果を返す", async () => {
  delay = 1;
  const { call, cid } = await setupCase();
  const path = `/cases/${cid}`;
  const text = "ガラス製品を購入したいです。3個、来月末までに必要です。";
  const mutation = {
    ...answer("purchase-unknown"),
    answer: { type: "text", text },
  };
  const pending = call(path + "/answers", "POST", mutation);
  try {
    await expect.poll(() => calls).toBe(1);
    await db
      .prepare("UPDATE intake_calls SET created_at=? WHERE case_id=?")
      .bind(Date.now() - 31_000, cid)
      .run();
    const response = await call(path + "/answers", "POST", mutation);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      action: "ask",
      question: { fieldKey: "purpose" },
    });
    const view = await call(path);
    expect(view.body.unresolvedInputs).toEqual([]);
    const [item] = view.body.items as Item[];
    expect(item.label).toBe("ガラス製品");
    expect(
      Object.fromEntries(
        item.fields.map(({ key, value }) => [key, value?.text]),
      ),
    ).toMatchObject({
      request_scope: "purchase",
      quantity: "3個",
      required_date: "来月末",
    });
    expect(await call(path + "/answers", "POST", mutation)).toEqual(response);
    expect(
      await db
        .prepare("SELECT state,error_code FROM intake_calls WHERE case_id=?")
        .bind(cid)
        .first(),
    ).toEqual({ state: "unknown", error_code: "MODEL_RESULT_UNKNOWN" });
    expect(
      await db.prepare("SELECT calls FROM intake_totals WHERE id=1").first(),
    ).toEqual({ calls: 1 });
    expect(calls).toBe(1);
  } finally {
    release?.();
    await pending;
  }
});
