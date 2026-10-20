import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, type Conversation, type Quote, type Source } from '../lib/contracts';
import { byId, db, putSettings, resetDbForTests, save } from '../lib/server/db';
import { answerChat, currentMessages } from '../lib/server/chat';
import { createQuote } from '../lib/server/business';
import { customerStatements, statedConditions } from '../lib/server/consultation';
import { importSupplierKnowledge } from '../lib/server/supplier-knowledge';
vi.mock('../lib/server/safe-fetch', () => ({ safeFetch: vi.fn() }));
import { safeFetch } from '../lib/server/safe-fetch';

// Conversations from the live evaluation of 2026-10-07 that ended in a canned
// request for a product name, and the procedures customers asked about.
const network = vi.mocked(safeFetch);
const directory = mkdtempSync(join(tmpdir(), 'aoki-chat-quality-'));
const canned = 'もう少し詳しく教えていただけますか';
const source: Source = {
  id: 'private-fields',
  name: '秘密資料.xlsx',
  kind: 'supplier_catalog',
  enabled: true,
  visibility: 'internal',
  trust: 'internal',
  url: '',
  config: { answerEnabled: true },
  syncIntervalHours: 0,
  lastSyncedAt: null,
  lastError: null,
  recordCount: 0,
  createdAt: new Date().toISOString(),
};
beforeEach(async () => {
  vi.stubEnv('DATA_DIR', directory);
  vi.stubEnv('DEMO_MODE', 'true');
  vi.stubEnv('OPENAI_API_KEY', 'unit-openai');
  vi.stubEnv('TYPESAFE_API_KEY', '');
  (await resetDbForTests());
  rmSync(directory, { recursive: true, force: true });
  db();
  network.mockReset();
  (await save('sources', source));
  (await importSupplierKnowledge(
    source,
    [
      {
        supplierName: '非公開確認商事',
        website: 'https://private-identity.example',
        products: 'バルブ・パッキン・ポンプ・断熱材・ガラス製品',
        fields: [],
        sheet: '仕入',
        row: 2,
      },
    ],
    true,
  ));
  (await putSettings({ ...DEFAULT_SETTINGS, responseProvider: 'openai' }));
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  (await resetDbForTests());
  rmSync(directory, { recursive: true, force: true });
});
// Each response call returns the next text; the last one repeats.
function replies(...texts: string[]) {
  const queue = [...texts];
  network.mockImplementation(async (url, options) => {
    const text = queue.length > 1 ? queue.shift()! : queue[0];
    for (const event of [
      {
        type: 'response.output_text.delta',
        delta: JSON.stringify({ blocks: [{ text, evidenceIds: [] }] }),
      },
      { type: 'response.completed', response: { usage: { input_tokens: 500, output_tokens: 90 } } },
    ])
      options?.onChunk?.(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    return { status: 200, headers: new Headers(), url, body: Buffer.from('') };
  });
}
const sentInput = (index = -1) =>
  JSON.parse(JSON.parse(network.mock.calls.at(index)![1]!.body!).input);
const valve = [
  '商品名が分からないのですが、水の流れを止めたり開いたりする部品を探しています。',
  '工場の冷却水です。手で開け閉めできるもので、配管は25A、温度は40度くらいです。どんな種類から選べばいいですか？',
  '圧力はまだ分かりません。全開か全閉で使うつもりです。ほかに何を調べておくとよいですか？',
  '接続はねじ込み式でした。設備の資料を担当者に見てもらって選定を相談したいです。どうすればいいですか？',
  'では、いま分かっている希望条件を、担当者に伝えやすいように短くまとめてください。',
];

it("lets the response model repeat the customer's own conditions", async () => {
  replies(
    'バルブのご相談ですね。どのような流体に使いますか？',
    '25Aで40度の冷却水を手で開け閉めするなら、ボール弁や仕切弁が一般的な候補です。圧力が分かると絞り込めます。',
  );
  const first = await answerChat(valve[0], 'valve-ai');
  const second = await answerChat(valve[1], 'valve-ai', first.conversationId);
  expect(second.message.responseProvider).toBe('openai');
  expect(second.message.content).toContain('25Aで40度');
  const input = sentInput();
  expect(input.customerNotes).toEqual([valve[0], valve[1]]);
  expect(input.facts.find((f: { id: string }) => f.id === 'selection_points').text).toContain(
    '口径',
  );
  expect(JSON.stringify(network.mock.calls)).not.toContain('非公開確認商事');
});

it('continues from the stated conditions when a draft invents a value', async () => {
  replies('耐熱温度は500度までです。');
  const first = await answerChat(valve[0], 'valve-rejected');
  const second = await answerChat(valve[1], 'valve-rejected', first.conversationId);
  expect(second.message.responseProvider).toBe('local');
  expect(second.message.content).not.toContain(canned);
  expect(second.message.content).not.toContain('500');
  expect(second.message.content).toContain('25A');
  expect(second.message.content).toContain('40度');
  expect(second.message.content).toContain('「圧力」');
});

it('keeps a whole consultation useful without a response model', async () => {
  (await putSettings({ ...DEFAULT_SETTINGS, responseProvider: 'local' }));
  const replies = [];
  let conversationId: string | undefined;
  for (const message of valve) {
    const result = await answerChat(message, 'valve-local', conversationId);
    conversationId = result.conversationId;
    replies.push(result.message);
  }
  expect(network).not.toHaveBeenCalled();
  for (const reply of replies) {
    expect(reply.content).not.toContain(canned);
    expect(reply.content).not.toContain('商品名・型番');
  }
  expect(replies[0].content).toContain('バルブ');
  expect(replies[1].content).toContain('25A');
  // Pressure was answered as unknown; the next question moves on.
  expect(replies[2].content).not.toContain('「圧力」');
  expect(replies[2].content).toContain('接続方式');
  expect(replies[3].content).toContain('この内容で相談を依頼する');
  expect(replies[3].handoff).toBe('inquiry');
  expect(replies[4].route).toBe('summary');
  expect(replies[4].content).toContain(
    '・手で開け閉めできるもので、配管は25A、温度は40度くらいです',
  );
  expect(replies[4].content).toContain('未確認：圧力');
  expect(replies[4].handoffDraft).toContain('25A');
  // A reopened conversation keeps the composed replies.
  expect((await currentMessages(conversationId!)).at(-1)?.content).toBe(replies[4].content);
});

it('answers the request after thanks instead of only replying to the thanks', async () => {
  (await putSettings({ ...DEFAULT_SETTINGS, responseProvider: 'local' }));
  const first = await answerChat(
    'DEMO-CART-01はすぐ買えますか？在庫とお値段も知りたいです。',
    'cart',
  );
  await answerChat(
    '別件で、DEMO-CAST-01を4個にした場合の参考価格を先に教えてください。',
    'cart',
    first.conversationId,
  );
  const back = await answerChat(
    'ありがとうございます。さっきの搬送台車1台の方に戻ります。300kgを載せる時に確認すべきことを教えてください。',
    'cart',
    first.conversationId,
  );
  expect(back.message.content).not.toContain('どういたしまして');
  expect(back.message.route).toBe('consultation');
  expect(back.message.content).toContain('300kg');
  expect(back.message.content).not.toContain('4個');
});

it('keeps the product through quantity changes and adds tax and shipping answers', async () => {
  (await putSettings({ ...DEFAULT_SETTINGS, responseProvider: 'local' }));
  const first = await answerChat(
    'DEMO-STUD-01についてお伺いします。単価と在庫、通常の納期を教えていただけますか？',
    'stud',
  );
  const three = await answerChat(
    '3本で考えています。商品代だけの金額をお願いします。',
    'stud',
    first.conversationId,
  );
  expect(three.message.content).toContain('3本ですね');
  expect(three.message.content).toContain('21,600');
  const five = await answerChat(
    'すみません、5本に変更します。金額も更新して、今月末までに静岡へ届けられるか確認したいです。',
    'stud',
    first.conversationId,
  );
  expect(five.message.products?.[0].model).toBe('DEMO-STUD-01');
  expect(five.message.content).toContain('36,000');
  expect(five.message.content).toContain('ご希望の時期に間に合うか');
  const total = await answerChat(
    '税込み・送料込みだと合計いくらでしょうか。送料が未確定なら、その点を教えてください。',
    'stud',
    first.conversationId,
  );
  expect(total.message.content).toContain('39,600');
  expect(total.message.content).toContain('送料はお届け先と数量によって変わる');
  expect((await currentMessages(first.conversationId)).at(-1)?.content).toBe(total.message.content);
  expect(network).not.toHaveBeenCalled();
});

it('answers order, status and reservation questions separately and offers the hand-off', async () => {
  (await putSettings({ ...DEFAULT_SETTINGS, responseProvider: 'local' }));
  const order = await answerChat(
    'ポンプについて相談です。循環水用に1台必要ですが、ここで注文できますか？',
    'pump',
  );
  expect(order.message.content).toContain('このチャットからはご注文を受け付けていません');
  // Ordering goes through a quote, so the button opens the quote request.
  expect(order.message.handoff).toBe('quote');
  expect(order.message.content).toContain('この内容で見積を依頼する');
  const status = await answerChat(
    '今のポンプ1台の注文内容はもう担当者に送信されましたか？確認メールも届きますか？',
    'pump',
    order.conversationId,
  );
  expect(status.message.content).toContain('正式なご依頼としては未送信');
  const hold = await answerChat(
    '注文前に、在庫を取り置きしておいてもらえますか？返信が来るまで確保してください。',
    'pump',
    order.conversationId,
  );
  expect(hold.message.content).toContain('取り置き');
  expect(hold.message.content).toContain('お約束できません');
  const text = await answerChat(
    '問い合わせに使う文章を作ってください。循環水用のポンプ1台で、購入前に在庫と取り置き可否を確認したいです。',
    'pump',
    order.conversationId,
  );
  expect(text.message.route).toBe('summary');
  expect(text.message.handoffDraft).toContain(
    '循環水用のポンプ1台で、購入前に在庫と取り置き可否を確認したいです',
  );
  expect(new Set([order, status, hold].map((r) => r.message.content)).size).toBe(3);
  expect(network).not.toHaveBeenCalled();
});

it('tells the customer when the conversation was already handed off', async () => {
  const first = await answerChat('パッキンを探しています', 'handed');
  const conversation = (await byId<Conversation>('conversations', first.conversationId))!;
  (await save('conversations', { ...conversation, status: 'handed_off' }, { owner_id: 'handed' }));
  const status = await answerChat(
    'もう問い合わせは送られていますか？',
    'handed',
    first.conversationId,
  );
  expect(status.message.content).toContain('受け付けています');
  expect(status.message.handoff).toBeUndefined();
});

it('asks the response model for a summary and carries it to the inquiry form', async () => {
  replies(
    'バルブのご相談ですね。',
    '25Aの冷却水用ですね。圧力が分かると絞り込めます。',
    'ご相談内容をまとめました。\n・工場の冷却水用、25A、40度、手動\n未確認：圧力。下の「この内容で相談を依頼する」から送れます。',
  );
  const first = await answerChat(valve[0], 'summary-ai');
  await answerChat(valve[1], 'summary-ai', first.conversationId);
  const summary = await answerChat(valve[4], 'summary-ai', first.conversationId);
  expect(sentInput().mode).toBe('summary');
  expect(summary.message.responseProvider).toBe('openai');
  expect(summary.message.handoff).toBe('inquiry');
  expect(summary.message.handoffDraft).toContain('・工場の冷却水用、25A、40度、手動');
});

it('explains how to reach the staff without calling a model', async () => {
  replies('使われないはずの文章です。');
  const result = await answerChat(
    'この内容を担当者に引き継いで連絡してもらえますか？メールアドレスはどこで入力すればいいですか？',
    'handoff',
  );
  expect(result.message.route).toBe('handoff');
  expect(result.message.content).toContain('この内容で相談を依頼する');
  expect(result.message.content).toContain('お名前とメールアドレス');
  expect(result.message.handoff).toBe('inquiry');
  expect(network).not.toHaveBeenCalled();
});

it('gives the phone number once per conversation unless the customer asks for it', async () => {
  (await putSettings({ ...DEFAULT_SETTINGS, responseProvider: 'local' }));
  const phone = '093-382-2110';
  const urgent = await answerChat('至急パッキンが必要です。ラインが止まっています。', 'phone');
  expect(urgent.message.content.split(phone)).toHaveLength(2);
  const handoff = await answerChat('担当者に相談したいです。', 'phone', urgent.conversationId);
  expect(handoff.message.content).not.toContain(phone);
  expect(handoff.message.content).toContain('お名前とメールアドレス');
  const asked = await answerChat(
    '電話番号をもう一度教えてください。',
    'phone',
    urgent.conversationId,
  );
  expect(asked.message.content).toContain(phone);
});

it('invites a quote request right after a registered price, once', async () => {
  (await putSettings({ ...DEFAULT_SETTINGS, responseProvider: 'local' }));
  const price = await answerChat('DEMO-GLASS-01の価格は？', 'quote-invite');
  expect(price.message.handoff).toBe('quote');
  expect(price.message.handoffProductId).toBeTruthy();
  expect(price.message.content).toContain('この内容で見積を依頼する');
  const quantity = await answerChat('10個だといくら？', 'quote-invite', price.conversationId);
  expect(quantity.message.handoff).toBe('quote');
  expect(quantity.message.content).not.toContain('この内容で見積を依頼する');
});

// Findings of the customer-agent conversations of 2026-10-13.
it('gives a fixed terms answer once, then answers in conversation', async () => {
  replies('掛け払いのご希望は、見積依頼に添えて当社で確認します。');
  const first = await answerChat('支払いは月末締めの請求書払いでいけますか？', 'terms-once');
  expect(first.message.content).toContain('お支払い方法・条件は');
  expect(network).not.toHaveBeenCalled();
  const second = await answerChat(
    '支払条件ですが、掛け払いで大丈夫ですか？',
    'terms-once',
    first.conversationId,
  );
  expect(second.message.content).not.toContain('お支払い方法・条件は');
  expect(second.message.responseProvider).toBe('openai');
  expect(sentInput().facts.find((f: { id: string }) => f.id === 'policies').text).toContain(
    'お支払い方法・条件は',
  );
});

it('keeps offering the quote request and names the button that is shown', async () => {
  replies(
    'ご相談内容をまとめました。\n・パッキン 30枚\n下の「この内容で相談を依頼する」から送れます。',
  );
  const first = await answerChat('パッキンを30枚ほしいです。在庫はありますか？', 'sticky');
  expect(first.message.handoff).toBe('quote');
  const summary = await answerChat(
    'ここまでの内容をまとめてください',
    'sticky',
    first.conversationId,
  );
  expect(summary.message.handoff).toBe('quote');
  expect(summary.message.content).toContain('この内容で見積を依頼する');
  expect(summary.message.content).not.toContain('この内容で相談を依頼する');
});

it('does not answer another item with the previous registered product', async () => {
  (await putSettings({ ...DEFAULT_SETTINGS, responseProvider: 'local' }));
  const first = await answerChat('DEMO-CAST-01を50個、単価はいくらですか？', 'other-item');
  expect(first.message.content).toContain('円');
  const plate = await answerChat(
    'SUS304の板のほうは、1枚あたりの価格の目安はどのくらいでしょうか。',
    'other-item',
    first.conversationId,
  );
  expect(plate.message.products).toHaveLength(0);
  expect(plate.message.content).not.toContain('鋳物');
  expect(plate.message.content).toContain('鋼材・板材の価格');
});

it('answers whether work is outsourced without the supplier privacy reply', async () => {
  (await putSettings({ ...DEFAULT_SETTINGS, responseProvider: 'local' }));
  const reply = await answerChat(
    '石英の丸切りは社内で加工されるんですか、それとも外注ですか？',
    'outsourcing',
  );
  expect(reply.message.route).toBe('policy');
  expect(reply.message.content).toContain('協力会社');
  const withdrawn = await answerChat(
    '外注先の名前を知りたいわけではないので大丈夫です。二重窓は一般的ですか？',
    'outsourcing',
    reply.conversationId,
  );
  expect(withdrawn.message.route).not.toBe('privacy');
  expect(JSON.stringify([reply, withdrawn])).not.toContain('非公開確認商事');
});

it('removes a repeated phone sentence as a whole and keeps the rest', async () => {
  replies(
    'お急ぎの場合は093-382-2110へお電話いただくのが確実です。パッキンの寸法が分かると選定が早まります。',
  );
  const reply = await answerChat(
    '至急パッキンが必要です。ラインが止まっていて、ポンプの軸から漏れています。',
    'phone-sentence',
  );
  expect(reply.message.content.split('093-382-2110')).toHaveLength(2);
  expect(reply.message.content).not.toContain('へお電話');
  expect(reply.message.content).toContain('寸法が分かると');
});

it('does not refuse an unregistered model or ask again for a maker already given', async () => {
  (await putSettings({ ...DEFAULT_SETTINGS, responseProvider: 'local' }));
  const reply = await answerChat('三ツ星ベルトのB60を4本、在庫ありますか？', 'unknown-model');
  expect(reply.message.content).toContain('「B60」は登録商品にはありませんが');
  expect(reply.message.content).not.toContain('取扱いを確認できませんでした');
  expect(reply.message.content).not.toContain('メーカー名');
  expect(reply.message.handoff).toBe('quote');
});

it('attaches the chat to a quote request for the staff only', async () => {
  (await putSettings({ ...DEFAULT_SETTINGS, responseProvider: 'local' }));
  const chat = await answerChat('パッキンを30枚、見積お願いします', 'quote-link');
  const quote = (await createQuote(
    {
      name: '購買',
      company: '',
      email: 'buyer@example.com',
      message: 'チャットの内容で見積希望',
      consent: true,
      quantity: 1,
      conversationId: chat.conversationId,
    },
    'quote-link',
  ));
  expect(quote.conversationId).toBeUndefined();
  expect((await byId<Quote>('quotes', quote.id))!.conversationId).toBe(chat.conversationId);
  expect((await byId<Conversation>('conversations', chat.conversationId))!.status).toBe('handed_off');
});

it('gives the phone number first when the customer wants to call', async () => {
  (await putSettings({ ...DEFAULT_SETTINGS, responseProvider: 'local' }));
  const first = await answerChat('至急パッキンが必要です。ラインが止まっています。', 'call');
  const call = await answerChat('電話で直接話したいです。', 'call', first.conversationId);
  expect(call.message.content.startsWith('お電話でのご相談は、093-382-2110で承ります。')).toBe(
    true,
  );
});

it('lists what a quote needs once and passes an answered question to the model', async () => {
  replies('当日の手配は在庫の確認次第です。お電話いただくと早く確認できます。');
  const items = await answerChat('では見積を依頼したいです。何を書けばいいですか？', 'items');
  expect(items.message.content.match(/品名/g)).toHaveLength(1);
  const urgent = await answerChat('至急で今日中に必要です。', 'items', items.conversationId);
  const again = await answerChat('今日中に何とかなりませんか？', 'items', urgent.conversationId);
  expect(again.message.responseProvider).toBe('openai');
  expect(sentInput().answer).toContain('当日の対応や最短の手配');
});

it('does not repeat the same sentences across a consultation without a response model', async () => {
  (await putSettings({ ...DEFAULT_SETTINGS, responseProvider: 'local' }));
  const seen = new Map<string, number>();
  let conversationId: string | undefined;
  for (const message of valve.slice(0, 4)) {
    const result = await answerChat(message, 'no-repeat', conversationId);
    conversationId = result.conversationId;
    for (const sentence of new Set(result.message.content.split(/(?<=[。？])|\n/)))
      if (sentence.trim().length >= 12) seen.set(sentence, (seen.get(sentence) || 0) + 1);
  }
  expect([...seen].filter(([, n]) => n > 1)).toEqual([]);
});

it('never returns an empty reply when the response model fails on a repeated question', async () => {
  network.mockResolvedValue({
    status: 500,
    headers: new Headers(),
    url: 'https://api.openai.com/v1/responses',
    body: Buffer.from(''),
  });
  const first = await answerChat('支払いは月末締めの請求書払いでいけますか？', 'outage');
  const again = await answerChat('支払いは月末締めでいけますか？', 'outage', first.conversationId);
  expect(again.message.responseProvider).toBe('local');
  expect(again.message.content).toContain('お支払い方法・条件は');
  const facts = await answerChat('パッキン50Aを30枚、在庫はありますか？', 'outage-facts');
  const more = await answerChat('在庫はありますか？', 'outage-facts', facts.conversationId);
  expect(more.message.content.trim()).not.toBe('');
});

it('keeps the newest amount and ignores unit prices and asked choices', () => {
  expect(
    statedConditions([
      'SUS316の金網トレーを30枚、1枚あたりの価格も知りたいです。',
      '50枚に変更します。165℃で使います。316Lにした方が無難でしょうか？',
    ]),
  ).toEqual(['165℃', '50枚']);
  const statements = customerStatements([
    '三ツ星ベルトのB60を4本ほしいです。大分市の工場に届けてください。',
    ...Array.from({ length: 14 }, (_, i) => `条件${i + 1}は${i + 10}ミリです。`),
    'まあいいや',
    '同じ返事が続いていますね',
  ]);
  expect(statements[0]).toContain('B60を4本');
  expect(statements.join()).not.toMatch(/まあいいや|同じ返事/);
});

it('uses the newest quantity and leaves an acknowledged topic alone', async () => {
  (await putSettings({ ...DEFAULT_SETTINGS, responseProvider: 'local' }));
  const first = await answerChat('DEMO-CAST-01を40個、単価はいくらですか？', 'newest');
  const changed = await answerChat(
    '値引きの件は承知しました。40個から60個に変更します。60個だと税込でいくらですか？',
    'newest',
    first.conversationId,
  );
  expect(changed.message.requestedQuantity).toBe(60);
  expect(changed.message.content).not.toContain('値引きをこの場で');
  const unit = await answerChat(
    '1個あたり8,400円で合っていますか？',
    'newest',
    first.conversationId,
  );
  expect(unit.message.requestedQuantity).toBe(60);
  expect(unit.message.content).toContain('1個あたり8,400円');
});

it('follows a quoted unit price back to its product and does not ask which item a bolt is', async () => {
  (await putSettings({ ...DEFAULT_SETTINGS, responseProvider: 'local' }));
  const first = await answerChat('DEMO-CAST-01を40個購入したいです。単価と税込合計は？', 'back');
  const bolts = await answerChat(
    'SUS304の六角ボルト M12×40を300本も一緒にお願いしたいです。こちらの価格は？',
    'back',
    first.conversationId,
  );
  expect(bolts.message.content).not.toContain('どの商品か');
  expect(bolts.message.content).toContain('ボルト・ナットの価格');
  const unit = await answerChat('1個あたり8,400円で合っていますか？', 'back', first.conversationId);
  expect(unit.message.products?.[0].model).toBe('DEMO-CAST-01');
  expect(unit.message.content).toContain('1個あたり8,400円');
  expect(unit.message.requestedQuantity).toBe(40);
  const summary = await answerChat(
    'ここまでの内容をまとめてください',
    'back',
    first.conversationId,
  );
  // The demo casting's category ("耐熱ガラス・鋳物") does not make it a glass topic.
  expect(summary.message.content).not.toContain('覗き窓');
  expect(summary.message.content).toContain('M12×40');
});

it('speaks for our company even when the model draft deflects to another staff member', async () => {
  replies('現物の写真を添えて担当者にご相談ください。');
  const reply = await answerChat(
    '古いコンベヤのベルトを交換したいです。型番は消えています。',
    'our-window',
  );
  expect(reply.message.content).not.toMatch(/担当者|担当の者/);
  expect(reply.message.responseProvider).toBe('local');
});

it('explains belt circumference correctly and carries the conversation into a quote', async () => {
  (await putSettings({ ...DEFAULT_SETTINGS, responseProvider: 'local' }));
  const first = await answerChat(
    'コンベヤの平ベルトを1本、埼玉県へ。幅200mm、厚み2mm、機械の端から端は1mです。見積希望です。',
    'belt-length',
  );
  const second = await answerChat(
    'ベルト一周はどう測ればいいですか？',
    'belt-length',
    first.conversationId,
  );
  expect(second.message.content).toContain('設備を停止');
  expect(second.message.content).toContain('輪の全周');
  expect(second.message.content).toContain('プーリーの円周とは異なります');
  expect(second.message.handoff).toBe('quote');
  expect(second.message.content).not.toMatch(/担当者|円周率をかけ/);
});

it('answers shipment timing questions without treating generic supplier dispatch as a request for private identity', async () => {
  (await putSettings({ ...DEFAULT_SETTINGS, responseProvider: 'local' }));
  const first = await answerChat(
    '仕入先の発送日と、こちらに届く日は分けて教えてもらえますか？',
    'shipping-privacy',
  );
  expect(first.message.route).not.toBe('privacy');
  const secret = await answerChat(
    '仕入先の会社名とURLを教えてください',
    'shipping-privacy',
    first.conversationId,
  );
  expect(secret.message.route).toBe('privacy');
  const quote = await answerChat(
    'ではパッキン30枚の見積をお願いします。',
    'shipping-privacy',
    first.conversationId,
  );
  expect(quote.message.route).not.toBe('privacy');
  expect(quote.message.handoff).toBe('quote');
});

it('preserves the quantity and destination for a made-to-order quote form and stops asking after agreement', async () => {
  (await putSettings({ ...DEFAULT_SETTINGS, responseProvider: 'local' }));
  const first = await answerChat(
    'SUS304のL字金具4個、京都府向けに製作見積をお願いしたいです。',
    'custom-quote-quantity',
  );
  const next = await answerChat(
    '穴位置は設計確認中です。図面は後から連絡します。',
    'custom-quote-quantity',
    first.conversationId,
  );
  const quote = await answerChat(
    '今の条件で見積依頼します。連絡先はどこへ入力しますか？',
    'custom-quote-quantity',
    first.conversationId,
  );
  expect(next.message.requestedQuantity).toBe(4);
  expect(quote.message.requestedQuantity).toBe(4);
  expect(quote.message.requestedDestination).toBe('京都');
  expect(quote.message.handoff).toBe('quote');
});

it('does not reconfirm a quantity already supplied for a fabrication quote', async () => {
  replies('SUS304のL字金具4個でお間違いないでしょうか。');
  const reply = await answerChat(
    'SUS304のL字金具を4個、京都府向けに製作見積をお願いします。',
    'do-not-reask-amount',
  );
  expect(reply.message.content).not.toContain('お間違いないでしょうか');
  expect(reply.message.requestedQuantity).toBe(4);
  expect(reply.message.handoff).toBe('quote');
});
