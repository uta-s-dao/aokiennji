// Local-only lifecycle commands. Raw CLI output includes keys: keep it private.
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const action = process.argv[2];
if (!["start", "status", "stop"].includes(action) || process.argv.length !== 3) {
  console.error("Usage: node scripts/supabase-local.mjs start|status|stop");
  process.exit(1);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const privateDir = join(homedir(), ".config/aokiennji/secrets");
mkdirSync(privateDir, { recursive: true, mode: 0o700 });
chmodSync(privateDir, 0o700);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("SUPABASE_")));
env.SUPABASE_EXPERIMENTAL_STACK = "1";
const command = process.platform === "win32" ? "npx.cmd" : "npx";
const args = ["--yes", "supabase@2.121.0", action];
if (action === "start") args.push("--runtime", "native", "--preparation", "on-demand");
if (action === "status") args.push("--output-format", "json");
const logPath = join(privateDir, `supabase-local-${action}.${action === "status" ? "json" : "log"}`);
const fd = openSync(logPath, "w", 0o600);
chmodSync(logPath, 0o600);
const result = spawnSync(command, args, {
  cwd: root,
  env,
  encoding: "utf8",
  stdio: action === "status" ? ["ignore", "pipe", fd] : ["ignore", fd, fd],
  maxBuffer: 8 * 1024 * 1024,
});
closeSync(fd);
if (result.error || result.status !== 0) {
  console.error(`Local ${action} failed; inspect the private log: ${logPath}`);
  process.exit(1);
}
if (action === "status") {
  const status = JSON.parse(result.stdout);
  writeFileSync(logPath, result.stdout, { mode: 0o600 });
  for (const endpoint of Object.values(status.endpoints)) {
    if (endpoint.address !== "127.0.0.1" && endpoint.address !== "::1") {
      throw new Error("Unexpected non-loopback endpoint; inspect local configuration");
    }
  }
  console.log(JSON.stringify({
    runtime: status.runtime,
    lifecycle: status.lifecycle,
    apiUrl: status.env.API_URL,
    studioUrl: status.env.STUDIO_URL,
    mailpitUrl: status.env.MAILPIT_URL,
    secretFile: logPath,
  }, null, 2));
} else {
  console.log(`Local ${action} completed. Run this helper with status to see endpoints.`);
}
