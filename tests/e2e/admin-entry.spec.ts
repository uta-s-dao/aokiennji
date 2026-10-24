import { test, expect } from '@playwright/test';
import type { AppSettings, Order, Quote } from '../../lib/contracts';

test('staff can create a draft and a pending order, with protected APIs and aligned filters', async ({
  page,
}, testInfo) => {
  const payload = {
    name: `管理者登録テスト ${testInfo.project.name}`,
    company: '画面確認会社',
    email: 'entry@example.invalid',
    message: '',
    notes: '',
    lines: [{ productId: null, name: '手入力品', quantity: 2, unitPrice: 1500 }],
    shipping: 500,
    taxRate: 10,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  };
  for (const path of ['quotes', 'orders']) {
    const response = await page.request.post(`/api/admin/${path}`, { data: payload });
    expect(response.status()).toBe(401);
  }
  const login = await page.request.post('/api/auth/login', {
    data: { password: 'aoki-e2e-test-password-only' },
  });
  expect(login.ok()).toBeTruthy();
  const settings: AppSettings = (await (await page.request.get('/api/admin/settings')).json()).data;
  try {
    expect(
      (
        await page.request.put('/api/admin/settings', {
          data: {
            ...settings,
            flags: { ...settings.flags, quoteRequests: true, orders: true, autoOrder: true },
          },
        })
      ).ok(),
    ).toBeTruthy();
    await page.goto('/admin?tab=quotes');
    await page.getByRole('button', { name: '見積を新規作成' }).click();
    let dialog = page.getByRole('dialog', { name: '見積を新規作成' });
    await dialog.getByLabel('お名前', { exact: true }).fill(payload.name);
    await dialog.getByLabel('会社名', { exact: true }).fill(payload.company);
    await dialog.getByLabel('メールアドレス', { exact: true }).fill(payload.email);
    await dialog.getByLabel('品名', { exact: true }).fill('手入力品');
    await dialog.getByLabel('数量', { exact: true }).fill('2');
    await dialog.getByLabel('単価（税抜・円）', { exact: true }).fill('1500');
    await dialog.getByLabel('送料（税抜・円）', { exact: true }).fill('500');
    await expect(dialog.locator('.quote-totals output')).toHaveText('3,850円');
    await dialog.getByRole('button', { name: '＋ 明細を追加' }).click();
    await expect(dialog.locator('.document-line')).toHaveCount(2);
    await dialog.getByRole('button', { name: '明細2を削除' }).click();
    for (const width of testInfo.project.name === 'mobile-chromium' ? [390, 320] : [1280]) {
      await page.setViewportSize({ width, height: 844 });
      await expect
        .poll(() => dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1))
        .toBe(true);
    }
    await dialog.evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.screenshot({ path: testInfo.outputPath('quote-entry.png'), fullPage: true });
    await dialog.getByRole('button', { name: '見積を下書き保存' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('見積を下書き保存しました', { exact: true })).toBeVisible();
    let quotes: Quote[] = (await (await page.request.get('/api/admin/quotes')).json()).data;
    const quote = quotes.find((q) => q.name === payload.name && q.status === 'draft')!;
    expect(quote).toMatchObject({ total: 3850, name: payload.name });

    await page.goto('/admin?tab=orders');
    await page.getByRole('button', { name: '注文を新規作成' }).click();
    dialog = page.getByRole('dialog', { name: '注文を新規作成' });
    await dialog.getByLabel('お名前', { exact: true }).fill(`${payload.name} 注文`);
    await dialog.getByLabel('メールアドレス', { exact: true }).fill(payload.email);
    await dialog.getByLabel('品名', { exact: true }).fill('電話注文品');
    await dialog.getByLabel('単価（税抜・円）', { exact: true }).fill('2000');
    await expect(dialog.getByRole('button', { name: '承認待ちで注文を作成' })).toBeDisabled();
    await dialog.getByLabel('青木さんによる見積内容の確認済み').check();
    await dialog.getByLabel('お客様の注文内容・注文意思を確認済み').check();
    await dialog.getByRole('button', { name: '承認待ちで注文を作成' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('承認待ちの注文を作成しました', { exact: true })).toBeVisible();
    quotes = (await (await page.request.get('/api/admin/quotes')).json()).data;
    const orderQuote = quotes.find((q) => q.name === `${payload.name} 注文`)!;
    expect(orderQuote.status).toBe('accepted');
    const orders: Order[] = (await (await page.request.get('/api/admin/orders')).json()).data;
    const order = orders.find((o) => o.quoteId === orderQuote.id)!;
    expect(order).toMatchObject({ status: 'pending_approval', total: 2200, externalId: null });
    // An enabled auto-order flag must not bypass staff approval on manual entry.
    await expect(page.getByText(`${payload.name} 注文`, { exact: true })).toBeVisible();
    const approval = await page.request.post(`/api/admin/orders/${order.id}/approve`);
    expect(approval.ok()).toBeTruthy();
    expect((await approval.json()).data.status).toBe('approved');
    await page.goto('/admin?tab=suppliers');
    const add = page.getByRole('button', { name: '仕入先を追加' });
    await expect(add.locator('svg')).toBeVisible();
    await page.goto('/admin?tab=ai-usage');
    const refresh = page.getByRole('button', { name: '再読み込み', exact: true });
    await expect(refresh).toBeEnabled();
    if (testInfo.project.name === 'chromium') {
      const select = await page.getByRole('combobox', { name: '期間で絞り込み' }).boundingBox();
      const button = await refresh.boundingBox();
      expect(Math.abs(select!.y + select!.height - button!.y - button!.height)).toBeLessThanOrEqual(
        1,
      );
    }
    await refresh.click();
    await expect(refresh).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath('reload-alignment.png'), fullPage: true });
  } finally {
    await page.request.put('/api/admin/settings', { data: settings });
  }
});

test('mobile chat opens without focusing the keyboard and keeps controls visible in a short viewport', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/');
  await page.bringToFront();
  await page.getByRole('button', { name: '商品相談チャットを開く' }).click();
  const dialog = page.getByRole('dialog', { name: '商品相談チャット' });
  await expect(dialog).toBeFocused();
  await expect(dialog.getByRole('textbox', { name: '相談内容' })).not.toBeFocused();
  await expect.poll(() => dialog.locator('.chat-messages').evaluate((el) => el.scrollTop)).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('mobile-chat-open.png') });
  await dialog.getByRole('textbox', { name: '相談内容' }).fill('会社の住所を教えて');
  await dialog.getByRole('button', { name: 'メッセージを送信' }).click();
  await expect(dialog.locator('.chat-message.assistant')).toHaveCount(1);
  for (const height of [640, 380]) {
    await page.setViewportSize({ width: 320, height });
    await expect
      .poll(() =>
        dialog.evaluate((el) => {
          const panel = el.getBoundingClientRect();
          const composer = el.querySelector('.chat-compose')!.getBoundingClientRect();
          const thread = el.querySelector('.chat-messages')!.getBoundingClientRect();
          const close = el
            .querySelector('[aria-label="チャットを閉じる"]')!
            .getBoundingClientRect();
          return (
            panel.right <= innerWidth + 1 &&
            panel.bottom <= innerHeight + 1 &&
            thread.bottom <= composer.top + 1 &&
            composer.bottom <= innerHeight + 1 &&
            close.right <= innerWidth
          );
        }),
      )
      .toBe(true);
    expect(
      await dialog
        .locator('.chat-bubble')
        .last()
        .evaluate((el) => getComputedStyle(el).fontSize),
    ).toBe('16px');
  }
  await page.screenshot({ path: testInfo.outputPath('mobile-chat-short.png') });
});
