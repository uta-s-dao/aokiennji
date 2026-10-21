import { expect, test } from '@playwright/test';
test('admin can run cleanup and read its durable history without exposing backup execution', async ({
  page,
}) => {
  expect((await page.request.post('/api/jobs/run')).status()).toBe(401);
  expect((await page.request.get('/api/admin/jobs')).status()).toBe(401);
  await page.goto('/admin/login');
  await page.getByLabel('パスワード').fill('aoki-e2e-test-password-only');
  await page.getByRole('button', { name: 'ログイン', exact: true }).press('Enter');
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto('/admin?tab=jobs');
  await expect(
    page.getByRole('heading', { name: '定期処理・バックアップ', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('無効・配備待ち', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '期限切れ整理', exact: true }).press('Enter');
  await expect(page.getByRole('row').filter({ hasText: '期限切れ整理' }).first()).toContainText(
    '成功',
  );
  await page.reload();
  await expect(page.getByRole('row').filter({ hasText: '期限切れ整理' }).first()).toContainText(
    '成功',
  );
  expect((await page.request.post('/api/admin/jobs', { data: { job: 'backup' } })).status()).toBe(
    400,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
