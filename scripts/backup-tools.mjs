// Node-only runner. Database archives and Storage bytes are separate encrypted artifacts.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, open, stat, unlink, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import postgres from 'postgres';

const MAGIC = Buffer.from('AOKIBK01');
function key() {
  const value = process.env.BACKUP_ENCRYPTION_KEY || '';
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== value)
    throw new Error('A canonical base64 32-byte backup key is required');
  return bytes;
}
function endpoint(raw, localOnly = false) {
  const u = new URL(raw);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (localOnly && !local) throw new Error('Restore targets must be loopback-only');
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== '/' ||
    !(u.protocol === 'https:' || (local && u.protocol === 'http:'))
  )
    throw new Error('Expected a clean HTTPS Storage origin (HTTP is local-only)');
  return u.origin;
}
function databaseUrl(raw, localOnly = false) {
  const u = new URL(raw);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (!['postgres:', 'postgresql:'].includes(u.protocol) || !u.pathname.slice(1))
    throw new Error('Invalid database endpoint');
  if (localOnly && !local) throw new Error('Restore database must be loopback-only');
  if (!local && u.searchParams.get('sslmode') && u.searchParams.get('sslmode') !== 'verify-full')
    throw new Error('Remote backups require verify-full TLS');
  return { url: u, local };
}
function dbIdentity(raw) {
  const { url } = databaseUrl(raw);
  // Does not include credentials. Used only to reject same-environment restoration.
  return createHash('sha256')
    .update(`${url.hostname}:${url.port || 5432}${url.pathname}`)
    .digest('hex');
}
function client(raw) {
  const { local } = databaseUrl(raw);
  return postgres(raw, {
    max: 1,
    prepare: false,
    ssl: local ? false : 'verify-full',
    onnotice: () => {},
    connection: { timezone: 'UTC' },
  });
}
function pgEnvironment(raw) {
  const { url: u, local } = databaseUrl(raw);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG')));
  return {
    ...env,
    PGHOST: u.hostname.replace(/^\[|\]$/g, ''),
    PGPORT: u.port || '5432',
    PGDATABASE: decodeURIComponent(u.pathname.slice(1)),
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGSSLMODE: local ? 'disable' : 'verify-full',
    ...(process.env.PGSSLROOTCERT ? { PGSSLROOTCERT: process.env.PGSSLROOTCERT } : {}),
    PGCONNECT_TIMEOUT: '10',
  };
}
function pg(name, args, raw, stdin = 'ignore') {
  const child = spawn(
    process.env.BACKUP_PG_BIN ? join(process.env.BACKUP_PG_BIN, name) : name,
    args,
    {
      env: pgEnvironment(raw),
      stdio: [stdin, 'pipe', 'pipe'],
    },
  );
  // Consume but never echo database diagnostics, which can contain credentials or record contents.
  child.stderr.resume();
  const done = new Promise((res, rej) => {
    child.on('error', () => rej(new Error(`${name} could not start`)));
    child.on('close', (code) => (code === 0 ? res() : rej(new Error(`${name} failed`))));
  });
  return { child, done };
}
export async function encryptStream(stream, path) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(MAGIC);
  const hash = createHash('sha256');
  let bytes = 0;
  const count = new Transform({
    transform(chunk, _, cb) {
      hash.update(chunk);
      bytes += chunk.length;
      cb(null, chunk);
    },
  });
  const out = createWriteStream(path, { flags: 'wx', mode: 0o600 });
  out.write(Buffer.concat([MAGIC, iv]));
  await pipeline(stream, count, cipher, out);
  const file = await open(path, 'a');
  try {
    await file.write(cipher.getAuthTag());
  } finally {
    await file.close();
  }
  return { bytes, sha256: hash.digest('hex') };
}
export async function decryptFile(path, destination) {
  const size = (await stat(path)).size;
  if (size < 36) throw new Error('Invalid encrypted artifact');
  const file = await open(path, 'r');
  const header = Buffer.alloc(20),
    tag = Buffer.alloc(16);
  try {
    await file.read(header, 0, 20, 0);
    await file.read(tag, 0, 16, size - 16);
  } finally {
    await file.close();
  }
  if (!header.subarray(0, 8).equals(MAGIC)) throw new Error('Invalid encrypted artifact');
  const decipher = createDecipheriv('aes-256-gcm', key(), header.subarray(8));
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(tag);
  try {
    await pipeline(
      size === 36 ? Readable.from([]) : createReadStream(path, { start: 20, end: size - 17 }),
      decipher,
      createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
    );
  } catch {
    await unlink(destination).catch(() => {});
    throw new Error('Backup authentication failed');
  }
}
async function request(origin, token, path, options = {}) {
  if (!token) throw new Error('Storage server credential is required');
  const response = await fetch(`${origin}/storage/v1${path}`, {
    ...options,
    redirect: 'error',
    signal: AbortSignal.timeout(120000),
    headers: { Authorization: `Bearer ${token}`, apikey: token, ...options.headers },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Storage operation failed');
  }
  return response;
}
const encoded = (value) => value.split('/').map(encodeURIComponent).join('/');
async function inventory(origin, token) {
  const buckets = await (await request(origin, token, '/bucket')).json();
  const result = [];
  for (const bucket of [...buckets].sort((a, b) => a.id.localeCompare(b.id))) {
    const objects = [];
    const visit = async (prefix) => {
      for (let offset = 0; ; offset += 1000) {
        const rows = await (
          await request(origin, token, `/object/list/${encoded(bucket.id)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prefix,
              limit: 1000,
              offset,
              sortBy: { column: 'name', order: 'asc' },
            }),
          })
        ).json();
        if (!Array.isArray(rows)) throw new Error('Invalid Storage inventory');
        for (const row of rows) {
          const path = prefix ? `${prefix}/${row.name}` : row.name;
          if (row.id === null) await visit(path);
          else
            objects.push({ path, id: row.id, updated_at: row.updated_at, metadata: row.metadata });
        }
        if (rows.length < 1000) break;
      }
    };
    await visit('');
    result.push({
      id: bucket.id,
      name: bucket.name,
      public: bucket.public,
      file_size_limit: bucket.file_size_limit,
      allowed_mime_types: bucket.allowed_mime_types,
      objects: objects.sort((a, b) => a.path.localeCompare(b.path)),
    });
  }
  return result;
}
async function tableChecks(sql) {
  const tables =
    await sql`SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('app_private','app_migrations') ORDER BY schemaname,tablename`;
  const checks = [];
  for (const { schemaname, tablename } of tables) {
    const [check] =
      await sql`SELECT count(*)::text AS rows,md5(COALESCE(string_agg(md5(row_to_json(t)::text),'' ORDER BY row_to_json(t)::text),'')) AS digest FROM ${sql(`${schemaname}.${tablename}`)} t`;
    checks.push({ schema: schemaname, table: tablename, ...check });
  }
  return checks;
}
export async function backup(directory) {
  key();
  const database = process.env.BACKUP_DATABASE_URL;
  const origin = endpoint(process.env.BACKUP_STORAGE_URL);
  const token = process.env.BACKUP_STORAGE_KEY;
  databaseUrl(database);
  // Never reuse a directory or write an apparently complete manifest after partial failure.
  await mkdir(directory, { mode: 0o700 });
  const before = await inventory(origin, token);
  const sql = client(database);
  try {
    const { checks, archive } = await sql.begin(async (tx) => {
      await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
      const [{ snapshot }] = await tx`SELECT pg_export_snapshot() AS snapshot`;
      const dump = pg(
        'pg_dump',
        [
          '--format=custom',
          '--no-owner',
          '--no-acl',
          '--schema=app_private',
          '--schema=app_migrations',
          `--snapshot=${snapshot}`,
        ],
        database,
      );
      const [archive] = await Promise.all([
        encryptStream(dump.child.stdout, join(directory, 'database.enc')),
        dump.done,
      ]);
      return { checks: await tableChecks(tx), archive };
    });
    let index = 0;
    const storage = [];
    for (const bucket of before) {
      const objects = [];
      for (const object of bucket.objects) {
        const response = await request(
          origin,
          token,
          `/object/authenticated/${encoded(bucket.id)}/${encoded(object.path)}`,
        );
        const file = `object-${index++}.enc`;
        const integrity = await encryptStream(
          Readable.fromWeb(response.body),
          join(directory, file),
        );
        objects.push({
          path: object.path,
          file,
          contentType: object.metadata?.mimetype || 'application/octet-stream',
          ...integrity,
        });
      }
      const { objects: _, ...settings } = bucket;
      storage.push({ ...settings, objects });
    }
    if (JSON.stringify(before) !== JSON.stringify(await inventory(origin, token)))
      throw new Error('Storage changed during backup; stop writes and retry');
    const manifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      source: dbIdentity(database),
      storageSource: origin,
      schemas: ['app_private', 'app_migrations'],
      database: { file: 'database.enc', ...archive },
      checks,
      storage,
    };
    await encryptStream(Readable.from([JSON.stringify(manifest)]), join(directory, 'manifest.enc'));
    return { tables: checks.length, objects: index, storageBuckets: storage.length };
  } finally {
    await sql.end();
  }
}
async function checkedFile(directory, artifact, temp) {
  // Manifest paths are untrusted even after decryption. Never traverse outside the backup.
  if (!/^(database|object-\d+)\.enc$/.test(artifact.file)) throw new Error('Invalid artifact path');
  const path = join(temp, artifact.file + '.plain');
  await decryptFile(join(directory, artifact.file), path);
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  if (bytes !== artifact.bytes || hash.digest('hex') !== artifact.sha256)
    throw new Error('Artifact checksum mismatch');
  return path;
}
export async function restore(directory) {
  key();
  const target = process.env.RESTORE_DATABASE_URL;
  databaseUrl(target, true);
  const origin = endpoint(process.env.RESTORE_STORAGE_URL, true);
  const token = process.env.RESTORE_STORAGE_KEY;
  const temp = await mkdtemp(join(tmpdir(), 'aoki-restore-'));
  const sql = client(target);
  try {
    await decryptFile(join(directory, 'manifest.enc'), join(temp, 'manifest.json'));
    const manifest = JSON.parse(await readFile(join(temp, 'manifest.json'), 'utf8'));
    if (
      manifest.version !== 1 ||
      manifest.source === dbIdentity(target) ||
      manifest.storageSource === origin
    )
      throw new Error('Restore requires a distinct database AND Storage service');
    const existing =
      await sql`SELECT 1 FROM pg_namespace WHERE nspname IN ('app_private','app_migrations') LIMIT 1`;
    if (existing.length || (await inventory(origin, token)).length)
      throw new Error('Restore target must be empty');
    // Authenticate and checksum ALL artifacts before any SQL or Storage write.
    const archive = await checkedFile(directory, manifest.database, temp);
    const files = [];
    for (const bucket of manifest.storage)
      for (const object of bucket.objects)
        files.push({ bucket, object, path: await checkedFile(directory, object, temp) });
    await sql`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='aoki_app') THEN CREATE ROLE aoki_app NOLOGIN NOBYPASSRLS; END IF; END $$`;
    const restore = pg(
      'pg_restore',
      [
        '--single-transaction',
        '--exit-on-error',
        '--no-owner',
        '--no-acl',
        '--dbname',
        decodeURIComponent(new URL(target).pathname.slice(1)),
        archive,
      ],
      target,
    );
    restore.child.stdout.resume();
    await restore.done;
    const restored = await tableChecks(sql);
    if (JSON.stringify(restored) !== JSON.stringify(manifest.checks))
      throw new Error('Restored database differs from snapshot');
    await sql`GRANT USAGE ON SCHEMA app_private TO aoki_app`;
    await sql`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA app_private TO aoki_app`;
    await sql`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA app_private TO aoki_app`;
    for (const bucket of manifest.storage) {
      await request(origin, token, '/bucket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: bucket.id,
          name: bucket.name,
          public: bucket.public,
          file_size_limit: bucket.file_size_limit,
          allowed_mime_types: bucket.allowed_mime_types,
        }),
      });
    }
    for (const { bucket, object, path } of files) {
      await request(origin, token, `/object/${encoded(bucket.id)}/${encoded(object.path)}`, {
        method: 'POST',
        headers: { 'Content-Type': object.contentType, 'x-upsert': 'false' },
        body: createReadStream(path),
        duplex: 'half',
      });
      const response = await request(
        origin,
        token,
        `/object/authenticated/${encoded(bucket.id)}/${encoded(object.path)}`,
      );
      const hash = createHash('sha256');
      let bytes = 0;
      for await (const chunk of Readable.fromWeb(response.body)) {
        hash.update(chunk);
        bytes += chunk.length;
      }
      if (bytes !== object.bytes || hash.digest('hex') !== object.sha256)
        throw new Error('Restored Storage bytes differ');
    }
    const actual = await inventory(origin, token);
    if (actual.reduce((n, b) => n + b.objects.length, 0) !== files.length)
      throw new Error('Restored Storage inventory differs');
    await writeFile(
      join(directory, 'restore-verification.json'),
      JSON.stringify({
        verifiedAt: new Date().toISOString(),
        tables: restored.length,
        objects: files.length,
      }),
      { mode: 0o600 },
    );
    return {
      tables: restored.length,
      objects: files.length,
      storageBuckets: manifest.storage.length,
    };
  } finally {
    await sql.end();
    await rm(temp, { recursive: true, force: true });
  }
}
