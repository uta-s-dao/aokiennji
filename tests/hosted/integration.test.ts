import { it, expect } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { migrate } from "../helpers/migrate";
import { runJob } from "../../src/research-worker";
import type { Env } from "../../src/adapters/store";
import fixture from "../../fixtures/demo/knowledge.json";
it("本番試用の実DB・Cookie・CSRF・所有権・判定・数量訂正・メールを接続確認する", async () => {
  const bundle = await build({
    entryPoints: ["src/hosted/trial-worker.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    conditions: ["workerd"],
  });
  const token = "private-test-".repeat(5),
    origin = "https://aoki-enji.official-b.workers.dev";
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-11-16",
      bindings: {
        APP_MODE: "hosted-trial",
        TRIAL_ORIGIN: origin,
        TRIAL_PROXY_TOKEN: token,
        INTAKE_PROVIDER: "demo",
        EXTERNAL_ENABLED: "false",
        LOCAL_ADMIN_TOKEN: "",
        CONTACT_EMAIL: "",
      },
      d1Databases: { DB: "trial-integration-only" },
      r2Buckets: ["FILES"],
      queueProducers: { RESEARCH_QUEUE: "trial-integration-only" },
    }),
  );
  try {
    const db = await mf.getD1Database("DB");
    await migrate(db);
    for (const s of fixture.sources)
      await db
        .prepare("INSERT INTO sources VALUES(?,?,?,?,?,?,?,?)")
        .bind(
          s.id,
          s.version,
          s.label,
          s.public_allowed,
          s.ai_allowed,
          s.role,
          s.confirmation_stage,
          s.is_demo,
        )
        .run();
    for (const r of fixture.rules)
      await db
        .prepare("INSERT INTO capability_rules VALUES(?,?,?)")
        .bind(r.id, JSON.stringify(r), r.sourceId)
        .run();
    const session = await mf.dispatchFetch(origin + "/api/v2/session", {
      headers: { "X-Availability-Trial-Token": token },
    });
    const csrf = ((await session.json()) as { csrf: string }).csrf;
    const cookie = session.headers.get("Set-Cookie")!.split(";")[0];
    async function call(
      path: string,
      method = "GET",
      body?: unknown,
      extra: Record<string, string> = {},
    ) {
      const r = await mf.dispatchFetch(origin + "/api/v2" + path, {
        method,
        headers: {
          Cookie: cookie,
          Origin: origin,
          "X-CSRF-Token": csrf,
          "X-Availability-Trial-Token": token,
          "Content-Type": "application/json",
          ...extra,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return {
        status: r.status,
        json: (await r.json()) as Record<string, unknown>,
      };
    }
    const created = await call(
      "/cases",
      "POST",
      {},
      { "Idempotency-Key": "hosted-only-case" },
    );
    expect(created.status).toBe(201);
    const cid = String(created.json.caseId);
    expect(
      (
        await call(
          `/cases/${cid}/answers`,
          "POST",
          {
            mutationId: "bad-csrf",
            expectedRevision: 0,
            questionId: "initial",
            answer: { type: "text", text: "AX-100を購入したい" },
          },
          { "X-CSRF-Token": "invalid" },
        )
      ).status,
    ).toBe(403);
    const first = await call(`/cases/${cid}/answers`, "POST", {
      mutationId: "first",
      expectedRevision: 0,
      questionId: "initial",
      answer: { type: "text", text: "AX-100を2個購入したい" },
    });
    expect(first.status).toBe(200);
    expect(first.json.jobId).toBeTruthy();
    await runJob(
      {
        DB: db,
        FILES: await mf.getR2Bucket("FILES"),
        RESEARCH_QUEUE: await mf.getQueueProducer("RESEARCH_QUEUE"),
      } as unknown as Env,
      String(first.json.jobId),
    );
    const state = await call("/cases/" + cid);
    expect((state.json.result as { verdict: string }).verdict).toBe(
      "can_handle",
    );
    expect(
      (
        await call("/cases/" + cid, "GET", undefined, {
          Cookie: "av2_session=00000000-0000-0000-0000-000000000000",
        })
      ).status,
    ).toBe(404);
    const corrected = await call(`/cases/${cid}/answers`, "POST", {
      mutationId: "correction",
      expectedRevision: state.json.revision,
      questionId: "initial",
      answer: { type: "text", text: "数量を3個へ訂正します" },
    });
    expect(corrected.status).toBe(200);
    const mail = await call(`/cases/${cid}/mail-draft`, "POST", {});
    expect(mail.json.body).toContain("数量：3個");
    expect(mail.json.body).not.toContain("数量：2個");
    expect(mail.json.mailto).toBeNull();
    expect(
      (
        await db
          .prepare("SELECT count(*) AS n FROM intake_calls")
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  } finally {
    await mf.dispose();
  }
}, 30000);
