import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

// Separate cwd, bindings, port and storage. Never read the normal preview's .dev.vars.
const root = process.cwd();
const directory = path.resolve(".wrangler/e2e");
await mkdir(directory, { recursive: true });
const config = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
delete config.$schema;
config.main = path.join(root, "src/worker.ts");
config.assets.directory = path.join(root, "dist/ui");
config.d1_databases[0].migrations_dir = path.join(root, "migrations");
config.vars = {
  ...config.vars,
  INTAKE_PROVIDER: "demo",
  EXTERNAL_ENABLED: "false",
  INTAKE_MODEL: "disabled",
};
await writeFile(path.join(directory, "wrangler.json"), JSON.stringify(config));
const command = path.join(root, "node_modules/.bin/wrangler");
const env = { ...process.env, WRANGLER_SEND_METRICS: "false" };
delete env.OPENAI_API_KEY;
const migration = spawn(
  command,
  ["d1", "migrations", "apply", "availability-local", "--local"],
  { cwd: directory, env, stdio: "inherit" },
);
const migrated = await new Promise((resolve) => migration.on("exit", resolve));
if (migrated !== 0) throw new Error("E2E_MIGRATION_FAILED");
const child = spawn(
  command,
  ["dev", "--local", "--ip", "127.0.0.1", "--port", "8788"],
  { cwd: directory, env, stdio: "inherit" },
);
let inFlight = false;
const timer = setInterval(async () => {
  if (inFlight) return;
  inFlight = true;
  try {
    await fetch("http://127.0.0.1:8788/cdn-cgi/local/scheduled", {
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    /* Startup/shutdown. */
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
