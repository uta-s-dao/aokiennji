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
  const picker = panel.getByLabel('写真を選択', { exact: true });
  await expect(panel.getByText('5MB', { exact: false })).toHaveCount(0);
  await panel.getByRole('button', { name: 'ファイルを添付' }).click();
  await expect(panel.getByRole('button', { name: 'カメラで撮影', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'ファイルを選択', exact: true })).toBeVisible();
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

test('attachment menu, size error and private document downloads', async ({ page, browser }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '商品相談チャットを開く' }).click();
  const panel = page.getByRole('dialog', { name: '商品相談チャット' });
  const add = panel.getByRole('button', { name: 'ファイルを添付' });
  await expect(panel.getByText('5MB', { exact: false })).toHaveCount(0);
  await add.click();
  await expect(add).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(add).toHaveAttribute('aria-expanded', 'false');
  await expect(panel).toBeVisible();
  await add.click();
  const chooser = page.waitForEvent('filechooser');
  await panel.getByRole('button', { name: 'ファイルを選択', exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: 'large.txt',
    mimeType: 'text/plain',
    buffer: Buffer.alloc(5 * 1024 * 1024 + 1, 65),
  });
  await expect(panel.getByRole('alert')).toContainText('5MBを超え');
  await expect(panel.getByRole('button', { name: '再試行' })).toHaveCount(0);
  const file = {
    name: '商品メモ.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('DEMO-GLASS-01を2枚検討しています。'),
  };
  await panel.getByLabel('ファイルを選択', { exact: true }).setInputFiles(file);
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(panel.getByText(file.name, { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'メッセージを送信' }).click();
  const attachment = panel.getByRole('link', { name: file.name, exact: true });
  await expect(attachment).toBeVisible({ timeout: 30000 });
  const path = (await attachment.getAttribute('href'))!;
  const response = await page.request.get(path);
  expect(response.status()).toBe(200);
  expect(await response.body()).toEqual(file.buffer);
  expect(response.headers()['content-disposition']).toContain('attachment;');
  const outsider = await browser.newContext();
  expect((await outsider.request.get(`http://127.0.0.1:3210${path}`)).status()).toBe(403);
  expect((await outsider.request.get(`http://127.0.0.1:3210${path}?metadata=1`)).status()).toBe(
    403,
  );
  await outsider.close();
  await page.reload();
  await page.getByRole('button', { name: '商品相談チャットを開く' }).click();
  await expect(attachment).toBeVisible();
});

test('company icons and sharing metadata are served on public pages', async ({ page }) => {
  for (const path of ['/', '/profile', '/products']) {
    await page.goto(path);
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      'content',
      /\/images\/brand\/company-share.png$/,
    );
    await expect(page.locator('meta[name="twitter:image"]')).toHaveAttribute(
      'content',
      /\/images\/brand\/company-share.png$/,
    );
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
      'href',
      /apple-icon/,
    );
  }
  for (const [path, width, height] of [
    ['/icon.png', 512, 512],
    ['/apple-icon.png', 180, 180],
    ['/images/brand/company-share.png', 1200, 630],
  ] as const) {
    const response = await page.request.get(path);
    expect(response.status()).toBe(200);
    const metadata = await sharp(await response.body()).metadata();
    expect([metadata.width, metadata.height]).toEqual([width, height]);
  }
  expect((await page.request.get('/favicon.ico')).status()).toBe(200);
});
