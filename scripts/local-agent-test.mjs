import nextEnv from '@next/env';
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';

nextEnv.loadEnvConfig(process.cwd(), true);
const enableSourcing = process.env.LOCAL_AGENT_ENABLE_SOURCING === 'true';
if (enableSourcing && (!process.env.OPENAI_API_KEY || !process.env.TYPESAFE_API_KEY))
  throw Error('Sourcing mode requires OPENAI_API_KEY and TYPESAFE_API_KEY');
const apiPort = Number(process.env.LOCAL_AGENT_PORT || 4010);
const appPort = Number(process.env.LOCAL_AGENT_APP_PORT || 3212);
for (const port of [apiPort, appPort]) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw Error('Invalid local test port');
  const available = await new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
  if (!available)
    throw Error(
      `Port ${port} is already in use. Use the running test site or stop its terminal first.`,
    );
}
const root = resolve('.data/verification/agent-api');
const dataDir = join(root, 'sandbox');
mkdirSync(dataDir, { recursive: true });
const originalFile = resolve('.data/aokienji.sqlite');
if (!existsSync(originalFile)) throw Error('The migrated source database is required');
const originalHash = createHash('sha256').update(readFileSync(originalFile)).digest('hex');
const target = join(dataDir, 'aokienji.sqlite');
if (!existsSync(target)) {
  const original = new Database(originalFile, { readonly: true, fileMustExist: true });
  await original.backup(target);
  original.close();
}
const sourceStat = statSync(originalFile),
  targetStat = statSync(target);
if (sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino)
  throw Error('The test database must be a separate copy of the migrated database');
const db = new Database(target, { fileMustExist: true });
const settings = JSON.parse(db.prepare('SELECT json FROM settings WHERE id=1').get().json);
Object.assign(settings, {
  decisionProvider: enableSourcing ? 'jev' : 'local',
  responseProvider: 'openai',
  responseModel: 'local-agent',
  searchProvider: enableSourcing ? 'openai' : 'none',
});
settings.flags = {
  ...settings.flags,
  webSearch: enableSourcing,
  aiResearch: false,
  orders: false,
  autoOrder: false,
  autoQuote: false,
};
db.prepare('UPDATE settings SET json=? WHERE id=1').run(JSON.stringify(settings));
db.close();
const privateDir = mkdtempSync(join(tmpdir(), 'aoki-agent-api-'));
const tokenFile = join(privateDir, 'token');
writeFileSync(tokenFile, randomBytes(32).toString('base64url'), { mode: 0o600 });
const env = {
  ...process.env,
  NODE_ENV: 'development',
  DATA_DIR: dataDir,
  NEXT_DIST_DIR: '.next-live-ai',
  APP_ORIGIN: `http://localhost:${appPort}`,
  DEMO_MODE: 'true',
  ALLOW_LIVE_ORDERS: 'false',
  LOCAL_AGENT_API_URL: `http://127.0.0.1:${apiPort}/v1/responses`,
  LOCAL_AGENT_API_TOKEN_FILE: tokenFile,
  LOCAL_AGENT_PORT: String(apiPort),
  LOCAL_AGENT_WORKSPACE: join(privateDir, 'workspace'),
  OPENAI_API_KEY: enableSourcing ? process.env.OPENAI_API_KEY : 'local-agent-placeholder',
  OPENAI_MODEL: 'local-agent',
  TYPESAFE_API_KEY: enableSourcing ? process.env.TYPESAFE_API_KEY : '',
  GEMINI_API_KEY: '',
  EXA_API_KEY: '',
  TAVILY_API_KEY: '',
  VERCEL_OIDC_TOKEN: '',
};
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stop());
const api = spawn(process.execPath, ['scripts/agent-openai-server.mjs'], { env, stdio: 'inherit' });
children.push(api);
api.on('exit', (code) => stop(code || 0));
let ready = false;
for (let n = 0; n < 60; n++) {
  if (stopping) break;
  try {
    ready = (await fetch(`http://127.0.0.1:${apiPort}/health`)).ok;
  } catch {}
  if (ready) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (!ready) {
  stop(1);
  throw Error('The dedicated Codex responder did not become ready');
}
const app = spawn(
  process.execPath,
  ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(appPort)],
  { env, stdio: 'inherit' },
);
children.push(app);
app.on('exit', (code) => stop(code || 0));
writeFileSync(
  join(root, 'runtime.json'),
  JSON.stringify(
    {
      startedAt: new Date().toISOString(),
      appURL: `http://localhost:${appPort}`,
      apiURL: env.LOCAL_AGENT_API_URL,
      tokenFile,
      dataDir,
      pids: { launcher: process.pid, api: api.pid, app: app.pid },
      originalHash,
      backend: 'one Codex app-server, serialized requests, isolated ephemeral request contexts',
      realOpenaiApi: enableSourcing,
      sourcing: enableSourcing,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(
  `Conversation test site: http://localhost:${appPort} — copied DB, local response agent, ${enableSourcing ? 'real Jev and product web search enabled' : 'external APIs disabled'}, real orders disabled`,
);
