import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { encryptStream, decryptFile, restore } from '../scripts/backup-tools.mjs';
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const d of directories.splice(0)) await rm(d, { recursive: true, force: true });
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'aoki-backup-unit-'));
  directories.push(path);
  return path;
}
it('encrypts bytes with authenticated encryption and rejects corruption before plaintext can be used', async () => {
  vi.stubEnv('BACKUP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  const path = await directory(),
    original = Buffer.from('private fixture backup bytes');
  const result = await encryptStream(Readable.from([original]), join(path, 'file.enc'));
  expect(result.bytes).toBe(original.length);
  const encrypted = await readFile(join(path, 'file.enc'));
  expect(encrypted.includes(original)).toBe(false);
  await decryptFile(join(path, 'file.enc'), join(path, 'restored'));
  expect(await readFile(join(path, 'restored'))).toEqual(original);
  encrypted[22] ^= 1;
  await writeFile(join(path, 'corrupt.enc'), encrypted);
  await expect(decryptFile(join(path, 'corrupt.enc'), join(path, 'bad'))).rejects.toThrow(
    'authentication',
  );
  await expect(readFile(join(path, 'bad'))).rejects.toThrow();
});
it('rejects missing encryption keys and remote restore destinations before connection or writes', async () => {
  const path = await directory();
  vi.stubEnv('BACKUP_ENCRYPTION_KEY', '');
  await expect(encryptStream(Readable.from(['fixture']), join(path, 'file.enc'))).rejects.toThrow(
    'backup key',
  );
  vi.stubEnv('BACKUP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  vi.stubEnv('RESTORE_DATABASE_URL', 'postgres://fixture@remote.example/production');
  await expect(restore(path)).rejects.toThrow('loopback');
});

it('preserves a zero-byte Storage original', async () => {
  vi.stubEnv('BACKUP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  const path = await directory();
  await encryptStream(Readable.from([]), join(path, 'empty.enc'));
  await decryptFile(join(path, 'empty.enc'), join(path, 'empty'));
  expect(await readFile(join(path, 'empty'))).toEqual(Buffer.alloc(0));
});
