import { imageSize } from 'image-size';
import { PhotonImage, SamplingFilter, resize, rotate, fliph, flipv } from '@cf-wasm/photon';

// Inspect bounded headers before the WASM decoder allocates pixel storage.
export function siteImageHeader(bytes: Buffer) {
  const meta = imageSize(bytes);
  if (
    !['jpg', 'png', 'webp'].includes(meta.type || '') ||
    !meta.width ||
    !meta.height ||
    meta.width * meta.height > 25000000
  )
    throw new Error('image dimensions or format');
  if (meta.type === 'png') {
    for (let at = 8; at + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(at),
        kind = bytes.toString('ascii', at + 4, at + 8);
      if (kind === 'acTL') throw new Error('animated PNG');
      if (length > bytes.length - at - 12) throw new Error('truncated PNG');
      at += length + 12;
    }
  }
  if (meta.type === 'webp' && bytes.toString('ascii', 12, 16) === 'VP8X' && bytes[20] & 2)
    throw new Error('animated WebP');
  return meta;
}
export function siteImageMime(bytes: Buffer) {
  return bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' : 'image/webp';
}
export async function prepareSiteImage(bytes: Buffer): Promise<Buffer> {
  const meta = siteImageHeader(bytes);
  let image: PhotonImage | undefined;
  try {
    image = PhotonImage.new_from_byteslice(new Uint8Array(bytes));
    if (image.get_width() !== meta.width || image.get_height() !== meta.height)
      throw new Error('dimensions mismatch');
    const orientation = meta.orientation || 1;
    const angle =
      orientation === 3 ? 180 : [5, 6, 7].includes(orientation) ? 90 : orientation === 8 ? 270 : 0;
    if (angle) {
      const oriented = rotate(image, angle);
      image.free();
      image = oriented;
    }
    if ([2, 5].includes(orientation)) fliph(image);
    if ([4, 7].includes(orientation)) flipv(image);
    const scale = Math.min(1, 1920 / image.get_width(), 1920 / image.get_height());
    if (scale < 1) {
      const smaller = resize(
        image,
        Math.max(1, Math.round(image.get_width() * scale)),
        Math.max(1, Math.round(image.get_height() * scale)),
        SamplingFilter.Lanczos3,
      );
      image.free();
      image = smaller;
    }
    // Re-encoding removes EXIF and other metadata. PNG/WebP retain alpha;
    // JPEG photos retain a bounded lossy encoding rather than ballooning as lossless WebP.
    return Buffer.from(meta.type === 'jpg' ? image.get_bytes_jpeg(82) : image.get_bytes_webp());
  } finally {
    image?.free();
  }
}
