import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiError, checkOrigin, requireAdmin, rateLimit, clientKey } from './auth';
import {
  getSiteEditor,
  saveSiteDraft,
  publishSiteDraft,
  uploadSiteImage,
  readSiteImage,
  SITE_IMAGE_MAX_BYTES,
} from './site-content';

export function siteError(error: unknown) {
  const known = error instanceof ApiError;
  return NextResponse.json(
    {
      error: {
        code: known ? error.code : 'invalid_content',
        message: known
          ? error.message
          : error instanceof z.ZodError
            ? '入力内容・文字数・日付を確認してください。'
            : '処理を完了できませんでした。',
      },
    },
    {
      status: known ? error.status : error instanceof z.ZodError ? 400 : 500,
      headers: { 'Cache-Control': 'private, no-store' },
    },
  );
}
export async function limitedBytes(req: NextRequest, limit: number): Promise<Buffer> {
  if (Number(req.headers.get('content-length')) > limit)
    throw new ApiError(413, 'too_large', '送信容量が大きすぎます。');
  const reader = req.body?.getReader();
  if (!reader) throw new ApiError(400, 'empty_body', '入力を確認してください。');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new ApiError(413, 'too_large', '送信容量が大きすぎます。');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
export async function siteEditorRequest(req: NextRequest) {
  try {
    (await requireAdmin(req));
    if (req.method !== 'GET') checkOrigin(req);
    if (req.method === 'GET')
      return NextResponse.json(
        { data: (await getSiteEditor()) },
        { headers: { 'Cache-Control': 'private, no-store' } },
      );
    let input: unknown;
    try {
      input = JSON.parse((await limitedBytes(req, 1024 * 1024)).toString('utf8'));
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(400, 'invalid_json', '入力形式を確認してください。');
    }
    const { revision, content } = z
      .object({ revision: z.number().int().nonnegative(), content: z.unknown().optional() })
      .strict()
      .parse(input);
    const result =
      req.method === 'PUT' ? (await saveSiteDraft(content, revision)) : (await publishSiteDraft(revision));
    return NextResponse.json(
      { data: result },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (e) {
    return siteError(e);
  }
}
export async function siteImageUpload(req: NextRequest) {
  try {
    (await requireAdmin(req));
    checkOrigin(req);
    (await rateLimit(`site-image:${clientKey(req)}`, 30, 60000));
    const result = await uploadSiteImage(await limitedBytes(req, SITE_IMAGE_MAX_BYTES));
    return NextResponse.json(
      { data: result },
      { status: 201, headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (e) {
    return siteError(e);
  }
}
export async function siteImageResponse(req: NextRequest, id: string, admin: boolean) {
  try {
    if (admin) (await requireAdmin(req));
    const bytes = (await readSiteImage(id, admin));
    if (!bytes) throw new ApiError(404, 'not_found', '写真が見つかりません。');
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'image/webp',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    });
  } catch (e) {
    return siteError(e);
  }
}
