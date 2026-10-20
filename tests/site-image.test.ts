import { expect, it } from 'vitest';
import sharp from 'sharp';
import { prepareSiteImage, siteImageHeader, siteImageMime } from '../lib/server/site-image';

it('normalizes JPEG orientation and strips EXIF with bounded dimensions', async () => {
  const input = await sharp({
    create: { width: 2400, height: 1200, channels: 3, background: '#135b6c' },
  })
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 90 })
    .toBuffer();
  const result = await prepareSiteImage(input),
    meta = await sharp(result).metadata();
  expect(meta).toMatchObject({ width: 960, height: 1920, format: 'jpeg' });
  expect(meta.exif).toBeUndefined();
  expect(siteImageMime(result)).toBe('image/jpeg');
});
it('preserves transparent PNG pixels in the processed WebP', async () => {
  const input = await sharp({
    create: { width: 50, height: 40, channels: 4, background: { r: 20, g: 50, b: 80, alpha: 0.5 } },
  })
    .png()
    .toBuffer();
  const result = await prepareSiteImage(input);
  expect(await sharp(result).metadata()).toMatchObject({
    format: 'webp',
    hasAlpha: true,
    width: 50,
    height: 40,
  });
  expect(siteImageMime(result)).toBe('image/webp');
});
it('rejects an excessive declared size before decoding and rejects animation headers', async () => {
  const input = await sharp({
    create: { width: 10, height: 10, channels: 3, background: '#123456' },
  })
    .png()
    .toBuffer();
  const large = Buffer.from(input);
  large.writeUInt32BE(100000, 16);
  large.writeUInt32BE(100000, 20);
  expect(() => siteImageHeader(large)).toThrow('dimensions');
  const control = Buffer.alloc(20);
  control.writeUInt32BE(8, 0);
  control.write('acTL', 4);
  const animated = Buffer.concat([input.subarray(0, 33), control, input.subarray(33)]);
  expect(() => siteImageHeader(animated)).toThrow('animated');
});

it('accepts camera photo headers for browser resize but rejects direct large server uploads', async () => {
  const { imageInputMetadata } = await import('../lib/site-image-input');
  const photo = await sharp({
    create: { width: 4000, height: 3000, channels: 3, background: '#12536a' },
  })
    .jpeg()
    .toBuffer();
  expect(imageInputMetadata(new Uint8Array(photo))).toMatchObject({ width: 4000, height: 3000 });
  await expect(prepareSiteImage(photo)).rejects.toThrow('dimensions');
});
