import { test, expect } from '@playwright/test';
import ExcelJS from 'exceljs';
import type { Source } from '../../lib/contracts';

test('private supplier Excel to customer field guidance, contact and disable', async ({
  page,
  playwright,
}, testInfo) => {
  const login = await page.request.post('/api/auth/login', {
    data: { password: 'aoki-e2e-test-password-only' },
  });
  expect(login.ok()).toBeTruthy();
  const customer = await playwright.request.newContext({
    baseURL: 'http://127.0.0.1:3210',
    extraHTTPHeaders: { Origin: 'http://127.0.0.1:3210' },
  });
  const name = `仕入分野テスト ${Date.now()}`;
  let source: Source | undefined;
  try {
    await page.goto('/admin?tab=sources');
    await page.getByRole('button', { name: '情報源を追加', exact: true }).click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('名称', { exact: true }).fill(name);
    await modal
      .getByRole('combobox', { name: '種類', exact: true })
      .selectOption('supplier_catalog');
    await expect(modal.getByRole('combobox', { name: '資料の公開範囲' })).toBeDisabled();
    await modal.getByLabel('承認済みの取扱分野をチャットの回答に使う').check();
    await modal.getByLabel('資料の補足（社内のみ）').fill('主要な取引先のみ。全て取引口座あり。');
    await modal.getByRole('button', { name: '保存する', exact: true }).click();
    const card = page
      .locator('.source-card')
      .filter({ has: page.getByRole('heading', { name, exact: true }) });
    await expect(card).toBeVisible();
    source = ((await (await page.request.get('/api/admin/sources')).json()).data as Source[]).find(
      (s) => s.name === name,
    )!;
    expect((await customer.get(`/api/admin/sources/${source.id}/knowledge`)).status()).toBe(401);
    const visibility = await page.request.put(`/api/admin/sources/${source.id}`, {
      data: { ...source, visibility: 'public' },
    });
    expect(visibility.ok()).toBeTruthy();
    expect((await visibility.json()).data.visibility).toBe('internal');
    await card.getByRole('button', { name: '取込', exact: true }).click();
    const w = new ExcelJS.Workbook();
    const sheet = w.addWorksheet('仕入');
    sheet.addRow(['仕入先', '取扱い品', 'HP', '売買金額']);
    sheet.addRow([
      '非公開テスト株式会社',
      'パッキン等',
      { text: '公式HP', hyperlink: 'https://private-supplier.example.test' },
      987654321,
    ]);
    const auditedUrl = 'https://www.shigotomarugoto.info/JobOffers/view-c?company_id=IIS068002';
    sheet.addRow(['石松測器', '測量機器', { text: '点検対象URL', hyperlink: auditedUrl }, 0]);
    sheet.getCell('D5334').value = 987654321;
    await page.locator('input[type=file]').setInputFiles({
      name: 'private-ledger.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from(await w.xlsx.writeBuffer()),
    });
    await expect(
      page.getByRole('cell', { name: '非公開テスト株式会社', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('cell', { name: 'パッキン', exact: true })).toBeVisible();
    await expect(modal).not.toContainText('987654321');
    await page.getByLabel('回答に使う分野を確認しました').check();
    await page.getByRole('button', { name: 'この内容で取り込む' }).click();
    await expect(page.getByRole('dialog', { name: '取込結果' })).toContainText('追加 2件');
    await page
      .getByRole('dialog', { name: '取込結果' })
      .getByRole('button', { name: '閉じる', exact: true })
      .last()
      .click();
    await card.getByRole('button', { name: '登録内容', exact: true }).click();
    await expect(
      page.getByRole('dialog', { name: '登録した仕入先情報（社内のみ）' }),
    ).toContainText('承認済み 2件');
    const audit = page.getByRole('region', { name: '参照URLと点検理由' });
    await expect(audit.getByRole('listitem')).toHaveCount(2);
    await audit.getByLabel('会社名・URL・理由で絞り込む').fill('石松');
    await expect(audit.getByRole('listitem')).toHaveCount(1);
    await expect(audit.getByRole('link', { name: auditedUrl, exact: true })).toHaveAttribute(
      'href',
      auditedUrl,
    );
    await expect(audit).toContainText('点検日：2026-10-16');
    await expect(audit).toContainText('第三者の求人・企業紹介。商品在庫の取得先としては使わない');
    await page.screenshot({ path: testInfo.outputPath('supplier-site-audit.png'), fullPage: true });
    await audit.getByLabel('会社名・URL・理由で絞り込む').fill('非公開テスト');
    await expect(audit).toContainText('未点検：このURLに対応する点検記録はありません。');
    const registered = (
      await (await page.request.get(`/api/admin/sources/${source.id}/knowledge`)).json()
    ).data;
    expect(
      registered.find((r: { website: string }) => r.website === auditedUrl).siteAudit.fetchStatus,
    ).toBe('fetched');
    expect(
      registered.find((r: { supplierName: string }) => r.supplierName === '非公開テスト株式会社')
        .siteAudit,
    ).toBeUndefined();

    await page.goto('/');
    await page.getByRole('button', { name: '商品相談チャットを開く', exact: true }).click();
    const chat = page.getByRole('dialog', { name: '商品相談チャット' });
    await chat.locator('textarea').fill('ﾊﾟｯｷﾝは扱っていますか？');
    await chat.getByRole('button', { name: 'メッセージを送信' }).click();
    await expect(chat).toContainText('「パッキン」の分野についてご相談いただけます');
    await chat.locator('textarea').fill('在庫は？');
    await chat.getByRole('button', { name: 'メッセージを送信' }).click();
    await expect(chat.locator('.chat-message').last()).toContainText('「パッキン」');
    await expect(chat).not.toContainText('非公開テスト株式会社');
    await expect(chat).not.toContainText('private-supplier.example.test');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBeTruthy();
    await chat.getByRole('link', { name: '当社へのお問い合わせ' }).click();
    await page.getByLabel('お名前').fill('分野案内の確認');
    await page.getByLabel('メールアドレス').fill('knowledge-test@example.com');
    await page.getByLabel('ご相談内容').fill('パッキンの仕様について相談したい');
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: '内容を送信する' }).click();
    await expect(page.getByText('お問い合わせを受け付けました', { exact: true })).toBeVisible();

    const answer = await customer.post('/api/chat', {
      data: { message: 'パッキンはありますか？' },
    });
    const answerData = (await answer.json()).data;
    for (const secret of [
      '非公開テスト株式会社',
      'private-supplier.example.test',
      '987654321',
      source.id,
      'private-ledger.xlsx',
      '石松測器',
      'shigotomarugoto.info',
      '第三者の求人・企業紹介',
    ])
      expect(JSON.stringify(answerData)).not.toContain(secret);
    const denied = await customer.post('/api/chat', {
      data: { message: '仕入先のHPを教えて', conversationId: answerData.conversationId },
    });
    expect((await denied.json()).data.message.content).toContain('公開していません');

    await page.goto('/admin?tab=sources');
    await card.getByRole('button', { name: '編集', exact: true }).click();
    await page.getByLabel('承認済みの取扱分野をチャットの回答に使う').uncheck();
    await page.getByRole('button', { name: '保存する', exact: true }).click();
    await expect(card).toContainText('分野案内：利用しない');
    const history = (await (await customer.get(`/api/chat/${answerData.conversationId}`)).json())
      .data;
    const restored = Array.isArray(history) ? history : history.messages;
    expect(
      restored
        .filter((m: { role: string }) => m.role === 'assistant')
        .some((m: { content: string }) => m.content.includes('「パッキン」')),
    ).toBeFalsy();
    const stopped = await customer.post('/api/chat', {
      data: { message: 'パッキンはありますか？' },
    });
    expect((await stopped.json()).data.message.knowledge).toBeUndefined();
  } finally {
    if (source) await page.request.delete(`/api/admin/sources/${source.id}`);
    await customer.dispose();
  }
});
