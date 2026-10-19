import { test, expect, type APIRequestContext } from '@playwright/test';
import type { AppSettings, Product, Quote, Source } from '../../lib/contracts';

async function login(request: APIRequestContext) {
  const response = await request.post('/api/auth/login', {
    data: { password: 'aoki-e2e-test-password-only' },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}
async function getData<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path);
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()).data;
}

test('public pages, responsive navigation and product conversation', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBeTruthy();
  await page.goto('/products');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const products = await getData<Product[]>(page.request, '/api/products');
  expect(products.length).toBeGreaterThan(0);
  const response = await page.request.post('/api/chat', {
    data: { message: `${products[0].model}を取り扱っていますか？` },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const answer = (await response.json()).data;
  expect(answer.conversationId).toBeTruthy();
  expect(answer.message.content.length).toBeGreaterThan(10);
  for (const path of ['/projects', '/profile', '/contact', '/privacy']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      path,
    ).toBeTruthy();
  }
});

test('admin authorization, private conversation ownership and feature enforcement', async ({
  request,
  playwright,
}) => {
  const unauth = await request.get('/api/admin/settings');
  expect(unauth.status()).toBe(401);
  const chat = await request.post('/api/chat', {
    data: { message: '耐熱ガラスの取り扱いを相談したい' },
  });
  expect(chat.ok()).toBeTruthy();
  const id = (await chat.json()).data.conversationId;
  const stranger = await playwright.request.newContext({
    baseURL: 'http://127.0.0.1:3210',
    extraHTTPHeaders: { Origin: 'http://127.0.0.1:3210' },
  });
  const stolen = await stranger.get(`/api/chat/${id}`);
  expect([401, 403, 404]).toContain(stolen.status());
  await stranger.dispose();
  await login(request);
  const original = await getData<AppSettings>(request, '/api/admin/settings');
  try {
    const off = {
      ...original,
      flags: {
        ...original.flags,
        chat: false,
        showPrice: false,
        showStock: false,
        showLeadTime: false,
        quoteRequests: false,
        autoQuote: false,
        orders: false,
        autoOrder: false,
      },
    };
    expect((await request.put('/api/admin/settings', { data: off })).ok()).toBeTruthy();
    expect((await request.post('/api/chat', { data: { message: '価格を教えて' } })).status()).toBe(
      403,
    );
    const products = await getData<Product[]>(request, '/api/products');
    expect(products.every((p) => p.price == null && p.stock == null && !p.leadTime)).toBeTruthy();
    expect(
      (
        await request.post('/api/quotes', {
          data: {
            name: 'テスト',
            company: 'テスト会社',
            email: 'test@example.com',
            message: '見積',
            consent: true,
            quantity: 1,
          },
        })
      ).status(),
    ).toBe(403);
  } finally {
    await request.put('/api/admin/settings', { data: original });
  }
});

test('CSV import to issued quote, accepted order and idempotent demo dispatch', async ({
  request,
}) => {
  await login(request);
  const original = await getData<AppSettings>(request, '/api/admin/settings');
  const unique = Date.now().toString();
  let productId = '';
  try {
    const options = {
      ...original,
      flags: {
        ...original.flags,
        quoteRequests: true,
        orders: true,
        autoOrder: false,
        showPrice: true,
        showStock: true,
        showLeadTime: true,
      },
    };
    expect((await request.put('/api/admin/settings', { data: options })).ok()).toBeTruthy();
    const sourceResponse = await request.post('/api/admin/sources', {
      data: {
        name: `E2E台帳${unique}`,
        kind: 'csv',
        url: '',
        enabled: true,
        trust: 'internal',
        visibility: 'internal',
        syncIntervalHours: 24,
        config: {},
      },
    });
    expect(sourceResponse.ok(), await sourceResponse.text()).toBeTruthy();
    const source = (await sourceResponse.json()).data as Source;
    const csv = `商品名,型番,メーカー,販売価格,在庫,取扱状態,確認日時\n確認用部品,E2E-${unique},デモメーカー,2500,8,available,${new Date().toISOString()}\n`;
    const previewResponse = await request.post('/api/admin/import/preview', {
      multipart: {
        sourceId: source.id,
        file: { name: 'products.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) },
      },
    });
    expect(previewResponse.ok(), await previewResponse.text()).toBeTruthy();
    const preview = (await previewResponse.json()).data;
    const committed = await request.post('/api/admin/import/commit', {
      data: {
        previewId: preview.previewId,
        approved: true,
        mapping: {
          name: '商品名',
          model: '型番',
          manufacturer: 'メーカー',
          price: '販売価格',
          stock: '在庫',
          availability: '取扱状態',
          verifiedAt: '確認日時',
        },
      },
    });
    expect(committed.ok(), await committed.text()).toBeTruthy();
    const products = await getData<Product[]>(request, `/api/admin/products`);
    const imported = products.find((p) => p.model === `E2E-${unique}`);
    expect(imported).toBeTruthy();
    productId = imported!.id;
    // Staff explicitly approves public release; source visibility does not expose raw rows.
    expect(
      (
        await request.put(`/api/admin/products/${productId}`, {
          data: { ...imported, visibility: 'public', approved: true },
        })
      ).ok(),
    ).toBeTruthy();
    const created = await request.post('/api/quotes', {
      data: {
        name: '検証担当',
        company: '検証会社',
        email: 'test@example.com',
        message: '動作確認',
        consent: true,
        productId,
        quantity: 2,
      },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    const quote = (await created.json()).data as Quote;
    const issued = await request.put(`/api/admin/quotes/${quote.id}`, {
      data: {
        lines: [{ productId, name: '確認用部品', quantity: 2, unitPrice: 2500 }],
        shipping: 500,
        taxRate: 10,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        notes: '内部の確認メモ',
        status: 'issued',
        aokiReviewed: true,
      },
    });
    expect(issued.ok(), await issued.text()).toBeTruthy();
    expect((await issued.json()).data.total).toBe(6050);
    const publicQuote = await getData<Quote>(request, `/api/quotes/${quote.token}`);
    expect(publicQuote.notes || '').not.toContain('内部の確認メモ');
    const accepted = await request.post(`/api/quotes/${quote.token}/accept`, {
      data: { confirmed: true, idempotencyKey: `accept-${unique}` },
    });
    expect(accepted.ok(), await accepted.text()).toBeTruthy();
    const order = (await accepted.json()).data;
    const repeated = await request.post(`/api/quotes/${quote.token}/accept`, {
      data: { confirmed: true, idempotencyKey: `accept-${unique}` },
    });
    expect([200, 409]).toContain(repeated.status());
    const orders = await getData<{ id: string; quoteId: string }[]>(request, '/api/admin/orders');
    expect(orders.filter((o) => o.quoteId === quote.id)).toHaveLength(1);
    expect((await request.post(`/api/admin/orders/${order.id}/approve`)).ok()).toBeTruthy();
    const sent = await request.post(`/api/admin/orders/${order.id}/dispatch`);
    expect(sent.ok(), await sent.text()).toBeTruthy();
    expect((await sent.json()).data.status).toBe('simulated');
    const sentAgain = await request.post(`/api/admin/orders/${order.id}/dispatch`);
    expect([200, 409]).toContain(sentAgain.status());
    // Disabling the source must revoke affirmative public availability.
    expect(
      (
        await request.put(`/api/admin/sources/${source.id}`, {
          data: { ...source, enabled: false },
        })
      ).ok(),
    ).toBeTruthy();
    const visible = await request.get(`/api/products/${productId}`);
    if (visible.ok()) {
      const p = (await visible.json()).data;
      expect(p.availability).toBe('needs_review');
      expect(p.price).toBeNull();
    } else expect(visible.status()).toBe(404);
  } finally {
    await request.put('/api/admin/settings', { data: original });
  }
});

test('admin application renders after actual login', async ({ page }) => {
  await login(page.request);
  await page.goto('/admin');
  await expect(page.getByText('概要', { exact: true }).first()).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBeTruthy();
});

test('automatic settings still require Aoki review before issuing a quote', async ({ request }) => {
  await login(request);
  const original = await getData<AppSettings>(request, '/api/admin/settings');
  try {
    const settings = {
      ...original,
      flags: {
        ...original.flags,
        showPrice: true,
        quoteRequests: true,
        autoQuote: true,
        orders: true,
        autoOrder: true,
      },
      maxAutoOrderAmount: 50000,
    };
    expect((await request.put('/api/admin/settings', { data: settings })).ok()).toBeTruthy();
    const created = await request.post('/api/quotes', {
      data: {
        name: '自動処理の確認',
        company: '検証会社',
        email: 'automation@example.com',
        message: '条件を確認済み',
        consent: true,
        productId: 'demo-1',
        quantity: 2,
      },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    const q = (await created.json()).data;
    expect(q.status).toBe('requested');
    const reviewInput = {
      lines: [{ productId: 'demo-1', name: '確認用部品', quantity: 2, unitPrice: 2500 }],
      shipping: 0,
      taxRate: 10,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      notes: '',
      status: 'issued',
    };
    const unreviewed = await request.put(`/api/admin/quotes/${q.id}`, { data: reviewInput });
    expect(unreviewed.status()).toBe(400);
    expect(
      (
        await request.put(`/api/admin/quotes/${q.id}`, {
          data: { ...reviewInput, aokiReviewed: true },
        })
      ).ok(),
    ).toBeTruthy();
    const accepted = await request.post(`/api/quotes/${q.token}/accept`, {
      data: { confirmed: true, idempotencyKey: crypto.randomUUID() },
    });
    expect(accepted.ok(), await accepted.text()).toBeTruthy();
    expect((await accepted.json()).data.status).toBe('simulated');
  } finally {
    await request.put('/api/admin/settings', { data: original });
  }
});

test('the quote editor requires the Aoki review checkbox before formal issuance', async ({
  page,
}) => {
  await login(page.request);
  const created = await page.request.post('/api/quotes', {
    data: {
      name: '青木確認フローの検証',
      company: '',
      email: 'review@example.invalid',
      message: '確認後に見積を発行',
      consent: true,
      productId: 'demo-1',
      quantity: 2,
    },
  });
  expect(created.ok()).toBeTruthy();
  const quote = (await created.json()).data as Quote;
  expect(quote.status).toBe('requested');
  await page.goto('/admin?tab=quotes');
  await page.bringToFront();
  const row = page.getByRole('row').filter({ hasText: quote.id.slice(0, 8) });
  await row.getByRole('button', { name: '明細を編集' }).click();
  const modal = page.getByRole('dialog', { name: '見積の明細を作成' });
  const issue = modal.getByRole('button', { name: 'この金額で見積を発行' });
  await expect(issue).toBeDisabled();
  await modal.getByLabel('青木さんによる見積内容の確認済み').check();
  await expect(issue).toBeEnabled();
  await issue.click();
  await expect(modal).toBeHidden();
  const saved = (await (await page.request.get('/api/admin/quotes')).json()).data as Quote[];
  expect(saved.find((q) => q.id === quote.id)).toMatchObject({
    status: 'issued',
    reviewedBy: '青木',
  });
  expect(saved.find((q) => q.id === quote.id)?.reviewedAt).toBeTruthy();
});

test('customer chat and admin import forms work through the browser', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '耐熱ガラスを探している', exact: true }).click();
  const chat = page.getByRole('dialog', { name: '商品相談チャット' });
  await expect(chat).toBeVisible();
  await chat.getByRole('button', { name: 'メッセージを送信' }).click();
  await expect(chat.getByText('取扱あり', { exact: true })).toBeVisible();
  await chat.getByRole('link', { name: '担当者へのお問い合わせ' }).click();
  await page.getByLabel('お名前').fill('ブラウザー確認');
  await page.getByLabel('会社名').fill('検証会社');
  await page.getByLabel('メールアドレス').fill('browser@example.com');
  await page.getByLabel('ご相談内容').fill('在庫と納期を確認したいです');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '内容を送信する' }).click();
  await expect(page.getByText('お問い合わせを受け付けました', { exact: true })).toBeVisible();
  await login(page.request);
  await page.goto('/admin?tab=sources');
  await page.getByRole('button', { name: '情報源を追加', exact: true }).click();
  const modal = page.getByRole('dialog');
  const name = `ブラウザー取込 ${Date.now()}`;
  await modal.getByLabel('名称', { exact: true }).fill(name);
  await modal.getByRole('combobox', { name: '種類', exact: true }).selectOption('csv');
  await modal.getByRole('button', { name: '保存する', exact: true }).click();
  const card = page
    .locator('.source-card')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });
  await card.getByRole('button', { name: '取込', exact: true }).click();
  const csv = `商品名,型番,販売価格,在庫,取扱状態,確認日時\nブラウザー部品,BROWSER-${Date.now()},3500,3,available,${new Date().toISOString()}\n`;
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'browser.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(page.getByRole('button', { name: 'この内容で取り込む' })).toBeEnabled();
  await page.getByRole('combobox', { name: '確認日時', exact: true }).selectOption('確認日時');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'この内容で取り込む' }).click();
  await expect(page.getByRole('dialog', { name: '取込結果' })).toBeVisible();
  await expect(page.getByText('追加 1件 / 更新 0件 / 文書 0件')).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBeTruthy();
});
