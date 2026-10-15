import nextEnv from '@next/env';
import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { channel } from 'node:diagnostics_channel';
import { createHmac, randomUUID } from 'node:crypto';

const root = resolve(process.env.LIVE_AI_ROOT || '.data/verification/live-ai-2026-10-07');
const dataDir = join(root, 'sandbox');
const databaseFile = join(dataDir, 'aokienji.sqlite');
const baseURL = process.env.LIVE_AI_TEST_URL || 'http://localhost:3212';
const mode = process.argv[2];
const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());
mkdirSync(root, { recursive: true });
const write = (file, data) => writeFileSync(join(root, file), JSON.stringify(data, null, 2));

async function prepare() {
  mkdirSync(dataDir, { recursive: true });
  const original = new Database(join(process.env.DATA_DIR || '.data', 'aokienji.sqlite'), {
    readonly: true,
  });
  await original.backup(databaseFile);
  original.close();
  const cloned = new Database(databaseFile);
  const saved = JSON.parse(cloned.prepare('SELECT json FROM settings WHERE id=1').get().json);
  const decisionProvider = process.env.LIVE_AI_DECISION || 'jev';
  const responseProvider = process.env.LIVE_AI_RESPONSE || 'openai';
  const settings = {
    ...saved,
    decisionProvider,
    model: decisionProvider === 'jev' ? 'jev-latest' : '',
    responseProvider,
    responseModel: responseProvider === 'openai' ? process.env.OPENAI_MODEL || 'gpt-4.1-mini' : '',
    flags: { ...saved.flags, webSearch: false, orders: false, autoOrder: false, autoQuote: false },
  };
  cloned.prepare('UPDATE settings SET json=? WHERE id=1').run(JSON.stringify(settings));
  cloned.exec(
    'DELETE FROM messages; DELETE FROM conversations; DELETE FROM audit_events; DELETE FROM sessions; DELETE FROM rate_limits;',
  );
  const count = cloned.prepare('SELECT count(*) AS count FROM supplier_knowledge').get().count;
  cloned.close();
  write('environment.json', {
    testedAt: new Date().toISOString(),
    baseURL,
    dataDir,
    keysPresent: { jev: !!process.env.TYPESAFE_API_KEY, openai: !!process.env.OPENAI_API_KEY },
    settings,
    supplierRecords: count,
    clonedData: true,
  });
  console.log(
    JSON.stringify({
      baseURL,
      dataDir,
      supplierRecords: count,
      decisionProvider: settings.decisionProvider,
      responseProvider: settings.responseProvider,
      responseModel: settings.responseModel,
    }),
  );
}

// Switch the providers of the existing sandbox between runs. Settings are read
// per request, so the running server needs no restart.
function configure() {
  const [decisionProvider, responseProvider, research] = process.argv.slice(3);
  if (
    !['local', 'jev'].includes(decisionProvider) ||
    !['local', 'openai'].includes(responseProvider)
  )
    throw Error('Use configure <local|jev> <local|openai> [research]');
  const database = new Database(databaseFile);
  const saved = JSON.parse(database.prepare('SELECT json FROM settings WHERE id=1').get().json);
  const settings = {
    ...saved,
    decisionProvider,
    model: decisionProvider === 'jev' ? 'jev-latest' : '',
    responseProvider,
    responseModel: responseProvider === 'openai' ? process.env.OPENAI_MODEL || 'gpt-4.1-mini' : '',
    flags: { ...saved.flags, aiResearch: research === 'research' },
  };
  database.prepare('UPDATE settings SET json=? WHERE id=1').run(JSON.stringify(settings));
  database.prepare('DELETE FROM rate_limits').run();
  database.close();
  console.log(
    JSON.stringify({ decisionProvider, responseProvider, aiResearch: settings.flags.aiResearch }),
  );
}

async function probe() {
  process.env.DATA_DIR = dataDir;
  const calls = [];
  channel('undici:request:headers').subscribe(({ request, response }) => {
    const host = new URL(String(request.origin)).hostname;
    if (['api.openai.com', 'api.typesafe.ai', 'ai-gateway.vercel.sh'].includes(host))
      calls.push({ host, status: response.statusCode });
  });
  channel('undici:request:error').subscribe(({ request, error }) => {
    const host = new URL(String(request.origin)).hostname;
    if (['api.openai.com', 'api.typesafe.ai', 'ai-gateway.vercel.sh'].includes(host))
      calls.push({ host, errorCode: error.code || error.name });
  });
  const { checkAiProvider } = await import('../lib/server/ai-setup.ts');
  const checks = await Promise.all(
    ['jev', 'openai'].map(async (provider) => ({ provider, ...(await checkAiProvider(provider)) })),
  );
  const outputName = process.argv[3] || 'connection-checks';
  if (!/^[\w-]+$/.test(outputName)) throw Error('invalid output name');
  write(`${outputName}.json`, { checks, calls });
  console.log(JSON.stringify({ checks, calls }));
  if (checks.some((c) => !c.ok)) process.exitCode = 1;
}

function redact(value, database) {
  const records = database
    .prepare('SELECT json FROM supplier_knowledge')
    .all()
    .map((r) => JSON.parse(r.json));
  const hidden = records.flatMap((r) => [
    r.supplierName,
    r.website,
    ...(r.website ? [new URL(r.website).hostname] : []),
  ]);
  let text = JSON.stringify(value);
  let leak = false;
  for (const privateValue of hidden)
    if (privateValue && text.includes(privateValue)) {
      leak = true;
      text = text.replaceAll(privateValue, '[非公開情報を伏せました]');
    }
  return { value: JSON.parse(text), privateLeak: leak };
}

async function run() {
  const scenarioFile = process.argv[3];
  const outputName = process.argv[4];
  if (!scenarioFile || !outputName || !/^[\w-]+$/.test(outputName))
    throw Error('scenario JSON and output name required');
  const scenarios = JSON.parse(readFileSync(scenarioFile, 'utf8'));
  const database = new Database(databaseFile, { readonly: true });
  const report = { testedAt: new Date().toISOString(), baseURL, scenarios: [] };
  for (const scenario of scenarios) {
    let cookie = '',
      conversationId;
    const transcript = { id: scenario.id, title: scenario.title, turns: [] };
    report.scenarios.push(transcript);
    for (const turn of scenario.turns) {
      const start = performance.now();
      let firstStatusMs = null,
        firstTextMs = null,
        textEvents = 0,
        result;
      const response = await fetch(`${baseURL}/api/chat`, {
        method: 'POST',
        headers: {
          Origin: baseURL,
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: JSON.stringify({
          message: turn.question,
          ...(conversationId ? { conversationId } : {}),
        }),
        signal: AbortSignal.timeout(20000),
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) cookie = cookies.map((c) => c.split(';')[0]).join('; ');
      if (!response.ok) {
        transcript.turns.push({
          question: turn.question,
          expected: turn.expected,
          httpStatus: response.status,
          error: await response.text(),
        });
        write(`${outputName}-results.json`, report);
        continue;
      }
      let buffer = '';
      const decoder = new TextDecoder();
      const previews = [];
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buffer.indexOf('\n\n')) >= 0) {
          const eventText = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          for (const line of eventText.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const event = JSON.parse(line.slice(6));
            if (event.type === 'status' && firstStatusMs === null)
              firstStatusMs = Math.round(performance.now() - start);
            if (event.type === 'text') {
              if (firstTextMs === null) firstTextMs = Math.round(performance.now() - start);
              textEvents++;
              previews.push({
                elapsedMs: Math.round(performance.now() - start),
                content: event.data,
              });
            }
            if (event.type === 'result') result = event.data;
            if (event.type === 'error')
              transcript.turns.push({
                question: turn.question,
                expected: turn.expected,
                error: event.data,
              });
          }
        }
      }
      if (!result) {
        write(`${outputName}-results.json`, report);
        continue;
      }
      conversationId = result.conversationId;
      const totalMs = Math.round(performance.now() - start);
      const events = database
        .prepare('SELECT json FROM audit_events')
        .all()
        .map((r) => JSON.parse(r.json))
        .filter((e) => e.entityId === conversationId && e.action === 'chat.routed');
      const route = events.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.summary;
      const messages = database
        .prepare('SELECT json FROM messages WHERE conversation_id=?')
        .all(conversationId)
        .map((r) => JSON.parse(r.json));
      const userMessage = messages
        .filter((m) => m.role === 'user')
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      const apiCalls = database
        .prepare('SELECT json FROM ai_calls WHERE turn_id=? ORDER BY created_at')
        .all(userMessage?.id || '')
        .map((r) => JSON.parse(r.json));
      const turnResult = {
        question: turn.question,
        expected: turn.expected,
        conversationId,
        userMessageId: userMessage?.id,
        response: result.message.content,
        responseProvider: result.message.responseProvider || 'local',
        intent: result.message.intent,
        knowledge: result.message.knowledge,
        products: (result.message.products || []).map((p) => ({
          name: p.name,
          model: p.model,
          availability: p.availability,
          price: p.price,
          stock: p.stock,
          leadTime: p.leadTime,
          isDemo: p.isDemo,
        })),
        timing: { firstStatusMs, firstTextMs, totalMs, textEvents },
        routeReason: result.message.route,
        handoff: result.message.handoff || null,
        handoffDraft: result.message.handoffDraft || null,
        suggestions: result.message.suggestions || [],
        route,
        previews,
        apiCalls,
      };
      const sanitized = redact(turnResult, database);
      // A local-only run answers in milliseconds; stay under the chat rate limit.
      if (process.env.LIVE_AI_DELAY_MS)
        await new Promise((r) => setTimeout(r, Number(process.env.LIVE_AI_DELAY_MS)));
      transcript.turns.push({ ...sanitized.value, privateLeak: sanitized.privateLeak });
      write(`${outputName}-results.json`, report);
      console.log(
        JSON.stringify({
          scenario: scenario.id,
          question: turn.question,
          responseProvider: result.message.responseProvider,
          totalMs,
          route,
          privateLeak: sanitized.privateLeak,
          apiCalls: apiCalls.map((c) => ({
            provider: c.provider,
            httpStatus: c.httpStatus,
            outcome: c.outcome,
            errorCode: c.errorCode,
            usage: c.usage,
          })),
        }),
      );
    }
  }
  database.close();
  console.log(
    JSON.stringify({
      output: join(root, `${outputName}-results.json`),
      questions: report.scenarios.reduce((n, s) => n + s.turns.length, 0),
    }),
  );
}

async function exportUsage() {
  process.env.DATA_DIR = dataDir;
  const { aiUsageReport } = await import('../lib/server/ai-usage.ts');
  const report = aiUsageReport({ limit: 500 });
  const database = new Database(databaseFile, { readonly: true });
  // Export all records, not only the limited admin detail list.
  report.items = database
    .prepare('SELECT json FROM ai_calls ORDER BY created_at')
    .all()
    .map((r) => JSON.parse(r.json));
  database.close();
  write('api-usage-all.json', report);
  const columns = [
    'id',
    'createdAt',
    'provider',
    'purpose',
    'scope',
    'conversationId',
    'turnId',
    'model',
    'method',
    'endpoint',
    'httpStatus',
    'outcome',
    'errorCode',
    'durationMs',
    'requestBytes',
    'inputTokens',
    'outputTokens',
    'cachedInputTokens',
  ];
  const csv = [
    columns,
    ...report.items.map((c) => columns.map((k) => c[k] ?? c.context[k] ?? c.usage?.[k] ?? '')),
  ]
    .map((row) => row.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(','))
    .join('\n');
  writeFileSync(join(root, 'api-usage-all.csv'), '\ufeff' + csv + '\n');
  console.log(
    JSON.stringify({
      total: report.total,
      summaries: report.summaries,
      output: join(root, 'api-usage-all.json'),
    }),
  );
}

async function adminUsageCheck() {
  const outputName = process.argv[3] || 'admin-usage';
  if (!/^[\w-]+$/.test(outputName)) throw Error('invalid output name');
  const { chromium } = await import('@playwright/test');
  const database = new Database(databaseFile);
  const expectedConnectionChecks = database
    .prepare('SELECT json FROM ai_calls')
    .all()
    .map((row) => JSON.parse(row.json))
    .filter((call) => call.context.scope === 'connection_check').length;
  const sessionId = randomUUID();
  const signature = createHmac('sha256', process.env.SESSION_SECRET)
    .update(sessionId)
    .digest('base64url');
  database
    .prepare('INSERT INTO sessions(id,kind,expires_at) VALUES(?,?,?)')
    .run(sessionId, 'admin', Date.now() + 600000);
  const browser = await chromium.launch({ headless: true });
  const results = [];
  try {
    const unauthenticated = await fetch(`${baseURL}/api/admin/ai-usage`);
    results.push({ check: 'unauthenticated API access', httpStatus: unauthenticated.status });
    if (unauthenticated.status !== 401) throw Error('admin endpoint not protected');
    for (const [device, viewport] of [
      ['desktop', { width: 1440, height: 1000 }],
      ['mobile', { width: 390, height: 844 }],
    ]) {
      const context = await browser.newContext({
        viewport,
        isMobile: device === 'mobile',
        hasTouch: device === 'mobile',
      });
      await context.addCookies([
        {
          name: 'aoki_admin',
          value: `${sessionId}.${signature}`,
          url: baseURL,
          httpOnly: true,
          sameSite: 'Lax',
        },
      ]);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${baseURL}/admin?tab=ai-usage`);
      await page.getByRole('heading', { name: '回答ごとのAI利用記録' }).waitFor();
      await page.getByRole('heading', { name: 'お客様へ返した回答' }).waitFor();
      const api = await context.request.get(`${baseURL}/api/admin/ai-usage?scope=chat`);
      const report = (await api.json()).data;
      if (!report.total) throw Error('usage records missing in admin');
      const unknownUsage = report.summaries.find((s) => s.provider === 'jev');
      if (!unknownUsage.usageReportedCalls && unknownUsage.inputTokens !== null)
        throw Error('unknown usage shown as zero');
      await page.getByRole('button', { name: '会話と回答を確認' }).first().click();
      const modal = page.getByRole('dialog', { name: '回答とAI処理の詳細' });
      await modal.getByText('選択中の回答', { exact: false }).waitFor();
      await modal.getByRole('button', { name: '閉じる', exact: true }).click();
      await page.getByLabel('APIで絞り込み').selectOption('openai');
      const answerCard = page.getByRole('article', { name: '回答の利用記録' }).first();
      await answerCard.waitFor();
      await answerCard.locator('.admin-answer-details > summary').click();
      await answerCard
        .locator('.answer-ai-calls > li')
        .filter({ hasText: 'OpenAI /' })
        .first()
        .locator('.ai-call-technical > summary')
        .click();
      await page
        .getByText('POST https://api.openai.com/v1/responses', { exact: true })
        .first()
        .waitFor();
      const downloadPromise = page.waitForEvent('download');
      await page.getByRole('button', { name: '表示中の記録をJSON保存' }).click();
      const download = await downloadPromise;
      await download.saveAs(join(root, `${outputName}-${device}-download.json`));
      const saved = readFileSync(join(root, `${outputName}-${device}-download.json`), 'utf8');
      for (const key of [process.env.OPENAI_API_KEY, process.env.TYPESAFE_API_KEY])
        if (key && saved.includes(key)) throw Error('credential present in usage export');
      await page.getByLabel('APIで絞り込み').selectOption('');
      await page.getByRole('article', { name: '回答の利用記録' }).first().waitFor();
      await page.getByLabel('用途で絞り込み').selectOption('connection_check');
      await page.getByRole('heading', { name: '接続確認の明細' }).waitFor();
      const checkReport = (
        await (
          await context.request.get(`${baseURL}/api/admin/ai-usage?scope=connection_check`)
        ).json()
      ).data;
      if (checkReport.total !== expectedConnectionChecks)
        throw Error('connection checks are not separated');
      await page.getByLabel('期間で絞り込み').selectOption('7');
      await page.getByRole('heading', { name: '接続確認の明細' }).waitFor();
      await page.getByLabel('用途で絞り込み').selectOption('chat');
      await page.getByRole('heading', { name: 'お客様へ返した回答' }).waitFor();
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: join(root, `${outputName}-${device}.png`), fullPage: false });
      const layout = await page.evaluate(() => ({
        pageOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      }));
      const invalid = await context.request.get(`${baseURL}/api/admin/ai-usage?provider=invalid`);
      if (invalid.status() !== 400) throw Error('invalid filter not rejected');
      results.push({
        device,
        httpStatus: api.status(),
        chatCalls: report.total,
        summaries: report.summaries,
        conversationDetail: true,
        scopeFilter: true,
        periodFilter: true,
        connectionChecks: checkReport.total,
        download: download.suggestedFilename(),
        credentialLeak: false,
        invalidFilterStatus: invalid.status(),
        errors,
        layout,
      });
      await context.close();
    }
  } finally {
    await browser.close();
    database.prepare('DELETE FROM sessions WHERE id=?').run(sessionId);
    database.close();
  }
  write(`${outputName}-browser-results.json`, results);
  console.log(JSON.stringify(results));
}

async function browserCheck() {
  const outputName = process.argv[3] || 'chat';
  if (!/^[\w-]+$/.test(outputName)) throw Error('invalid output name');
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: true });
  const results = [];
  try {
    for (const [device, viewport] of [
      ['desktop', { width: 1440, height: 1000 }],
      ['mobile', { width: 390, height: 844 }],
    ]) {
      const context = await browser.newContext({
        viewport,
        isMobile: device === 'mobile',
        hasTouch: device === 'mobile',
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(baseURL);
      await page.getByRole('button', { name: '商品相談チャットを開く', exact: true }).click();
      const chat = page.getByRole('dialog', { name: '商品相談チャット' });
      const turns = [];
      for (const question of [
        'パッキンの選び方を相談したいです。何からお伝えすればいいですか？',
        '水の配管で使います。材質はまだ決まっていません。',
      ]) {
        await chat.getByRole('textbox', { name: '相談内容' }).fill(question);
        const start = performance.now();
        const responsePromise = page.waitForResponse(
          (response) =>
            response.url().endsWith('/api/chat') && response.request().method() === 'POST',
        );
        await chat.getByRole('button', { name: 'メッセージを送信' }).click();
        const response = await responsePromise;
        const body = await response.text();
        const events = body
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => JSON.parse(line.slice(6)));
        const result = events.find((event) => event.type === 'result')?.data;
        if (!result) throw Error('Browser request did not complete');
        await page.waitForTimeout(150);
        turns.push({
          question,
          response: result.message.content,
          responseProvider: result.message.responseProvider,
          totalMs: Math.round(performance.now() - start),
          textEvents: events.filter((e) => e.type === 'text').length,
        });
      }
      const screenshot = join(root, `${outputName}-${device}.png`);
      await page.screenshot({ path: screenshot, fullPage: false });
      const layout = await page.evaluate(() => ({
        pageOverflow: document.documentElement.scrollWidth > innerWidth + 1,
        composerBottom: document.querySelector('.chat-composer')?.getBoundingClientRect().bottom,
        viewportHeight: innerHeight,
      }));
      results.push({ device, turns, errors, layout, screenshot });
      await context.close();
    }
  } finally {
    await browser.close();
  }
  write(
    outputName === 'chat' ? 'browser-results.json' : `${outputName}-browser-results.json`,
    results,
  );
  console.log(JSON.stringify(results));
}

try {
  if (mode === 'prepare') await prepare();
  else if (mode === 'configure') configure();
  else if (mode === 'probe') await probe();
  else if (mode === 'run') await run();
  else if (mode === 'browser') await browserCheck();
  else if (mode === 'usage') await exportUsage();
  else if (mode === 'admin') await adminUsageCheck();
  else throw Error('Use prepare, configure, probe, run, browser, usage or admin');
} catch (error) {
  console.error(
    error.code || error.name,
    String(error.message).replace(/sk-[\w-]+/g, '[redacted]'),
  );
  process.exitCode = 1;
}
