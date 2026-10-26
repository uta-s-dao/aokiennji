import { requestPatterns } from '../chat-policy';
import { z } from 'zod';
import type { AiUsageContext, AppSettings, ChatMessage } from '../contracts';
import { CONSULTATION_POLICY } from '../consultation-policy';
import { salesModel } from './sales-model';

// The model can interpret language and choose an information need; it cannot
// write commercial claims, execute tools, or set consent for transactions.
const schema = z.object({
  model: z.string().max(100),
  designation: z.string().max(100),
  designationKind: z.enum(['product_name', 'series', 'material', 'category', 'unknown']),
  newSubject: z
    .boolean()
    .describe(
      '既存の商品を別商品に変更・訂正するときだけtrue。メーカー回答後に商品名を補足することは話題変更ではない。',
    ),
  confirmingGuidance: z
    .boolean()
    .describe(
      '最新発言は、直前の案内・説明を自分の言葉で確認し、理解が合っているか尋ねているか。例えば測定項目の理解確認。',
    ),
  quantityWithdrawn: z.boolean(),
  purpose: z.string().max(300),
  shape: z.string().max(300),
  dimensions: z
    .string()
    .max(300)
    .describe(
      '最新発言で提示された数値と単位を含む実際の寸法。何を測るかという質問・測定候補・未定は空文字。',
    ),
  quantity: z.number().int().min(0).max(100000),
  quantityEvidence: z.string().max(100),
  quantityUnit: z.string().max(20),
  handoffPreference: z.enum(['requested', 'declined', 'unchanged']),
  requestedInformation: z
    .enum([
      'identification',
      'availability',
      'stock',
      'price',
      'lead_time',
      'requirements',
      'measurement',
      'description',
      'selection',
      'company',
      'scope',
      'other',
    ])
    .describe(
      '最新発言の主質問。名称だけの入力はidentification。何を/どこを/どう測るか、測定方法や測定箇所の確認はmeasurementをrequirementsより優先。単にどの情報を用意するかはrequirements。履歴の古い質問に引きずられない。',
    ),
  quotePreference: z.enum(['requested', 'declined', 'unchanged']),
  manufacturer: z
    .string()
    .max(100)
    .describe(
      '最新発言内のメーカー/会社名を原文で抽出。会社名のみの短い発言も分類してよい。商品名から発言にないメーカーを補完することは禁止。',
    ),
  identityUnavailable: z.boolean(),
  identityUnavailableEvidence: z
    .string()
    .max(300)
    .describe('型番不明・資料なしをお客様が明言した原文の一節。単に未回答の場合は空文字。'),
  next: z.enum(['identity', 'purpose', 'shape', 'mounting', 'dimensions', 'clarify', 'none']),
  known: z.array(z.enum(['identity', 'purpose', 'shape', 'mounting', 'dimensions'])).max(5),
});
export type InquiryUnderstanding = z.infer<typeof schema>;
export async function understandInquiry(input: {
  message: string;
  history: ChatMessage[];
  settings: AppSettings;
  context: AiUsageContext;
  signal?: AbortSignal;
}): Promise<InquiryUnderstanding | undefined> {
  if (!process.env.OPENAI_API_KEY) return;
  try {
    const result = schema.parse(
      await salesModel({
        settings: input.settings,
        model: process.env.OPENAI_INQUIRY_MODEL || 'gpt-4.1-mini',
        context: input.context,
        signal: input.signal,
        purpose: 'classification',
        validator: schema,
        schema: z.toJSONSchema(schema),
        instructions: `${CONSULTATION_POLICY}\n最新発言を直前質問に結び付けて解釈。会社の事業・所在地・業務内容・製作から据付までの相談はrequestedInformation=company。産業設備ではない家庭用家電等の修理受付や対象範囲の質問はscope。用途purposeは何に使うかだけを抽出し、材質・寸法列をpurposeやshapeへ複写しない。用途・特徴・材質・適用範囲を説明してほしい質問はdescription、選定に必要な条件やチェック項目はselection。requirementsは問い合わせ準備に必要な情報だけ。寸法文字列、用途の文章、会社名、質問全文をdesignationやmodelに入れない。型番不明の用途相談はpurpose/shape/dimensionsへ分け、nextは不足する運転条件を選ぶ。designationは最新発言に明記された製品名・シリーズ名・材質名などの商品識別情報（一般的な「ガラス」「部品」などの分野名は除く）。designationKindで種類を区別する。「耐熱ガラス」「バルブ」「固定金具」など一般的な品目・用途分類はcategory。materialは特定の材質記号・規格表示がある場合のみ。categoryならnext=identityとし、メーカー・具体的な製品名や型番を尋ねる。名称を勝手に注文型番に変換しない。商標記号・空白・末尾を原文のまま保持。メーカーが発言にない場合は知識から補完しない。newSubjectは別商品への変更か型番・名称の訂正時のみtrue。quantityは今回希望した数量、最新発言の根拠をquantityEvidenceにそのまま転記（数字だけなら直前の数量質問を参照）。数量未回答なら0と空文字。単位不明の数値は前の質問が数量を明確に尋ねた場合以外は数量にしない。quantityWithdrawnは以前の数量を否定・取り消して新しい数量未定の場合true。数量ではなく幅や温度だったと明示された場合だけ数量を取り消す。厚さだけの訂正は既知数量を保持。取消の根拠もquantityEvidenceに最新発言から転記する。purpose、shape、dimensionsには最新発言の用途・形状・寸法を示す原文の部分文字列だけ。なければ空文字。掲載在庫・型番中の数字を数量にしない。quotePreferenceは明示された見積希望・不要だけを判断。handoffPreferenceは今回担当者への依頼に進む明示希望のみrequested。手順や必要情報を聞く質問はrequestedではない。「送信せず」など否定を優先。requestedInformationは最新の質問が求める情報。問い合わせに必要な情報や最低限何を用意すればよいかはrequirements。何を測ればよいかという質問はmeasurement。modelとmanufacturerは最新発言内でお客様が明言した文字列だけ。古い訂正前の型番や画像からの未確認候補を復活させない。図面番号・部品番号をmodelに入れない。最新発言にないなら空文字。identityUnavailableは会話で表示資料がない・型番不明と明言された場合のみtrue。単に名称が入力されていないことを不明という回答と扱わない。knownはお客様が回答済みの事項。nextは今回の特定に一番有効な未確認情報を一つだけ選ぶ。既知、分からないと回答された項目を再質問しない。既知の用途を材料に必要な形状・取付・寸法を選ぶが固定順序にしない。単位・意味が曖昧ならclarify。これ以上チャットで特定できなければnone。型番があればnext=none。`,
        data: {
          history: input.history.slice(-16).map((m) => ({ role: m.role, content: m.content })),
          message: input.message,
        },
      }),
    );
    if (
      !/\d+\s*(?:mm|cm|m|ミリ|センチ|メートル|インチ|寸|尺)/i.test(
        result.dimensions.normalize('NFKC'),
      )
    )
      result.dimensions = '';
    // Model interpretation alone is not evidence of an explicit handoff request.
    if (result.handoffPreference === 'requested' && !requestPatterns.handoff.test(input.message))
      result.handoffPreference = 'unchanged';
    const customerWords = input.history
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .concat(input.message);
    if (
      !result.identityUnavailableEvidence ||
      !customerWords.some((t) => t.includes(result.identityUnavailableEvidence)) ||
      !/不明|ない|なく|ありません|わから|分から|知りません/.test(result.identityUnavailableEvidence)
    )
      result.identityUnavailable = false;
    if (result.designationKind === 'category' || result.designationKind === 'material') {
      result.designation = '';
      result.model = '';
    }
    if (
      result.designation &&
      !input.message.normalize('NFKC').includes(result.designation.normalize('NFKC'))
    )
      result.designation = '';
    if (
      !result.quantityEvidence ||
      !input.message.includes(result.quantityEvidence) ||
      !result.quantityEvidence
        .normalize('NFKC')
        .match(/\d+/g)
        ?.some((n) => Number(n) === result.quantity)
    )
      result.quantity = 0;
    if (/mm|ミリ|内径|外径|厚さ|使う|使い|の中を見る|[？?。]/i.test(result.designation))
      result.designation = '';
    if (/用途(?:と|を|は|が|の)|どんな|どのような|何を|教えて/.test(result.purpose))
      result.purpose = '';
    if (result.designation === result.manufacturer) result.designation = '';
    for (const key of ['purpose', 'shape', 'dimensions'] as const)
      if (result[key] && !input.message.includes(result[key])) result[key] = '';
    if (!result.quantityEvidence || !input.message.includes(result.quantityEvidence))
      result.quantityWithdrawn = false;
    const replacement = [
      ...input.message.normalize('NFKC').matchAll(/(\d+)\s*(個|枚|本|台|セット)/g),
    ]
      .filter(
        (m) =>
          !/(?:旧|古い|以前の|先ほどの)[^、。]*$/.test(
            input.message.slice(Math.max(0, m.index! - 16), m.index),
          ) &&
          !/^\s*(?:を)?(?:取り消|取消|ではなく|ではありません)/.test(
            input.message.slice(m.index! + m[0].length),
          ),
      )
      .at(-1);
    if (replacement && Number(replacement[1]) === result.quantity) result.quantityWithdrawn = false;
    if (result.quantityWithdrawn && !/数量|個数|枚数|本数|台数|取り消|取消/.test(input.message))
      result.quantityWithdrawn = false;
    if (result.quantityWithdrawn) result.quantity = 0;
    for (const key of ['purpose', 'shape'] as const)
      if (/(?:内径|外径|厚さ|板厚|幅|高さ)\s*\d|\d\s*(?:mm|cm|ミリ|センチ)/i.test(result[key]))
        result[key] = '';
    const count = result.quantityEvidence.normalize('NFKC').match(/(\d+)\s*(個|枚|本|台|セット)/);
    const previous = input.history.toReversed().find((m) => m.role === 'assistant')?.content || '';
    const numberAnswer =
      /^\s*\d+\s*$/.test(input.message.normalize('NFKC')) &&
      /何(?:個|枚|本|台)|数量.*(?:教え|いくつ)/.test(previous);
    if (result.quantity && !count && !numberAnswer) result.quantity = 0;
    if (count && Number(count[1]) === result.quantity) result.quantityUnit = count[2];
    if (result.model && !input.message.normalize('NFKC').includes(result.model.normalize('NFKC')))
      result.model = '';
    if (
      result.manufacturer &&
      !input.message.normalize('NFKC').includes(result.manufacturer.normalize('NFKC'))
    )
      result.manufacturer = '';
    return result;
  } catch {
    return;
  }
}
