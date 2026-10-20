import { test, expect } from '@playwright/test';
import sharp from 'sharp';
import type { SiteEditorState } from '../../lib/site-content';

test.setTimeout(120000);
test('staff edit, save, preview, publish and hide website content', async ({
  page,
  context,
}, testInfo) => {
  const request = context.request;
  expect((await request.get('/api/admin/site-content')).status()).toBe(401);
  const previewUnauthorized = await request.get('/admin/site-preview');
  expect(previewUnauthorized.url()).toContain('/admin/login');
  expect(
    (
      await request.post('/api/auth/login', { data: { password: 'aoki-e2e-test-password-only' } })
    ).ok(),
  ).toBeTruthy();
  const original: SiteEditorState = (await (await request.get('/api/admin/site-content')).json())
    .data;
  const title = `編集テスト ${testInfo.project.name}`;
  let uploadedUrl = '';
  try {
    await page.goto('/admin?tab=site-content');
    await page.getByLabel('メイン見出し', { exact: true }).fill(title);
    await page.getByLabel('メイン写真1を選ぶ', { exact: true }).setInputFiles({
      name: 'photo.png',
      mimeType: 'image/png',
      buffer: await sharp({
        create: { width: 800, height: 500, channels: 3, background: '#1d7374' },
      })
        .png()
        .toBuffer(),
    });
    await expect(page.getByRole('button', { name: '下書き保存', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'お知らせ', exact: true }).click();
    await page.getByRole('button', { name: 'お知らせを追加', exact: true }).click();
    await page.getByLabel('お知らせのタイトル').fill(title + ' お知らせ');
    await page.getByLabel('お知らせの本文').fill('社員による更新の動作確認です。');
    await page.getByRole('button', { name: '下書き保存', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('下書きを保存しました');
    expect(await (await request.get('/')).text()).not.toContain(title);
    let state: SiteEditorState = (await (await request.get('/api/admin/site-content')).json()).data;
    uploadedUrl = state.draft.home.slides[0].image;
    expect(uploadedUrl).toMatch(/^\/api\/site-content\/images\//);
    expect((await request.get(uploadedUrl)).status()).toBe(404);
    await page.reload();
    await expect(page.getByLabel('メイン見出し', { exact: true })).toHaveValue(title);
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({
      path: `docs/screenshots/site-content-editor-${testInfo.project.name}.png`,
      caret: 'initial',
    });
    await page.getByRole('button', { name: 'プレビュー', exact: true }).click();
    const frame = page.frameLocator('iframe[title="保存した下書き"]');
    await expect(frame.getByRole('heading', { level: 1 })).toContainText(title);
    await expect(
      frame.getByRole('heading', { name: title + ' お知らせ', exact: true }),
    ).toBeVisible();
    await expect
      .poll(async () =>
        (await frame
          .locator('.hero-slide img')
          .first()
          .evaluate((img) => (img as HTMLImageElement).naturalWidth)),
      )
      .toBeGreaterThan(0);
    await page.getByRole('button', { name: 'スマートフォン表示', exact: true }).click();
    await expect(page.locator('iframe')).toHaveClass('cms-frame-mobile');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await page.screenshot({
      path: `docs/screenshots/site-content-${testInfo.project.name}.png`,
      caret: 'initial',
    });
    await page.getByRole('button', { name: '公開する', exact: true }).click();
    await page.getByRole('button', { name: 'この内容を公開', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('公開しました');
    expect(await (await request.get('/')).text()).toContain(title);
    expect((await request.get(uploadedUrl)).status()).toBe(200);
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(title);
    await page.goto('/admin?tab=site-content');
    await page.getByRole('button', { name: '製作実績', exact: true }).click();
    await page.getByRole('button', { name: '実績を追加', exact: true }).click();
    await page
      .getByLabel('実績名', { exact: true })
      .first()
      .fill(title + ' 実績');
    await page.getByLabel('カテゴリ', { exact: true }).first().fill('検証');
    await page.getByLabel('実績の説明', { exact: true }).first().fill('新しい実績の説明です。');
    await page.getByRole('button', { name: '下書き保存', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('下書きを保存しました');
    expect(await (await request.get('/projects')).text()).not.toContain(title + ' 実績');
    await page.getByRole('button', { name: 'プレビュー', exact: true }).click();
    await expect(frame.getByRole('heading', { name: title + ' 実績', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '公開する', exact: true }).click();
    await page.getByRole('button', { name: 'この内容を公開', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('公開しました');
    expect(await (await request.get('/projects')).text()).toContain(title + ' 実績');
    await page.getByRole('checkbox', { name: '公開対象にする' }).first().uncheck();
    await page.getByRole('button', { name: '下書き保存', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('下書きを保存しました');
    await page.getByRole('button', { name: '公開する', exact: true }).click();
    await page.getByRole('button', { name: 'この内容を公開', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('公開しました');
    expect(await (await request.get('/projects')).text()).not.toContain(title + ' 実績');
  } finally {
    const current: SiteEditorState = (await (await request.get('/api/admin/site-content')).json())
      .data;
    const restored = await request.put('/api/admin/site-content', {
      data: { revision: current.revision, content: original.draft },
    });
    const state: SiteEditorState = (await restored.json()).data;
    if (state)
      await request.post('/api/admin/site-content', { data: { revision: state.revision } });
  }
});
