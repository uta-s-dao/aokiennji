export async function localClient() {
  const origin = process.env.LOCAL_ORIGIN ?? "http://127.0.0.1:8787";
  const u = new URL(origin);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname))
    throw new Error("loopback only");
  const s = await fetch(origin + "/api/v2/session"),
    data = await s.json();
  const cookie = s.headers.get("set-cookie").split(";")[0];
  return async (path, body) => {
    const r = await fetch(origin + "/api/v2" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Cookie: cookie,
        Origin: origin,
        "X-CSRF-Token": data.csrf,
        "X-Local-Admin-Token":
          process.env.LOCAL_ADMIN_TOKEN ?? "availability-local-admin",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const b = await r.json();
    if (!r.ok) throw new Error(b.message ?? b.error);
    return b;
  };
}
