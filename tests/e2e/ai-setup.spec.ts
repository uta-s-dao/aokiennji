import { test, expect } from '@playwright/test';

test('admin distinguishes missing credentials and can save the AI configuration', async ({
  page,
}) => {
  expect((await page.request.post('/api/admin/providers/openai/test')).status()).toBe(401);
  await page.request.post('/api/auth/login', { data: { password: 'aoki-e2e-test-password-only' } });
  const original = (await (await page.request.get('/api/admin/settings')).json()).data;
  try {
    await page.goto('/admin?tab=settings');
    await page.bringToFront();
    await expect(page.getByRole('heading', { name: 'AIチャットの接続設定' })).toBeVisible();
    // The disclosure also supports keyboard activation, including in a background CI tab.
    await page.getByText('ローカル処理とAIの使い分け', { exact: true }).press('Enter');
    await expect(page.getByText('ローカルで確定', { exact: true })).toBeVisible();
    await expect(page.getByText('事実の質問と相談が混在', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '接続を確認' }).first()).toBeDisabled();
    await page.getByRole('button', { name: 'Jev＋OpenAIの構成を選ぶ' }).press('Enter');
    const responseModel = page.getByRole('combobox', { name: '回答生成のモデル名', exact: true });
    await expect(responseModel).toHaveValue('gpt-6-astra');
    await expect(
      page.getByRole('combobox', { name: 'モデル名（省略時は標準）', exact: true }),
    ).toHaveValue('jev-latest');
    await responseModel.selectOption('gpt-6-luna');
    await expect(responseModel).toHaveValue('gpt-6-luna');
    await responseModel.selectOption('gpt-6-astra');
    await expect(page.getByText('生成AIの接続は未完了です。', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: '設定を保存する' }).press('Enter');
    await expect(page.getByText('設定を保存しました。公開画面にも適用されます。')).toBeVisible();
    const settings = (await (await page.request.get('/api/admin/settings')).json()).data;
    expect(settings).toMatchObject({
      decisionProvider: 'jev',
      responseProvider: 'openai',
      responseModel: 'gpt-6-astra',
    });
    await page.reload();
    await expect(responseModel).toHaveValue('gpt-6-astra');
    const check = (await (await page.request.post('/api/admin/providers/openai/test')).json()).data;
    expect(check).toMatchObject({ ok: false });
    expect(check.message).toContain('未設定');
    const stream = await page.request.post('/api/chat', {
      headers: { Accept: 'text/event-stream' },
      data: { message: 'どんなことを相談できますか？' },
    });
    expect(stream.headers()['content-type']).toContain('text/event-stream');
    const events = (await stream.text())
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice(6)));
    expect(events.map((e) => e.type)).toEqual(['status', 'text', 'result']);
    expect(events.at(-1).data.message.responseProvider).toBe('local');
  } finally {
    await page.request.put('/api/admin/settings', { data: original });
  }
});

test('model choices follow the provider and preserve previously saved model identifiers', async ({
  page,
}) => {
  await page.request.post('/api/auth/login', { data: { password: 'aoki-e2e-test-password-only' } });
  const original = (await (await page.request.get('/api/admin/settings')).json()).data;
  try {
    await page.request.put('/api/admin/settings', {
      data: { ...original, responseProvider: 'openai', responseModel: 'gpt-4.1-2025-04-14' },
    });
    await page.goto('/admin?tab=settings');
    await page.bringToFront();
    const model = page.getByRole('combobox', { name: '回答生成のモデル名', exact: true });
    const provider = page.getByRole('combobox', { name: '回答文を生成するAI', exact: true });
    await expect(model).toHaveValue('gpt-4.1-2025-04-14');
    await expect(model.locator('option:checked')).toHaveText('gpt-4.1-2025-04-14（保存済み）');
    await provider.selectOption('gemini');
    await expect(model).toHaveValue('');
    await expect(model.locator('option[value="gpt-6-astra"]')).toHaveCount(0);
    await model.selectOption('gemini-2.5-flash');
    await provider.selectOption('local');
    await expect(model).toBeDisabled();
    await provider.selectOption('openai');
    await expect(model).toBeEnabled();
    await model.selectOption('gpt-6-astra');
    await expect(model).toHaveValue('gpt-6-astra');
  } finally {
    await page.request.put('/api/admin/settings', { data: original });
  }
});

test('shows streamed text before the result and keeps it clear of the composer', async ({
  page,
}) => {
  // Controlled transport: hold the final result until the partial UI is verified.
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = async (input, init) => {
      if (input !== '/api/chat' || new Headers(init?.headers).get('Accept') !== 'text/event-stream')
        return original(input, init);
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(controller) {
            const send = (type: string, data: unknown) =>
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type, data })}\n\n`));
            send('text', 'バルブのご相談ですね。液体の種類を教えてください。');
            (window as unknown as { finishChat: () => void }).finishChat = () => {
              send('result', {
                conversationId: 'stream-ui-test',
                message: {
                  id: 'partial-test',
                  role: 'assistant',
                  content: 'バルブのご相談ですね。液体の種類を教えてください。',
                  createdAt: new Date().toISOString(),
                },
              });
              controller.close();
            };
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: '商品相談チャットを開く' }).click();
  const panel = page.getByRole('dialog', { name: '商品相談チャット' });
  await panel.getByRole('textbox', { name: '相談内容' }).fill('バルブを相談したい');
  await panel.getByRole('button', { name: 'メッセージを送信' }).click();
  await expect(panel.locator('.chat-streaming')).toContainText('液体の種類');
  await expect(panel.locator('.chat-message.assistant')).toHaveCount(0);
  await expect(page.locator('.hero-consult')).toBeHidden();
  const partial = await panel.locator('.chat-streaming').boundingBox();
  const composer = await panel.locator('.chat-compose').boundingBox();
  expect(partial!.y + partial!.height).toBeLessThanOrEqual(composer!.y);
  await page.evaluate(() => (window as unknown as { finishChat: () => void }).finishChat());
  await expect(panel.locator('.chat-message.assistant')).toHaveCount(1);
  await expect(panel.locator('.chat-streaming')).toHaveCount(0);
});
