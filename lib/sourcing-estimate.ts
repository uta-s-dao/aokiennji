import type { ProcurementOffer, SourcingEstimate, SourcingEstimatePolicy } from './contracts';

export const PREFECTURES = [
  '北海道',
  '青森',
  '岩手',
  '宮城',
  '秋田',
  '山形',
  '福島',
  '茨城',
  '栃木',
  '群馬',
  '埼玉',
  '千葉',
  '東京',
  '神奈川',
  '新潟',
  '富山',
  '石川',
  '福井',
  '山梨',
  '長野',
  '岐阜',
  '静岡',
  '愛知',
  '三重',
  '滋賀',
  '京都',
  '大阪',
  '兵庫',
  '奈良',
  '和歌山',
  '鳥取',
  '島根',
  '岡山',
  '広島',
  '山口',
  '徳島',
  '香川',
  '愛媛',
  '高知',
  '福岡',
  '佐賀',
  '長崎',
  '熊本',
  '大分',
  '宮崎',
  '鹿児島',
  '沖縄',
] as const;

export type EstimateResult = { estimate?: SourcingEstimate; missing: string[] };
const integer = (n: number | null, min = 0): n is number =>
  n !== null && Number.isSafeInteger(n) && n >= min;
const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;

export function calculateSourcingEstimate(
  policy: SourcingEstimatePolicy,
  offer: ProcurementOffer,
  quantity: number,
  destination: string,
  timestamp = Date.now(),
): EstimateResult {
  const missing: string[] = [];
  if (!policy.enabled) return { missing: ['販売条件の設定'] };
  if (
    !Number.isFinite(policy.markupPercent) ||
    policy.markupPercent === null ||
    policy.markupPercent < 0 ||
    policy.markupPercent > 1000 ||
    !integer(policy.minimumProfitYen) ||
    !integer(policy.handlingFeeYen) ||
    !integer(policy.extraBusinessDays) ||
    ![1, 10, 100].includes(policy.roundingYen) ||
    ![0, 8, 10].includes(policy.taxRate) ||
    !Number.isInteger(policy.validityHours) ||
    policy.validityHours < 1 ||
    policy.validityHours > 168
  )
    return { missing: ['販売条件の設定'] };
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100000)
    missing.push('必要数量');
  if (!PREFECTURES.includes(destination as (typeof PREFECTURES)[number]))
    missing.push('お届け先の都道府県');
  const confirmation = Date.parse(offer.confirmedAt || '');
  if (
    !offer.approved ||
    !Number.isFinite(confirmation) ||
    confirmation > timestamp ||
    timestamp - confirmation >= policy.validityHours * 3600000
  )
    missing.push('調達先の条件の再確認');
  if (!integer(offer.price, 1)) missing.push('仕入価格');
  if (
    offer.taxIncluded === null ||
    offer.purchaseTaxRate === null ||
    ![0, 8, 10].includes(offer.purchaseTaxRate)
  )
    missing.push('仕入価格の税区分');
  if (!integer(offer.packQuantity, 1)) missing.push('販売単位・入数');
  else if (quantity % offer.packQuantity !== 0)
    missing.push(`入数に合う数量（${offer.packQuantity}個単位）`);
  const purchasedQuantity = offer.packQuantity
    ? Math.ceil(quantity / offer.packQuantity) * offer.packQuantity
    : quantity;
  if (!integer(offer.availableQuantity) || offer.availableQuantity < purchasedQuantity)
    missing.push('必要数量分の調達可否');
  // Freight and delivery confirmed for Osaka must never be reused for Tokyo.
  if (offer.destination !== destination) missing.push('お届け先に対応する配送条件');
  if (
    !integer(offer.deliveryMinDays) ||
    !integer(offer.deliveryMaxDays) ||
    offer.deliveryMinDays > offer.deliveryMaxDays
  )
    missing.push('お届けまでの営業日数');
  const shipping =
    policy.shippingRates.find((r) => r.destination === destination)?.shippingNet ??
    offer.customerShippingNet;
  if (!integer(shipping)) missing.push('送料');
  if (policy.fulfillment === 'via_company' && !integer(offer.procurementShippingNet))
    missing.push('仕入先から当社までの送料');
  if (missing.length) return { missing };

  const packs = BigInt(Math.ceil(quantity / offer.packQuantity!));
  const taxDenominator = BigInt(offer.taxIncluded ? 100 + offer.purchaseTaxRate! : 100);
  // Round the acquisition total up, so tax conversion cannot reduce the minimum profit.
  const cost =
    ceil(BigInt(offer.price!) * packs * 100n, taxDenominator) +
    BigInt(policy.fulfillment === 'via_company' ? offer.procurementShippingNet! : 0);
  const marked = ceil(cost * BigInt(10000 + Math.round(policy.markupPercent * 100)), 10000n);
  const floor = cost + BigInt(policy.minimumProfitYen!);
  const sell = (marked > floor ? marked : floor) + BigInt(policy.handlingFeeYen!);
  const step = BigInt(policy.roundingYen);
  const unit = ceil(sell, BigInt(quantity) * step) * step;
  const subtotal = unit * BigInt(quantity);
  const tax = ((subtotal + BigInt(shipping!)) * BigInt(policy.taxRate)) / 100n;
  const total = subtotal + BigInt(shipping!) + tax;
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) return { missing: ['金額上限の確認'] };
  return {
    missing: [],
    estimate: {
      model: offer.model,
      quantity,
      destination,
      unitPrice: Number(unit),
      subtotal: Number(subtotal),
      shipping: shipping!,
      tax: Number(tax),
      taxRate: policy.taxRate,
      total: Number(total),
      minBusinessDays: offer.deliveryMinDays! + policy.extraBusinessDays!,
      maxBusinessDays: offer.deliveryMaxDays! + policy.extraBusinessDays!,
      calculatedAt: new Date(timestamp).toISOString(),
      validUntil: new Date(confirmation + policy.validityHours * 3600000).toISOString(),
    },
  };
}

export function estimateReply(estimate: SourcingEstimate) {
  const yen = (n: number) => `${n.toLocaleString('ja-JP')}円`;
  const days =
    estimate.minBusinessDays === estimate.maxBusinessDays
      ? `${estimate.minBusinessDays}`
      : `${estimate.minBusinessDays}～${estimate.maxBusinessDays}`;
  return `「${estimate.model}」${estimate.quantity}個・${estimate.destination}へのお届けの概算です。\n販売単価（税抜）：${yen(estimate.unitPrice)}\n商品小計（税抜）：${yen(estimate.subtotal)}\n送料（税抜）：${yen(estimate.shipping)}\n消費税（${estimate.taxRate}%）：${yen(estimate.tax)}\n合計（税込）：${yen(estimate.total)}\n納期目安：ご注文確定後 ${days}営業日でお届け\n金額の有効期限：${new Date(estimate.validUntil).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}\n在庫・配送条件を注文前に再確認し、正式なお見積りで確定します。離島・特殊配送は別途確認します。`;
}
