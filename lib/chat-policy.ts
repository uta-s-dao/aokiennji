import type { KnowledgeTopic, QueryIntent } from './contracts';

export type BusinessIntent = 'price' | 'stock' | 'lead_time' | 'quote' | 'order';
const businessPatterns: Record<BusinessIntent, RegExp> = {
  price: /価格|値段|ねだん|いくら|単価|金額|費用|予算|\d[\d,]*\s*円|how much|price|cost/i,
  stock: /在庫|ざいこ|何個|何台|残って|残り|確保でき|足り(?:ます|る)|in stock/i,
  lead_time:
    /納期|のうき|配送|配達|発送|出荷|到着|届く|届き|届い|届け|入荷|納品|受け取|何日|何週間|いつ(ぐらい|くらい|頃|ごろ|に|まで|なら|です|？|\?)|間に合|deliver|lead time|\bship/i,
  quote: /見積|quot(?:e|ation)/i,
  order: /注文|発注|\border\b/i,
};
// "在庫の話ではなく", "注文じゃなくて": what the customer is not asking about.
const negated =
  /(?:価格|値段|金額|在庫|納期|注文|発注|見積(?:もり|り)?)(?:の(?:話|こと|件))?(?:では|じゃ)(?:なく|ない|ありません)|まだ(?:注文|発注)(?:では|じゃ|はし)[^。、]*/g;
// "送料はいくら？" asks for the shipping cost, not the item's price.
const shippingCost =
  /(?:送料|運賃|配送料)(?:は|って|が|の)?(?:だいたい|おおよそ|大体|ざっくり)?(?:いくら|おいくら|どのくらい|どれくらい|どの位)/g;
export function businessIntents(message: string): BusinessIntent[] {
  const text = message.normalize('NFKC').replace(negated, '').replace(shippingCost, '送料');
  return (Object.keys(businessPatterns) as BusinessIntent[]).filter((key) =>
    businessPatterns[key].test(text),
  );
}
// Placing an order, unlike "注文したら最短いつ出荷？" or "発注先を決めたい".
const orderRequest =
  /(?:注文|発注)(?:を|も)?(?:したい|します|しましょう|させて|いたし|お願い|でき(?:ます|る|ない)|する(?:には|方法)|の(?:仕方|方法|手続|流れ)|方法|は(?:どこ|どう|どのように))|\b(?:place an? order|(?:want|like) to order|order (?:this|it|now|\d))/i;
// Asking for a quote, unlike "見積の回答はいつ？" or "見積を依頼するか決めます".
const quoteRequest =
  /見積(?:もり|り)?(?:を|も|の)?(?:お願い(?!し(?:たら|た場合))|依頼(?!する?か|し(?:たら|た場合|た後|てから)|すれば|する(?:場合|と|前)|後|に|の|時)|相談|希望|ください|下さい|ほしい|欲しい|して(?:ほし|欲し|もら|いただ|くだ)|出して|作って|取りたい|取らせ|頂きたい|いただきたい|いただけ|もらいたい|もらえ|可能|でき(?:ます|る|ない))|見積(?:もり|り)?(?:に|で)(?:します|しよう|進|切り替|お願い)|(?:この|その|上記の)(?:内容|条件)で見積|\bquot(?:e|ation)\b/i;
// How to get a quote ("見積はどうすれば？").
const quoteProcedure =
  /見積(?:もり|り)?(?:は|の|を)?(?:どう|どこ|どのように|方法|手順|流れ|頼み方|依頼方法)/;
// "見積を依頼した場合、回答は…" talks about a quote without asking for one.
const hypotheticalQuote =
  /見積(?:もり|り)?(?:の)?(?:を|も)?(?:依頼|お願い)(?:を)?(?:し(?:たら|た場合|た後|てから|た際)|すれば|する(?:場合|と|前|際|時))/g;
// Business questions the customer actually asks: an order or a quote only
// when requested, not when mentioned.
export function requestedFacts(message: string): BusinessIntent[] {
  const text = message.normalize('NFKC');
  const quoteText = text.replace(hypotheticalQuote, '');
  return businessIntents(text).filter((fact) =>
    fact === 'order'
      ? orderRequest.test(text.replace(negated, ''))
      : fact === 'quote'
        ? quoteRequest.test(quoteText) || quoteProcedure.test(quoteText)
        : true,
  );
}

// Greetings, thanks and acknowledgements that open a message. What follows is
// the actual request, as in "ありがとう。さっきの台車の件ですが…".
const courtesy =
  /^(?:(?:こんにちは|こんばんは|おはようございます|おはよう|はじめまして|初めまして|お世話になっております|お世話になります|お疲れ様です|ありがとうございました|ありがとうございます|ありがとう|助かりました|助かります|了解しました|了解です|了解|承知しました|わかりました|分かりました|なるほど|どうも|よろしくお願いいたします|よろしくお願いします|よろしく|すみません|失礼します|はい)[、。,.!！?？\s〜ー]*)+/;
const greetingOrThanks =
  /こんにちは|こんばんは|おはよう|はじめまして|初めまして|お世話にな|お疲れ様|ありがと|助か|了解|承知|わかりました|分かりました|なるほど|どうも|よろしく|失礼します/;
export function stripCourtesy(message: string) {
  return message.normalize('NFKC').trim().replace(courtesy, '').trim();
}
// Courtesy with no request after it. A bare "はい" answers the previous turn.
export function socialOnly(message: string) {
  const text = message.normalize('NFKC');
  return greetingOrThanks.test(text) && !/[\p{L}\p{N}]/u.test(stripCourtesy(text));
}

// "まとめてください" asks for a summary; "まとめて見積" only means "together".
const summaryPattern =
  /(?:内容|条件|希望|相談|ここまで|これまで|今まで|要点)[^。？?]{0,14}(?:まとめ|整理|要約)|(?:まとめ|(?:整理|要約)し)て(?!\s*\d|の|見積|注文|購入|発注|買|相談|送|お願いでき|教え|知り|聞)|(?:まとめ|整理|要約)(?:直|る|を|が(?:欲し|ほし))|短く(?:して|書|作|まとめ|整理)|(?:説明|文面|文章|メモ|依頼文)を(?:短く)?(?:作|書|用意|考え)|文章に(?:して|まとめ)|貼り付け|書けるように/;
const handoffPattern =
  /担当(?:者|の方|さん)?(?:の方)?(?:に|へ|と|から)(?:直接)?(?:相談|確認|連絡|引き?継|渡|送|つな|繋|話|聞|見|お願い|問い?合わせ|依頼|伝え)|どこ(?:で|に|から)(?:入力|記入|書|送|申し込)|連絡先を|(?:お?問い?合わせ|問合せ)(?:したい|します|する|たい|を送|の方法|方法|先|窓口|は(?:どこ|どう)|フォーム|ボタン|れば)|どこから(?:問い?合わせ|連絡|相談|依頼|送|申し込)|(?:連絡|電話|返信|折り返し)(?:して|を)(?:もらえ|ほしい|欲しい|ください|いただけ|お願い)|引き?継(?:いで|ぎ|げ)|どのボタン|どこで入力|人と話|電話で(?:相談|話|問)|直接(?:相談|話)/;
const statusPattern =
  /(?:送信|送付|送ら|届い|伝わ|手配|受付)(?:され|済|て(?:い|ま))|もう(?:担当者に)?(?:送|注文|手配|届|依頼|問い?合わせ|伝わ)|確認メール|(?:注文|発注|依頼|見積)(?:は|が)?(?:もう)?(?:完了|確定)/;
const holdPattern = /取り?置き|確保して|押さえて(?:おいて|もらえ|ください)|キープ/;
// "実際に買う場合はどうすれば？" asks for the purchase procedure: a quote.
const purchasePattern =
  /買う(?:場合|には|方法|とき)|購入(?:する(?:場合|には|とき)|方法|手続|の流れ)|買いたい|購入したい/;
// Words asking for advice. A bare "相談" ("見積を相談したい") is not advice.
const adviceWords =
  /用途|使い方|選び方|どう選|どう使|どのように|選定|比較|違い|おすすめ|適し|適合|使える|使えます|使いたい|使用でき|仕様|材質|耐え|温度|圧力|寸法|性能|図面|製作|製造|設計|特注|注意点|ポイント|確認すべき|確認すると|調べ|何を(?:伝え|確認|用意)|どんな種類|どれがいい|どちらがいい|大丈夫|問題ない|決められ|代替|選べ|選ぶ|交換|漏れ|劣化|故障|壊れ|トラブル|不具合|止ま|どうすれば|どうしたら|にくい|やすい|丈夫|長持ち|向いて|向き|相性/;
// Commercial terms and company questions with a fixed answer. Kept narrow:
// "締め付け", "施工場所" or "必ず必要" are conditions, not such questions.
export const policyPatterns = {
  promise:
    /約束|確約|保証(?:して|でき|します)|絶対(?:に)?(?:間に合|大丈夫|届|ない)|必ず(?:買え|手に入|届|間に合|用意|安く|割引)/,
  confirmed: /(?:製作|注文|発注)(?:が|は)?(?:その場で)?確定|その場で製作/,
  sourcing: /取り寄せ/,
  urgent: /今日中|本日中|至急|大至急|急ぎ(?!では|じゃ)|ライン(?:が)?止ま/,
  payment: /支払|請求書払|月末締め|締め日|振込|掛け払|掛け取引|手形|後払/,
  discount:
    /値引|割引|安く(?:なり|でき|して|なる)|まとめ買い|勉強して|(?:単価|価格|値段)(?:は|が)?下が|数量割|ボリュームディスカウント/,
  shipping: /送料|運賃|配送料/,
  estimate:
    /(?:価格|金額|値段|費用)の?目安|目安の(?:価格|金額|値段)|概算|相場|おおよそ(?:の)?(?:価格|金額|値段|いくら)|ざっくり(?:の|した)?(?:価格|金額|値段|いくら)|(?:価格|金額|値段)(?:も|は|を|だけ)?(?:ざっくり|おおよそ|だいたい)/,
  // About the quote itself: when it comes, what to write, what is passed on.
  quoteTime:
    /(?:見積|回答|返事|返信)(?:の(?:回答|返事|返信))?[^。？?]{0,12}(?:いつ(?:頃|ごろ|ぐらい|くらい)?|何日|何営業日|どのくらい|どれくらい|どの位|今日中|本日中|当日中|日数|何時間)|(?:いつ|何日|何営業日)[^。？?]{0,10}(?:見積|回答|返事|返信)|まで(?:に|には)?[^。？?]{0,4}見積(?:もり|り)?(?:を|が)?(?:いただ|もら|ほし|欲し|ください|間に合)/,
  quoteItems:
    /(?:見積|依頼|フォーム)[^。？?]{0,16}(?:何を|どんな(?:情報|項目|こと)|伝えて?おく|書いて?おく|書くべき|伝えるべき|必要な(?:情報|項目))|(?:何を|どんな(?:情報|項目))[^。？?]{0,10}(?:伝え|書|用意)/,
  quoteContent:
    /(?:ボタン|依頼|送信|送る|送れ|押)[^。？?]{0,24}(?:伝わ|添付|含ま|引き継)|(?:全部|すべて|そのまま)[^。？?]{0,10}(?:伝わ|担当者に届)/,
  pickup:
    /引き?取り(?:に|で|も|は|可|でき|たい|ます)|取りに(?:行|伺|来|い)|来社して|直接(?:受け取|取りに)/,
  // Whether work is done in-house; the partners themselves stay private.
  outsourcing:
    /外注(?:です|でしょう|され|して|か|に出)|社内で(?:加工|製作|作)|自社(?:で|工場で)(?:加工|製作)|内製/,
  location: /どこにあ|所在地|住所|会社の場所/,
  contact: /電話番号|代表番号|FAX|ファックス|連絡先(?:を|は|が)?(?:教え|知り)/,
  // "何時までに頼めば当日発送？" asks for the cut-off time, not the hours.
  cutoff:
    /何時(?:まで|頃まで|ごろまで)に(?:頼|注文|依頼|連絡|発注|電話)|当日(?:発送|出荷)(?:の)?(?:締め|締切|受付)|締め(?:の)?時間|締切時間/,
  hours: /営業時間|受付時間|何時まで(?!に(?:頼|注文|依頼|連絡|発注|電話))|何時から|定休/,
  formEdit:
    /(?:フォーム|入力欄|下書き|依頼内容|ご相談内容)[^。？?]{0,12}(?:書き直|修正|編集|変更|追記|直せ)/,
  visit: /現地(?:調査|確認|に来)|見に来|来て(?:もら|いただ)|訪問/,
  // A request for our installation work; "据付に間に合わせたい" is a deadline.
  installation:
    /(?:据付|据え付け|設置工事|施工|取付工事)(?:も|まで)?(?:お願い|依頼|して(?:もら|いただ|ほし|くれ)|でき(?:ます|る)か|可能|頼め|やって|対応)|(?:据付|施工|設置)(?:は|も)(?:御社|そちら)/,
  sample: /サンプル|見本/,
  catalog: /カタログ|資料を送|PDFで送/,
  invoice: /インボイス|適格請求書|請求書(?!払)/,
} as const;
export type PolicyKey = keyof typeof policyPatterns;
// "値引きの件は承知しました" acknowledges an answer; it is not asked again.
const acknowledged =
  /[^。、！!？?]*(?:の件|について|のこと)?は(?:承知しました|承知です|了解しました|了解です|理解しました|わかりました|分かりました|結構です|大丈夫です|不要です|問題ありません)(?!か)[^。、！!？?]*/g;
export function policyKeys(message: string): PolicyKey[] {
  const text = message.normalize('NFKC').replace(acknowledged, '');
  return (Object.keys(policyPatterns) as PolicyKey[]).filter((k) => policyPatterns[k].test(text));
}
// Conditions the customer states, such as "25A", "40度", "M8" or a material.
const specPattern =
  /M\d+|\d+(?:\.\d+)?\s*(?:A(?![A-Za-z])|mm|ミリ|みり|cm|センチ|せんち|m(?![A-Za-z])|メートル|度|℃|°C|kg|キロ|トン|MPa|kPa|L(?![A-Za-z])|リットル|インチ|kW|V(?![A-Za-z])|角)|内径|外径|厚さ|長さ|直径|重さ|重量|ステンレス|SUS|ゴム|樹脂|屋内|屋外|冷却水|洗浄/;
// A bare answer to the previous question ("はい", "お願いします", "わかりません").
const bareReply =
  /^(?:はい|ええ|うん|お願いします|お願いいたします|お願い|それで(?:お願いします)?|それでいいです|大丈夫です|OK|わかりません|分かりません|わからない|分からない|不明です|未定です)[。．！!、\s]*$/i;
// Advice that a fixed procedure text does not give: conditions or a choice.
const choiceWords =
  /おすすめ|選び方|選定|違い|どれ|どちら|注意点|ポイント|確認すべき|確認すると|調べ|何を(?:伝え|確認|用意|準備)|適し|向いて|安全/;
export const requestPatterns = { summary: summaryPattern, handoff: handoffPattern };
export function isBareReply(message: string) {
  return bareReply.test(message.normalize('NFKC').trim());
}

export const CHAT_ROUTE_LABELS = {
  privacy: '非公開情報・公開範囲の案内',
  transaction: '見積・注文の手続き案内',
  facts: '登録情報・金額計算',
  clarification: '商品を特定するための確認',
  social: 'あいさつ・基本案内',
  lookup: '登録済みの商品・分野の照合',
  sourcing: '未登録商品の検索・調達相談',
  consultation: '用途・仕様・比較の相談',
  discovery: '曖昧な商品説明の理解',
  mixed: '登録情報の回答と用途相談',
  summary: '相談内容のまとめ',
  handoff: '担当者への引継ぎ案内',
  policy: '取引条件・会社情報の案内',
} as const;
export type TransactionKind = 'status' | 'hold' | 'order' | 'quote';

export interface ChatRouteInput {
  message: string;
  intent: QueryIntent;
  knownProduct: boolean;
  topic?: KnowledgeTopic;
  privateQuestion: boolean;
  previousIntent?: QueryIntent['intent'];
  previousProduct: boolean;
  // Earlier turns exist, so an unanswerable fact still has a topic to discuss.
  hasContext?: boolean;
}
export interface ChatRoute {
  classify: boolean;
  search: boolean;
  response: 'local' | 'ai' | 'mixed';
  reason: keyof typeof CHAT_ROUTE_LABELS;
  facts: BusinessIntent[];
  transaction?: TransactionKind;
}

// This policy owns whether external services are called. Values that the
// registry answers exactly (price, stock, lead time, privacy, procedures) stay
// local; every other turn is a conversation, written by the response model.
// Models may help identify a topic, but never choose whether business rules
// can be bypassed.
export function planChatRoute(input: ChatRouteInput): ChatRoute {
  const { intent, topic } = input;
  const original = input.message.normalize('NFKC').trim();
  const text = stripCourtesy(original) || original;
  const route = (
    reason: ChatRoute['reason'],
    facts: BusinessIntent[] = [],
    response: ChatRoute['response'] = 'local',
    classify = false,
    search = false,
  ): ChatRoute => ({ reason, facts, response, classify, search });
  if (input.privateQuestion || (topic && topic.mode !== 'fields')) return route('privacy');
  if (socialOnly(original)) return route('social');
  if (bareReply.test(original)) return route('discovery', [], 'ai');

  const facts = requestedFacts(text);
  const quantityOrSelection =
    /^(?:それを|この商品を|こちらを|数量は|では|じゃあ|はい|まずは|とりあえず|やっぱり)?\s*(?:\d+\s*(?:個|台|枚|本|セット|pcs|pieces|units)|[1-4一二三四](?:番目?|つ目))/i.test(
      text,
    );
  const inherited =
    quantityOrSelection &&
    input.previousProduct &&
    input.previousIntent &&
    input.previousIntent in businessPatterns
      ? (input.previousIntent as BusinessIntent)
      : undefined;
  if (!facts.length && inherited) facts.push(inherited);
  if (!facts.length && intent.intent in businessPatterns)
    facts.push(intent.intent as BusinessIntent);

  const knownTopic =
    input.knownProduct ||
    !!topic?.fields.length ||
    ((quantityOrSelection || intent.referencesPrevious) && input.previousProduct);
  // An unknown model may be searched, but must never be changed by the model.
  const classify =
    !intent.model && !knownTopic && !intent.referencesPrevious && intent.intent !== 'general';
  const detail = adviceWords.test(text) || specPattern.test(text) || intent.intent === 'custom';
  const consultation = detail || /相談/.test(text);
  // Procedure, hand-off and policy texts answer fully unless conditions or a
  // choice also need a consultative reply.
  const beyondProcedure = specPattern.test(text) || choiceWords.test(text);

  if (summaryPattern.test(text)) return route('summary', [], 'ai');
  // A price, stock or delivery question is answered even when the customer
  // also wants to buy; the quote request is offered under the answer.
  const asksFacts = facts.some((f) => f === 'price' || f === 'stock' || f === 'lead_time');
  const transaction: TransactionKind | undefined = statusPattern.test(text)
    ? 'status'
    : holdPattern.test(text)
      ? 'hold'
      : facts.includes('order')
        ? 'order'
        : (facts.includes('quote') || purchasePattern.test(text)) && !asksFacts
          ? 'quote'
          : undefined;
  if (transaction)
    return {
      ...route('transaction', facts, beyondProcedure ? 'mixed' : 'local', classify),
      transaction,
    };
  if (handoffPattern.test(text)) return route('handoff', [], beyondProcedure ? 'mixed' : 'local');
  const policy = policyKeys(text).length > 0;
  // A short terms question has a complete fixed answer; anything more is
  // answered in conversation after it.
  if (policy && !(facts.length && (knownTopic || intent.model)))
    return route(
      'policy',
      facts,
      detail || facts.length || text.length > 60 ? 'mixed' : 'local',
      classify,
    );
  if (facts.length) {
    if (consultation) return route('mixed', facts, 'mixed', classify);
    // A field has no registered price, so an ongoing consultation continues
    // after the fixed statement instead of asking for a model number again.
    if (knownTopic || intent.model)
      return route(
        'facts',
        facts,
        !input.knownProduct && (topic?.fields.length || intent.model) && input.hasContext
          ? 'mixed'
          : 'local',
        classify,
      );
    return route('clarification', facts, 'local', classify);
  }
  if (intent.intent === 'general' && !consultation) return route('social');
  if (consultation)
    return route('consultation', [], 'ai', classify, !knownTopic && !intent.referencesPrevious);
  if (knownTopic || (intent.referencesPrevious && input.previousProduct)) return route('lookup');
  return route('discovery', [], 'ai', classify, !intent.referencesPrevious);
}
