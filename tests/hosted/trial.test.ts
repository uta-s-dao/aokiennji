import { it, expect, vi } from "vitest";
import trial, { type TrialEnv } from "../../src/hosted/trial-worker";
const origin = "https://aoki-enji.official-b.workers.dev",
  token = "trial-secret-".repeat(5),
  ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const env = {
  APP_MODE: "hosted-trial",
  INTAKE_PROVIDER: "demo",
  EXTERNAL_ENABLED: "false",
  TRIAL_ORIGIN: origin,
  TRIAL_PROXY_TOKEN: token,
  ASSETS: {
    fetch: vi.fn(
      async (req: Request) => new Response(new URL(req.url).pathname),
    ),
  },
} as unknown as TrialEnv;
const req = (
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
) =>
  new Request(origin + path, {
    method,
    headers: { "X-Availability-Trial-Token": token, ...headers },
    ...(method === "POST" ? { body: "{}" } : {}),
  });
it("非公開入口はトークン・origin・デモ設定が揃わなければ拒否する", async () => {
  expect(
    (
      await trial.fetch(
        req("/api/v2/session", { "X-Availability-Trial-Token": "bad" }),
        env,
        ctx,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await trial.fetch(
        req("/api/v2/session"),
        { ...env, EXTERNAL_ENABLED: "true" },
        ctx,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await trial.fetch(
        new Request("https://evil.test/api/v2/session", {
          headers: { "X-Availability-Trial-Token": token },
        }),
        env,
        ctx,
      )
    ).status,
  ).toBe(403);
  expect(
    (await trial.fetch(req("/api/v2/cases", {}, "POST"), env, ctx)).status,
  ).toBe(403);
});
it("セッションを本番試用と明示し、Cookieをv2 APIに限定する", async () => {
  const r = await trial.fetch(req("/api/v2/session"), env, ctx);
  expect(r.status).toBe(200);
  const j = await r.json();
  expect(j).toMatchObject({
    mode: "hosted-trial",
    extraction: "demo",
    externalEnabled: false,
  });
  expect(r.headers.get("Set-Cookie")).toContain("Path=/api/v2;");
  expect(r.headers.get("Cache-Control")).toBe("private, no-store");
});
it("固定ローカルトークンでも管理APIは開かず、静的ファイルは保護後にだけ取得する", async () => {
  expect(
    (
      await trial.fetch(
        req(
          "/api/v2/admin/demo",
          { "X-Local-Admin-Token": "availability-local-admin", Origin: origin },
          "POST",
        ),
        env,
        ctx,
      )
    ).status,
  ).toBe(403);
  expect((await trial.fetch(req("/unrelated"), env, ctx)).status).toBe(404);
  expect(
    (await trial.fetch(req("/availability-v2/api/v2/admin/demo"), env, ctx))
      .status,
  ).toBe(404);
  const r = await trial.fetch(
    req("/availability-v2/assets/example.js"),
    env,
    ctx,
  );
  expect(await r.text()).toBe("/assets/example.js");
  expect(r.headers.get("X-Robots-Tag")).toContain("noindex");
});
