import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { GET } from '../app/api/[...path]/route';
import { parseUpload } from '../lib/server/connectors';

// Reproduce the deployment's PDF module failure without requiring Vercel.
vi.mock('unpdf', () => {
  throw new ReferenceError('DOMMatrix is not defined');
});

const directory = mkdtempSync(join(tmpdir(), 'aoki-pdf-runtime-'));
beforeAll(() => {
  vi.stubEnv('DATA_DIR', directory);
  vi.stubEnv('DEMO_MODE', 'true');
});
afterAll(async () => {
  const { db } = await import('../lib/server/db');
  await db().close();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

it('serves configuration and checks admin authentication when the PDF module cannot load', async () => {
  const config = await GET(new NextRequest('http://localhost/api/config'), {
    params: Promise.resolve({ path: ['config'] }),
  });
  expect(config.status).toBe(200);
  expect((await config.json()).data.demoMode).toBe(true);

  const admin = await GET(new NextRequest('http://localhost/api/admin/overview'), {
    params: Promise.resolve({ path: ['admin', 'overview'] }),
  });
  expect(admin.status).toBe(401);
  expect((await admin.json()).error.code).toBe('unauthorized');
});

it('limits a PDF load failure to that import and continues parsing CSV files', async () => {
  await expect(
    parseUpload('catalog.pdf', readFileSync('tests/fixtures/catalog.pdf')),
  ).rejects.toThrow();

  const csv = await parseUpload('catalog.csv', Buffer.from('商品名,型番\n部品,ABC-123'));
  expect(csv.rows).toEqual([{ 商品名: '部品', 型番: 'ABC-123' }]);
});
