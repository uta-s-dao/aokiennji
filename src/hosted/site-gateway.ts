type Context = { waitUntil(promise: Promise<unknown>): void };
type GatewayEnv = Record<string, unknown> & {
  APP_ORIGIN?: string;
  AVAILABILITY_V2?: { fetch(request: Request): Promise<Response> };
  AVAILABILITY_V2_PROXY_TOKEN?: string;
};
type Legacy = {
  fetch(request: Request, env: GatewayEnv, ctx: Context): Promise<Response>;
  [name: string]: unknown;
};
const relevant = (path: string) =>
  path === "/availability-v2" ||
  path.startsWith("/availability-v2/") ||
  path === "/api/v2" ||
  path.startsWith("/api/v2/");
const error = (status: number, message: string) =>
  Response.json(
    { error: "TRIAL_ACCESS", message },
    {
      status,
      headers: {
        "Cache-Control": "private, no-store",
        "X-Robots-Tag": "noindex, nofollow",
      },
    },
  );

function loginRequired(request: Request, status = 401) {
  if (
    request.method === "GET" &&
    new URL(request.url).pathname.startsWith("/availability-v2")
  )
    return new Response(
      '<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>管理者向け試用</title><main><h1>管理者ログインが必要です</h1><p><a href="/admin">既存サイトの管理者画面でログイン</a>した後、この試用ページを開き直してください。</p></main></html>',
      {
        status,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "private, no-store",
          "X-Robots-Tag": "noindex, nofollow",
          "Content-Security-Policy":
            "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        },
      },
    );
  return error(status, "管理者ログインを確認してください。");
}

// Added around the exact deployed entry; existing handlers and routes pass
// through unchanged. Authorization uses the deployed application's own session
// validation, including password changes, session expiry and logout revocation.
export function createTrialGateway<T extends Legacy>(legacy: T) {
  return {
    ...legacy,
    async fetch(request: Request, env: GatewayEnv, ctx: Context) {
      const url = new URL(request.url);
      if (!relevant(url.pathname)) return legacy.fetch(request, env, ctx);
      if (!env.APP_ORIGIN || url.origin !== env.APP_ORIGIN)
        return error(403, "送信先を確認してください。");
      if (
        !["GET", "HEAD"].includes(request.method) &&
        request.headers.get("Origin") !== env.APP_ORIGIN
      )
        return error(403, "不正な送信元です。");
      if (
        !env.AVAILABILITY_V2 ||
        !env.AVAILABILITY_V2_PROXY_TOKEN ||
        env.AVAILABILITY_V2_PROXY_TOKEN.length < 32
      )
        return error(503, "試用環境への接続を準備しています。");
      const authHeaders = new Headers();
      const admin = request.headers
        .get("Cookie")
        ?.match(/(?:^|;\s*)aoki_admin=([^;]+)/)?.[1];
      if (!admin) return loginRequired(request);
      authHeaders.set("Cookie", "aoki_admin=" + admin);
      authHeaders.set("Accept", "application/json");
      const auth = await legacy.fetch(
        new Request(new URL("/api/admin/settings", url), {
          headers: authHeaders,
        }),
        env,
        ctx,
      );
      const authType = auth.headers.get("Content-Type");
      const authText = await auth.text();
      if (!auth.ok || !authType?.includes("application/json"))
        return loginRequired(request, auth.status >= 500 ? 503 : 401);
      try {
        const body = JSON.parse(authText);
        if (!body.data || typeof body.data !== "object" || !body.data.flags)
          return loginRequired(request);
      } catch {
        return loginRequired(request);
      }
      if (url.pathname === "/availability-v2")
        return new Response(null, {
          status: 302,
          headers: {
            Location: "/availability-v2/",
            "Cache-Control": "no-store",
          },
        });
      const headers = new Headers();
      for (const key of [
        "Accept",
        "Content-Type",
        "Content-Length",
        "Origin",
        "X-CSRF-Token",
        "Idempotency-Key",
      ]) {
        const value = request.headers.get(key);
        if (value !== null) headers.set(key, value);
      }
      const trialCookie = request.headers
        .get("Cookie")
        ?.match(/(?:^|;\s*)av2_session=([A-Za-z0-9-]{36})/)?.[1];
      if (trialCookie) headers.set("Cookie", "av2_session=" + trialCookie);
      headers.set(
        "X-Availability-Trial-Token",
        env.AVAILABILITY_V2_PROXY_TOKEN,
      );
      return env.AVAILABILITY_V2.fetch(
        new Request(request.url, {
          method: request.method,
          headers,
          body: ["GET", "HEAD"].includes(request.method)
            ? undefined
            : request.body,
          redirect: "manual",
          signal: request.signal,
          duplex: "half",
        } as RequestInit),
      );
    },
  };
}
