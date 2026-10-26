import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { investigateProduct } from '../lib/server/investigation';
import { createSourceTrace } from '../lib/server/preferred-sources';
import { DEFAULT_SETTINGS, type Source } from '../lib/contracts';
import { save, now, db, putSettings } from '../lib/server/db';
import { safeFetch } from '../lib/server/safe-fetch';
import { jsonRequest, searchWeb } from '../lib/server/providers';
vi.mock('../lib/server/safe-fetch', async (original) => ({
  ...(await original<typeof import('../lib/server/safe-fetch')>()),
  safeFetch: vi.fn(),
}));
vi.mock('../lib/server/providers', async (original) => ({
  ...(await original<typeof import('../lib/server/providers')>()),
  jsonRequest: vi.fn(),
  searchWeb: vi.fn(),
}));
vi.mock('../lib/server/sales-model', () => ({ salesModel: vi.fn() }));
import { salesModel } from '../lib/server/sales-model';
const network = vi.mocked(safeFetch),
  decision = vi.mocked(jsonRequest),
  search = vi.mocked(searchWeb);
const subject = 'SGM® ガスケット';
const settings = {
  ...DEFAULT_SETTINGS,
  searchProvider: 'exa' as const,
  flags: { ...DEFAULT_SETTINGS.flags, webSearch: true },
};
const source: Source = {
  id: 'investigation-source',
  name: '非公開仕入先資料',
  kind: 'supplier_catalog',
  url: '',
  enabled: true,
  visibility: 'internal',
  trust: 'internal',
  syncIntervalHours: 0,
  config: { answerEnabled: true },
  lastError: null,
  lastSyncedAt: null,
  recordCount: 1,
  createdAt: now(),
};
const context = { scope: 'chat' as const, conversationId: 'investigation-conversation' };
const page = `<main><table><tr><th>TOMBO No.</th><th>製品名</th></tr><tr><td>9096-SGM</td><td>${subject}</td></tr><tr><td>9096-G</td><td>ニチアスソフトシール</td></tr></table></main>`;
beforeEach(async () => {
  vi.stubEnv('TYPESAFE_API_KEY', 'synthetic');
  vi.stubEnv('AI_JEV_MAX_CALL_USD', '0.01');
  vi.stubEnv('AI_JEV_PRICE_VERSION', 'synthetic');
  vi.mocked(salesModel).mockReset();
  network.mockReset();
  decision.mockReset();
  search.mockReset();
  search.mockResolvedValue([]);
  await save('sources', source);
  await save(
    'supplier_knowledge',
    {
      id: 'investigation-supplier',
      sourceId: source.id,
      supplierName: '非公開会社',
      website: 'https://investigate.example/',
      products: 'パッキン',
      fields: ['パッキン'],
      approved: true,
      importedAt: now(),
    },
    { source_id: source.id },
  );
  await save(
    'conversations',
    {
      id: context.conversationId,
      title: '調査検証',
      status: 'open',
      createdAt: now(),
      updatedAt: now(),
    },
    { owner_id: 'investigation-customer' },
  );
  network.mockImplementation(async (url) => ({
    status: 200,
    url,
    headers: new Headers(),
    body: Buffer.from(
      url.endsWith('/robots.txt')
        ? 'User-agent: *\nDisallow: /blocked/'
        : url === 'https://investigate.example/'
          ? '<main><a href="/products/">製品紹介</a><a href="http://127.0.0.1/private">無効</a><a href="https://foreign.example/products/">外部</a></main>'
          : url.endsWith('/products/')
            ? '<main><a href="/products/gasket/">ガスケット製品一覧</a></main>'
            : page,
    ),
  }));
});
afterEach(() => vi.unstubAllEnvs());
function choose(selector: (actions: Record<string, string>, state: any) => string) {
  decision.mockImplementation(async (_url, _headers, body: any) => ({
    answers: {
      next: { choice: selector(body.questions.next.criteria, body.state), confidence: 0.95 },
    },
    usage: { input_tokens: 200, output_tokens: 1 },
  }));
}
async function run(patch: Partial<Parameters<typeof investigateProduct>[1]> = {}) {
  const trace = await createSourceTrace();
  const result = await investigateProduct(subject, {
    message: subject,
    settings,
    context,
    trace,
    ...patch,
  });
  return { result, trace };
}
const firstUrl = (a: Record<string, string>) => Object.keys(a).find((k) => k.startsWith('url_'))!;
it('lets Jev select a root, product list, detail and finish based on accumulated evidence', async () => {
  choose((actions, state) =>
    state.evidence.some((e: any) => e.entries.some((p: any) => p.name === subject))
      ? 'finish'
      : firstUrl(actions),
  );
  const { result, trace } = await run();
  expect(result).toMatchObject({
    status: 'identified',
    matches: [{ name: subject, model: '9096-SGM' }],
    investigation: { steps: 4, stopReason: 'answered' },
  });
  expect(trace.investigation?.visited).toEqual([
    'https://investigate.example/',
    'https://investigate.example/products/',
    'https://investigate.example/products/gasket/',
  ]);
  expect(
    network.mock.calls.some(
      ([url]) => url.includes('127.0.0.1') || url.includes('foreign.example'),
    ),
  ).toBe(false);
  expect(decision.mock.calls[2][2]).toMatchObject({
    state: {
      evidence: expect.arrayContaining([expect.objectContaining({ quote: expect.any(String) })]),
    },
  });
  expect(await db().prepare('SELECT json FROM ai_calls').all()).toHaveLength(4);
});
it('reads a company document before choosing a supplier and never invents a model from surrounding prose', async () => {
  await save(
    'documents',
    {
      id: 'company-doc',
      sourceId: source.id,
      title: 'ガスケット資料',
      url: '',
      content: `${subject}の資料。別製品型番は9999。`,
      createdAt: now(),
    },
    { source_id: source.id, content: `${subject}の資料。別製品型番は9999。` },
  );
  choose((a) => Object.keys(a).find((k) => k.startsWith('doc_')) || 'finish');
  const { result, trace } = await run();
  expect(result.matches).toEqual([{ name: subject }]);
  expect(trace.investigation?.actions.map((a) => a.action)).toEqual(['doc_0', 'finish']);
  expect(network).not.toHaveBeenCalled();
});
it('can search, fetch a returned registered URL and ask a specific follow-up', async () => {
  search.mockResolvedValue([
    {
      id: 'search-result',
      title: '製品',
      url: 'https://investigate.example/detail/',
      excerpt: 'SGM',
      retrievedAt: now(),
      visibility: 'internal',
      trust: 'discovery',
    },
  ]);
  let n = 0;
  choose((a) => (++n === 1 ? 'search' : n === 2 ? firstUrl(a) : 'ask_specification'));
  const { result } = await run();
  expect(search).toHaveBeenCalledOnce();
  expect(result.investigation.question).toContain('サイズ');
  expect(result.matches[0].model).toBe('9096-SGM');
});
it('rejects invented actions and low confidence without executing a URL', async () => {
  decision.mockResolvedValue({
    answers: { next: { choice: 'fetch_http://127.0.0.1/', confidence: 0.99 } },
  });
  expect((await run()).result.investigation.stopReason).toBe('decision_unavailable');
  expect(network).not.toHaveBeenCalled();
  decision.mockResolvedValue({ answers: { next: { choice: 'url_0', confidence: 0.2 } } });
  expect((await run()).result.status).toBe('failed');
  expect(network).not.toHaveBeenCalled();
});
it('stops after five decisions without fetching the same URL twice', async () => {
  network.mockImplementation(async (url) => ({
    status: 200,
    url,
    headers: new Headers(),
    body: Buffer.from(
      url.endsWith('/robots.txt')
        ? ''
        : `<a href="/next${network.mock.calls.length}/">製品詳細</a>`,
    ),
  }));
  choose(firstUrl);
  const { result, trace } = await run();
  expect(result.investigation).toMatchObject({ steps: 5, stopReason: 'step_limit' });
  expect(new Set(trace.investigation?.visited).size).toBe(trace.investigation?.visited.length);
  expect(decision).toHaveBeenCalledTimes(5);
});
it('stops on failures, unavailable decision budget or cancellation, and obeys disabled search', async () => {
  choose(firstUrl);
  network.mockRejectedValue(Error('timeout'));
  expect((await run()).result.status).toBe('failed');
  network.mockClear();
  decision.mockClear();
  const disabled = await run({
    settings: { ...settings, flags: { ...settings.flags, webSearch: false } },
  });
  expect(disabled.result.investigation.stopReason).toBe('disabled');
  expect(decision).not.toHaveBeenCalled();
  expect(network).not.toHaveBeenCalled();
  vi.stubEnv('AI_JEV_MAX_CALL_USD', '');
  expect((await run()).result.investigation.stopReason).toBe('decision_unavailable');
  expect(decision).not.toHaveBeenCalled();
  const abort = AbortSignal.abort();
  expect((await run({ signal: abort })).result.investigation.stopReason).toBe('timeout');
});
it('resumes the same investigation after asking the customer, despite its own index writes', async () => {
  let n = 0;
  choose((a) => (++n === 1 ? firstUrl(a) : 'ask_specification'));
  const first = await run();
  await save(
    'messages',
    {
      id: 'investigation-first',
      role: 'assistant',
      content: '仕様を教えてください',
      createdAt: now(),
      sourceTrace: first.trace,
    },
    { conversation_id: context.conversationId },
  );
  decision.mockReset();
  choose(firstUrl);
  const next = await run({ message: 'サイズは20Aです' });
  expect(next.trace.investigation?.visited[0]).toBe('https://investigate.example/');
  expect(next.trace.investigation?.actions[0].target).toBe('https://investigate.example/products/');
  expect(network.mock.calls.filter(([url]) => url === 'https://investigate.example/')).toHaveLength(
    1,
  );
});
it('holds robots-denied paths without fetching them', async () => {
  network.mockImplementation(async (url) => ({
    status: 200,
    url,
    headers: new Headers(),
    body: Buffer.from(
      url.endsWith('/robots.txt')
        ? 'User-agent: *\nDisallow: /blocked/'
        : '<a href="/blocked/product/">製品</a>',
    ),
  }));
  choose(firstUrl);
  const { trace } = await run();
  expect(network.mock.calls.some(([url]) => url.includes('/blocked/'))).toBe(false);
  expect(trace.investigation?.actions.some((a) => a.outcome === 'fetch_failed')).toBe(true);
});

it('connects a customer product-name turn to the loop and restores a grounded public reply', async () => {
  const { answerChat, currentMessages } = await import('../lib/server/chat');
  vi.stubEnv('OPENAI_API_KEY', 'synthetic');
  await putSettings({
    ...settings,
    responseProvider: 'local',
    flags: { ...settings.flags, aiResearch: false },
  });
  vi.mocked(salesModel).mockResolvedValue({
    model: '',
    manufacturer: '',
    designation: subject,
    designationKind: 'product_name',
    newSubject: true,
    confirmingGuidance: false,
    quantity: 0,
    quantityEvidence: '',
    quantityUnit: '',
    quantityWithdrawn: false,
    purpose: '',
    shape: '',
    dimensions: '',
    quotePreference: 'unchanged',
    handoffPreference: 'unchanged',
    requestedInformation: 'other',
    identityUnavailable: false,
    identityUnavailableEvidence: '',
    next: 'none',
    known: [],
  });
  choose((actions, state) =>
    state.evidence.some((e: any) => e.entries.some((p: any) => p.name === subject))
      ? 'finish'
      : firstUrl(actions),
  );
  const answer = await answerChat(subject, 'loop-customer');
  expect(answer.message.productNameLookup).toMatchObject({
    status: 'identified',
    matches: [{ model: '9096-SGM' }],
    investigation: { stopReason: 'answered' },
  });
  expect(answer.message.content).toContain('9096-SGM');
  expect(answer.message.content).toContain('販売・調達可否と現在庫は未確認');
  expect(JSON.stringify(answer)).not.toMatch(/investigate.example|非公開会社|sourceTrace/);
  const restored = (await currentMessages(answer.conversationId)).at(-1)!;
  expect(restored.content).toContain('9096-SGM');
  expect(JSON.stringify(restored)).not.toMatch(/investigate.example|sourceTrace/);
});

it('uses a registered redirect as a new candidate and never follows an external redirect', async () => {
  network.mockImplementation(async (url) => ({
    status: url === 'https://investigate.example/' ? 302 : 200,
    url,
    headers: new Headers(url === 'https://investigate.example/' ? { location: '/detail/' } : {}),
    body: Buffer.from(url.endsWith('/robots.txt') ? '' : page),
  }));
  choose((a, state) => (state.evidence.length ? 'finish' : firstUrl(a)));
  const first = await run();
  expect(first.result.status).toBe('identified');
  expect(first.trace.investigation?.actions[0].outcome).toBe('redirect_discovered');
  network.mockClear();
  network.mockImplementation(async (url) => ({
    status: url.endsWith('/robots.txt') ? 200 : 302,
    url,
    headers: new Headers({ location: 'https://foreign.example/' }),
    body: Buffer.from(''),
  }));
  const next = await run();
  expect(next.result.matches).toEqual([]);
  expect(network.mock.calls.some(([url]) => url.includes('foreign.example'))).toBe(false);
});

it('never repeats an identical search query in one investigation', async () => {
  choose((a) => (a.search ? 'search' : 'finish'));
  await run();
  expect(search).toHaveBeenCalledOnce();
});

it('expands from registered search to public search for a description without a model, and returns an unconfirmed candidate', async () => {
  const description = '炉の扉を固定するSUS316のL字金具';
  search.mockImplementation(async (_query, _settings, domains) =>
    domains.length
      ? []
      : [
          {
            id: 'outside',
            title: '炉扉固定部品',
            url: 'https://outside.example/item/',
            excerpt: 'SUS316の固定部品',
            retrievedAt: now(),
            visibility: 'public',
            trust: 'discovery',
          },
        ],
  );
  network.mockImplementation(async (url) => ({
    status: 200,
    url,
    headers: new Headers(),
    body: Buffer.from(
      url.endsWith('/robots.txt')
        ? ''
        : `<table><tr><th>型番</th><th>商品名</th></tr><tr><td>FIX-10</td><td>炉扉固定部品</td></tr></table>`,
    ),
  }));
  let n = 0;
  choose((a) =>
    ++n === 1
      ? 'search'
      : n === 2
        ? 'public_search'
        : n === 3
          ? firstUrl(a)
          : n === 4
            ? Object.keys(a).find((k) => k.startsWith('candidate_'))!
            : 'finish',
  );
  const trace = await createSourceTrace();
  const result = await investigateProduct(description, {
    message: description,
    settings,
    context,
    trace,
  });
  expect(search.mock.calls.map((c) => c[2])).toEqual([['investigate.example'], []]);
  expect(network.mock.calls.some(([url]) => url === 'https://outside.example/item/')).toBe(true);
  expect(result).toMatchObject({
    status: 'not_found',
    matches: [],
    candidates: [{ name: '炉扉固定部品', model: 'FIX-10' }],
  });
  expect(trace.stages.some((s) => s.scope === 'public_web')).toBe(true);
  expect(
    (await db().prepare('SELECT json FROM products').all()).some(
      (r) => JSON.parse(r.json).model === 'FIX-10',
    ),
  ).toBe(false);
});

it('does not offer public search before trying registered sources', async () => {
  choose((a) => {
    expect(a.public_search).toBeUndefined();
    return 'ask_specification';
  });
  await run();
  expect(search).not.toHaveBeenCalled();
});

it('starts research from customer purpose and shape even when no product name or model is known', async () => {
  const { productInquiry } = await import('../lib/server/product-inquiry');
  vi.stubEnv('OPENAI_API_KEY', '');
  choose((a) => {
    expect(Object.keys(a).some((k) => k.startsWith('url_'))).toBe(true);
    return 'ask_specification';
  });
  const reply = await productInquiry({
    message: '型番は不明です。炉の扉を固定するL字金具です',
    history: [
      {
        id: 'unknown',
        role: 'assistant',
        content: '用途を教えてください',
        createdAt: now(),
        inquiryState: { purpose: '炉の扉を固定する', shape: 'L字金具', identityUnavailable: true },
      },
    ],
    settings,
    trace: await createSourceTrace(),
    context: { ...context, turnId: 'unknown-turn' },
  });
  expect(reply.productNameLookup?.investigation?.stopReason).toBe('needs_customer');
  expect(reply.inquiryState.model).toBeUndefined();
  expect(reply.content).toContain('サイズ');
});
