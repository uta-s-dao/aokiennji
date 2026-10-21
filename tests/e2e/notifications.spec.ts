import { expect, test } from '@playwright/test';

test('shows saved receipts with mail disabled, including after reload', async ({ page }, info) => {
  const input = {
    name: '通知検証',
    company: '架空会社',
    email: 'fixture@example.net',
    message: '受付通知の表示確認です',
    consent: true,
  };
  const response = await page.request.post('/api/inquiries', {
    headers: { 'Idempotency-Key': `notification-e2e-${info.project.name}` },
    data: input,
  });
  expect(response.status()).toBe(201);
  const receipt = (await response.json()).data;
  await page.goto('/admin/login');
  await page.getByLabel('パスワード').fill('aoki-e2e-test-password-only');
  await page.getByRole('button', { name: 'ログイン', exact: true }).press('Enter');
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto('/admin?tab=notifications');
  await expect(page.getByRole('heading', { name: 'メール送信設定' })).toBeVisible();
  await expect(
    page.getByText('メール送信は無効、または設定待ちです。受付は保存されています。'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '通知待ちを送信', exact: true })).toBeDisabled();
  const row = page.getByRole('row').filter({ hasText: receipt.id });
  await expect(row).toContainText('通知待ち');
  await row.getByRole('button', { name: '送信履歴', exact: true }).press('Enter');
  await expect(page.getByText('送信はまだ試行されていません。')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('row').filter({ hasText: receipt.id })).toContainText('通知待ち');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const report = (await (await page.request.get('/api/admin/notifications')).json()).data;
  expect(report.config.ready).toBe(false);
  expect(
    report.items.find((item: { inquiry_id: string }) => item.inquiry_id === receipt.id).attempts,
  ).toBe(0);
});
