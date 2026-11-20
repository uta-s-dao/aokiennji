import { describe, it, expect, vi } from "vitest";
import { createTrialGateway } from "../../src/hosted/site-gateway";
const origin = "https://aoki-enji.official-b.workers.dev",
  token = "test-".repeat(12);
const ctx = { waitUntil: vi.fn() };
function setup(allowed = true) {
  const legacy = {
    fetch: vi.fn(async (req: Request) =>
      new URL(req.url).pathname === "/api/admin/settings"
        ? Response.json(
            allowed
              ? { data: { flags: { chat: true } } }
              : { error: "unauthorized" },
            { status: allowed ? 200 : 401 },
          )
        : new Response("original route"),
    ),
    scheduled: vi.fn(),
  };
  const service = {
    fetch: vi.fn(
      async (req: Request) => new Response((await req.text()) || "trial"),
    ),
  };
  const env = {
    APP_ORIGIN: origin,
    AVAILABILITY_V2_PROXY_TOKEN: token,
    AVAILABILITY_V2: service,
  };
  return { legacy, service, env, gateway: createTrialGateway(legacy) };
}
describe("existing production gateway", () => {
  it("旧ルート・旧チャット・scheduledは変更せず元のハンドラへ渡す", async () => {
    const x = setup();
    for (const p of [
      "/",
      "/api/chat",
      "/admin",
      "/availability-v2-not-a-route",
    ]) {
      const req = new Request(origin + p);
      expect(await (await x.gateway.fetch(req, x.env, ctx)).text()).toBe(
        "original route",
      );
      expect(x.legacy.fetch).toHaveBeenLastCalledWith(req, x.env, ctx);
    }
    expect(x.service.fetch).not.toHaveBeenCalled();
    expect(x.gateway.scheduled).toBe(x.legacy.scheduled);
  });
  it("未ログイン・偽装ヘッダ・失効した管理セッションを拒否する", async () => {
    const x = setup(false);
    for (const cookie of ["", "aoki_admin=forged"]) {
      const r = await x.gateway.fetch(
        new Request(origin + "/api/v2/session", {
          headers: { cookie, "X-Availability-Trial-Token": token },
        }),
        x.env,
        ctx,
      );
      expect(r.status).toBe(401);
    }
    expect(x.service.fetch).not.toHaveBeenCalled();
    const login = await x.gateway.fetch(
      new Request(origin + "/availability-v2/"),
      x.env,
      ctx,
    );
    expect(await login.text()).toContain('href="/admin"');
  });
  it("管理認証後だけ転送し、旧サイトの資格情報をv2へ渡さない", async () => {
    const x = setup();
    const req = new Request(origin + "/api/v2/cases", {
      method: "POST",
      headers: {
        Cookie:
          "aoki_admin=valid; av2_session=12345678-1234-1234-1234-123456789abc; unrelated=private",
        Origin: origin,
        "Content-Type": "application/json",
        "X-CSRF-Token": "csrf",
        Authorization: "secret-old",
        "X-Availability-Trial-Token": "forged",
      },
      body: '{"test":1}',
    });
    const r = await x.gateway.fetch(req, x.env, ctx);
    expect(await r.text()).toBe('{"test":1}');
    const forwarded = x.service.fetch.mock.calls[0][0];
    expect(forwarded.headers.get("Cookie")).toBe(
      "av2_session=12345678-1234-1234-1234-123456789abc",
    );
    expect(forwarded.headers.get("Authorization")).toBeNull();
    expect(forwarded.headers.get("X-Availability-Trial-Token")).toBe(token);
    expect(forwarded.headers.get("X-CSRF-Token")).toBe("csrf");
    expect(x.legacy.fetch.mock.calls[0][0].headers.get("Cookie")).toBe(
      "aoki_admin=valid",
    );
  });
  it("別origin・送信元なし・接続未設定では認証や転送を始めない", async () => {
    const x = setup();
    for (const url of [origin, "https://evil.test"]) {
      const r = await x.gateway.fetch(
        new Request(url + "/api/v2/cases", {
          method: "POST",
          headers: { cookie: "aoki_admin=valid" },
          body: "{}",
        }),
        x.env,
        ctx,
      );
      expect(r.status).toBe(403);
    }
    expect(x.legacy.fetch).not.toHaveBeenCalled();
    expect(x.service.fetch).not.toHaveBeenCalled();
    expect(
      (
        await x.gateway.fetch(
          new Request(origin + "/api/v2/session"),
          { ...x.env, AVAILABILITY_V2_PROXY_TOKEN: "" },
          ctx,
        )
      ).status,
    ).toBe(503);
  });
});
