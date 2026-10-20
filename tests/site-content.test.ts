import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { NextRequest, NextResponse } from 'next/server';
import {
  getSiteEditor,
  getPublishedSiteContent,
  publishSiteDraft,
  readSiteImage,
  saveSiteDraft,
  uploadSiteImage,
  siteContentSchema,
} from '../lib/server/site-content';
import { resetDbForTests } from '../lib/server/db';
import { setSession } from '../lib/server/auth';
import {
  siteEditorRequest,
  siteImageUpload,
  siteImageResponse,
} from '../lib/server/site-content-http';

let directory: string;
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'aoki-site-content-'));
  vi.stubEnv('DATA_DIR', directory);
  vi.stubEnv('DEMO_MODE', 'false');
  vi.stubEnv('SESSION_SECRET', 'cms-test-session-secret-of-at-least-32-characters');
  vi.stubEnv('APP_ORIGIN', 'http://localhost');
  vi.stubEnv('VERCEL', '');
  (await resetDbForTests());
});
afterEach(async () => {
  (await resetDbForTests());
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

it('persists drafts separately and publishes only visible entries across database reopen', async () => {
  const initial = (await getSiteEditor());
  const originalTitle = initial.draft.home.title;
  initial.draft.home.title = '下書きの新しい見出し';
  initial.draft.news = [
    {
      id: crypto.randomUUID(),
      title: '公開するお知らせ',
      body: '公開本文',
      date: '2026-10-20',
      published: true,
    },
    {
      id: crypto.randomUUID(),
      title: '非公開のお知らせ',
      body: '社内本文',
      date: '2026-10-21',
      published: false,
    },
  ];
  initial.draft.projects[0].published = false;
  const draft = (await saveSiteDraft(initial.draft, initial.revision));
  expect((await getPublishedSiteContent()).home.title).toBe(originalTitle);
  expect((await getPublishedSiteContent()).news).toHaveLength(0);
  (await resetDbForTests());
  expect((await getSiteEditor()).draft.home.title).toBe('下書きの新しい見出し');
  const result = (await publishSiteDraft(draft.revision));
  expect(result.hasUnpublishedChanges).toBe(false);
  expect(result.publishedAt).toBeTruthy();
  (await resetDbForTests());
  expect((await getPublishedSiteContent()).home.title).toBe('下書きの新しい見出し');
  expect((await getPublishedSiteContent()).news.map((n) => n.title)).toEqual(['公開するお知らせ']);
  expect(
    (await getPublishedSiteContent()).projects.some((p) => p.id === initial.draft.projects[0].id),
  ).toBe(false);
});

it('rejects stale saves and stale publication without overwriting the newer draft', async () => {
  const state = (await getSiteEditor());
  const saved = (await saveSiteDraft({ ...state.draft, news: [] }, state.revision));
  await expect(async () => (await saveSiteDraft(state.draft, state.revision))).rejects.toThrow('他の画面');
  await expect(async () => (await publishSiteDraft(state.revision))).rejects.toThrow('下書きが更新');
  expect((await getSiteEditor()).revision).toBe(saved.revision);
});

it('rejects external or missing images, duplicate IDs, invalid dates and oversized text', async () => {
  const state = (await getSiteEditor());
  for (const image of [
    'https://example.com/a.jpg',
    '//example.com/a.jpg',
    '/images/../secret.png',
    '/images/missing.jpg',
    '/api/site-content/images/00000000-0000-0000-0000-000000000000',
  ]) {
    const content = structuredClone(state.draft);
    content.home.slides[0].image = image;
    await expect(async () => (await saveSiteDraft(content, state.revision))).rejects.toThrow();
  }
  const content = structuredClone(state.draft);
  content.projects.push(content.projects[0]);
  expect(siteContentSchema.safeParse(content).success).toBe(false);
  content.projects.pop();
  content.news = [
    { id: crypto.randomUUID(), title: '日付', body: '本文', date: '2026-02-30', published: true },
  ];
  expect(siteContentSchema.safeParse(content).success).toBe(false);
  content.news = [];
  content.home.title = '長'.repeat(101);
  expect(siteContentSchema.safeParse(content).success).toBe(false);
});

it('decodes photos and publishes only images used in visible published content', async () => {
  const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#1d7374' } })
    .png()
    .toBuffer();
  const image = await uploadSiteImage(png);
  const id = image.url.split('/').at(-1)!;
  expect((await readSiteImage(id))).toBeNull();
  expect((await sharp((await readSiteImage(id, true))!).metadata()).format).toBe('webp');
  const state = (await getSiteEditor());
  state.draft.projects[0].image = image.url;
  state.draft.projects[0].published = false;
  let draft = (await saveSiteDraft(state.draft, state.revision));
  draft = (await publishSiteDraft(draft.revision));
  expect((await readSiteImage(id))).toBeNull();
  draft.draft.projects[0].published = true;
  draft = (await saveSiteDraft(draft.draft, draft.revision));
  expect((await readSiteImage(id))).toBeNull();
  draft = (await publishSiteDraft(draft.revision));
  expect((await readSiteImage(id))).not.toBeNull();
  draft.draft.projects[0].published = false;
  draft = (await saveSiteDraft(draft.draft, draft.revision));
  (await publishSiteDraft(draft.revision));
  expect((await readSiteImage(id))).toBeNull();
});

it('rejects disguised SVG, corrupt photos and excessive upload bytes', async () => {
  for (const input of [
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    Buffer.from('not a jpeg'),
  ])
    await expect(((uploadSiteImage(input)))).rejects.toMatchObject({ status: 400 });
  await expect(((uploadSiteImage(Buffer.alloc(5 * 1024 * 1024 + 1))))).rejects.toMatchObject({
    status: 413,
  });
});

async function adminCookie() {
  const response = NextResponse.json({});
  (await setSession(response, 'admin'));
  return response.cookies
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

it('requires administrator auth for drafts, updates and private photos, including uploads', async () => {
  for (const method of ['GET', 'PUT', 'POST']) {
    const result = await siteEditorRequest(
      new NextRequest('http://localhost/api/admin/site-content', {
        method,
        headers: { Origin: 'http://localhost' },
      }),
    );
    expect(result.status).toBe(401);
  }
  expect(
    (
      await siteImageUpload(
        new NextRequest('http://localhost/api/admin/site-content/images', { method: 'POST' }),
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await siteImageResponse(
        new NextRequest('http://localhost/api/admin/site-content/images/id'),
        'id',
        true,
      )
    ).status,
  ).toBe(401);
});

it('rejects CSRF and invalid JSON and validates all writes on the server', async () => {
  const cookie = (await adminCookie());
  const state = (await getSiteEditor());
  const request = (body: string, origin = 'http://localhost') =>
    new NextRequest('http://localhost/api/admin/site-content', {
      method: 'PUT',
      headers: { Cookie: cookie, Origin: origin },
      body,
    });
  expect(
    (
      await siteEditorRequest(
        request(
          JSON.stringify({ revision: state.revision, content: state.draft }),
          'https://evil.example',
        ),
      )
    ).status,
  ).toBe(403);
  expect((await siteEditorRequest(request('{bad'))).status).toBe(400);
  expect(
    (await siteEditorRequest(request(JSON.stringify({ revision: 0, content: {} })))).status,
  ).toBe(400);
  expect((await siteEditorRequest(request('a'.repeat(1024 * 1024 + 1)))).status).toBe(413);
  expect((await getSiteEditor()).revision).toBe(state.revision);
  const accepted = await siteEditorRequest(
    request(JSON.stringify({ revision: state.revision, content: state.draft })),
  );
  expect(accepted.status).toBe(200);
});
