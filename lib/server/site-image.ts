import { imageInputMetadata, SITE_IMAGE_EDGE } from '../site-image-input';
import { PhotonImage, SamplingFilter, resize, rotate, fliph, flipv } from '@cf-wasm/photon';

// Reject oversized direct API uploads before entering the WASM decoder.
// The editor resizes camera photos to this bound on the client first.
export const siteImageHeader = (bytes: Buffer) => imageInputMetadata(bytes, SITE_IMAGE_EDGE ** 2);
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
    const scale = Math.min(
      1,
      SITE_IMAGE_EDGE / image.get_width(),
      SITE_IMAGE_EDGE / image.get_height(),
    );
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
    // Re-encoding removes EXIF and other metadata. PNG/WebP retain alpha;
    // JPEG photos retain a bounded lossy encoding rather than ballooning as lossless WebP.
    return Buffer.from(meta.type === 'jpg' ? image.get_bytes_jpeg(82) : image.get_bytes_webp());
  } finally {
    image?.free();
  }
}
