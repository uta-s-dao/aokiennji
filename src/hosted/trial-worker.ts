import localWorker from "../worker";
import type { Env } from "../adapters/store";

export type TrialEnv = Env & {
  TRIAL_ORIGIN: string;
  TRIAL_PROXY_TOKEN: string;
};
const apiPath = (path: string) =>
  path === "/api/v2" || path.startsWith("/api/v2/");
const trialPath = (path: string) =>
  path === "/availability-v2/" || path.startsWith("/availability-v2/");
const deny = (status: number) =>
  Response.json(
    {
      error: "TRIAL_UNAVAILABLE",
      message: "管理者向け試用への接続を確認してください。",
    },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex, nofollow",
      },
    },
  );
async function validToken(actual: string | null, expected: string) {
  if (!actual || !expected || expected.length < 32) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all(
    [actual, expected].map((v) =>
      crypto.subtle.digest("SHA-256", enc.encode(v)),
    ),
  );
  const aa = new Uint8Array(a),
    bb = new Uint8Array(b);
  let difference = 0;
  for (let n = 0; n < aa.length; n++) difference |= aa[n] ^ bb[n];
  return difference === 0;
}

// This entry is private (no routes, workers.dev or version URLs). Only the
// authenticated production gateway receives its dedicated service binding.
export default {
  async fetch(request: Request, env: TrialEnv, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (
      env.APP_MODE !== "hosted-trial" ||
      env.INTAKE_PROVIDER !== "demo" ||
      env.EXTERNAL_ENABLED !== "false" ||
      url.origin !== env.TRIAL_ORIGIN ||
      !(await validToken(
        request.headers.get("X-Availability-Trial-Token"),
        env.TRIAL_PROXY_TOKEN,
      ))
    )
      return deny(403);
    if (!apiPath(url.pathname) && !trialPath(url.pathname)) return deny(404);
    if (
      url.pathname === "/api/v2/admin" ||
      url.pathname.startsWith("/api/v2/admin/")
    )
      return deny(403);
    if (
      !["GET", "HEAD"].includes(request.method) &&
      request.headers.get("Origin") !== env.TRIAL_ORIGIN
    )
      return deny(403);
    const internal = new URL(request.url);
    internal.protocol = "https:";
    internal.hostname = "localhost";
    internal.port = "";
    if (!apiPath(url.pathname))
      internal.pathname = url.pathname.slice("/availability-v2".length) || "/";
    if (!apiPath(url.pathname) && internal.pathname.startsWith("/api/"))
      return deny(404);
    const headers = new Headers(request.headers);
    headers.delete("X-Availability-Trial-Token");
    if (!["GET", "HEAD"].includes(request.method))
      headers.set("Origin", internal.origin);
    const req = new Request(internal, {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
      redirect: "manual",
      signal: request.signal,
      duplex: "half",
    } as RequestInit);
    // Reuse the unchanged local engine only after the private gateway check.
    // Never supply an AI key or the local administrator token to hosted requests.
    const safe: Env = {
      ...env,
      APP_MODE: "local-demo",
      LOCAL_ADMIN_TOKEN: "",
      INTAKE_PROVIDER: "demo",
      INTAKE_MODEL: "disabled",
      OPENAI_API_KEY: undefined,
      EXTERNAL_ENABLED: "false",
      RESEARCH_MODEL: "disabled",
    };
    let response = await localWorker.fetch(req, safe, ctx);
    if (
      url.pathname === "/api/v2/session" &&
      request.method === "GET" &&
      response.ok
    ) {
      const data = (await response.json()) as Record<string, unknown>;
      response = new Response(
        JSON.stringify({ ...data, mode: "hosted-trial" }),
        response,
      );
    }
    const out = new Headers(response.headers);
    out.set("Cache-Control", "private, no-store");
    out.set("X-Robots-Tag", "noindex, nofollow, noarchive");
    const cookie = out.get("Set-Cookie");
    if (cookie)
      out.set("Set-Cookie", cookie.replace("Path=/;", "Path=/api/v2;"));
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: out,
    });
  },
  queue: localWorker.queue,
  scheduled: localWorker.scheduled,
};
