import { imageInputMetadata, SITE_IMAGE_EDGE, SITE_IMAGE_MAX_BYTES } from './site-image-input';

// Large camera photos are decoded/resized on the user's device. The server still
// checks dimensions and re-encodes the bounded upload before persisting it.
export async function prepareSiteImageUpload(file: File): Promise<Blob> {
  if (!file.size || file.size > SITE_IMAGE_MAX_BYTES)
    throw new Error('写真は5MB以下にしてください。');
  let meta;
  try {
    meta = imageInputMetadata(new Uint8Array(await file.arrayBuffer()));
  } catch {
    throw new Error('JPEG・PNG・WebPの静止画を選んでください（最大2,500万画素）。');
  }
  const swapped = [5, 6, 7, 8].includes(meta.orientation || 1);
  const width = swapped ? meta.height : meta.width,
    height = swapped ? meta.width : meta.height;
  const scale = Math.min(1, SITE_IMAGE_EDGE / width, SITE_IMAGE_EDGE / height);
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  const bitmap = await createImageBitmap(file, {
    imageOrientation: 'from-image',
    resizeWidth: targetWidth,
    resizeHeight: targetHeight,
    resizeQuality: 'high',
  });
  const canvas = document.createElement('canvas');
  try {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('写真を圧縮できませんでした。');
    context.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error('写真を圧縮できませんでした。'))),
        meta.type === 'jpg' ? 'image/jpeg' : 'image/webp',
        0.9,
      ),
    );
    if (blob.size > SITE_IMAGE_MAX_BYTES) throw new Error('写真の容量が大きすぎます。');
    return blob;
  } finally {
    bitmap.close();
    canvas.width = canvas.height = 0;
  }
}
