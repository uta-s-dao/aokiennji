import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

test('shows usage and persists stop/resume while payment setup is pending', async ({
  page,
}, info) => {
  await page.goto('/admin/login');
  await page.getByLabel('パスワード').fill('aoki-e2e-test-password-only');
  await page.getByRole('button', { name: 'ログイン', exact: true }).press('Enter');
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto('/admin?tab=billing');
  await expect(page.getByRole('heading', { name: '今月のAPI利用状況' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '月額プラン・お支払い' })).toBeVisible();
  await expect(page.getByText('5,000円', { exact: false }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'このプランで申し込む' }).first()).toBeDisabled();
  await page.getByLabel('API原価の月額上限（円）').fill('2500');
  await page.getByLabel('有料APIを一時停止する').press('Space');
  await page.getByRole('button', { name: '設定を保存', exact: true }).press('Enter');
  await expect(page.getByText('有料API停止中：管理者が一時停止中', { exact: false })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('API原価の月額上限（円）')).toHaveValue('2500');
  await expect(page.getByLabel('有料APIを一時停止する')).toBeChecked();
  await page.getByLabel('有料APIを一時停止する').press('Space');
  await page.getByRole('button', { name: '設定を保存', exact: true }).press('Enter');
  await expect(page.getByText('利用可能 —', { exact: false })).toBeVisible();
  const report = (await (await page.request.get('/api/admin/billing')).json()).data;
  expect(report.limitYen).toBe(2500);
  expect(report.history.length).toBeGreaterThanOrEqual(2);
  expect(JSON.stringify(report)).not.toMatch(/sk_test|whsec_|STRIPE_SECRET_KEY/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await mkdir('.data/verification/uta9', { recursive: true });
  // Capture directly: this headless desktop environment can suspend animation
  // frames used by Playwright's screenshot preparation.
  const cdp = await page.context().newCDPSession(page);
  const shot = await cdp.send('Page.captureScreenshot', { captureBeyondViewport: true });
  await writeFile(
    `.data/verification/uta9/billing-${info.project.name}.png`,
    Buffer.from(shot.data, 'base64'),
  );
  await cdp.detach();
});
