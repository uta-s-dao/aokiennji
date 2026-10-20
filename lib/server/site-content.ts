import sharp from 'sharp';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_SITE_CONTENT,
  siteImageReferences,
  visibleSiteContent,
  type SiteContent,
  type SiteEditorState,
} from '../site-content';
import { db, audit, now, uid } from './db';
import { ApiError } from './auth';

const assetPrefix = '/api/site-content/images/';
const localImage = z
  .string()
  .max(220)
  .regex(
    /^\/(?:images\/[a-zA-Z0-9_/-]+\.(?:jpg|jpeg|png|webp)|api\/site-content\/images\/[a-f0-9-]{36})$/,
  );
const text = (max: number) => z.string().trim().min(1).max(max);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === s;
  }, '日付を確認してください');
export const siteContentSchema = z
  .object({
    home: z
      .object({
        title: text(100),
        subtitle: text(100),
        lead: text(600),
        introduction: text(1000),
        slides: z.array(z.object({ image: localImage, label: text(100) }).strict()).length(3),
      })
      .strict(),
    news: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            title: text(120),
            date,
            body: text(3000),
            published: z.boolean(),
          })
          .strict(),
      )
      .max(100),
    projects: z
      .array(
        z
          .object({
            id: text(100).regex(/^[a-zA-Z0-9-]+$/),
            name: text(120),
            category: text(60),
            image: localImage,
            description: text(1500),
            published: z.boolean(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict()
  .superRefine((c, ctx) => {
    for (const key of ['news', 'projects'] as const) {
      if (new Set(c[key].map((p) => p.id)).size !== c[key].length)
        ctx.addIssue({ code: 'custom', path: [key], message: '重複した項目があります' });
    }
  });

function connection() {
  const conn = db();
  conn.exec(`
    CREATE TABLE IF NOT EXISTS site_content (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, draft TEXT NOT NULL, published TEXT NOT NULL, published_at TEXT);
    CREATE TABLE IF NOT EXISTS site_images (id TEXT PRIMARY KEY, bytes BLOB NOT NULL, created_at TEXT NOT NULL);
  `);
  const initial = JSON.stringify(DEFAULT_SITE_CONTENT);
  conn
    .prepare('INSERT OR IGNORE INTO site_content(id,revision,draft,published) VALUES(1,0,?,?)')
    .run(initial, initial);
  return conn;
}
type Row = { revision: number; draft: string; published: string; published_at: string | null };
function row(): Row {
  return connection().prepare('SELECT * FROM site_content WHERE id=1').get() as Row;
}
function editor(r: Row): SiteEditorState {
  return {
    revision: r.revision,
    draft: JSON.parse(r.draft),
    publishedAt: r.published_at,
    hasUnpublishedChanges: r.draft !== r.published,
  };
}
export const getSiteEditor = () => editor(row());
export const getPublishedSiteContent = (): SiteContent =>
  visibleSiteContent(JSON.parse(row().published));

function validateReferences(content: SiteContent) {
  for (const image of new Set(siteImageReferences(content))) {
    const found = image.startsWith(assetPrefix)
      ? connection()
          .prepare('SELECT id FROM site_images WHERE id=?')
          .get(image.slice(assetPrefix.length))
      : existsSync(join(process.cwd(), 'public', image));
    if (!found)
      throw new ApiError(
        400,
        'missing_image',
        '写真が見つかりません。アップロードし直してください。',
      );
  }
}
export function saveSiteDraft(content: unknown, revision: number): SiteEditorState {
  const parsed = siteContentSchema.parse(content);
  return connection().transaction(() => {
    validateReferences(parsed);
    const result = connection()
      .prepare('UPDATE site_content SET draft=?, revision=revision+1 WHERE id=1 AND revision=?')
      .run(JSON.stringify(parsed), revision);
    if (!result.changes)
      throw new ApiError(
        409,
        'content_conflict',
        '他の画面で更新されています。入力内容を控えてから再読み込みしてください。',
      );
    audit('site_content.draft', 'site', 'サイトの下書きを保存');
    return getSiteEditor();
  })();
}
export function publishSiteDraft(revision: number): SiteEditorState {
  return connection().transaction(() => {
    const current = row();
    if (current.revision !== revision)
      throw new ApiError(
        409,
        'content_conflict',
        '下書きが更新されています。再読み込みして確認してください。',
      );
    const parsed = siteContentSchema.parse(JSON.parse(current.draft));
    validateReferences(parsed);
    connection()
      .prepare(
        'UPDATE site_content SET published=draft, published_at=?, revision=revision+1 WHERE id=1',
      )
      .run(now());
    audit('site_content.publish', 'site', '確認済みのサイト下書きを公開');
    return getSiteEditor();
  })();
}

export const SITE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export async function uploadSiteImage(bytes: Buffer) {
  if (!bytes.length || bytes.length > SITE_IMAGE_MAX_BYTES)
    throw new ApiError(413, 'image_size', '写真は5MB以下にしてください。');
  let output: Buffer;
  try {
    const input = sharp(bytes, { limitInputPixels: 25000000, animated: false, failOn: 'warning' });
    const meta = await input.metadata();
    if (!['jpeg', 'png', 'webp'].includes(meta.format || '') || (meta.pages || 1) > 1)
      throw new Error('format');
    output = await input
      .rotate()
      .resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
  } catch {
    throw new ApiError(
      400,
      'image_format',
      'JPEG・PNG・WebPの写真を選んでください（最大2,500万画素）。',
    );
  }
  if (output.length > SITE_IMAGE_MAX_BYTES)
    throw new ApiError(413, 'image_size', '写真の容量が大きすぎます。');
  const conn = connection();
  const id = uid();
  conn.transaction(() => {
    const used = (
      conn.prepare('SELECT COALESCE(SUM(length(bytes)),0) AS size FROM site_images').get() as {
        size: number;
      }
    ).size;
    if (used + output.length > 100 * 1024 * 1024)
      throw new ApiError(
        413,
        'image_storage',
        '写真の保存容量が上限に達しました。管理担当者へご相談ください。',
      );
    conn
      .prepare('INSERT INTO site_images(id,bytes,created_at) VALUES(?,?,?)')
      .run(id, output, now());
    audit('site_content.image', id, 'サイトの写真を登録');
  })();
  return { url: `${assetPrefix}${id}` };
}

export function readSiteImage(id: string, admin = false): Buffer | null {
  if (!/^[a-f0-9-]{36}$/.test(id)) return null;
  if (!admin && !siteImageReferences(getPublishedSiteContent()).includes(`${assetPrefix}${id}`))
    return null;
  const image = connection().prepare('SELECT bytes FROM site_images WHERE id=?').get(id) as
    { bytes: Buffer } | undefined;
  return image?.bytes || null;
}
