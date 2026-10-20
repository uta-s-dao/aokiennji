import { test, expect } from '@playwright/test';
import type { AdminConversation, SourceVerificationReport } from '../../lib/source-verification';

test('the chat history keeps all batches of API tests and every turn of the customer simulations', async ({
  page,
  request,
}, testInfo) => {
  expect((await request.get('/api/admin/conversations')).status()).toBe(401);
  expect((await request.get('/api/admin/source-verification')).status()).toBe(401);
  const normal = (
    await (
      await page.request.post('/api/chat', {
        data: { message: 'こんにちは。履歴の確認です。' },
      })
    ).json()
  ).data;
  expect(
    (
      await page.request.post('/api/auth/login', {
        data: { password: 'aoki-e2e-test-password-only' },
      })
    ).ok(),
  ).toBe(true);
  const report: SourceVerificationReport = (
    await (await page.request.get('/api/admin/source-verification')).json()
  ).data;
  const conversations: AdminConversation[] = (
    await (await page.request.get('/api/admin/conversations')).json()
  ).data;
  expect(conversations.filter((c) => c.verification)).toHaveLength(report.scenarios.length);
  expect(
    report.scenarios.filter(
      (s) => s.id.startsWith('staged-') && !s.id.startsWith('staged-natural-'),
    ),
  ).toHaveLength(2);
  expect(report.scenarios.filter((s) => s.id.startsWith('staged-natural-'))).toHaveLength(10);
  expect(conversations.some((c) => c.id === normal.conversationId && !c.verification)).toBe(true);
  expect(
    (await request.get(`/api/admin/conversations/${report.scenarios[0].conversationId}`)).status(),
  ).toBe(401);
  expect((await request.get(`/api/chat/${report.scenarios[0].conversationId}`)).ok()).toBe(false);
  const simulation = report.scenarios.find((s) => s.simulation)!;
  expect(
    (await request.get(`/api/admin/conversations/${simulation.conversationId}`)).status(),
  ).toBe(401);
  expect((await request.get(`/api/chat/${simulation.conversationId}`)).ok()).toBe(false);
  await page.goto('/admin?tab=conversations');
  await page.bringToFront();
  await expect(
    page.getByRole('heading', { name: `チャットの履歴（${conversations.length}件）`, exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '検索の検証記録', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '実API検証10問を見る' })).toHaveCount(0);
  const list = page.locator('.conversation-list');
  await expect(list.locator('button')).toHaveCount(conversations.length);
  await expect(list.locator('button').filter({ hasText: '実API検証' })).toHaveCount(10);
  await expect(list.locator('button').filter({ hasText: '顧客会話検証' })).toHaveCount(
    report.scenarios.filter((s) => s.simulation).length,
  );
  for (const scenario of report.scenarios) {
    await list.locator(`button[data-conversation-id="${scenario.conversationId}"]`).click();
    const modal = page.getByRole('dialog');
    const history = modal.getByRole('log', { name: 'チャットの会話履歴' });
    await expect(history.locator('.user .chat-bubble')).toHaveText(
      scenario.messages?.filter((m) => m.role === 'user').map((m) => m.content) || [
        scenario.question,
      ],
    );
    await expect(history.locator('.assistant .chat-bubble')).toHaveText(
      scenario.messages?.filter((m) => m.role === 'assistant').map((m) => m.content) || [
        scenario.response,
      ],
    );
    await expect(history.locator('.source-trace > summary')).toHaveCount(
      scenario.answers?.length || 1,
    );
    if (scenario.simulation) {
      await modal.getByText('会話の検証結果', { exact: true }).click();
      if (scenario.simulation.quoteOutcome) {
        await expect(modal.getByText(/見積依頼：受付済み/)).toContainText('正式見積：未発行');
        await expect(modal.getByText(/見積依頼：受付済み/)).toContainText('注文：なし');
      }
      await expect(
        modal.getByText(scenario.simulation.review!.summary, { exact: false }),
      ).toBeVisible();
      await expect(modal.getByRole('button', { name: 'この会話の全記録をJSON保存' })).toBeVisible();
      if (scenario.id === 'customer-07') {
        await expect(
          modal.getByText('回答と検索記録の照合で見つかった問題', { exact: true }),
        ).toBeVisible();
        for (const finding of scenario.simulation.technicalFindings || []) {
          await expect(
            modal.getByText(`第${finding.turn}回答：${finding.detail}`, { exact: false }),
          ).toBeVisible();
        }
        const downloadEvent = (await page.waitForEvent('download'));
        await modal.getByRole('button', { name: 'この会話の全記録をJSON保存' }).click();
        const stream = await (await downloadEvent).createReadStream();
        let text = '';
        for await (const chunk of stream!) text += chunk.toString();
        expect(JSON.parse(text)).toEqual(scenario);
      }
    }
    if (scenario.id === '01-reference-stud') {
      await history.locator('.source-trace > summary').click();
      await expect(
        history.getByRole('link', { name: 'https://www.asiagiken.co.jp/products/product01.html' }),
      ).toBeVisible();
      await modal
        .getByText('AI調査メモ（担当者用・お客様には表示されません）', { exact: true })
        .click();
      await expect(modal.locator('.research-source')).not.toHaveCount(0);
      await expect(modal.locator('.procurement-offer')).toHaveCount(0);
    }
    if (scenario.id === '08-sensor-deadline') {
      await history.getByText('この回答のAI・処理詳細', { exact: true }).click();
      const failed = history.locator('.ai-call-technical').filter({ hasText: 'invalid_json' });
      await failed.locator('summary').click();
      await expect(failed.getByText('エラーコード：invalid_json')).toBeVisible();
      const downloadEvent = (await page.waitForEvent('download'));
      await modal.getByRole('button', { name: 'この質問の全記録をJSON保存' }).click();
      const stream = await (await downloadEvent).createReadStream();
      let text = '';
      for await (const chunk of stream!) text += chunk.toString();
      const saved = JSON.parse(text);
      expect(saved).toEqual(scenario);
      expect(
        saved.aiCalls.items.some(
          (call: { errorCode: string }) => call.errorCode === 'invalid_json',
        ),
      ).toBe(true);
    }
    await modal.getByRole('button', { name: '閉じる', exact: true }).click();
  }
  await page.screenshot({ path: testInfo.outputPath('unified-chat-history.png'), fullPage: true });
  await page.goto(`/admin?tab=source-verification&case=08-sensor-deadline`);
  await expect(page).toHaveURL(
    new RegExp(`tab=conversations&conversation=${report.scenarios[7].conversationId}`),
  );
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('log').locator('.user .chat-bubble')).toHaveText(
    report.scenarios[7].question,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
