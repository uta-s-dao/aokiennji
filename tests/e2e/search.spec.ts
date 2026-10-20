import { test, expect } from '@playwright/test';
import { serviceDetails } from '../../lib/service-content';
test.setTimeout(120000);

test('public content has distinct canonical metadata and service navigation', async ({
  page,
  request,
}) => {
  const routes = [
    '/services',
    ...serviceDetails.map((s) => `/services/${s.id}`),
    '/estimate-system',
    '/profile',
    '/projects',
    '/contact',
  ];
  const titles = new Set<string>();
  for (const path of routes) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    const html = await response.text();
    expect(html).toContain(`href="https://www.aokieng.co.jp${path}"`);
    expect(html).toContain('noindex');
    await page.goto(path);
    const title = await page.title();
    expect(titles.has(title), path).toBe(false);
    titles.add(title);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      path,
    ).toBe(true);
  }
  await page.goto('/services/structures');
  await page.getByRole('link', { name: 'この内容で相談する', exact: true }).first().click();
  await expect(page.locator('textarea')).toHaveValue(/鋼構造物・機械装置/);
});

test('service content and products are available without JavaScript; missing products return 404', async ({
  browser,
  request,
  baseURL,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
  const page = await context.newPage();
  try {
    await page.goto('/services/structures');
    await expect(
      page.getByRole('heading', { name: '鋼構造物・機械装置の設計・製作・据付', exact: true }),
    ).toBeVisible();
    const products = (await (await request.get('/api/products')).json()).data;
    expect(products.length).toBeGreaterThan(0);
    await page.goto('/products');
    await expect(page.getByText(products[0].name, { exact: true }).first()).toBeVisible();
    await page.goto(`/products/${products[0].id}`);
    await expect(page.getByRole('heading', { level: 1, name: products[0].name })).toBeVisible();
    expect((await request.get('/products/does-not-exist')).status()).toBe(404);
  } finally {
    await context.close();
  }
});

test('demo search exclusion and private response headers are enforced', async ({ request }) => {
  expect(await (await request.get('/robots.txt')).text()).toContain('Disallow: /');
  expect(await (await request.get('/sitemap.xml')).text()).not.toContain('<loc>');
  for (const path of ['/admin/login', '/quotes/missing-secret-token', '/api/config']) {
    const response = await request.get(path);
    expect(response.headers()['x-robots-tag'], path).toContain('noindex');
    expect(response.headers()['referrer-policy'], path).toBe('no-referrer');
    expect(response.headers()['cache-control'], path).toMatch(/no-cache|no-store/);
  }
  const html = await (await request.get('/')).text();
  expect(html).not.toContain('googletagmanager.com/gtag');
  expect((await request.get('/services/not-a-service')).status()).toBe(404);
});

test('successful inquiries emit one lead event and failed submissions emit none', async ({
  page,
}) => {
  await page.goto('/contact?subject=製作相談');
  await page.evaluate(() => {
    (window as unknown as { leadEvents: unknown[] }).leadEvents = [];
    window.addEventListener('aoki:conversion', (event) =>
      (window as unknown as { leadEvents: unknown[] }).leadEvents.push(
        (event as CustomEvent).detail,
      ),
    );
  });
  await page.getByLabel('お名前').fill('検証用担当者');
  await page.getByLabel('メールアドレス').fill('search-test@example.invalid');
  await page.getByRole('checkbox').check();
  await page.route('**/api/inquiries', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: '検証用エラー' } }),
    }),
  );
  await page.getByRole('button', { name: '内容を送信する', exact: true }).click();
  await expect(page.locator('.form-error')).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as { leadEvents: unknown[] }).leadEvents),
  ).toEqual([]);
  await page.unroute('**/api/inquiries');
  await page.getByRole('button', { name: '内容を送信する', exact: true }).click();
  await expect(page.getByText('お問い合わせを受け付けました', { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as { leadEvents: unknown[] }).leadEvents),
  ).toEqual([{ name: 'generate_lead', leadType: 'inquiry' }]);
});
