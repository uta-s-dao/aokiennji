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
      path: testInfo.outputPath('site-content-editor.png'),
      caret: 'initial',
    });
    await page.getByRole('button', { name: 'プレビュー', exact: true }).click();
    const frame = page.frameLocator('iframe[title="保存した下書き"]');
    await expect(frame.getByRole('heading', { level: 1 })).toContainText(title);
    await expect(
      frame.getByRole('heading', { name: title + ' お知らせ', exact: true }),
    ).toBeVisible();
    await expect
      .poll(
        async () =>
          await frame
            .locator('.hero-slide img')
            .first()
            .evaluate((img) => (img as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);
    await page.getByRole('button', { name: 'スマートフォン表示', exact: true }).click();
    await expect.poll(() => frame.locator('html').evaluate(() => innerWidth)).toBe(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath('site-content-preview.png'),
      caret: 'initial',
    });
    if (await page.getByRole('dialog', { name: '下書きプレビュー' }).count())
      await page
        .getByRole('dialog', { name: '下書きプレビュー' })
        .getByRole('button', { name: '閉じる' })
        .click();
    await page.getByRole('button', { name: '変更をまとめて公開', exact: true }).click();
    await page.getByRole('button', { name: 'この内容を公開', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('公開しました');
    expect(await (await request.get('/')).text()).toContain(title);
    expect((await request.get(uploadedUrl)).status()).toBe(200);
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(title);
    await page.goto('/admin?tab=site-content');
    await page.getByRole('button', { name: '製作実績', exact: true }).click();
    await page.getByRole('button', { name: '＋ 実績を追加', exact: true }).click();
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
    if (await page.getByRole('dialog', { name: '下書きプレビュー' }).count())
      await page
        .getByRole('dialog', { name: '下書きプレビュー' })
        .getByRole('button', { name: '閉じる' })
        .click();
    await page.getByRole('button', { name: '変更をまとめて公開', exact: true }).click();
    await page.getByRole('button', { name: 'この内容を公開', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('公開しました');
    expect(await (await request.get('/projects')).text()).toContain(title + ' 実績');
    await page.getByRole('checkbox', { name: '公開対象にする' }).first().uncheck();
    await page.getByRole('button', { name: '下書き保存', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('下書きを保存しました');
    if (await page.getByRole('dialog', { name: '下書きプレビュー' }).count())
      await page
        .getByRole('dialog', { name: '下書きプレビュー' })
        .getByRole('button', { name: '閉じる' })
        .click();
    await page.getByRole('button', { name: '変更をまとめて公開', exact: true }).click();
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

test('editor guides errors across tabs, reviews every change, and previews fixed screen widths', async ({
  page,
}, testInfo) => {
  expect(
    (
      await page.request.post('/api/auth/login', {
        data: { password: 'aoki-e2e-test-password-only' },
      })
    ).ok(),
  ).toBeTruthy();
  const original: SiteEditorState = (
    await (await page.request.get('/api/admin/site-content')).json()
  ).data;
  try {
    await page.goto('/admin?tab=site-content');
    if (testInfo.project.name === 'mobile-chromium') {
      await page.setViewportSize({ width: 320, height: 844 });
      await expect
        .poll(() =>
          page.locator('.cms-toolbar button').evaluateAll((buttons) => {
            const tops = buttons.map((button) => Math.round(button.getBoundingClientRect().top));
            return Math.max(...tops) - Math.min(...tops);
          }),
        )
        .toBeLessThanOrEqual(6);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true);
    }
    await page.getByLabel('メイン見出し', { exact: true }).fill('差分確認の見出し');
    await page.getByRole('button', { name: 'お知らせ', exact: true }).click();
    await page.getByRole('button', { name: 'お知らせを追加', exact: true }).click();
    await page.getByRole('button', { name: 'トップページ', exact: true }).click();
    await page.getByRole('button', { name: '下書き保存', exact: true }).click();
    await expect(page.getByLabel('お知らせのタイトル')).toBeFocused();
    await expect(page.getByLabel('お知らせのタイトル')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('.cms-issues')).toContainText('お知らせ 1：タイトル');
    await page.getByLabel('お知らせのタイトル').fill('差分確認のお知らせ');
    await page.getByLabel('お知らせの本文').fill('編集体験の確認です。');
    await page.getByRole('button', { name: '下書き保存', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('下書きを保存しました');
    await expect(page.getByRole('button', { name: 'トップページ', exact: true })).toContainText(
      '未公開',
    );
    await page.getByRole('button', { name: 'プレビュー', exact: true }).click();
    const preview = page.getByRole('dialog', { name: '下書きプレビュー', exact: true });
    await expect(preview).toBeVisible();
    expect((await preview.boundingBox())!.y).toBeGreaterThanOrEqual(0);
    const frame = page.frameLocator('iframe[title="保存した下書き"]');
    await expect.poll(() => frame.locator('html').evaluate(() => innerWidth)).toBe(1440);
    await expect
      .poll(() =>
        frame.locator('#site-news').evaluate((el) => Math.round(el.getBoundingClientRect().top)),
      )
      .toBeLessThan(150);
    await preview.getByRole('button', { name: 'スマートフォン表示', exact: true }).click();
    await expect.poll(() => frame.locator('html').evaluate(() => innerWidth)).toBe(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await preview.getByRole('button', { name: '閉じる' }).click();
    await page.getByRole('button', { name: '変更をまとめて公開', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: '公開する変更の確認' });
    await expect(confirmation).toContainText('トップページ：メイン見出し');
    await expect(confirmation).toContainText('差分確認のお知らせを追加');
    await expect(confirmation).toContainText('現在の内容');
    await expect(confirmation).toContainText('公開後');
    await page.keyboard.press('Escape');
    await expect(confirmation).toBeHidden();
    await page.getByRole('button', { name: '製作実績', exact: true }).click();
    const rows = page.locator('.cms-project-row');
    await expect(rows).toHaveCount(original.draft.projects.length);
    await expect(page.getByLabel('実績名', { exact: true })).toHaveCount(0);
    const initialName = await rows.first().locator('strong').innerText();
    await rows
      .first()
      .getByRole('button', { name: /を下へ$/ })
      .click();
    await expect(rows.nth(1).locator('strong')).toHaveText(initialName);
    await rows.nth(1).locator('.cms-project-select').click();
    await expect(page.getByLabel('実績名', { exact: true })).toBeFocused();
    await expect(page.getByText('現在の写真：実績写真2', { exact: true })).toBeVisible();
    await expect(page.locator('.cms-photo-control input[type=file]')).toHaveCount(1);
    await expect(page.getByText('選択されていません')).toHaveCount(0);
    await page.getByRole('button', { name: '下書き保存', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('下書きを保存しました');
    await page.getByRole('button', { name: '変更をまとめて公開', exact: true }).click();
    await expect(confirmation).toContainText('表示順の変更');
    await page.screenshot({ path: testInfo.outputPath('publication-review.png') });
    await confirmation.getByRole('button', { name: '戻る' }).click();
  } finally {
    const current: SiteEditorState = (
      await (await page.request.get('/api/admin/site-content')).json()
    ).data;
    await page.request.put('/api/admin/site-content', {
      data: { revision: current.revision, content: original.draft },
    });
  }
});
