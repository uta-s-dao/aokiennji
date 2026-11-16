import { spawn } from "node:child_process";
const child = spawn(
  "node_modules/.bin/wrangler",
  ["dev", "--local", "--ip", "127.0.0.1", "--port", "8787"],
  { stdio: "inherit", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
);
let inFlight = false;
// Wrangler does not automatically run cron locally. Drive the documented local-only scheduler.
const timer = setInterval(async () => {
  if (inFlight) return;
  inFlight = true;
  try {
    await fetch("http://127.0.0.1:8787/cdn-cgi/local/scheduled", {
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    /* Startup or shutdown; the next local tick retries. */
  } finally {
    inFlight = false;
  }
}, 5000);
for (const sig of ["SIGINT", "SIGTERM"])
  process.on(sig, () => {
    clearInterval(timer);
    child.kill(sig);
  });
child.on("exit", (code) => {
  clearInterval(timer);
  process.exitCode = code ?? 0;
});
