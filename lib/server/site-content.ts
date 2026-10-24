import { prepareSiteImage } from './site-image';
import { staticImageExists } from './runtime-assets';
import {
  DEFAULT_SITE_CONTENT,
  siteImageReferences,
  visibleSiteContent,
  type SiteContent,
  type SiteEditorState,
} from '../site-content';
import { db, lockResource, audit, now, uid } from './db';
import { ApiError } from './auth';

const assetPrefix = '/api/site-content/images/';
export { siteContentSchema } from '../site-content-editor';
import { siteContentSchema } from '../site-content-editor';

function connection() {
  return db();
}
type Row = { revision: number; draft: string; published: string; published_at: string | null };
async function row(): Promise<Row> {
  return (await connection().prepare('SELECT * FROM site_content WHERE id=1').get()) as Row;
}
function editor(r: Row): SiteEditorState {
  return {
    revision: r.revision,
    draft: JSON.parse(r.draft),
    published: JSON.parse(r.published),
    publishedAt: r.published_at,
    hasUnpublishedChanges: r.draft !== r.published,
  };
}
export const getSiteEditor = async () => editor(await row());
export const getPublishedSiteContent = async (): Promise<SiteContent> =>
  visibleSiteContent(JSON.parse((await row()).published));

async function validateReferences(content: SiteContent) {
  for (const image of new Set(siteImageReferences(content))) {
    const found = image.startsWith(assetPrefix)
      ? await connection()
          .prepare('SELECT id FROM site_images WHERE id=?')
          .get(image.slice(assetPrefix.length))
      : await staticImageExists(image);
    if (!found)
      throw new ApiError(
        400,
        'missing_image',
        '写真が見つかりません。アップロードし直してください。',
      );
  }
}
export async function saveSiteDraft(content: unknown, revision: number): Promise<SiteEditorState> {
  const parsed = siteContentSchema.parse(content);
  return await connection().transaction(async () => {
    await lockResource('site-content');
    await validateReferences(parsed);
    const result = await connection()
      .prepare('UPDATE site_content SET draft=?, revision=revision+1 WHERE id=1 AND revision=?')
      .run(JSON.stringify(parsed), revision);
    if (!result.changes)
      throw new ApiError(
        409,
        'content_conflict',
        '他の画面で更新されています。入力内容を控えてから再読み込みしてください。',
      );
    await audit('site_content.draft', 'site', 'サイトの下書きを保存');
    return await getSiteEditor();
  })();
}
export async function publishSiteDraft(revision: number): Promise<SiteEditorState> {
  return await connection().transaction(async () => {
    await lockResource('site-content');
    const current = await row();
    if (current.revision !== revision)
      throw new ApiError(
        409,
        'content_conflict',
        '下書きが更新されています。再読み込みして確認してください。',
      );
    const parsed = siteContentSchema.parse(JSON.parse(current.draft));
    await validateReferences(parsed);
    await connection()
      .prepare(
        'UPDATE site_content SET published=draft, published_at=?, revision=revision+1 WHERE id=1',
      )
      .run(now());
    await audit('site_content.publish', 'site', '確認済みのサイト下書きを公開');
    return await getSiteEditor();
  })();
}

export const SITE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export async function uploadSiteImage(bytes: Buffer) {
  if (!bytes.length || bytes.length > SITE_IMAGE_MAX_BYTES)
    throw new ApiError(413, 'image_size', '写真は5MB以下にしてください。');
  let output: Buffer;
  try {
    output = await prepareSiteImage(bytes);
  } catch {
    throw new ApiError(
      400,
      'image_format',
      '写真を圧縮できませんでした。JPEG・PNG・WebPの静止画を選び直してください。直接送信する場合は1920px以下に縮小してください。',
    );
  }
  if (output.length > SITE_IMAGE_MAX_BYTES)
    throw new ApiError(413, 'image_size', '写真の容量が大きすぎます。');
  const conn = connection();
  const id = uid();
  await conn.transaction(async () => {
    await lockResource('site-images');
    const used = (
      (await conn
        .prepare('SELECT COALESCE(SUM(length(bytes)),0) AS size FROM site_images')
        .get()) as {
        size: number;
      }
    ).size;
    if (Number(used) + output.length > 100 * 1024 * 1024)
      throw new ApiError(
        413,
        'image_storage',
        '写真の保存容量が上限に達しました。管理担当者へご相談ください。',
      );
    await conn
      .prepare('INSERT INTO site_images(id,bytes,created_at) VALUES(?,?,?)')
      .run(id, output, now());
    await audit('site_content.image', id, 'サイトの写真を登録');
  })();
  return { url: `${assetPrefix}${id}` };
}

export async function readSiteImage(id: string, admin = false): Promise<Buffer | null> {
  if (!/^[a-f0-9-]{36}$/.test(id)) return null;
  if (
    !admin &&
    !siteImageReferences(await getPublishedSiteContent()).includes(`${assetPrefix}${id}`)
  )
    return null;
  const image = (await connection().prepare('SELECT bytes FROM site_images WHERE id=?').get(id)) as
    { bytes: Buffer } | undefined;
  return image?.bytes || null;
}
