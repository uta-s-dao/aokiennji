import { expect, it, vi, beforeEach } from 'vitest';
import { currentInquiryFacts, updateConditions } from '../lib/server/inquiry-guidance';
import type { ProductInquiryState } from '../lib/contracts';
import { streamChat } from '../components/api';
import { selectProductPassages } from '../lib/server/product-explanation';
import { salesModel } from '../lib/server/sales-model';
import { DEFAULT_SETTINGS } from '../lib/contracts';
vi.mock('../lib/server/sales-model', () => ({ salesModel: vi.fn() }));
beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(salesModel).mockReset();
  vi.stubEnv('OPENAI_API_KEY', 'synthetic');
});
it('keeps the roles of dimensions and overwrites only the corrected thickness', () => {
  const state: ProductInquiryState = { quantity: 2, quantityUnit: '枚' };
  updateConditions(state, 'PTFE製、内径50mm・外径90mm・厚さ3mmを2枚');
  updateConditions(state, '材質はそのまま、厚さだけ2mmに訂正します');
  expect(currentInquiryFacts(state)).toContain('内径50mm');
  expect(currentInquiryFacts(state)).toContain('外径90mm');
  expect(currentInquiryFacts(state)).toContain('厚さ2mm');
  expect(currentInquiryFacts(state)).not.toContain('3mm');
  expect(currentInquiryFacts(state)).toContain('材質：PTFE');
  expect(state.quantity).toBe(2);
});
it('recovers a truncated stream with the identical receipt, without sending a new turn', async () => {
  const result = {
    conversationId: 'existing',
    message: { id: 'answer', role: 'assistant', content: '回復した回答' },
  };
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json({ data: null }))
    .mockResolvedValueOnce(new Response('data: {"type":"text","data":"途中"}\n\n'))
    .mockResolvedValueOnce(Response.json({ data: result }));
  const input = { requestId: crypto.randomUUID(), message: '条件を教えて' };
  expect(await streamChat(input, vi.fn())).toEqual(result);
  expect(fetcher.mock.calls[1][1]?.body).toBe(fetcher.mock.calls[2][1]?.body);
  expect(fetcher.mock.calls[2][1]?.headers).not.toHaveProperty('Accept', 'text/event-stream');
});
it('reads a terminal SSE result without a final newline and handles split UTF-8', async () => {
  const result = { conversationId: 'c', message: { id: 'a', content: '説明' } };
  const bytes = new TextEncoder().encode(
    'data: ' + JSON.stringify({ type: 'result', data: result }),
  );
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(bytes.slice(0, bytes.length - 2));
      c.enqueue(bytes.slice(bytes.length - 2));
      c.close();
    },
  });
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json({ data: null }))
    .mockResolvedValueOnce(new Response(stream));
  expect(await streamChat({ requestId: crypto.randomUUID(), message: '質問' }, vi.fn())).toEqual(
    result,
  );
});
it('rejects invented technical quotes even when the model supplies a valid source index', async () => {
  vi.mocked(salesModel).mockResolvedValue({
    passages: [
      { source: 0, quote: '使用温度は1000℃です。' },
      { source: 0, quote: '架空材は水配管用の密封材です。' },
    ],
  });
  const result = await selectProductPassages({
    question: '用途は',
    names: ['架空材'],
    documents: [{ url: 'https://example.com/product', content: '架空材は水配管用の密封材です。' }],
    settings: DEFAULT_SETTINGS,
    context: { scope: 'chat' },
  });
  expect(result).toEqual([
    { quote: '架空材は水配管用の密封材です。', url: 'https://example.com/product' },
  ]);
});

it('retries a transient non-JSON recovery failure with the same request once', async () => {
  const result = {
    conversationId: 'recovered',
    message: { id: 'a', role: 'assistant', content: '回答' },
  };
  const f = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json({ data: null }))
    .mockResolvedValueOnce(new Response('data: {"type":"status","data":"確認中"}\n\n'))
    .mockResolvedValueOnce(new Response('Service unavailable', { status: 503 }))
    .mockResolvedValueOnce(Response.json({ data: result }));
  const input = { requestId: crypto.randomUUID(), message: '相談' };
  expect(await streamChat(input, vi.fn())).toEqual(result);
  expect(f.mock.calls[2][1]?.body).toBe(f.mock.calls[3][1]?.body);
});

it('extracts the matching product card without copying another model or the whole list', async () => {
  const { productDocumentText, productExplanationQuery } =
    await import('../lib/server/product-explanation');
  const target = { name: '試験ガスケット', model: '9007' };
  const text = productDocumentText(
    `<main><article><a><h3>試験ガスケット</h3><p>9007-LC</p><p>異なる製品の特徴で、最高温度は架空値です。</p></a></article><article><a><h3>試験ガスケット</h3><p>TOMBO No.9007</p><p>この製品はPTFE製のガスケットで、薬品を扱う配管の接合部に使用します。</p></a></article></main>`,
    [target],
  );
  expect(text).toContain('PTFE製');
  expect(text).not.toContain('9007-LC');
  expect(text).not.toContain('架空値');
  expect(productExplanationQuery('薬品に対するゴムとの使い分けは？', [target])).toContain(
    '耐薬品性',
  );
  expect(productExplanationQuery('仕様と厚さは？', [target])).toContain('標準寸法');
});

it('reads a product description whose heading is a table header inside its own product section', async () => {
  const { productDocumentText } = await import('../lib/server/product-explanation');
  const html = `<div class="products"><div class="article"><div class="title"><table><tr><th>試験ガスケット</th><td>TOMBO No.9007</td></tr></table></div><div><h4>特長</h4><p>この製品は試験用PTFEシートを所定の寸法に切断した部材で、配管の接合部に使用します。</p></div></div><div class="article"><div class="title"><table><tr><th>試験ガスケットLC</th><td>9007-LC</td></tr></table></div><p>別の製品の特徴です。薬品への適用条件は対象製品と異なります。</p></div></div>`;
  const result = productDocumentText(html, [{ name: '試験ガスケット', model: '9007' }]);
  expect(result).toContain('所定の寸法に切断');
  expect(result).not.toContain('9007-LC');
  expect(result).not.toContain('別の製品');
});

it('keeps a nearby temperature limitation with a source quote about performance', async () => {
  const benefit = '試験ガスケットは耐薬品性に優れたPTFE製の部材です。';
  const caution = '使用温度が100℃を超える場合は別の材質を確認してください。';
  vi.mocked(salesModel).mockResolvedValue({ passages: [{ source: 0, quote: benefit }] });
  const r = await selectProductPassages({
    question: '特徴は？',
    names: ['試験ガスケット'],
    documents: [{ url: 'https://example.com/detail', content: benefit + caution }],
    settings: DEFAULT_SETTINGS,
    context: { scope: 'chat' },
  });
  expect(r[0].quote).toBe(benefit + caution);
});
