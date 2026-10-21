import { test, expect } from '@playwright/test';

test('admin persists monitoring settings and reads operational status on desktop and mobile', async ({
  page,
}) => {
  expect((await page.request.get('/api/admin/monitoring')).status()).toBe(401);
  expect((await page.request.get('/api/monitor/health')).status()).toBe(401);
  expect((await page.request.post('/api/monitor/health')).status()).toBe(405);
  expect((await page.request.get('/api/monitor/report')).status()).toBe(405);
  await page.goto('/admin/login');
  await page.getByLabel('パスワード').fill('aoki-e2e-test-password-only');
  await page.getByRole('button', { name: 'ログイン', exact: true }).press('Enter');
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto('/admin?tab=monitoring');
  await expect(page.getByRole('heading', { name: '運用・外部監視', exact: true })).toBeVisible();
  await expect(page.getByText('最終受信：未接続')).toBeVisible();
  await page.getByLabel('外部監視の通知先メール').fill('synthetic-operations@example.org');
  await page.getByLabel('障害と判定する連続回数').fill('4');
  await page.getByRole('button', { name: '監視設定を保存', exact: true }).press('Enter');
  await expect(page.getByRole('status')).toContainText('監視設定を保存しました');
  await page.reload();
  await expect(page.getByLabel('外部監視の通知先メール')).toHaveValue(
    'synthetic-operations@example.org',
  );
  await expect(page.getByLabel('障害と判定する連続回数')).toHaveValue('4');
  const audit = (await (await page.request.get('/api/admin/audit')).json()).data;
  expect(audit.some((e: { action: string }) => e.action === 'monitoring.settings_updated')).toBe(
    true,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '利用枠・停止と再開', exact: true }).press('Enter');
  await expect(page).toHaveURL(/tab=billing/);
});
