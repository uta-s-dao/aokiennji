import { z } from 'zod';
import type { AiUsageContext, AppSettings, ChatMessage } from '../contracts';
import { CONSULTATION_POLICY } from '../consultation-policy';
import { salesModel } from './sales-model';

// The model can interpret language and choose an information need; it cannot
// write commercial claims, execute tools, or set consent for transactions.
const schema = z.object({
  model: z.string().max(100),
  designation: z.string().max(100),
  designationKind: z.enum(['product_name', 'series', 'material', 'unknown']),
  newSubject: z.boolean(),
  quantity: z.number().int().min(0).max(100000),
  quantityEvidence: z.string().max(100),
  quantityUnit: z.string().max(20),
  quotePreference: z.enum(['requested', 'declined', 'unchanged']),
  manufacturer: z.string().max(100),
  identityUnavailable: z.boolean(),
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
        instructions: `${CONSULTATION_POLICY}\n最新発言を直前質問に結び付けて解釈。designationは最新発言に明記された製品名・シリーズ名・材質名などの商品識別情報（一般的な「ガラス」「部品」などの分野名は除く）。designationKindで種類を区別する。名称を勝手に注文型番に変換しない。商標記号・空白・末尾を原文のまま保持。メーカーが発言にない場合は知識から補完しない。newSubjectは別商品への変更か型番・名称の訂正時のみtrue。quantityは今回希望した数量、最新発言の根拠をquantityEvidenceにそのまま転記（数字だけなら直前の数量質問を参照）。数量未回答なら0と空文字。掲載在庫・型番中の数字を数量にしない。quotePreferenceは明示された見積希望・不要だけを判断。modelとmanufacturerは最新発言内でお客様が明言した文字列だけ。古い訂正前の型番や画像からの未確認候補を復活させない。図面番号・部品番号をmodelに入れない。最新発言にないなら空文字。identityUnavailableは会話で表示資料がない・型番不明と回答済みの場合true。knownはお客様が回答済みの事項。nextは今回の特定に一番有効な未確認情報を一つだけ選ぶ。既知、分からないと回答された項目を再質問しない。既知の用途を材料に必要な形状・取付・寸法を選ぶが固定順序にしない。単位・意味が曖昧ならclarify。これ以上チャットで特定できなければnone。型番があればnext=none。`,
        data: {
          history: input.history.slice(-16).map((m) => ({ role: m.role, content: m.content })),
          message: input.message,
        },
      }),
    );
    if (result.designation && !input.message.normalize('NFKC').includes(result.designation.normalize('NFKC'))) result.designation = '';
    if (!result.quantityEvidence || !input.message.includes(result.quantityEvidence) || !result.quantityEvidence.normalize('NFKC').match(/\d+/g)?.some(n => Number(n) === result.quantity)) result.quantity = 0;
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
