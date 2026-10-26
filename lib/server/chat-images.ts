import { imageInputMetadata } from '../site-image-input';
import { PhotonImage, SamplingFilter, resize, rotate, fliph, flipv } from '@cf-wasm/photon';
import { ApiError } from './auth';
import { db, lockResource, uid, now, save } from './db';
import { verifyConversation } from './business';
import { CHAT_ATTACHMENT_MAX_BYTES, CHAT_FILE_TYPES, chatAttachmentError } from '../chat-attachments';

export const CHAT_IMAGE_MAX_BYTES = CHAT_ATTACHMENT_MAX_BYTES;
export async function validateChatImage(bytes: Buffer) {
  if (!bytes.length || bytes.length > CHAT_IMAGE_MAX_BYTES)
    throw new ApiError(413, 'image_size', '写真は5MB以下にしてください。');
  try {
    const meta = imageInputMetadata(bytes);
    let image: PhotonImage | undefined;
    let output: Buffer;
    try {
      image = PhotonImage.new_from_byteslice(new Uint8Array(bytes));
      if (image.get_width() !== meta.width || image.get_height() !== meta.height)
        throw new Error('dimensions mismatch');
      const scale = Math.min(1, 1920 / meta.width, 1920 / meta.height);
      if (scale < 1) {
        const smaller = resize(image, Math.max(1, Math.round(meta.width * scale)), Math.max(1, Math.round(meta.height * scale)), SamplingFilter.Lanczos3);
        image.free(); image = smaller;
      }
      const orientation = meta.orientation || 1;
      const angle = orientation === 3 ? 180 : [5, 6, 7].includes(orientation) ? 90 : orientation === 8 ? 270 : 0;
      if (angle) { const oriented = rotate(image, angle); image.free(); image = oriented; }
      if ([2, 5].includes(orientation)) fliph(image);
      if ([4, 7].includes(orientation)) flipv(image);
      // Re-encode without EXIF/filenames using the same WASM codec as site images.
      output = Buffer.from(image.get_bytes_webp());
    } finally { image?.free(); }
    if (output.length > CHAT_IMAGE_MAX_BYTES) throw Error();
    return output;
  } catch {
    throw new ApiError(
      400,
      'image_format',
      'JPEG・PNG・WebPの写真を選んでください（最大2,500万画素）。',
    );
  }
}
export async function validateChatAttachment(
  bytes: Buffer,
  fileName = 'photo',
  contentType = 'image/webp',
) {
  const name =
    fileName
      .split(/[\\/]/)
      .pop()!
      .replace(/[\x00-\x1f\x7f]/g, '')
      .slice(0, 180) || 'document';
  const error = chatAttachmentError({ size: bytes.length, type: contentType, name });
  if (error)
    throw new ApiError(bytes.length > CHAT_IMAGE_MAX_BYTES ? 413 : 400, 'attachment', error);
  if (contentType.startsWith('image/')) {
    return {
      bytes: await validateChatImage(bytes),
      contentType: 'image/webp',
      fileName: name.replace(/\.[^.]+$/, '') + '.webp',
      text: '',
    };
  }
  const ext = name.split('.').pop()!.toLowerCase();
  const type = Object.hasOwn(CHAT_FILE_TYPES, ext) ? CHAT_FILE_TYPES[ext] : undefined;
  if (
    !type ||
    (ext === 'pdf' && bytes.subarray(0, 5).toString() !== '%PDF-') ||
    (['docx', 'xlsx'].includes(ext) &&
      !bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) ||
    (['txt', 'csv'].includes(ext) && bytes.includes(0))
  )
    throw new ApiError(
      400,
      'attachment_format',
      'ファイルの形式を確認できません。別のファイルを選んでください。',
    );
  let text = '';
  try {
    const { parseUpload } = await import('./connectors');
    const parsed = await parseUpload(name, bytes);
    text = [
      ...parsed.documents.map((d) => d.content),
      ...parsed.rows.slice(0, 200).map((row) => JSON.stringify(row)),
    ]
      .join('\n')
      .slice(0, 12000);
  } catch {
    // Preserve readable downloads even when the document requires OCR or is encrypted.
  }
  return { bytes, contentType: type, fileName: name, text };
}
export async function uploadChatImage(
  bytes: Buffer,
  owner: string,
  conversationId?: string,
  fileName?: string,
  contentType?: string,
) {
  if (conversationId) await verifyConversation(conversationId, owner);
  const attachment = await validateChatAttachment(bytes, fileName, contentType);
  const output = attachment.bytes;
  const id = uid();
  const cid = conversationId || uid();
  await db().transaction(async () => {
    await lockResource('chat-images');
    const total = await db()
      .prepare('SELECT COALESCE(SUM(octet_length(bytes)),0) AS size FROM chat_images')
      .get();
    const count = await db()
      .prepare('SELECT COUNT(*) AS count FROM chat_images WHERE conversation_id=?')
      .get(cid);
    if (Number(total.size) + output.length > 100 * 1024 * 1024 || Number(count.count) >= 12)
      throw new ApiError(
        413,
        'image_storage',
        '添付ファイルの保存上限に達しました。文字での相談をご利用ください。',
      );
    if (!conversationId)
      await save(
        'conversations',
        {
          id: cid,
          title: attachment.contentType.startsWith('image/')
            ? '写真からの商品相談'
            : '資料からの商品相談',
          status: 'open',
          createdAt: now(),
          updatedAt: now(),
        },
        { owner_id: owner },
      );
    await db()
      .prepare(
        'INSERT INTO chat_images(id,conversation_id,bytes,content_type,file_name,extracted_text) VALUES(?,?,?,?,?,?)',
      )
      .run(id, cid, output, attachment.contentType, attachment.fileName, attachment.text);
  })();
  return { id, conversationId: cid };
}
export async function readChatImage(id: string, owner: string | null, admin = false) {
  const row = await db()
    .prepare(
      'SELECT conversation_id,bytes,content_type,file_name,extracted_text FROM chat_images WHERE id=?',
    )
    .get(id);
  if (!row) throw new ApiError(404, 'not_found', '添付ファイルが見つかりません。');
  if (!admin) await verifyConversation(row.conversation_id, owner);
  return {
    conversationId: row.conversation_id as string,
    bytes: Buffer.from(row.bytes),
    contentType: row.content_type as string,
    fileName: row.file_name as string,
    text: row.extracted_text as string,
  };
}
export async function chatAttachmentInputs(ids: string[], conversationId: string, owner: string) {
  if (ids.length > 3 || new Set(ids).size !== ids.length)
    throw new ApiError(400, 'images', '一度に添付できるファイルは3件までです。');
  const images: string[] = [];
  const documents: string[] = [];
  for (const id of ids) {
    const image = await readChatImage(id, owner);
    if (image.conversationId !== conversationId)
      throw new ApiError(403, 'forbidden', 'この会話の添付ファイルを選んでください。');
    if (image.contentType.startsWith('image/'))
      images.push(`data:image/webp;base64,${image.bytes.toString('base64')}`);
    else
      documents.push(
        `資料名：${image.fileName}\n${image.text || '本文を自動で読み取れませんでした。内容を推測せず、お客様に必要箇所を文字または写真で確認してください。'}`,
      );
  }
  return { images, documents };
}
export async function chatImageInputs(ids: string[], conversationId: string, owner: string) {
  return (await chatAttachmentInputs(ids, conversationId, owner)).images;
}
