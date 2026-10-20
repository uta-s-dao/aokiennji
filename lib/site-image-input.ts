import { imageSize } from 'image-size';

export const SITE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const SITE_IMAGE_MAX_INPUT_PIXELS = 25000000;
export const SITE_IMAGE_EDGE = 1920;

// Shared by the browser and server; inspect headers before allocating pixel buffers.
export function imageInputMetadata(bytes: Uint8Array, maxPixels = SITE_IMAGE_MAX_INPUT_PIXELS) {
  const meta = imageSize(bytes);
  if (
    !['jpg', 'png', 'webp'].includes(meta.type || '') ||
    !meta.width ||
    !meta.height ||
    meta.width * meta.height > maxPixels
  )
    throw new Error('image dimensions or format');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kindAt = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (meta.type === 'png') {
    for (let at = 8; at + 12 <= bytes.length;) {
      const length = view.getUint32(at);
      if (kindAt(at + 4) === 'acTL') throw new Error('animated PNG');
      if (length > bytes.length - at - 12) throw new Error('truncated PNG');
      at += length + 12;
    }
  }
  if (meta.type === 'webp' && kindAt(12) === 'VP8X' && bytes[20] & 2)
    throw new Error('animated WebP');
  return meta;
}
