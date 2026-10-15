import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ResearchNote } from '../../lib/contracts';

test('staff confirms source conditions and the chat presents all selling terms with a quote handoff', async ({
  page,
}, testInfo) => {
  // Only the source-page facts are fixtures; the admin form, API, calculation,
  // public chat and contact form all run against the real disposable test DB.
  await page.goto('/');
  await page.getByRole('button', { name: '商品相談チャットを開く' }).click();
  let panel = page.getByRole('dialog', { name: '商品相談チャット' });
  await panel.getByRole('textbox', { name: '相談内容' }).fill('B-300-SCIは取り寄せできますか？');
  await panel.getByRole('button', { name: 'メッセージを送信' }).click();
  await expect(panel.locator('.chat-message.assistant')).toHaveCount(1);
  const conversationId = await page.evaluate(
    () => JSON.parse(localStorage.getItem('aoki-chat-current')!).id as string,
  );
  const checkedAt = new Date().toISOString();
  const note: ResearchNote = {
    id: randomUUID(),
    conversationId,
    turnId: randomUUID(),
    subject: 'B-300-SCI',
    status: 'done',
    createdAt: checkedAt,
    completedAt: checkedAt,
    findings: [],
    aspects: ['availability', 'price'],
    summary: 'ブラウザー試験用の架空調達条件です。',
    decidedBy: 'local',
    sourcing: { model: 'B-300-SCI', status: 'candidate', checkedAt },
    offers: [
      {
        id: randomUUID(),
        model: 'B-300-SCI',
        title: '試験用の調達候補',
        url: 'https://supplier.example/item',
        price: 1100,
        taxIncluded: null,
        purchaseTaxRate: null,
        packQuantity: null,
        availableQuantity: null,
        procurementShippingNet: null,
        customerShippingNet: null,
        destination: '',
        deliveryMinDays: null,
        deliveryMaxDays: null,
        approved: false,
        checkedAt,
        confirmedAt: null,
      },
    ],
  };
  const directory = process.env.AOKI_E2E_DATA_DIR;
  if (!directory || !directory.includes('aoki-eng-e2e-'))
    throw Error('Disposable test database required');
  const db = new Database(join(directory, 'aokienji.sqlite'), { fileMustExist: true });
  try {
    db.prepare(
      'INSERT INTO research_notes(id,conversation_id,created_at,json) VALUES(?,?,?,?)',
    ).run(note.id, conversationId, checkedAt, JSON.stringify(note));
  } finally {
    db.close();
  }

  const login = await page.request.post('/api/auth/login', {
    data: { password: 'aoki-e2e-test-password-only' },
  });
  expect(login.ok()).toBe(true);
  const original = (await (await page.request.get('/api/admin/settings')).json()).data;
  try {
    await page.goto('/admin?tab=conversations');
    await page.locator('.conversation-list > button').first().click();
    await page
      .getByText('AI調査メモ（担当者用・お客様には表示されません）', { exact: true })
      .click();
    await page.getByText('販売概算用の調達条件：', { exact: false }).click();
    const editor = page.locator('.procurement-offer');
    await editor.getByLabel('仕入価格の税区分').selectOption('true');
    await editor.getByLabel('仕入時の税率').selectOption('10');
    await editor.getByLabel('1販売単位あたりの入数（個）').fill('1');
    await editor.getByLabel('確認できた調達可能数量（個）').fill('20');
    await editor.getByLabel('配送条件を確認したお届け先').selectOption('大阪');
    await editor.getByLabel('お客様への請求送料（税抜・円）').fill('800');
    await editor.getByLabel('お届けまでの最短営業日数').fill('2');
    await editor.getByLabel('お届けまでの最長営業日数').fill('3');
    await editor.getByRole('checkbox').check();
    await editor.getByRole('button', { name: '調達条件を保存', exact: true }).click();
    await expect(editor.getByRole('status')).toContainText('調達条件を保存しました');
    await page.screenshot({ path: testInfo.outputPath('confirmed-source.png'), fullPage: true });

    await page.goto('/admin?tab=settings');
    await page.getByLabel('原価への上乗せ率（%・粗利率ではありません）').fill('20');
    await page.getByLabel('1案件あたりの最低利益（税抜・円）').fill('0');
    await page.getByLabel('1案件あたりの手配料（税抜・円）').fill('0');
    await page.getByLabel('単価の切り上げ単位').selectOption('10');
    await page.getByLabel('確認済みの配送日数に加える営業日数').fill('1');
    await page.getByLabel('チャットで販売概算を案内する').check();
    await expect(page.getByLabel('原価への上乗せ率（%・粗利率ではありません）')).toHaveValue('20');
    await expect(page.getByLabel('1案件あたりの最低利益（税抜・円）')).toHaveValue('0');
    await expect(page.getByLabel('1案件あたりの手配料（税抜・円）')).toHaveValue('0');
    await page.getByRole('button', { name: '設定を保存する' }).click();
    await expect(page.getByText('設定を保存しました。公開画面にも適用されます。')).toBeVisible();
    const configured = (await (await page.request.get('/api/admin/settings')).json()).data;
    // Web search is enabled, but the fresh fixture makes this test independent of network services.
    expect(
      (
        await page.request.put('/api/admin/settings', {
          data: {
            ...configured,
            searchProvider: 'exa',
            flags: { ...configured.flags, webSearch: true },
          },
        })
      ).ok(),
    ).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('selling-policy.png'), fullPage: true });

    await page.goto('/');
    await page.getByRole('button', { name: '商品相談チャットを開く' }).click();
    panel = page.getByRole('dialog', { name: '商品相談チャット' });
    await panel
      .getByRole('textbox', { name: '相談内容' })
      .fill('B-300-SCIを10個、大阪までの価格と納期を教えてください');
    await panel.getByRole('button', { name: 'メッセージを送信' }).click();
    const reply = panel.locator('.chat-message.assistant .chat-bubble').last();
    await expect(reply).toContainText('合計（税込）：14,080円');
    await expect(reply).toContainText('送料（税抜）：800円');
    await expect(reply).toContainText('3～4営業日');
    await expect(reply).not.toContainText('supplier.example');
    await page.screenshot({ path: testInfo.outputPath('complete-selling-estimate.png') });
    const restored = (await (await page.request.get(`/api/chat/${conversationId}`)).json()).data;
    expect(JSON.stringify(restored)).not.toContain('supplier.example');
    await panel.getByRole('link', { name: 'この内容で見積を依頼する' }).last().click();
    await expect(page.getByLabel('数量')).toHaveValue('10');
    await expect(page.getByLabel('ご相談内容')).toHaveValue(/合計（税込）：14,080円/);
  } finally {
    await page.request.put('/api/admin/settings', { data: original });
  }
});
