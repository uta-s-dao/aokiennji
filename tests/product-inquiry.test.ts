import { beforeEach, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { answerChat, currentMessages } from '../lib/server/chat';
import { composeConsultation } from '../lib/server/consultation';
import {
  uploadChatImage,
  readChatImage,
  chatImageInputs,
  validateChatImage,
} from '../lib/server/chat-images';
import { salesModel } from '../lib/server/sales-model';
import { putSettings, list } from '../lib/server/db';
import { DEFAULT_SETTINGS, type Product } from '../lib/contracts';
vi.mock('../lib/server/sales-model', () => ({ salesModel: vi.fn() }));
const model = vi.mocked(salesModel);
beforeEach(async () => {
  vi.stubEnv('DEMO_MODE', 'true');
  vi.stubEnv('OPENAI_API_KEY', '');
  await putSettings({
    ...DEFAULT_SETTINGS,
    responseProvider: 'openai',
    flags: { ...DEFAULT_SETTINGS.flags, webSearch: false, aiResearch: false },
  });
  model.mockReset();
});
const png = () =>
  sharp({ create: { width: 64, height: 64, channels: 3, background: '#fff' } })
    .png()
    .toBuffer();
it('prioritizes identification and clarifies a bare answer before changing question', () => {
  const first = composeConsultation({ customerTexts: ['工業炉の部品を相談したい'], handoff: true });
  expect(first).toMatch(/メーカー名・型番/);
  expect(first).not.toMatch(/使用温度|見積/);
  const second = composeConsultation({
    customerTexts: ['工業炉の部品を相談したい', '40'],
    previousReplies: ['使用温度は何度ですか？'],
    handoff: true,
  });
  expect(second).toMatch(/40.*温度.*℃/);
  expect(second).not.toContain('材質');
});
it('answers the seven-turn customer scenario without a quote checklist', async () => {
  let id: string | undefined;
  const replies: string[] = [];
  for (const message of [
    '工業炉の部品を相談したい',
    '40',
    '鉄製の固定金具を買えますか？',
    '急ぎません',
    '見積はまだ不要',
    '在庫は確認できますか？',
    '現物写真で確認できますか？',
  ]) {
    const result = await answerChat(message, 'customer', id);
    id = result.conversationId;
    replies.push(result.message.content);
    expect(result.message.handoff).not.toBe('quote');
    expect(result.message.content).not.toMatch(/使用温度.*材質|見積.*依頼できます|お急ぎの場合/);
  }
  expect(replies[1]).toContain('意味と単位');
  expect(replies[2]).toContain('販売・調達可否はまだ確認できていません');
  expect(replies[3]).toContain('お急ぎでない');
  expect(replies[4]).toContain('見積依頼は進めません');
  expect(replies[5].match(/登録在庫/g)).toHaveLength(1);
  expect(replies[6]).toContain('写真を選ぶ');
});
it('keeps unknown-model discovery going with purpose and shape', async () => {
  const first = await answerChat('型番が不明で資料もありません。工業炉の部品です', 'unknown');
  expect(first.message.content).toContain('何をする部品');
  const second = await answerChat('炉の扉を固定する金具です', 'unknown', first.conversationId);
  expect(second.message.content).toContain('形状');
  const third = await answerChat('L字の板状です', 'unknown', first.conversationId);
  expect(third.message.content).toContain('販売可否と在庫は未確認');
  expect(third.message.content).not.toContain('見積');
});
it('uses registered evidence and replaces quantity and model without depending on response model name', async () => {
  const catalog = await list<Product>('products');
  const firstProduct = catalog.find((p) => p.model === 'DEMO-GLASS-01')!;
  expect(firstProduct).toBeTruthy();
  for (const responseModelName of ['gpt-4.1', 'gpt-4.1-mini']) {
    await putSettings({
      ...DEFAULT_SETTINGS,
      responseModel: responseModelName,
      flags: { ...DEFAULT_SETTINGS.flags, webSearch: false },
    });
    const first = await answerChat('DEMO-GLASS-01の在庫を確認したい。2枚です', responseModelName);
    expect(first.message.content).toContain('登録在庫');
    expect(first.message.inquiryState?.quantity).toBe(2);
    const second = await answerChat(
      '訂正、5枚です。見積はまだ不要',
      responseModelName,
      first.conversationId,
    );
    expect(second.message.inquiryState?.quantity).toBe(5);
    expect(second.message.handoff).not.toBe('quote');
    const third = await answerChat('型番はABC-999でした', responseModelName, first.conversationId);
    expect(third.message.inquiryState?.model).toBe('ABC-999');
    expect(third.message.content).not.toContain('検索では');
    expect(third.message.content).toContain('外部サイトの在庫検索は現在利用できません');
  }
});
it('rejects invalid files and foreign owners/conversations; strips originals into WebP', async () => {
  await expect(validateChatImage(Buffer.from('<svg/>'))).rejects.toMatchObject({
    code: 'image_format',
  });
  await expect(validateChatImage(Buffer.alloc(5 * 1024 * 1024 + 1))).rejects.toMatchObject({
    code: 'image_size',
  });
  const upload = await uploadChatImage(await png(), 'alice');
  await expect(readChatImage(upload.id, 'bob')).rejects.toMatchObject({ code: 'forbidden' });
  await expect(chatImageInputs([upload.id], 'wrong-conversation', 'alice')).rejects.toMatchObject({
    code: 'forbidden',
  });
  const own = await readChatImage(upload.id, 'alice');
  expect((await sharp(own.bytes).metadata()).format).toBe('webp');
  expect(await readChatImage(upload.id, null, true)).toHaveProperty('bytes');
});
it('requires explicit image confirmation then connects to catalog lookup', async () => {
  const upload = await uploadChatImage(await png(), 'photo');
  model.mockResolvedValue({
    candidates: [
      {
        manufacturer: '',
        value: 'DEMO-GLASS-01',
        target: '箱のラベル',
        kind: 'order_model',
        readable: true,
      },
    ],
  });
  const first = await answerChat('箱の写真です', 'photo', upload.conversationId, {
    attachmentIds: [upload.id],
  });
  expect(first.message.content).toContain('まだ商品照会には使っていません');
  expect(first.message.products).toBeUndefined();
  const second = await answerChat('1番で合っています', 'photo', upload.conversationId);
  expect(second.message.products?.[0].model).toBe('DEMO-GLASS-01');
  expect((await currentMessages(upload.conversationId))[0].attachmentIds).toEqual([upload.id]);
});
it('does not mistake a drawing number or blurred suffix for an order model', async () => {
  const upload = await uploadChatImage(await png(), 'drawing');
  model.mockResolvedValue({
    candidates: [
      {
        manufacturer: '',
        value: 'DRAW-100',
        target: '図面全体',
        kind: 'drawing_number',
        readable: true,
      },
      { manufacturer: '', value: '', target: '右の部品', kind: 'unknown', readable: false },
    ],
  });
  await answerChat('図面の部品を買いたい', 'drawing', upload.conversationId, {
    attachmentIds: [upload.id],
  });
  const ambiguous = await answerChat('はい', 'drawing', upload.conversationId);
  expect(ambiguous.message.content).toContain('対象の番号');
  const drawing = await answerChat('1番で合っています', 'drawing', upload.conversationId);
  expect(drawing.message.content).toContain('注文用型番と確認できていません');
  expect(drawing.message.inquiryState?.model).toBeUndefined();
  model.mockResolvedValue({
    candidates: [
      { manufacturer: '', value: 'AB-12?', target: 'タグ', kind: 'order_model', readable: false },
    ],
  });
  const blurry = await answerChat('読めますか', 'drawing', upload.conversationId, {
    attachmentIds: [upload.id],
  });
  expect(blurry.message.content).toContain('拡大写真');
  expect(blurry.message.content).not.toContain('AB-12');
});
it('uses photo corrections instead of the old candidate and respects no quote consent', async () => {
  const upload = await uploadChatImage(await png(), 'correction');
  model.mockResolvedValue({
    candidates: [
      { manufacturer: '', value: 'ABC-123', target: 'タグ', kind: 'order_model', readable: true },
    ],
  });
  await answerChat('タグを見てください', 'correction', upload.conversationId, {
    attachmentIds: [upload.id],
  });
  const fixed = await answerChat(
    '違います。型番はDEMO-GLASS-01です。3個で見積は不要です',
    'correction',
    upload.conversationId,
  );
  expect(fixed.message.inquiryState?.model).toBe('DEMO-GLASS-01');
  expect(fixed.message.inquiryState?.imageCandidates).toBeUndefined();
  expect(fixed.message.handoff).not.toBe('quote');
});
it('rebuilds stale facts without exposing hidden stock on restoration', async () => {
  const reply = await answerChat('DEMO-GLASS-01の在庫は？', 'permissions');
  await putSettings({
    ...DEFAULT_SETTINGS,
    flags: { ...DEFAULT_SETTINGS.flags, showStock: false },
  });
  const messages = await currentMessages(reply.conversationId);
  expect(messages.at(-1)?.content).not.toContain('12個');
  expect(messages.at(-1)?.products?.[0].stock).toBeNull();
});
it('reserves image tokens through existing budgets and rejects unknown image pricing', async () => {
  const { quoteCall } = await import('../lib/server/ai-pricing');
  const image_url = `data:image/webp;base64,${(await validateChatImage(await png())).toString('base64')}`;
  const body = JSON.stringify({
    input: [{ role: 'user', content: [{ type: 'input_image', detail: 'high', image_url }] }],
    max_output_tokens: 4500,
  });
  expect(quoteCall('openai', 'gpt-4.1-mini', body).inputBound).toBeGreaterThan(16384);
  expect(() => quoteCall('openai', 'unpriced-model', body)).toThrow();
  expect(() => quoteCall('openai', 'gpt-4.1-mini', body.replace('high', 'original'))).toThrow();
});
it('does not loop on unavailable photos or reinterpret old stock as requested quantity', async () => {
  const first = await answerChat(
    '工業炉の扉を固定する鉄製のL字金具を2個買えますか。型番や資料はなく写真もありません。見積もりは不要です',
    'no-photo',
  );
  expect(first.message.content).not.toContain('写真を選ぶ');
  expect(first.message.content).toContain('販売');
  const second = await answerChat(
    '数量は2個ではなく5個でした。在庫は未確認ですね？',
    'no-photo',
    first.conversationId,
  );
  expect(second.message.inquiryState?.quantity).toBe(5);
  const known = await answerChat('DEMO-GLASS-01を3枚希望', 'old-stock');
  const next = await answerChat(
    '先ほどの12個という在庫情報について確認したい',
    'old-stock',
    known.conversationId,
  );
  expect(next.message.inquiryState?.quantity).toBe(3);
});
it('does not make external requests when lookup is disabled, including unknown models', async () => {
  const transport = await import('../lib/server/safe-fetch');
  const spy = vi.spyOn(transport, 'safeFetch').mockRejectedValue(Error('must not fetch'));
  try {
    const answer = await answerChat('在庫を調べたい。型番はUNKNOWN-471です', 'no-network');
    expect(answer.message.content).toContain('外部サイトの在庫検索は現在利用できません');
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});
it('keeps corrected identity and count at the front of a handoff draft', async () => {
  const first = await answerChat('DEMO-GLASS-01を2枚希望', 'draft-correction');
  await answerChat('型番はABC-999に訂正。数量は5枚です', 'draft-correction', first.conversationId);
  const last = await answerChat('担当者に相談したいです', 'draft-correction', first.conversationId);
  const current = last.message.handoffDraft?.split('【会話経過')[0];
  expect(current).toContain('ABC-999');
  expect(current).toContain('5枚');
  expect(current).not.toContain('DEMO-GLASS-01');
});
