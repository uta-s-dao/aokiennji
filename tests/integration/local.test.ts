import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { migrate } from "../helpers/migrate";
import {
  runJob,
  flushOutbox,
  expireJobs,
  maintenance,
} from "../../src/research-worker";
import {
  type Env,
  type CaseRow,
  type JobRow,
  commit,
  stmt,
} from "../../src/adapters/store";
import { extractDemo } from "../../src/adapters/extraction";
import { makeSnapshot } from "../../src/domain/intake";
let mf: Miniflare, db: D1Database, env: Env;
const origin = "http://127.0.0.1";
let counter = 0;
type Client = {
  cookie: string;
  csrf: string;
  call: (
    p: string,
    method?: string,
    b?: unknown,
    h?: Record<string, string>,
  ) => Promise<{ status: number; body: Record<string, unknown> }>;
};
async function client(): Promise<Client> {
  const r = await mf.dispatchFetch(origin + "/api/v2/session");
  const token = ((await r.json()) as { csrf: string }).csrf,
    cookie = r.headers.get("Set-Cookie")!.split(";")[0];
  return {
    cookie,
    csrf: token,
    call: async (p, method = "GET", b, h = {}) => {
      const form = b instanceof FormData ? new Response(b) : null;
      const r = await mf.dispatchFetch(origin + "/api/v2" + p, {
        method,
        headers: {
          Cookie: cookie,
          Origin: origin,
          "X-CSRF-Token": token,
          ...(form
            ? { "Content-Type": form.headers.get("Content-Type")! }
            : { "Content-Type": "application/json" }),
          ...h,
        },
        body:
          b === undefined
            ? undefined
            : form
              ? Buffer.from(await form.arrayBuffer())
              : JSON.stringify(b),
      });
      return {
        status: r.status,
        body: (await r.json()) as Record<string, unknown>,
      };
    },
  };
}
async function create(c: Client) {
  const r = await c.call(
    "/cases",
    "POST",
    {},
    { "Idempotency-Key": "create-" + ++counter },
  );
  expect(r.status).toBe(201);
  return String(r.body.caseId);
}
async function initial(
  c: Client,
  cid: string,
  t = "AX-100を購入したい",
  mid = "m-" + ++counter,
) {
  return c.call(`/cases/${cid}/answers`, "POST", {
    kind: "answer_mutation",
    mutationId: mid,
    expectedRevision: 0,
    questionId: "initial",
    answer: { type: "text", text: t },
  });
}
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: "dist/worker/worker.js",
      compatibilityDate: "2026-11-16",
      bindings: {
        APP_MODE: "local-demo",
        LOCAL_ADMIN_TOKEN: "test-admin",
        CONTACT_EMAIL: "",
        EXTERNAL_ENABLED: "false",
      },
      d1Databases: { DB: "local-test" },
      r2Buckets: ["FILES"],
      queueProducers: { RESEARCH_QUEUE: "research" },
    }),
  );
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  await migrate(db);
  env = {
    DB: db,
    FILES: (await mf.getR2Bucket("FILES")) as unknown as R2Bucket,
    RESEARCH_QUEUE: (await mf.getQueueProducer(
      "RESEARCH_QUEUE",
    )) as unknown as Env["RESEARCH_QUEUE"],
  } as Env;
  const c = await client();
  expect(
    (
      await c.call(
        "/admin/demo",
        "POST",
        {},
        { "X-Local-Admin-Token": "test-admin" },
      )
    ).status,
  ).toBe(200);
});
afterAll(async () => {
  await mf?.dispose();
});
describe("ローカルAPIとD1/R2", () => {
  it("匿名所有権、CSRF、管理者認証を検証し外部originでは起動拒否", async () => {
    const a = await client(),
      b = await client(),
      cid = await create(a);
    expect((await b.call("/cases/" + cid)).status).toBe(404);
    const bad = await mf.dispatchFetch(origin + "/api/v2/cases", {
      method: "POST",
      headers: { Cookie: a.cookie, Origin: origin, "X-CSRF-Token": "fake" },
    });
    expect(bad.status).toBe(403);
    expect((await a.call("/admin/state")).status).toBe(403);
    expect(
      (await mf.dispatchFetch("https://public.example/api/v2/session")).status,
    ).toBe(503);
  });
  it("初回作成の冪等性", async () => {
    const c = await client(),
      h = { "Idempotency-Key": "same" };
    const a = await c.call("/cases", "POST", {}, h),
      b = await c.call("/cases", "POST", {}, h);
    expect(a.body.caseId).toBe(b.body.caseId);
  });
  it("J01 同一mutationId再送は同じ応答、イベントとジョブは1回", async () => {
    const c = await client(),
      cid = await create(c);
    const a = await initial(c, cid, undefined, "same"),
      b = await initial(c, cid, undefined, "same");
    expect(a.status).toBe(200);
    expect(b.body).toEqual(a.body);
    expect(
      (await stmt(
        env,
        "SELECT COUNT(*) n FROM case_events WHERE case_id=?",
        cid,
      ).first<{ n: number }>())!.n,
    ).toBe(1);
    expect(
      (await stmt(
        env,
        "SELECT COUNT(*) n FROM research_jobs WHERE case_id=?",
        cid,
      ).first<{ n: number }>())!.n,
    ).toBe(1);
  });
  it("J02 同じrevisionへの並行更新で負けた側の副作用を残さない", async () => {
    const c = await client(),
      cid = await create(c);
    const r = await Promise.all([
      initial(c, cid, undefined, "first"),
      initial(c, cid, undefined, "second"),
    ]);
    expect(r.map((x) => x.status).sort()).toEqual([200, 409]);
    for (const table of ["case_events", "research_jobs", "research_outbox"]) {
      const sql =
        table === "research_outbox"
          ? "SELECT COUNT(*) n FROM research_outbox WHERE job_id IN (SELECT id FROM research_jobs WHERE case_id=?)"
          : `SELECT COUNT(*) n FROM ${table} WHERE case_id=?`;
      expect((await stmt(env, sql, cid).first<{ n: number }>())!.n).toBe(1);
    }
  });
  it("CAS更新0行ではイベントもjob/outboxも残らない", async () => {
    const c = await client(),
      cid = await create(c);
    const row = await stmt(
      env,
      "SELECT * FROM cases WHERE id=?",
      cid,
    ).first<CaseRow>();
    await stmt(env, "UPDATE cases SET revision=2 WHERE id=?", cid).run();
    await expect(
      commit(env, row!, "stale", extractDemo(makeSnapshot(cid), "部品"), {}),
    ).rejects.toThrow("REVISION_CONFLICT");
    expect(
      (await stmt(
        env,
        "SELECT COUNT(*) n FROM case_events WHERE case_id=?",
        cid,
      ).first<{ n: number }>())!.n,
    ).toBe(0);
  });
  it("J03 重複queue処理とJ07再開で結果は1件", async () => {
    const c = await client(),
      cid = await create(c),
      r = await initial(c, cid);
    const jid = String(r.body.jobId);
    await Promise.all([runJob(env, jid), runJob(env, jid)]);
    await runJob(env, jid);
    const v = await c.call(`/cases/${cid}/result`);
    expect((v.body.result as { verdict: string }).verdict).toBe("can_handle");
    expect(
      (await stmt(
        env,
        "SELECT COUNT(*) n FROM results WHERE job_id=?",
        jid,
      ).first<{ n: number }>())!.n,
    ).toBe(1);
    expect((await c.call("/cases/" + cid)).status).toBe(200);
  });
  it("J04/J05 outbox停止回復は新しいjobを作らない", async () => {
    const c = await client(),
      cid = await create(c),
      r = await initial(c, cid);
    const jid = String(r.body.jobId);
    await stmt(
      env,
      "UPDATE research_outbox SET queued_at=NULL WHERE job_id=?",
      jid,
    ).run();
    await flushOutbox(env);
    await stmt(
      env,
      "UPDATE research_outbox SET queued_at=NULL WHERE job_id=?",
      jid,
    ).run();
    await flushOutbox(env);
    expect(
      (await stmt(
        env,
        "SELECT attempts FROM research_outbox WHERE job_id=?",
        jid,
      ).first<{ attempts: number }>())!.attempts,
    ).toBeGreaterThanOrEqual(2);
    expect(
      (await stmt(
        env,
        "SELECT COUNT(*) n FROM research_jobs WHERE case_id=?",
        cid,
      ).first<{ n: number }>())!.n,
    ).toBe(1);
  });
  it("S07 入力訂正後の旧jobは最新結果へ反映しない", async () => {
    const c = await client(),
      cid = await create(c),
      r = await initial(c, cid),
      jid = String(r.body.jobId);
    const view = (await c.call("/cases/" + cid)).body;
    const items = view.items as { id: string }[];
    const update = await c.call(`/cases/${cid}/fields`, "PATCH", {
      mutationId: "edit",
      expectedRevision: 1,
      text: "AX-100B",
      change: { itemId: items[0].id, key: "model", text: "AX-100B" },
    });
    expect(update.status).toBe(200);
    await runJob(env, jid);
    expect(
      (await stmt(
        env,
        "SELECT status FROM research_jobs WHERE id=?",
        jid,
      ).first<{ status: string }>())!.status,
    ).toBe("superseded");
    expect((await c.call(`/cases/${cid}/result`)).body.result).toBeNull();
  });
  it("J06 lease回復後は旧tokenでcommit不可、利用量を維持", async () => {
    const c = await client(),
      cid = await create(c),
      r = await initial(c, cid),
      jid = String(r.body.jobId);
    await stmt(
      env,
      "UPDATE research_jobs SET status='running',lease_token='old',lease_until=?,usage=? WHERE id=?",
      Date.now() - 1,
      '{"intake":1}',
      jid,
    ).run();
    await runJob(env, jid);
    const j = await stmt(
      env,
      "SELECT * FROM research_jobs WHERE id=?",
      jid,
    ).first<JobRow>();
    expect(j!.status).toBe("completed");
    expect(j!.lease_token).not.toBe("old");
    expect(j!.usage).toBe('{"intake":1}');
    expect(
      (
        await stmt(
          env,
          "UPDATE research_jobs SET stage='bad' WHERE id=? AND lease_token='old'",
          jid,
        ).run()
      ).meta.changes,
    ).toBe(0);
  });
  it("J08 60秒期限後の遅着結果を拒否し失敗表示", async () => {
    const c = await client(),
      cid = await create(c),
      r = await initial(c, cid),
      jid = String(r.body.jobId);
    await stmt(
      env,
      "UPDATE research_jobs SET deadline=? WHERE id=?",
      Date.now() - 1,
      jid,
    ).run();
    await expireJobs(env);
    await runJob(env, jid);
    const result = (await c.call(`/cases/${cid}/result`)).body.result as {
      status: string;
      verdict: null;
    };
    expect(result.status).toBe("failed");
    expect(result.verdict).toBeNull();
  });
  it("J09/R21 知識更新・撤回後は結果とメール文から肯定を失効", async () => {
    const c = await client(),
      cid = await create(c),
      r = await initial(c, cid);
    await runJob(env, String(r.body.jobId));
    await stmt(
      env,
      "UPDATE knowledge SET revision=revision+1 WHERE id=1",
    ).run();
    const result = (await c.call(`/cases/${cid}/result`)).body.result as {
      stale: boolean;
      verdict: string;
    };
    expect(result.stale).toBe(true);
    expect(result.verdict).toBe("needs_review");
    const mail = await c.call(`/cases/${cid}/mail-draft`, "POST", {});
    expect(mail.body.body).toContain("未確認");
  });
  it("添付MIME/実データ/所有権、図面差替え、削除を検証", async () => {
    const c = await client(),
      other = await client(),
      cid = await create(c);
    const f = new FormData();
    f.set("file", new Blob(["<svg/>"], { type: "image/png" }), "x.png");
    f.set("mutationId", "bad");
    f.set("expectedRevision", "0");
    expect((await c.call(`/cases/${cid}/attachments`, "POST", f)).status).toBe(
      400,
    );
    const upload = async (mid: string, rev: number, supersedes?: string) => {
      const f = new FormData();
      f.set(
        "file",
        new Blob(["%PDF-1.7\n%%EOF"], { type: "application/pdf" }),
        "旧仕様.pdf",
      );
      f.set("mutationId", mid);
      f.set("expectedRevision", String(rev));
      if (supersedes) f.set("supersedes", supersedes);
      return c.call(`/cases/${cid}/attachments`, "POST", f);
    };
    const a = await upload("pdf", 0);
    expect(a.status).toBe(200);
    expect((await upload("pdf", 0)).body).toEqual(a.body);
    const aid = String(a.body.attachmentId);
    expect((await other.call(`/cases/${cid}/attachments/${aid}`)).status).toBe(
      404,
    );
    const b = await upload("replace", 1, aid);
    expect(b.status).toBe(200);
    const mail = await c.call(`/cases/${cid}/mail-draft`, "POST", {});
    expect(mail.body.body).toContain("こちらが最新：旧仕様.pdf");
    expect(mail.body.body).not.toContain("object_key");
    await c.call("/cases/" + cid, "DELETE");
    expect((await c.call("/cases/" + cid)).status).toBe(410);
    await maintenance(env);
    expect(
      (await stmt(
        env,
        "SELECT COUNT(*) n FROM attachments WHERE case_id=?",
        cid,
      ).first<{ n: number }>())!.n,
    ).toBe(0);
  });
  it("メール起動とコピーを送信済みにしない", async () => {
    const c = await client(),
      cid = await create(c);
    expect(
      (await c.call(`/cases/${cid}/events`, "POST", { code: "sent" })).status,
    ).toBe(400);
    expect(
      (await c.call(`/cases/${cid}/events`, "POST", { code: "draft_copied" }))
        .status,
    ).toBe(200);
  });
  it("S08 分割で未処理入力を保持し、同じ操作の再送で子案件を増やさない", async () => {
    const c = await client(),
      cid = await create(c);
    const r = await initial(c, cid, "部品A\n部品B\n部品C\n部品D");
    expect(r.status).toBe(200);
    const payload = { mutationId: "split-once", expectedRevision: 1, index: 0 };
    const a = await c.call(`/cases/${cid}/split`, "POST", payload),
      b = await c.call(`/cases/${cid}/split`, "POST", payload);
    expect(a.status).toBe(200);
    expect(a.body.caseId).toBe(b.body.caseId);
    const parent = await c.call("/cases/" + cid),
      child = await c.call("/cases/" + a.body.caseId);
    expect(parent.body.overflow).toEqual(["部品D"]);
    const remaining = await c.call(`/cases/${cid}/split`, "POST", {
      mutationId: "split-last",
      expectedRevision: 2,
      index: 0,
    });
    expect(remaining.status).toBe(200);
    expect(
      (
        (await c.call("/cases/" + remaining.body.caseId)).body
          .items as unknown[]
      ).length,
    ).toBe(1);
    expect((child.body.items as unknown[]).length).toBe(3);
  });
  it("J06 遅い旧consumerはlease引継ぎ後の結果を上書きできない", async () => {
    const c = await client(),
      cid = await create(c),
      r = await initial(c, cid),
      jid = String(r.body.jobId);
    let entered!: () => void, release!: () => void;
    const paused = new Promise<void>((resolve) => (entered = resolve)),
      gate = new Promise<void>((resolve) => (release = resolve));
    function hold(prepared: D1PreparedStatement): D1PreparedStatement {
      return new Proxy(prepared, {
        get(p, k) {
          if (k === "bind")
            return (...values: unknown[]) => hold(p.bind(...values));
          if (k === "all")
            return async () => {
              entered();
              await gate;
              return p.all();
            };
          const value = Reflect.get(p, k);
          return typeof value === "function" ? value.bind(p) : value;
        },
      });
    }
    const delayedDB = new Proxy(db, {
      get(target, key) {
        if (key !== "prepare") {
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (sql: string) =>
          sql === "SELECT json FROM capability_rules"
            ? hold(target.prepare(sql))
            : target.prepare(sql);
      },
    });
    const old = runJob({ ...env, DB: delayedDB }, jid);
    await paused;
    await stmt(
      env,
      "UPDATE research_jobs SET lease_until=? WHERE id=?",
      Date.now() - 1,
      jid,
    ).run();
    await runJob(env, jid);
    const current = await stmt(
      env,
      "SELECT lease_token FROM research_jobs WHERE id=?",
      jid,
    ).first<{ lease_token: string }>();
    release();
    await old;
    expect(
      (await stmt(
        env,
        "SELECT COUNT(*) n FROM results WHERE job_id=?",
        jid,
      ).first<{ n: number }>())!.n,
    ).toBe(1);
    const job = await stmt(
      env,
      "SELECT * FROM research_jobs WHERE id=?",
      jid,
    ).first<JobRow>();
    expect(job!.lease_token).toBe(current!.lease_token);
    expect(job!.status).toBe("completed");
  });
});

it("訂正の返答・DB現在値・結果理由・メール文が同じ温度を示す", async () => {
  const c = await client(),
    cid = await create(c);
  const first = await initial(c, cid, "ガラス 通常温度780℃");
  expect(first.status).toBe(200);
  expect(first.body.notice).toBe("");
  const q = first.body.question as { id: string };
  const corrected = await c.call(`/cases/${cid}/answers`, "POST", {
    mutationId: "customer-temperature-correction",
    expectedRevision: 1,
    questionId: q.id,
    answer: { type: "text", text: "ガラス 通常温度680℃、最高温度820℃" },
  });
  expect(corrected.status).toBe(200);
  expect(corrected.body.notice).toContain("通常温度を680℃に変更しました");
  expect(corrected.body.notice).not.toContain("780℃");
  const replay = await c.call(`/cases/${cid}/answers`, "POST", {
    mutationId: "customer-temperature-correction",
    expectedRevision: 1,
    questionId: q.id,
    answer: { type: "text", text: "ガラス 通常温度680℃、最高温度820℃" },
  });
  expect(replay.body).toEqual(corrected.body);
  const research = await c.call(`/cases/${cid}/research`, "POST", {
    mutationId: "customer-research",
    expectedRevision: 2,
  });
  await runJob(env, String(research.body.jobId));
  const current = await c.call(`/cases/${cid}`);
  expect(current.body).toMatchObject({
    revision: 3,
    items: [
      {
        fields: expect.arrayContaining([
          expect.objectContaining({
            key: "normal_temperature",
            value: expect.objectContaining({ number: 680 }),
          }),
          expect.objectContaining({
            key: "peak_temperature",
            value: expect.objectContaining({ number: 820 }),
          }),
        ]),
      },
    ],
    result: {
      verdict: "needs_review",
      items: [expect.objectContaining({ missingFields: [] })],
    },
  });
  const result = current.body.result as { items: { reason: string }[] };
  expect(
    (current.body.items as { fields: { key: string }[] }[])[0].fields.some(
      (f) => f.key === "purpose",
    ),
  ).toBe(false);
  expect(result.items[0].reason).toContain("680℃");
  expect(result.items[0].reason).toContain("820℃");
  const mail = await c.call(`/cases/${cid}/mail-draft`, "POST", {});
  expect(mail.body.body).toContain(result.items[0].reason);
  expect(mail.body.body).not.toContain("780℃");
});

it("保存エラー時は成功通知を返さず、現在値と履歴も変えない", async () => {
  const c = await client(),
    cid = await create(c);
  const first = await initial(c, cid, "ガラス4枚、パッキン8個");
  const state = await c.call(`/cases/${cid}`);
  const items = state.body.items as { id: string }[];
  const failed = await c.call(`/cases/${cid}/fields`, "PATCH", {
    mutationId: "bad-field-copy",
    expectedRevision: 1,
    text: "10℃",
    change: {
      itemId: items[0].id,
      key: "outer_diameter",
      text: "10℃",
      number: 10,
      unit: "℃",
    },
  });
  expect(first.status).toBe(200);
  expect(failed.status).toBe(400);
  expect(failed.body).not.toHaveProperty("notice");
  expect((await c.call(`/cases/${cid}`)).body).toEqual(state.body);
});

it("6問を超えて品目別に続け、明示的な途中調査の後も回答できる", async () => {
  const c = await client(),
    cid = await create(c);
  let r = await initial(c, cid, "名前不明の交換部品です");
  const seen = new Set<string>();
  for (let n = 0; n < 8; n++) {
    const q = r.body.question as { id: string; fieldKey: string };
    expect(q).toBeTruthy();
    expect(seen.has(q.id)).toBe(false);
    seen.add(q.id);
    r = await c.call(`/cases/${cid}/answers`, "POST", {
      mutationId: "long-dialogue-" + n,
      expectedRevision: r.body.revision,
      questionId: q.id,
      answer: { type: n % 2 ? "skip" : "unknown" },
    });
    expect(r.status).toBe(200);
    expect(r.body.jobId).toBeNull();
  }
  expect(r.body.question).toBeTruthy();
  const research = await c.call(`/cases/${cid}/research`, "POST", {
    mutationId: "long-dialogue-research",
    expectedRevision: r.body.revision,
  });
  await runJob(env, String(research.body.jobId));
  const current = await c.call(`/cases/${cid}`);
  expect(current.body.result).toBeTruthy();
  const q = current.body.question as { id: string };
  expect(q).toBeTruthy();
  const continued = await c.call(`/cases/${cid}/answers`, "POST", {
    mutationId: "long-dialogue-continue",
    expectedRevision: current.body.revision,
    questionId: q.id,
    answer: { type: "unknown" },
  });
  expect(continued.status).toBe(200);
  expect(continued.body.question).toBeTruthy();
});
