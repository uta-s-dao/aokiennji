import { test, expect } from '@playwright/test';
import { db as appDb } from '../../lib/server/db';
import type { ChatResponse, SourceTrace, StoredChatMessage } from '../../lib/contracts';

test('staff can inspect the source and fallback path of an individual answer while public history excludes it', async ({
  page,
  request,
}, testInfo) => {
  const response = await page.request.post('/api/chat', {
    data: { message: 'ABC-100の在庫を確認したいです' },
  });
  expect(response.ok()).toBe(true);
  const reply: ChatResponse = (await response.json()).data;
  const stamp = new Date().toISOString();
  const trace: SourceTrace = {
    version: 1,
    preferredSites: [
      {
        name: '検証用の社内参照先',
        url: 'https://private-reference.example/catalog',
        domain: 'private-reference.example',
        kind: 'source',
        eligible: true,
        reason: '情報源に登録',
      },
    ],
    stages: [
      {
        scope: 'registered_data',
        startedAt: stamp,
        completedAt: stamp,
        status: 'done',
        query: 'ABC-100',
        domains: [],
        returnedUrls: [],
        reason: '登録資料に一致なし',
      },
      {
        scope: 'preferred_sites',
        startedAt: stamp,
        completedAt: stamp,
        status: 'done',
        query: 'ABC-100',
        domains: ['private-reference.example'],
        returnedUrls: [],
        reason: '優先参照先に該当する商品の記載を確認できず',
      },
      {
        scope: 'public_web',
        startedAt: stamp,
        completedAt: stamp,
        status: 'done',
        query: 'ABC-100',
        domains: [],
        returnedUrls: ['https://external-example.test/item'],
        reason: '優先参照先で見つからなかったため外部Webへ拡張',
      },
    ],
    observations: [
      {
        title: '検証用の商品ページ',
        url: 'https://external-example.test/item',
        origin: 'public_web',
        outcome: 'candidate',
        reason: '型番一致・見積窓口の記載あり。条件未確認',
        excerpt: 'ABC-100 在庫表示なし。お見積りはこちら。',
        retrievedAt: stamp,
      },
    ],
    conclusion: '外部Webで照会候補を確認。必要数量の在庫・発送日は未確認。',
    answerFacts: [{ id: 'sourcing_outcome', text: '商品掲載を確認。在庫・発送日は未確定。' }],
    answerBlocks: [
      { text: '在庫と発送予定は確認後にご案内します。', evidenceIds: ['sourcing_outcome'] },
    ],
  };
  const directory = process.env.AOKI_E2E_DATA_DIR;
  if (!directory?.includes('aoki-eng-e2e-')) throw Error('Disposable test database required');
  const database = appDb();
  const row = (await database
    .prepare('SELECT json FROM messages WHERE id=?')
    .get(reply.message.id)) as {
    json: string;
  };
  const message: StoredChatMessage = { ...JSON.parse(row.json), sourceTrace: trace };
  await database
    .prepare('UPDATE messages SET json=? WHERE id=?')
    .run(JSON.stringify(message), reply.message.id);
  await database.close();
  const anonymous = await request.get(`/api/admin/conversations/${reply.conversationId}`);
  expect(anonymous.status()).toBe(401);
  const publicHistory = await page.request.get(`/api/chat/${reply.conversationId}`);
  const publicText = await publicHistory.text();
  expect(publicText).not.toMatch(/sourceTrace|private-reference|external-example|sourcing_outcome/);
  expect(
    (
      await page.request.post('/api/auth/login', {
        data: { password: 'aoki-e2e-test-password-only' },
      })
    ).ok(),
  ).toBe(true);
  const detail = (
    await (await page.request.get(`/api/admin/conversations/${reply.conversationId}`)).json()
  ).data;
  expect(
    detail.answers.find((answer: { id: string }) => answer.id === reply.message.id).sourceTrace,
  ).toEqual(trace);
  await page.goto('/admin?tab=conversations');
  await page
    .locator('.conversation-list > button')
    .filter({ hasText: 'ABC-100の在庫を確認したいです' })
    .first()
    .click();
  const history = page.getByRole('log', { name: 'チャットの会話履歴' });
  const record = history.locator('.source-trace');
  await record.locator(':scope > summary').click();
  await expect(
    record.getByText('優先参照先で見つからなかったため外部Webへ拡張', { exact: true }),
  ).toBeVisible();
  await expect(
    record.getByRole('link', { name: 'https://external-example.test/item' }),
  ).toHaveAttribute('href', 'https://external-example.test/item');
  await record.getByText('取得した根拠の抜粋', { exact: true }).click();
  await expect(
    record.getByText('ABC-100 在庫表示なし。お見積りはこちら。', { exact: true }),
  ).toBeVisible();
  await record.getByText('回答作成に渡した根拠と採用した段落', { exact: true }).click();
  await expect(record.getByText('根拠ID：sourcing_outcome', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath('answer-source-trace.png'), fullPage: true });
});
