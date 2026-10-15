import { test, expect } from '@playwright/test';
import type {
  AiAnswer,
  AiAnswerReport,
  AiCall,
  ChatMessage,
  ChatResponse,
  Conversation,
} from '../../lib/contracts';

test('all consultations remain in admin after browser history deletion, with customer left and chat right', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '商品相談チャットを開く' }).click();
  const panel = page.getByRole('dialog', { name: '商品相談チャット' });
  const input = panel.getByRole('textbox', { name: '相談内容' });
  const questions = ['DEMO-CAST-01の価格を教えてください', 'いつぐらいに届く？'];
  for (const [i, question] of questions.entries()) {
    await input.fill(question);
    await panel.getByRole('button', { name: 'メッセージを送信' }).click();
    await expect(panel.locator('.chat-message.assistant')).toHaveCount(i + 1);
  }
  await expect
    .poll(() => page.evaluate(() => !!localStorage.getItem('aoki-chat-current')))
    .toBe(true);
  const original = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('aoki-chat-current')!),
  );
  const originalReplies = await panel
    .locator('.chat-message.assistant .chat-bubble')
    .allTextContents();
  await panel.getByRole('button', { name: '新しい相談を始める' }).click();
  await input.fill('こんにちは');
  await panel.getByRole('button', { name: 'メッセージを送信' }).click();
  await expect(panel.locator('.chat-message.assistant')).toHaveCount(1);
  await panel.getByRole('button', { name: '過去の相談', exact: true }).click();
  await panel.getByRole('button', { name: 'すべて削除', exact: true }).click();
  expect(await page.evaluate(() => localStorage.getItem('aoki-chat-archive'))).toBe('[]');

  // Resume the older chat to verify that the list orders by its latest turn.
  const resumedResponse = await page.request.post('/api/chat', {
    data: { message: 'ありがとうございます', conversationId: original.id },
  });
  expect(resumedResponse.ok()).toBeTruthy();
  const resumed: ChatResponse = (await resumedResponse.json()).data;
  const login = await page.request.post('/api/auth/login', {
    data: { password: 'aoki-e2e-test-password-only' },
  });
  expect(login.ok()).toBeTruthy();
  const response = await page.request.get('/api/admin/conversations');
  const conversations: Conversation[] = (await response.json()).data;
  expect(conversations[0].id).toBe(original.id);
  expect(conversations.length).toBeGreaterThanOrEqual(2);
  const detailResponse = await page.request.get(`/api/admin/conversations/${original.id}`);
  const detail: { messages: ChatMessage[] } = (await detailResponse.json()).data;
  expect(detail.messages).toHaveLength(6);
  expect(detail.messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual([
    ...questions,
    'ありがとうございます',
  ]);
  expect(detail.messages.filter((m) => m.role === 'assistant').map((m) => m.content)).toEqual([
    ...originalReplies,
    resumed.message.content,
  ]);

  await page.goto('/admin?tab=conversations');
  await page.locator('.conversation-list > button').first().click();
  const history = page.getByRole('log', { name: 'チャットの会話履歴' });
  await expect(history.locator('.chat-message')).toHaveCount(6);
  await expect(history.locator('time')).toHaveCount(6);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await history.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const customer = el.querySelector('.user')!;
      const assistant = el.querySelector('.assistant')!;
      const left = customer.getBoundingClientRect();
      const right = assistant.getBoundingClientRect();
      const colors = (node: Element) =>
        getComputedStyle(node.querySelector('.chat-bubble')!).backgroundColor;
      return {
        aligned: left.left < right.left && left.right < right.right,
        contained:
          left.left >= rect.left && right.right <= rect.right && el.scrollWidth <= el.clientWidth,
        customerColor: colors(customer),
        assistantColor: colors(assistant),
        overflow: document.documentElement.scrollWidth > window.innerWidth,
      };
    });
    expect(layout).toEqual({
      aligned: true,
      contained: true,
      customerColor: 'rgb(255, 255, 255)',
      assistantColor: 'rgb(217, 242, 223)',
      overflow: false,
    });
  }
  // The AI usage page is answer-centric and includes deterministic replies.
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  await page.goto('/admin?tab=ai-usage');
  await expect(page.getByRole('heading', { name: '回答ごとのAI利用記録' })).toBeVisible();
  const cards = page.getByRole('article', { name: '回答の利用記録' });
  const answerResponse = await page.request.get('/api/admin/ai-answers');
  const answerReport: AiAnswerReport = (await answerResponse.json()).data;
  expect(answerReport.total).toBeGreaterThanOrEqual(4);
  await expect(cards).toHaveCount(answerReport.items.length);
  expect(
    answerReport.items.every(
      (a) => a.responseProvider === 'local' && a.linkage === 'recorded' && a.calls.length === 0,
    ),
  ).toBe(true);
  const first = cards.first();
  await first.getByText('この回答のAI・処理詳細', { exact: true }).click();
  await expect(
    first.getByText('この回答にAIのAPI呼び出しはありません。', { exact: true }),
  ).toBeVisible();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '表示中の記録をJSON保存' }).click();
  const download = await downloadEvent;
  const stream = await download.createReadStream();
  let exported = '';
  for await (const chunk of stream!) exported += chunk.toString();
  const records = JSON.parse(exported);
  expect(records.answers.items).toHaveLength(answerReport.items.length);
  expect(exported).not.toContain(questions[0]);
  await first.getByRole('button', { name: '会話と回答を確認' }).click();
  const modal = page.getByRole('dialog', { name: '回答とAI処理の詳細' });
  const selected = modal.locator('.ai-usage-selected');
  await expect(selected).toHaveClass(/assistant/);
  await expect(selected.getByText('この回答のAI・処理詳細', { exact: true })).toBeVisible();
  await expect(selected.locator('.admin-answer-details')).toHaveAttribute('open', '');
  await expect(modal.locator('.user .ai-usage-selected')).toHaveCount(0);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await modal.evaluate((el) => ({
        contained: el.scrollWidth <= el.clientWidth,
        noOverflow: document.documentElement.scrollWidth <= window.innerWidth,
        color: getComputedStyle(el.querySelector('.assistant .chat-bubble')!).backgroundColor,
      })),
    ).toEqual({ contained: true, noOverflow: true, color: 'rgb(217, 242, 223)' });
  }
  await modal.getByRole('button', { name: '閉じる', exact: true }).click();
  await page.getByLabel('APIで絞り込み').selectOption('openai');
  await expect(page.getByText('この条件の回答記録はありません', { exact: true })).toBeVisible();
  await page.getByLabel('APIで絞り込み').selectOption('local');
  await expect(cards).toHaveCount(answerReport.items.length);
  await page.getByLabel('用途で絞り込み').selectOption('connection_check');
  await expect(page.getByRole('heading', { name: '接続確認の明細' })).toBeVisible();
  await expect(
    page.getByText('この条件のAPI呼び出し記録はありません', { exact: true }),
  ).toBeVisible();
  const guest = await page.context().browser()!.newContext({ baseURL: 'http://127.0.0.1:3210' });
  expect((await guest.request.get('/api/admin/ai-answers')).status()).toBe(401);
  await guest.close();
});

test('each answer shows its recorded AI model, retries and final fallback', async ({
  page,
}, testInfo) => {
  expect(
    (
      await page.request.post('/api/auth/login', {
        data: { password: 'aoki-e2e-test-password-only' },
      })
    ).ok(),
  ).toBeTruthy();
  const createdAt = '2026-10-15T05:41:42.000Z';
  const makeCall = (
    id: string,
    provider: AiCall['provider'],
    purpose: AiCall['purpose'],
    outcome: AiCall['outcome'] = 'accepted',
  ): AiCall => ({
    id,
    createdAt,
    completedAt: createdAt,
    provider,
    purpose,
    context: { scope: 'chat', conversationId: 'preview', turnId: 'question-1' },
    model: `${provider}-recorded-model`,
    endpoint: `https://${provider}.example.test/v1/response`,
    method: 'POST',
    requestBytes: 1024,
    requestShape: { bodyKeys: ['input', 'model'] },
    httpStatus: 200,
    requestId: `request-${id}`,
    durationMs: 1200,
    outcome,
    errorCode: outcome === 'rejected' ? 'unsupported_number' : null,
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cachedInputTokens: 10,
      reasoningTokens: null,
    },
  });
  const generated: AiAnswer = {
    id: 'answer-1',
    conversationId: 'preview',
    content: '材質は使用する場所や荷重によって選びます。使用する環境を教えていただけますか？',
    createdAt,
    incomplete: false,
    responseProvider: 'openai',
    route: 'consultation',
    linkage: 'recorded',
    processing: {
      classificationProvider: 'jev',
      responseProvider: 'openai',
      responseMode: 'ai',
      responseReason: 'success',
      responseModel: 'openai-recorded-model',
      durationMs: 2400,
      webSearch: false,
    },
    calls: [
      makeCall('classify', 'jev', 'classification'),
      makeCall('generate', 'openai', 'response'),
    ],
  };
  const fallback: AiAnswer = {
    ...generated,
    id: 'answer-2',
    content: '価格は仕様と数量をもとに担当者が確認します。',
    responseProvider: 'local',
    processing: {
      ...generated.processing!,
      classificationProvider: 'local',
      responseProvider: 'local',
      responseReason: 'failed_or_ungrounded',
      responseModel: null,
    },
    calls: [
      makeCall('rejected-1', 'openai', 'response', 'rejected'),
      makeCall('rejected-2', 'openai', 'response', 'rejected'),
    ],
  };
  await page.route('**/api/admin/ai-answers?*', (route) =>
    route.fulfill({ json: { data: { total: 2, items: [generated, fallback] } } }),
  );
  await page.route('**/api/admin/conversations/preview', (route) =>
    route.fulfill({
      json: {
        data: {
          conversation: {
            id: 'preview',
            title: '表示検証用の会話',
            status: 'open',
            createdAt,
            updatedAt: createdAt,
          },
          research: [],
          answers: [generated, fallback],
          messages: [
            { id: 'question-1', role: 'user', content: '材質の違いを知りたいです。', createdAt },
            { id: generated.id, role: 'assistant', content: generated.content, createdAt },
            { id: 'question-2', role: 'user', content: '価格はいくらですか？', createdAt },
            { id: fallback.id, role: 'assistant', content: fallback.content, createdAt },
          ],
        },
      },
    }),
  );
  await page.goto('/admin?tab=ai-usage');
  const cards = page.getByRole('article', { name: '回答の利用記録' });
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText('OpenAI / openai-recorded-model');
  await cards.first().locator('.admin-answer-details > summary').click();
  await expect(cards.first()).toContainText('Jev / TypeSafe / jev-recorded-model');
  await expect(cards.first()).toContainText('回答文の生成');
  await expect(cards.first().getByText(/回答文の作成：/)).toHaveCount(1);
  await expect(cards.first().getByText('回答の準備・判定', { exact: true })).toHaveCount(0);
  await expect(cards.first().getByText('回答前のWeb検索', { exact: true })).toHaveCount(0);
  await cards.last().locator('.admin-answer-details > summary').click();
  await expect(cards.last()).toContainText('登録情報・ルールで回答');
  await expect(cards.last().locator('.ai-call-outcome.rejected')).toHaveCount(2);
  await expect(cards.last()).toContainText('登録情報・ルールの文章で回答しました');
  await cards.first().getByRole('button', { name: '会話と回答を確認' }).click();
  const modal = page.getByRole('dialog', { name: '回答とAI処理の詳細' });
  await expect(modal.locator('.ai-usage-selected')).toHaveClass(/assistant/);
  await expect
    .poll(() =>
      modal.evaluate(
        (el) =>
          el.querySelector('.ai-usage-selected .chat-bubble')!.getBoundingClientRect().top >=
          el.querySelector('header')!.getBoundingClientRect().bottom,
      ),
    )
    .toBe(true);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await modal.evaluate(
        (el) =>
          el.scrollWidth <= el.clientWidth &&
          document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`answer-details-${width}.png`) });
  }
});

test('legacy answers omit missing processing fields while keeping AI uses and candidate prices', async ({
  page,
}, testInfo) => {
  expect(
    (
      await page.request.post('/api/auth/login', {
        data: { password: 'aoki-e2e-test-password-only' },
      })
    ).ok(),
  ).toBeTruthy();
  const createdAt = '2026-10-15T08:30:29.932Z';
  const answer: AiAnswer = {
    id: 'legacy-answer',
    conversationId: 'legacy-preview',
    content: '「B-300-SCI」の調達候補を確認できました。',
    createdAt,
    incomplete: false,
    responseProvider: 'local',
    route: 'sourcing',
    processing: null,
    linkage: 'legacy',
    calls: [
      {
        id: 'search-call',
        createdAt,
        completedAt: createdAt,
        provider: 'openai',
        purpose: 'research',
        model: 'search-recorded-model',
        context: { scope: 'chat', conversationId: 'legacy-preview', turnId: 'question' },
        endpoint: 'https://api.example.test/search',
        method: 'POST',
        requestBytes: 100,
        requestShape: { scope: 'product_sourcing' },
        httpStatus: 200,
        requestId: null,
        durationMs: 1200,
        outcome: 'accepted',
        errorCode: null,
        usage: null,
      },
    ],
  };
  await page.route('**/api/admin/ai-answers?*', (route) =>
    route.fulfill({
      json: { data: { total: 1, items: [answer] } },
    }),
  );
  await page.route('**/api/admin/conversations/legacy-preview', (route) =>
    route.fulfill({
      json: {
        data: {
          conversation: {
            id: 'legacy-preview',
            title: '価格表示の確認',
            status: 'open',
            createdAt,
            updatedAt: createdAt,
          },
          messages: [{ id: answer.id, role: 'assistant', content: answer.content, createdAt }],
          answers: [answer],
          research: [
            {
              id: 'reference-prices',
              conversationId: 'legacy-preview',
              turnId: 'question',
              subject: 'B-300-SCI',
              status: 'done',
              createdAt,
              completedAt: createdAt,
              sourcing: { model: 'B-300-SCI', status: 'identified', checkedAt: createdAt },
              aspects: ['availability', 'price'],
              decidedBy: 'jev',
              summary: '',
              offers: [],
              findings: ['matsuyoshi', 'rikanavi'].flatMap((name) => [
                {
                  url: `https://${name}.example.test/item`,
                  title: name,
                  source: 'other',
                  check: 'matched',
                  relevance: 0.84,
                  itemOnPage: true,
                  aspect: 'availability',
                  value: '型番の一致を確認',
                  note: '',
                },
                {
                  url: `https://${name}.example.test/item`,
                  title: name,
                  source: 'other',
                  check: 'matched',
                  relevance: 0.84,
                  itemOnPage: true,
                  aspect: 'price',
                  value: '標準価格:720円(税抜)',
                  note: '実際の仕入価格は要確認。',
                },
              ]),
            },
          ],
        },
      },
    }),
  );
  await page.goto('/admin?tab=ai-usage');
  const card = page.getByRole('article', { name: '回答の利用記録' });
  await card.locator('.admin-answer-details > summary').click();
  await expect(card.getByText(/回答文の作成：/)).toHaveCount(1);
  await expect(card.getByText('OpenAI / search-recorded-model', { exact: true })).toBeVisible();
  await expect(card.getByText('商品のWeb検索', { exact: true })).toBeVisible();
  await expect(card.getByText(/未記録/)).toHaveCount(0);
  await card.getByRole('button', { name: '会話と回答を確認' }).click();
  const modal = page.getByRole('dialog', { name: '回答とAI処理の詳細' });
  await expect(modal.getByText(/未記録/)).toHaveCount(0);
  await modal
    .getByText('AI調査メモ（担当者用・お客様には表示されません）', { exact: true })
    .click();
  const sources = modal.locator('.research-source');
  await expect(sources).toHaveCount(2);
  for (const source of await sources.all()) {
    await expect(source.getByRole('link')).toBeVisible();
    await expect(source.getByText('価格：標準価格:720円(税抜)', { exact: true })).toBeVisible();
    await expect(source.getByText('ページで確認済み', { exact: true })).toHaveCount(1);
    await expect(source.getByText(/品目の一致/)).toHaveCount(0);
  }
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await modal.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`simplified-candidates-${width}.png`) });
  }
});
