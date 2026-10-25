import { test, expect } from '@playwright/test';
import sharp from 'sharp';

test('photo preview, removal, retake, private upload and camera-independent selection', async ({
  page,
  browser,
}) => {
  await page.goto('/');
  await page.bringToFront();
  await page.getByRole('button', { name: '商品相談チャットを開く' }).click();
  const panel = page.getByRole('dialog', { name: '商品相談チャット' });
  const file = {
    name: 'tag.png',
    mimeType: 'image/png',
    buffer: await sharp({ create: { width: 180, height: 120, channels: 3, background: '#fff' } })
      .png()
      .toBuffer(),
  };
  const picker = panel.locator('input[type=file]:not([capture])');
  await expect(
    panel.getByText('カメラが使えない場合は写真を選べます。', { exact: false }),
  ).toBeVisible();
  await picker.setInputFiles(file);
  await expect(panel.getByAltText('送信前の写真')).toBeVisible();
  await panel.getByRole('button', { name: '写真を削除', exact: true }).click();
  await expect(panel.getByAltText('送信前の写真')).toHaveCount(0);
  await picker.setInputFiles(file);
  const chooser = page.waitForEvent('filechooser');
  await panel.getByRole('button', { name: '撮り直す', exact: true }).click();
  await (await chooser).setFiles(file);
  await panel.getByRole('button', { name: 'メッセージを送信' }).click();
  await expect(panel.locator('.chat-message.assistant').last()).toContainText(
    '画像の読み取りを完了できませんでした',
    { timeout: 30000 },
  );
  const image = panel.getByAltText('添付した商品写真');
  await expect(image).toBeVisible();
  const path = await image.getAttribute('src');
  const own = await page.request.get(path!);
  expect(own.status()).toBe(200);
  expect(own.headers()['cache-control']).toBe('private, no-store');
  const outsider = await browser.newContext();
  expect((await outsider.request.get(`http://127.0.0.1:3210${path}`)).status()).toBe(403);
  await outsider.close();
  await page.reload();
  await page.getByRole('button', { name: '商品相談チャットを開く' }).click();
  await expect(panel.getByAltText('添付した商品写真')).toBeVisible();
  const box = await panel.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
});
