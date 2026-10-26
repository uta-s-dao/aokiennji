import { beforeEach, expect, it, vi } from 'vitest';
import { answerChat } from '../lib/server/chat';
import { salesModel } from '../lib/server/sales-model';
import { DEFAULT_SETTINGS } from '../lib/contracts';
import { putSettings } from '../lib/server/db';
import { understandInquiry } from '../lib/server/inquiry-understanding';
vi.mock('../lib/server/sales-model', () => ({ salesModel: vi.fn() }));
const model = vi.mocked(salesModel);
const parsed = (extra = {}) => ({
  model: '',
  quantityWithdrawn: false,
  purpose: '',
  shape: '',
  dimensions: '',
  manufacturer: '',
  designation: '',
  designationKind: 'unknown',
  newSubject: false,
  confirmingGuidance: false,
  quantity: 0,
  quantityEvidence: '',
  quantityUnit: '',
  quotePreference: 'unchanged',
  handoffPreference: 'unchanged',
  requestedInformation: 'other',
  identityUnavailable: false,
  identityUnavailableEvidence: '',
  next: 'none',
  known: [],
  ...extra,
});
beforeEach(async () => {
  model.mockReset();
  vi.stubEnv('OPENAI_API_KEY', 'synthetic');
  await putSettings({
    ...DEFAULT_SETTINGS,
    responseProvider: 'local',
    flags: { ...DEFAULT_SETTINGS.flags, webSearch: false, aiResearch: false },
  });
});
it('interprets a spaced trademark series with local replies, without inventing a manufacturer or stock', async () => {
  model.mockResolvedValueOnce(parsed({ next: 'identity' }));
  const first = await answerChat('耐熱ガラスを探している', 'interpretation');
  model.mockResolvedValueOnce(
    parsed({ designation: 'BOROFLOAT® 33', designationKind: 'series', known: ['identity'] }),
  );
  const next = await answerChat('BOROFLOAT® 33', 'interpretation', first.conversationId);
  expect(next.message.inquiryState?.designation).toBe('BOROFLOAT® 33');
  expect(next.message.inquiryState?.manufacturer).toBeUndefined();
  expect(next.message.content).toContain('BOROFLOAT® 33');
  expect(next.message.content).toContain('登録商品を照合');
  expect(next.message.content).not.toContain('資料がなければ');
  expect(next.message.content).toContain('現在庫は未確認');
  expect(model.mock.calls.at(-1)?.[0].model).toBe('gpt-4.1-mini');
});
it('retains a name and corrects quantities without interpreting the series number as stock', async () => {
  model.mockResolvedValueOnce(
    parsed({ designation: '透明ガラスα', designationKind: 'product_name' }),
  );
  const first = await answerChat('商品名は透明ガラスα', 'correction');
  model.mockResolvedValueOnce(
    parsed({
      quantity: 5,
      quantityEvidence: '5枚',
      quantityUnit: '枚',
      quotePreference: 'declined',
    }),
  );
  const next = await answerChat(
    '3枚ではなく5枚、見積は不要です',
    'correction',
    first.conversationId,
  );
  expect(next.message.inquiryState).toMatchObject({
    designation: '透明ガラスα',
    quantity: 5,
    quoteDeclined: true,
  });
  expect(next.message.handoff).not.toBe('quote');
});
it('asks clarification when the interpreter fails instead of advancing a checklist', async () => {
  model.mockRejectedValue(Error('quota'));
  const first = await answerChat('耐熱ガラスを探している', 'failure');
  const next = await answerChat('BOROFLOAT® 33', 'failure', first.conversationId);
  expect(next.message.content).toContain('判断できませんでした');
  expect(next.message.content).not.toContain('資料がなければ');
});
it('rejects identities and quantity evidence absent from the latest message', async () => {
  model.mockResolvedValue(
    parsed({
      designation: 'invented',
      manufacturer: 'invented',
      model: 'invented',
      quantity: 50,
      quantityEvidence: '50個',
    }),
  );
  const result = await understandInquiry({
    message: 'まだ分かりません',
    history: [],
    settings: DEFAULT_SETTINGS,
    context: { scope: 'chat' },
  });
  expect(result).toMatchObject({
    designation: '',
    model: '',
    quantityWithdrawn: false,
    purpose: '',
    shape: '',
    dimensions: '',
    manufacturer: '',
    quantity: 0,
  });
});

it('does not treat a general category as a specific product', async () => {
  model.mockResolvedValueOnce(
    parsed({ designation: '耐熱ガラス', designationKind: 'category', next: 'identity' }),
  );
  const r = await answerChat('耐熱ガラスを探している', 'category');
  expect(r.message.inquiryState?.designation).toBeUndefined();
  expect(r.message.content).toContain('メーカー名・型番');
});
it('uses a manufacturer answer to ask for the remaining identity', async () => {
  model.mockResolvedValueOnce(parsed({ next: 'identity' }));
  const first = await answerChat('ガラスを探しています', 'maker');
  model.mockResolvedValueOnce(parsed({ manufacturer: 'Example Maker', next: 'identity' }));
  const next = await answerChat('Example Maker', 'maker', first.conversationId);
  expect(next.message.content).toContain('メーカーは「Example Maker」');
  expect(next.message.content).not.toContain('資料がなければ');
});

it.each([
  'BOROFLOAT® 33',
  'BOROFLOAT® 33→',
  'クリンシル® トップ',
  '名称に数字のない製品',
  'AB / CX 20',
])('interprets the first message without a product keyword: %s', async (message) => {
  const designation = message.replace(/→$/, '');
  model.mockResolvedValueOnce(parsed({ designation, designationKind: 'product_name' }));
  const result = await answerChat(message, 'first-turn');
  expect(model).toHaveBeenCalledTimes(1);
  expect(result.message.inquiryState?.designation).toBe(designation);
  expect(result.message.content).toContain('登録商品を照合');
  expect(result.message.content).not.toContain('メーカー名・型番は分かりますか');
});
it('interprets a manufacturer-only first turn and clarifies a bare initial number', async () => {
  model.mockResolvedValueOnce(parsed({ manufacturer: 'Example Maker', next: 'identity' }));
  const maker = await answerChat('Example Maker', 'first-maker');
  expect(maker.message.content).toContain('メーカーは「Example Maker」');
  model.mockResolvedValueOnce(parsed({ next: 'clarify' }));
  const number = await answerChat('40', 'first-number');
  expect(number.message.content).toContain('意味と単位');
  expect(number.message.inquiryState?.quantity).toBeUndefined();
});

it('answers information requirements rather than offering a handoff after a refusal to send', async () => {
  model.mockResolvedValueOnce(
    parsed({ designation: 'クリンシル® トップ', designationKind: 'product_name' }),
  );
  const first = await answerChat('クリンシル® トップ', 'requirements');
  model.mockResolvedValueOnce(
    parsed({ requestedInformation: 'requirements', handoffPreference: 'declined' }),
  );
  const next = await answerChat(
    '送信せず、担当者に確認するための最低限必要な情報だけ教えて',
    'requirements',
    first.conversationId,
  );
  expect(next.message.handoff).toBeUndefined();
  expect(next.message.content).toContain('クリンシル® トップ');
  expect(next.message.content).toContain('推測して埋める必要はありません');
});

it('does not turn a bare number or width into quantity and honors withdrawal', async () => {
  model.mockResolvedValueOnce(
    parsed({ quantity: 40, quantityEvidence: '40', quantityUnit: '個', next: 'clarify' }),
  );
  const first = await answerChat('40', 'number-meaning');
  expect(first.message.inquiryState?.quantity).toBeUndefined();
  model.mockResolvedValueOnce(
    parsed({
      designation: 'BOROFLOAT® 33',
      designationKind: 'series',
      quantityWithdrawn: true,
      quantityEvidence: '個数ではなく幅40mm',
      dimensions: '幅40mm',
    }),
  );
  const second = await answerChat(
    '個数ではなく幅40mmです。BOROFLOAT® 33です',
    'number-meaning',
    first.conversationId,
  );
  expect(second.message.inquiryState?.quantity).toBeUndefined();
  expect(second.message.content).not.toContain('40個');
  model.mockResolvedValueOnce(
    parsed({ quantity: 40, quantityWithdrawn: true, quantityEvidence: '40個を取り消して' }),
  );
  const third = await answerChat(
    '数量は未定です。40個を取り消して',
    'number-meaning',
    first.conversationId,
  );
  expect(third.message.inquiryState?.quantity).toBeUndefined();
});
it('keeps purpose and shape and answers a measurement question without reasking them', async () => {
  model.mockResolvedValueOnce(
    parsed({
      purpose: '炉の扉を留める',
      shape: 'L字金具',
      identityUnavailable: true,
      known: ['purpose', 'shape'],
      next: 'dimensions',
    }),
  );
  const first = await answerChat('資料はない。炉の扉を留めるL字金具です', 'known-shape');
  expect(first.message.content).not.toContain('何をする部品');
  model.mockResolvedValueOnce(
    parsed({
      requestedInformation: 'measurement',
      identityUnavailable: true,
      known: ['purpose', 'shape'],
      next: 'none',
    }),
  );
  const next = await answerChat('何を測ればいいですか', 'known-shape', first.conversationId);
  expect(next.message.content).toContain('L字金具');
  expect(next.message.content).toContain('厚さ');
  expect(next.message.content).not.toContain('用途をお知らせ');
});
it('keeps product identity through a policy turn and answers ordering capability', async () => {
  model.mockResolvedValueOnce(parsed({ designation: 'BOROFLOAT® 33', designationKind: 'series' }));
  const first = await answerChat('BOROFLOAT® 33', 'policy-turn');
  const policy = await answerChat(
    '営業時間を教えて。このチャットで注文までできますか',
    'policy-turn',
    first.conversationId,
  );
  expect(policy.message.content).toMatch(/注文.*(?:休止|受け付けていません)/);
  expect(policy.message.handoff).not.toBe('quote');
  model.mockResolvedValueOnce(parsed({ requestedInformation: 'stock' }));
  const next = await answerChat('先ほどの商品の在庫は？', 'policy-turn', first.conversationId);
  expect(next.message.inquiryState?.designation).toBe('BOROFLOAT® 33');
});

it('does not interpret declining transmission as ending the conversation', async () => {
  model.mockResolvedValueOnce(parsed({ designation: 'BOROFLOAT® 33', designationKind: 'series' }));
  const first = await answerChat('BOROFLOAT® 33', 'no-send');
  model.mockResolvedValueOnce(
    parsed({
      quantityWithdrawn: true,
      quantityEvidence: '40個という意味ではない',
      dimensions: '幅40mm',
    }),
  );
  const next = await answerChat(
    '数量はまだ決めていません。40個という意味ではないので、もし数量として入っていれば取り消してください。幅40mmの商品を探しています。今は送信不要です。',
    'no-send',
    first.conversationId,
  );
  expect(next.message.content).not.toContain('ご相談ありがとうございました');
  expect(next.message.requestedQuantity).toBeUndefined();
  expect(next.message.inquiryState?.designation).toBe('BOROFLOAT® 33');
});

it('keeps a manufacturer when a product name is supplied next', async () => {
  model.mockResolvedValueOnce(parsed({ manufacturer: 'Example Maker', next: 'identity' }));
  const first = await answerChat('Example Maker', 'maker-refinement');
  model.mockResolvedValueOnce(
    parsed({ designation: 'Example Product', designationKind: 'product_name', newSubject: true }),
  );
  const next = await answerChat('Example Product', 'maker-refinement', first.conversationId);
  expect(next.message.inquiryState?.manufacturer).toBe('Example Maker');
});
it('answers a confirmation of measurement guidance without recording measurements', async () => {
  model.mockResolvedValueOnce(
    parsed({ requestedInformation: 'measurement', purpose: '炉の扉', shape: 'L字' }),
  );
  const first = await answerChat('炉の扉用L字金具は何を測ればよいですか', 'measurement-confirm');
  model.mockResolvedValueOnce(parsed({ confirmingGuidance: true }));
  const next = await answerChat(
    'まだ測っていません。両辺と厚みと穴の間隔を測るということですね？',
    'measurement-confirm',
    first.conversationId,
  );
  expect(next.message.content).toContain('はい、その測定項目');
  expect(next.message.inquiryState?.dimensions).toBeUndefined();
});

it('does not accept a unitless dimension or inferred handoff permission', async () => {
  model.mockResolvedValueOnce(parsed({ dimensions: '40', handoffPreference: 'requested' }));
  const result = await understandInquiry({
    message: '40',
    history: [],
    settings: DEFAULT_SETTINGS,
    context: { scope: 'chat' },
  });
  expect(result?.dimensions).toBe('');
  expect(result?.handoffPreference).toBe('unchanged');
});

it('answers company questions without treating the company name as a product', async () => {
  const result = await answerChat(
    'アオキエンジはどこにあり、どんな仕事をしている会社ですか？',
    'company-context',
  );
  expect(result.message.content).toContain('北九州市');
  expect(result.message.content).toContain('設計');
  expect(result.message.content).toContain('据付');
  expect(result.message.productNameLookup).toBeUndefined();
});
it('summarizes corrected specifications from the current state and preserves quantity', async () => {
  model.mockResolvedValueOnce(
    parsed({
      designationKind: 'category',
      purpose: '配管のシール',
      dimensions: '内径50mm・外径90mm・厚さ3mm',
      quantity: 2,
      quantityUnit: '枚',
      quantityEvidence: '2枚',
      requestedInformation: 'selection',
    }),
  );
  const first = await answerChat(
    '配管のシール用のPTFEガスケット、内径50mm・外径90mm・厚さ3mmを2枚。選定に必要な条件は？',
    'spec-correction',
  );
  model.mockResolvedValueOnce(
    parsed({ dimensions: '2mm', quantityWithdrawn: true, quantityEvidence: '厚さだけ2mmに訂正' }),
  );
  const next = await answerChat(
    '厚さだけ2mmに訂正します。いまの希望条件をまとめてください。',
    'spec-correction',
    first.conversationId,
  );
  expect(next.message.content).toContain('厚さ2mm');
  expect(next.message.content).toContain('内径50mm');
  expect(next.message.content).toContain('外径90mm');
  expect(next.message.content).toContain('材質：PTFE');
  expect(next.message.content).toContain('2枚');
  expect(next.message.content).not.toContain('3mm');
});
it('does not replace a request for selection information with a summary or handoff', async () => {
  model.mockResolvedValueOnce(
    parsed({ designationKind: 'category', requestedInformation: 'selection' }),
  );
  const r = await answerChat(
    '見積も問い合わせ送信も不要です。耐熱ガラスを選ぶために整理しておく情報を教えてください。',
    'selection',
  );
  expect(r.message.content).toContain('温度');
  expect(r.message.content).toContain('取付');
  expect(r.message.handoff).toBeUndefined();
});

it('answers both company location and business even when the address policy also matches', async () => {
  const r = await answerChat('会社の所在地と事業内容を教えてください。', 'company-combined');
  expect(r.message.content).toContain('北九州市');
  expect(r.message.content).toContain('設計');
  expect(r.message.content).toContain('据付');
});

it('explains the limits and preparation of photo identification before attempting product discovery', async () => {
  const r = await answerChat(
    '写真しかありません。写真を見せれば型番や材質を確定できますか？',
    'photo-limits',
  );
  expect(r.message.content).toContain('写真だけで型番や材質を確定できるとは限りません');
  expect(r.message.content).toContain('刻印');
  expect(r.message.productNameLookup).toBeUndefined();
  expect(model).not.toHaveBeenCalled();
});
it('answers food contact and washing evidence requirements without asserting approval', async () => {
  model.mockResolvedValueOnce(
    parsed({ designationKind: 'category', requestedInformation: 'selection' }),
  );
  const first = await answerChat(
    '食品用のガスケットを探しています。PTFEなら使えますか？',
    'food-contact',
  );
  expect(first.message.content).toContain('材質名だけでは');
  model.mockResolvedValueOnce(parsed({ requestedInformation: 'requirements' }));
  const r = await answerChat(
    '洗浄時の薬剤も使います。食品接触と洗浄の両方で必要な証明と条件は？',
    'food-contact',
    first.conversationId,
  );
  expect(r.message.content).toContain('証明');
  expect(r.message.content).toContain('濃度');
  expect(r.message.content).toContain('接触温度');
  expect(r.message.handoff).toBeUndefined();
});


it('treats a dimensional selection request as specifications rather than a product name', async () => {
  model.mockResolvedValueOnce(
    parsed({
      designationKind: 'category',
      dimensions: '内径50mm・外径90mm・厚さ3mm',
      requestedInformation: 'identification',
      quantity: 2, quantityUnit: '枚', quantityEvidence: '2枚',
    }),
  );
  const r = await answerChat(
    'PTFE製で、内径50mm・外径90mm・厚さ3mmのガスケットを2枚探しています。この寸法で選べる製品はありますか？',
    'dimension-selection',
  );
  expect(r.message.content).toContain('流体');
  expect(r.message.content).toContain('厚さ3mm');
  expect(r.message.content).toContain('2枚');
  expect(r.message.content).not.toContain('この名称');
  expect(r.message.productNameLookup).toBeUndefined();
});
