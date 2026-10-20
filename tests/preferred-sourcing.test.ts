import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_SETTINGS,
  type Source,
  type SupplierKnowledge,
  type StoredChatMessage,
} from '../lib/contracts';
import { db, now, putSettings, resetDbForTests, save } from '../lib/server/db';
import { answerChat, currentMessages } from '../lib/server/chat';
import { conversationMessages } from '../lib/server/business';
import { researchNotes } from '../lib/server/research';
import { createSourceTrace, preferredDomains } from '../lib/server/preferred-sources';
import { aiAnswerReport } from '../lib/server/ai-answer-history';
import { pauseOpenaiForQuota } from '../lib/server/ai-usage';
import { searchWeb } from '../lib/server/providers';
vi.mock('../lib/server/safe-fetch', () => ({ safeFetch: vi.fn() }));
import { safeFetch } from '../lib/server/safe-fetch';
const network = vi.mocked(safeFetch);
const directory = mkdtempSync(join(tmpdir(), 'aoki-preferred-'));
const settings = {
  ...DEFAULT_SETTINGS,
  searchProvider: 'exa' as const,
  flags: { ...DEFAULT_SETTINGS.flags, webSearch: true },
};
const reference = 'https://preferred-0.example/item';
const external = 'https://outside.example/item';
function source(id: string, patch: Partial<Source> = {}): Source {
  return {
    id,
    name: `情報源${id}`,
    kind: 'supplier_catalog',
    url: '',
    enabled: true,
    trust: 'internal',
    visibility: 'internal',
    syncIntervalHours: 0,
    config: { answerEnabled: true },
    lastSyncedAt: null,
    lastError: null,
    recordCount: 0,
    createdAt: now(),
    ...patch,
  };
}
async function seed(count = 37) {
  (await save('sources', source('registered')));
  for (let i = 0; i < count; i++)
    (await save(
      'supplier_knowledge',
      {
        id: `supplier-${i}`,
        sourceId: 'registered',
        supplierName: `非公開仕入先${i}`,
        website: `https://preferred-${i}.example/`,
        products: '工具',
        fields: ['工具・機械部品'],
        sheet: '一覧',
        row: i + 1,
        approved: true,
        importedAt: now(),
      } satisfies SupplierKnowledge,
      { source_id: 'registered' },
    ));
}
function mockPages(
  options: {
    empty?: boolean;
    wrong?: boolean;
    failed?: boolean;
    stock?: string;
    preferredUrl?: string;
  } = {},
) {
  network.mockImplementation(async (url, init) => {
    const reply = { status: 200, headers: new Headers(), url, body: Buffer.from('') };
    if (url.includes('exa.ai')) {
      const body = JSON.parse(init!.body!);
      if (body.includeDomains && options.failed) throw Error('preferred_search_timeout');
      const productUrl = body.includeDomains ? options.preferredUrl || reference : external;
      reply.body = Buffer.from(
        JSON.stringify({
          results:
            body.includeDomains && options.empty
              ? []
              : [
                  {
                    title: 'ABC-100 商品',
                    url: productUrl,
                    highlights: ['ABC-100 カートに入れる'],
                  },
                ],
        }),
      );
      return reply;
    }
    if (url.includes('api.openai.com')) {
      const block = {
        text: '同じ型番のままでお見積りをご希望でしょうか？',
        evidenceIds: ['sourcing_outcome'],
      };
      init?.onChunk?.(
        new TextEncoder().encode(
          `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: JSON.stringify({ blocks: [block] }) })}\n\n`,
        ),
      );
      init?.onChunk?.(
        new TextEncoder().encode(
          `data: ${JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 40 } } })}\n\n`,
        ),
      );
      return reply;
    }
    reply.body = Buffer.from(
      `<main><h1>${url === reference && options.wrong ? 'ABC-100-2' : 'ABC-100'}</h1><p>${url === reference ? options.stock || '' : '在庫あり'}</p><p>カートに入れる</p></main>`,
    );
    return reply;
  });
}
function searches() {
  return network.mock.calls
    .filter(([url]) => url.includes('exa.ai'))
    .map(([, init]) => JSON.parse(init!.body!));
}
beforeEach(async () => {
  (await resetDbForTests());
  rmSync(directory, { recursive: true, force: true });
  vi.stubEnv('DATA_DIR', directory);
  vi.stubEnv('DEMO_MODE', 'true');
  vi.stubEnv('EXA_API_KEY', 'unit-exa');
  vi.stubEnv('TYPESAFE_API_KEY', '');
  vi.stubEnv('OPENAI_API_KEY', 'unit-openai');
  db();
  (await putSettings(settings));
  network.mockReset();
  pauseOpenaiForQuota(false);
});
afterEach(async () => {
  (await resetDbForTests());
  vi.unstubAllEnvs();
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

it('searches all 37 registered sites first and stops before public search when a purchase candidate is verified', async () => {
  (await seed());
  mockPages();
  const reply = await answerChat('ABC-100を10個、大阪府へ取り寄せたい', 'owner');
  expect(searches()).toHaveLength(1);
  expect(searches()[0].includeDomains).toHaveLength(37);
  expect(
    (await researchNotes(reply.conversationId))[0].sourceTrace?.stages[1].searches?.[0].consultedUrls,
  ).toContain(reference);
  const [note] = (await researchNotes(reply.conversationId));
  expect(note.sourceTrace?.observations[0]).toMatchObject({
    origin: 'preferred_sites',
    outcome: 'candidate',
    stock: 'unknown',
    listedQuantity: null,
  });
  expect(note.offers?.[0]).toMatchObject({ availableQuantity: null, approved: false });
  expect(note.sourceTrace?.stages.map((s) => s.scope)).toEqual([
    'registered_data',
    'preferred_sites',
  ]);
});
it('reads an imported internal document before doing any web search', async () => {
  (await seed());
  (await save(
    'documents',
    {
      id: 'doc',
      sourceId: 'registered',
      title: '社内の製品資料',
      content: 'ABC-100の仕様資料です。在庫は問い合わせ。',
      url: '',
      createdAt: now(),
    },
    { source_id: 'registered', content: 'ABC-100の仕様資料です。在庫は問い合わせ。' },
  ));
  mockPages();
  const reply = await answerChat('ABC-100の仕様と在庫を知りたい', 'owner');
  expect(network).not.toHaveBeenCalled();
  expect(reply.message.sourcing?.status).toBe('identified');
  expect((await researchNotes(reply.conversationId))[0].sourceTrace?.observations[0]).toMatchObject({
    origin: 'registered_data',
    sourceId: 'registered',
  });
});
it('keeps a registered catalogue as an inquiry candidate even without a shopping cart or stock display', async () => {
  (await seed());
  mockPages();
  const implementation = network.getMockImplementation()!;
  network.mockImplementation(async (url, init) =>
    url === reference
      ? {
          status: 200,
          headers: new Headers(),
          url,
          body: Buffer.from('<main><h1>ABC-100</h1><p>製品の仕様を掲載しています。</p></main>'),
        }
      : (await implementation(url, init)),
  );
  const reply = await answerChat('ABC-100を10個ほしい', 'owner');
  expect(searches()).toHaveLength(1);
  expect((await researchNotes(reply.conversationId))[0].offers?.[0]).toMatchObject({
    discoveryBasis: 'registered_listing',
    approved: false,
  });
});
it('includes additional websites from information sources at the same priority', async () => {
  (await seed());
  (await save('sources', source('web', { kind: 'website', url: 'https://extra.example/catalog' })));
  mockPages({ preferredUrl: 'https://extra.example/item' });
  const reply = await answerChat('ABC-100の見積を相談したい', 'owner');
  expect(searches()[0].includeDomains).toContain('extra.example');
  expect(searches()).toHaveLength(1);
  expect((await researchNotes(reply.conversationId))[0].sourceTrace?.observations[0]).toMatchObject({
    sourceId: 'web',
    origin: 'preferred_sites',
  });
});
it('expands to public web only after a completed empty preferred search and records why', async () => {
  (await seed());
  mockPages({ empty: true });
  const reply = await answerChat('ABC-100の在庫はありますか', 'owner');
  expect(searches()).toHaveLength(2);
  expect(searches()[0].includeDomains).toHaveLength(37);
  expect(searches()[1].includeDomains).toBeUndefined();
  const trace = (await researchNotes(reply.conversationId))[0].sourceTrace!;
  expect(trace.stages.map((s) => s.scope)).toEqual([
    'registered_data',
    'preferred_sites',
    'public_web',
  ]);
  expect(trace.stages[2].reason).toContain('確認できなかった');
  expect(trace.observations[0].origin).toBe('public_web');
});
it('rejects a different model suffix at the preferred site before trying the public web', async () => {
  (await seed());
  mockPages({ wrong: true });
  const reply = await answerChat('ABC-100は注文できますか', 'owner');
  const trace = (await researchNotes(reply.conversationId))[0].sourceTrace!;
  expect(searches()).toHaveLength(2);
  expect(trace.observations.map((o) => o.outcome)).toEqual(['mismatch', 'candidate']);
});
it('records preferred search failure separately from no stock and continues to the external web', async () => {
  (await seed());
  mockPages({ failed: true });
  const reply = await answerChat('ABC-100の納期を知りたい', 'owner');
  const trace = (await researchNotes(reply.conversationId))[0].sourceTrace!;
  expect(trace.stages[1]).toMatchObject({ status: 'failed', reason: 'preferred_search_timeout' });
  expect(trace.observations[0]).toMatchObject({ origin: 'public_web', outcome: 'candidate' });
});
it('retains a preferred out-of-stock observation while looking for another seller', async () => {
  (await seed());
  mockPages({ stock: '在庫なし' });
  const reply = await answerChat('ABC-100を10個ほしい', 'owner');
  const trace = (await researchNotes(reply.conversationId))[0].sourceTrace!;
  expect(trace.observations[0]).toMatchObject({
    origin: 'preferred_sites',
    stock: 'out_of_stock',
    outcome: 'identified',
  });
  expect(trace.observations[1]).toMatchObject({ origin: 'public_web', outcome: 'candidate' });
});
it('reports an incomplete search when public search fails after preferred pages did not match', async () => {
  (await seed());
  mockPages({ wrong: true });
  const implementation = network.getMockImplementation()!;
  network.mockImplementation(async (url, init) => {
    if (url.includes('exa.ai') && !JSON.parse(init!.body!).includeDomains)
      throw Error('invalid_json');
    return (await implementation(url, init));
  });
  const reply = await answerChat('ABC-100の在庫を確認したい', 'owner');
  expect(reply.message.sourcing?.status).toBe('failed');
  expect((await researchNotes(reply.conversationId))[0].status).toBe('failed');
  expect(reply.message.content).toContain('ページの取得が完了せず');
});
it('reuses the source snapshot for a quantity follow-up and keeps the record tied to that reply', async () => {
  (await seed());
  mockPages();
  const first = await answerChat('ABC-100は取り寄せできますか', 'owner');
  const next = await answerChat('10個、大阪府です', 'owner', first.conversationId);
  expect(searches()).toHaveLength(1);
  const answer = (await aiAnswerReport({ conversationId: next.conversationId })).items[0];
  expect(answer.sourceTrace?.reusedFromNoteId).toBe((await researchNotes(first.conversationId))[0].id);
  expect(answer.id).toBe(next.message.id);
});
it('invalidates cached priority decisions when a source is disabled', async () => {
  (await seed(1));
  mockPages();
  const first = await answerChat('ABC-100の在庫は', 'owner');
  (await save('sources', source('registered', { enabled: false })));
  await answerChat('ABC-100を10個ほしい', 'owner', first.conversationId);
  expect(searches()).toHaveLength(2);
  expect(searches()[1].includeDomains).toBeUndefined();
});
it('preserves original evidence after source edits and excludes private traces from both public response and restored history', async () => {
  (await seed());
  mockPages();
  const reply = await answerChat('ABC-100の価格を知りたい', 'owner');
  (await save('sources', source('registered', { name: '名前を変更', enabled: false })));
  const stored = (await conversationMessages(reply.conversationId)).at(-1) as StoredChatMessage;
  expect(stored.sourceTrace?.preferredSites[0].name).toBe('非公開仕入先0');
  expect(JSON.stringify(reply)).not.toMatch(/preferred-0|sourceTrace|非公開仕入先/);
  expect(JSON.stringify((await currentMessages(reply.conversationId)))).not.toMatch(
    /preferred-0|sourceTrace|非公開仕入先/,
  );
});
it('lets the configured OpenAI generate the actual sourcing reply and records its supplied facts and accepted citations', async () => {
  (await seed());
  mockPages();
  (await putSettings({ ...settings, responseProvider: 'openai', responseModel: 'gpt-4.1-mini' }));
  const reply = await answerChat(
    'ABC-100を10個、大阪府に届けたい。選び方の違いも教えてください',
    'owner',
  );
  expect(reply.message.responseProvider).toBe('openai');
  expect(reply.message.content).not.toContain('必要数量分の在庫・発送日は未確定');
  expect(reply.message.handoff).toBe('quote');
  const answer = (await aiAnswerReport({ conversationId: reply.conversationId })).items[0];
  expect(answer.sourceTrace?.answerFacts?.[0].id).toBe('sourcing_outcome');
  expect(answer.sourceTrace?.answerBlocks?.[0].evidenceIds).toEqual(['sourcing_outcome']);
  expect(
    answer.calls.some(
      (c) => c.provider === 'openai' && c.purpose === 'response' && c.outcome === 'accepted',
    ),
  ).toBe(true);
});
it('excludes disabled/unapproved sources and keeps the two held sites distinct from eligible sites', async () => {
  (await seed(1));
  (await save('sources', source('held')));
  (await save(
    'supplier_knowledge',
    {
      id: 'held-site',
      sourceId: 'held',
      supplierName: '保留仕入先',
      website: 'https://www.mcctr.co.jp/',
      products: '',
      fields: [],
      sheet: '',
      row: 1,
      approved: true,
      importedAt: now(),
    } satisfies SupplierKnowledge,
    { source_id: 'held' },
  ));
  const trace = (await createSourceTrace());
  expect(preferredDomains(trace)).toEqual(['preferred-0.example']);
  expect(trace.preferredSites.find((s) => s.domain === 'mcctr.co.jp')?.eligible).toBe(false);
});
it('retains a consulted HTTP supplier page and records excluded search URLs without using them as evidence', async () => {
  const url = 'http://www.s-s-p.jp/product.html';
  network.mockResolvedValue({
    status: 200,
    headers: new Headers(),
    url: 'https://api.openai.com/v1/responses',
    body: Buffer.from(
      JSON.stringify({
        status: 'completed',
        output: [
          {
            type: 'web_search_call',
            action: { queries: ['site:s-s-p.jp ABC-100'], sources: [{ url }, { url: external }] },
          },
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({ results: [{ title: 'ABC-100', url, content: '製品紹介' }] }),
              },
            ],
          },
        ],
      }),
    ),
  });
  const metadata: unknown[] = [];
  const result = await searchWeb(
    'ABC-100',
    { ...settings, searchProvider: 'openai' },
    ['s-s-p.jp'],
    { onSearch: (search) => metadata.push(search) },
  );
  expect(result.map((e) => e.url)).toEqual([url]);
  expect(metadata[0]).toMatchObject({
    queries: ['site:s-s-p.jp ABC-100'],
    discardedUrls: [external],
  });
});
