import type { AppSettings, ChatMessage, Product, QueryIntent } from '../contracts';
import type { BusinessIntent, TransactionKind } from '../chat-policy';
import { company } from '../company';
import { HANDOFF_LABEL, QUOTE_LABEL, handoffGuide } from './consultation';

// The button under the reply and whether the phone number may still be given.
export interface Guide {
  label: string;
  phone: boolean;
}
const defaultGuide: Guide = { label: HANDOFF_LABEL, phone: true };

const topics: Partial<Record<QueryIntent['intent'], string>> = {
  price: '価格',
  stock: '在庫',
  lead_time: 'お届け時期',
  quote: 'お見積り',
  order: 'ご注文',
};
type FactDetail = NonNullable<ChatMessage['factDetail']>;
// Details of a fact question that the registered values can still answer.
export function factDetail(message: string, unit?: string): FactDetail {
  const text = message.normalize('NFKC');
  return {
    ...(unit && unit !== '個' ? { unit } : {}),
    ...(/税込/.test(text) ? { taxIncluded: true } : {}),
    ...(/送料|配送料|運賃/.test(text) ? { shipping: true } : {}),
    ...(/までに|まで(?:に|には)?(?:欲しい|ほしい|必要|届)|今週|来週|今月|来月|月末|明日|明後日|急ぎ|至急|next week|tomorrow|\bby\b/i.test(
      text,
    )
      ? { deadline: true }
      : {}),
  };
}
const yen = (value: number) => value.toLocaleString('ja-JP');

export function productReply(
  products: Product[],
  intent: QueryIntent['intent'],
  settings: AppSettings,
  quantity?: number,
  detail: FactDetail = {},
) {
  if (!products.length)
    return '以前ご案内した商品情報は、現在確認できない状態です。当社で情報を確認します。';
  if (products.length > 1) {
    const topic = topics[intent];
    return topic
      ? `${topic}についてですね。候補が${products.length}件あるので、どの商品か教えていただけますか？\n商品名・型番、または「1番目」のようにお答えください。`
      : `候補が${products.length}件見つかりました。どの商品をお探しでしょうか？\n商品名や型番がわからなければ、用途からも一緒に絞り込めます。`;
  }
  const p = products[0];
  const label = `「${p.name}」`;
  const count = quantity ? `${quantity}${detail.unit || '個'}` : '';
  if (p.availability === 'needs_review')
    return `${label}の登録はありますが、現在の取扱条件を確認する必要があります。\n価格・在庫・納期は、条件を確認したうえでご案内します。${
      quantity
        ? `ご希望の${count}も含めて当社で確認します。`
        : 'ご希望の数量や用途を教えていただけますか？'
    }`;
  if (p.availability === 'unavailable')
    return `${label}は現在、取扱対象外として登録されています。\n用途や必要な仕様を教えていただければ、代替品のご相談を承ります。`;
  switch (intent) {
    case 'lead_time':
      return settings.flags.showLeadTime && p.leadTime
        ? `お届け時期についてですね。${label}の登録上の納期は「${p.leadTime}」です。\n${
            quantity
              ? `ご希望は${count}ですね。具体的なお届け日は、配送先と必要数量を確保できるかを確認してご案内します。`
              : '具体的なお届け日は、数量と配送先を確認してご案内します。'
          }${detail.deadline ? 'ご希望の時期に間に合うかは、在庫と配送を確認してご連絡します。' : 'ご希望の時期はありますか？'}`
        : `${label}の納期は、当社で確認します。\nご希望の数量とお届け先の都道府県、必要な時期を教えていただけますか？`;
    case 'price': {
      if (!settings.flags.showPrice || p.price === null)
        return `${label}の価格は個別にご案内します。ご希望の数量を教えていただけますか？`;
      const subtotal = p.price * (quantity || 1);
      const extra = [
        detail.taxIncluded &&
          `消費税10%を含めると${yen(subtotal + Math.floor(subtotal / 10))}円です（送料別）。`,
        detail.shipping &&
          '送料はお届け先と数量によって変わるため、現時点では未確定です。お見積りで確定してご案内します。',
      ].filter(Boolean);
      return quantity
        ? `${count}ですね。${label}の登録単価から計算すると、商品代金の目安は${yen(subtotal)}円（税抜・送料別）です。\n${extra.length ? extra.join('') + '\n' : ''}正式な金額と条件は、お見積りでご案内します。`
        : `${label}の参考価格は、1個あたり${yen(p.price)}円（税抜）です。\n${extra.length ? extra.join('') + '\n' : ''}数量や送料を含む正式な金額は、お見積りでご案内します。何個ほど必要でしょうか？`;
    }
    case 'stock':
      return settings.flags.showStock && p.stock !== null
        ? `${label}の登録在庫は${p.stock.toLocaleString('ja-JP')}個です。\n${quantity ? `ご希望の${count}を確保できるかは、ご注文前に当社で確認します。` : '在庫は変動するため、確保できる数量はご注文前に確認します。何個ほど必要でしょうか？'}`
        : `${label}の在庫は、当社で確認します。${quantity ? `ご希望の${count}を確保できるかも含めて当社で確認します。` : 'ご希望の数量を教えていただけますか？'}`;
    case 'quote':
      return settings.flags.quoteRequests
        ? `${label}のお見積りですね。下の「${QUOTE_LABEL}」から、数量とご連絡先を入れて依頼できます。この会話の内容も依頼に添えられます。`
        : '現在、オンラインの見積受付は休止しています。お電話でのご相談をご利用ください。';
    case 'order':
      return settings.flags.orders
        ? `${label}のご注文についてですね。発行済みの見積専用ページで、内容を確認して注文を依頼できます。お見積りはお持ちでしょうか？`
        : '現在、オンラインの注文受付は休止しています。当社へご相談ください。';
    default:
      return p.availability === 'orderable'
        ? `${label}は、取り寄せに対応しています。\n価格・在庫・お届け時期など、知りたいことをそのまま続けてお聞きください。`
        : `はい、${label}を取り扱っています。\n価格・在庫・お届け時期など、知りたいことをそのまま続けてお聞きください。`;
  }
}

export function missingProductReply(intent: QueryIntent['intent']) {
  const topic = topics[intent];
  return topic
    ? `${topic}についてですね。どの商品か、商品名や型番を教えていただけますか？\nわからない場合は、用途やメーカー名からお探しします。`
    : 'どのようなものをお探しですか？何に使うものか、今お使いの物の名前や大きさなど、分かる範囲で教えてください。型番が分からなくてもご相談いただけます。';
}

export function factualReply(
  products: Product[],
  facts: BusinessIntent[],
  intent: QueryIntent['intent'],
  settings: AppSettings,
  quantity?: number,
  detail: FactDetail = {},
) {
  if (
    facts.length < 2 ||
    products.length !== 1 ||
    !products[0].approved ||
    ['needs_review', 'unavailable'].includes(products[0].availability)
  )
    return productReply(products, facts[0] || intent, settings, quantity, detail);
  // Each paragraph comes from the same deterministic rules as a single query.
  return facts.map((f) => productReply(products, f, settings, quantity, detail)).join('\n\n');
}

// Procedures stay fixed: the chat never sends, reserves or accepts anything.
export function transactionReply(
  kind: TransactionKind,
  settings: AppSettings,
  products: Product[],
  handedOff: boolean,
  guide: Guide = defaultGuide,
) {
  const path = handoffGuide(settings.flags.humanHandoff, guide.label, guide.phone);
  switch (kind) {
    case 'status':
      return handedOff
        ? 'この会話は、ご相談として受け付け済みです。当社で内容を確認してご連絡します。追加の条件があれば、続けてお知らせください。'
        : `このチャットでは、ご注文やお問い合わせの送信は行っていません。まだ正式なご依頼としては未送信のため、確認メールも送られません。\n${path}`;
    case 'hold':
      return `在庫の取り置き・確保は、在庫と条件を確認したうえでのご案内になるため、このチャットではお約束できません。\n${path}`;
    case 'order':
      if (settings.flags.orders)
        return products.length === 1
          ? productReply(products, 'order', settings)
          : `ご注文は、当社が発行したお見積りの専用ページから依頼できます。まずはお見積りのご依頼から承ります。\n${path}`;
      return `このチャットからはご注文を受け付けていません（オンラインのご注文受付は現在休止しています）。\n${path}`;
    case 'quote':
      if (!settings.flags.quoteRequests)
        return `現在、オンラインの見積受付は休止しています。お電話（${company.phone}）でのご相談をご利用ください。`;
      return products.length === 1
        ? productReply(products, 'quote', settings)
        : `伺った内容でお見積りを承ります。\n${path}`;
  }
}

export function handoffReply(
  settings: AppSettings,
  thanks: boolean,
  handedOff: boolean,
  guide: Guide = defaultGuide,
  // "電話で話したい": the phone comes first, the button second.
  call = false,
) {
  const opening = thanks ? 'ありがとうございます。' : '';
  if (handedOff)
    return `${opening}この会話は、ご相談として受け付け済みです。当社で内容を確認してご連絡します。`;
  if (!settings.flags.humanHandoff || call)
    return `${opening}お電話でのご相談は、${company.phone}で承ります。${
      settings.flags.humanHandoff
        ? `この会話の内容を事前にお送りいただく場合は、下の「${guide.label}」から送れます。`
        : ''
    }`;
  return `${opening}ご相談は、下の「${guide.label}」から送れます。お名前とメールアドレスを入れて送信すると、当社でこの会話を確認してご連絡します。${
    guide.phone ? `お急ぎの場合はお電話（${company.phone}）でもご相談いただけます。` : ''
  }`;
}
