import { test, expect } from '@playwright/test';

test('chat keeps the topic, reserves space and keeps the composer clear at different sizes', async ({
  page,
}) => {
  await page.goto('/');
  const originalScroll = await page.evaluate(() => window.scrollY);
  await page.getByRole('button', { name: '商品相談チャットを開く' }).click();
  const panel = page.getByRole('dialog', { name: '商品相談チャット' });
  const input = panel.getByRole('textbox', { name: '相談内容' });
  const send = panel.getByRole('button', { name: 'メッセージを送信' });
  await input.fill('DEMO-CAST-01を売っていますか');
  await send.click();
  await expect(panel.locator('.chat-message.assistant')).toHaveCount(1);
  await input.fill('いつぐらいに届く？');
  await send.click();
  await expect(panel.locator('.chat-message.assistant')).toHaveCount(2);
  await expect(panel.locator('.chat-message.assistant').last()).toContainText('確認後3〜5営業日');
  await expect(panel.locator('.chat-message.assistant').last()).not.toContainText(
    '取扱いを確認できません',
  );
  // Follow-ups answer inline, without repeating a full product card.
  await expect(panel.locator('.chat-product')).toHaveCount(1);

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 960, height: 620 },
    { width: 390, height: 660 },
    { width: 390, height: 380 },
  ]) {
    await page.setViewportSize(viewport);
    await expect
      .poll(async () => {
        return page.evaluate(() => {
          const rect = (s: string) => document.querySelector(s)!.getBoundingClientRect();
          const panel = rect('.chat-panel');
          const messages = rect('.chat-messages');
          const composer = rect('.chat-compose');
          const input = rect('.chat-compose textarea');
          const content = rect('.site-content');
          return {
            contained:
              panel.top >= -1 &&
              panel.bottom <= window.innerHeight + 1 &&
              panel.right <= window.innerWidth + 1,
            clear: messages.bottom <= composer.top + 1 && input.bottom <= panel.bottom,
            reserved: window.innerWidth < 1200 || content.right <= panel.left,
            pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
          };
        });
      })
      .toEqual({ contained: true, clear: true, reserved: true, pageOverflow: false });
  }
  await input.fill(
    '複数行の相談です\n追加の条件\n数量について\n配送について\n製品について\n最後の行',
  );
  const textarea = await input.boundingBox();
  expect(textarea!.height).toBeLessThanOrEqual(104);
  const composer = await panel.locator('.chat-compose').boundingBox();
  expect(composer!.y + composer!.height).toBeLessThanOrEqual(381);
  await panel.getByRole('button', { name: 'チャットを閉じる' }).click();
  await expect(panel).toBeHidden();
  await expect(page.locator('.site-content')).not.toHaveAttribute('inert');
  expect(await page.evaluate(() => window.scrollY)).toBe(originalScroll);
  await page.getByRole('button', { name: '商品相談チャットを開く' }).click();
  await panel.getByRole('button', { name: '新しい相談を始める' }).click();
  await input.fill('いつぐらいに届く？');
  await send.click();
  await expect(panel.locator('.chat-message.assistant')).toHaveCount(1);
  await expect(panel.locator('.chat-message.assistant')).toContainText('どの商品');
  await expect(panel.locator('.chat-message.assistant')).not.toContainText(
    '取扱いを確認できません',
  );
});

test('a consultation hands off to the inquiry form with what the customer said', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '商品相談チャットを開く' }).click();
  const panel = page.getByRole('dialog', { name: '商品相談チャット' });
  const input = panel.getByRole('textbox', { name: '相談内容' });
  const send = panel.getByRole('button', { name: 'メッセージを送信' });
  await input.fill('工場の冷却水に使うバルブを探しています。配管は25Aで、手で開け閉めします。');
  await send.click();
  const replies = panel.locator('.chat-message.assistant');
  await expect(replies).toHaveCount(1);
  await expect(replies.last()).toContainText('25A');
  await expect(replies.last()).not.toContainText('もう少し詳しく');
  await input.fill('この内容で担当者に相談したいです');
  await send.click();
  await expect(replies).toHaveCount(2);
  const handoff = panel.getByRole('link', { name: 'この内容で担当者に相談する' });
  await expect(handoff).toBeVisible();
  await handoff.click();
  await expect(page).toHaveURL(/\/contact\?conversationId=/);
  await expect(page.getByLabel('ご相談内容')).toHaveValue(/配管は25A/);
});

test('a consultation left for a long time moves to the past list in this browser', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '商品相談チャットを開く' }).click();
  const panel = page.getByRole('dialog', { name: '商品相談チャット' });
  await panel.getByRole('textbox', { name: '相談内容' }).fill('DEMO-CAST-01を売っていますか');
  await panel.getByRole('button', { name: 'メッセージを送信' }).click();
  await expect(panel.locator('.chat-message.assistant')).toHaveCount(1);
  // Simulate a pause of 13 hours since the last message.
  await page.evaluate(() => {
    const current = JSON.parse(localStorage.getItem('aoki-chat-current')!);
    current.updatedAt = new Date(Date.now() - 13 * 3600 * 1000).toISOString();
    localStorage.setItem('aoki-chat-current', JSON.stringify(current));
  });
  await page.reload();
  await page.getByRole('button', { name: '商品相談チャットを開く' }).click();
  await expect(panel.getByText('何をお探しですか？')).toBeVisible();
  await panel.getByRole('button', { name: /前回の相談を見る/ }).click();
  await expect(panel.locator('.chat-archive')).toContainText('DEMO-CAST-01を売っていますか');
  await expect(panel.locator('.chat-archive')).toContainText('閲覧のみ');
  await panel.getByRole('button', { name: 'この相談を削除' }).click();
  await expect(panel.getByRole('button', { name: '過去の相談' })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('aoki-chat-archive'))).toBe('[]');
});

test('an unregistered item quote keeps its quantity and destination in the form', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '商品相談チャットを開く' }).click();
  const panel = page.getByRole('dialog', { name: '商品相談チャット' });
  await panel
    .getByRole('textbox', { name: '相談内容' })
    .fill('B-300-SCIを10個、大阪までの見積をお願いします');
  await panel.getByRole('button', { name: 'メッセージを送信' }).click();
  const link = panel.getByRole('link', { name: 'この内容で見積を依頼する' });
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(/quote=1/);
  await expect(page.getByLabel('数量', { exact: false })).toHaveValue('10');
  await expect(page.getByLabel('ご相談内容')).toHaveValue(/B-300-SCI/);
  await expect(page.getByLabel('ご相談内容')).toHaveValue(/大阪/);
});
