import type { AppSettings, PageAvailability, ProductSourcing } from '../contracts';
import { listedStockLabels } from './page-availability';

// Keep one SKU at one source together. Never sum stocks at different sellers.
export function listingAvailability(pages: PageAvailability[]): ProductSourcing['availability'] {
  const best = pages
    .filter((p) => p.verification !== 'held' && p.stock !== 'conflict')
    .sort((a, b) => score(b) - score(a))[0];
  if (!best) return;
  // Only the timing adjacent to dispatch is public; raw text can contain private identities.
  const time =
    '(?:最短)?(?:[0-9]+(?:[〜～~-][0-9]+)?(?:営業日|日|週間|週|か月)|翌営業日|翌日|当日|即日)';
  const text = best.dispatchText?.normalize('NFKC').replace(/\s+/g, '') || '';
  const timing =
    text.match(
      new RegExp(`(?:出荷|発送)(?:予定|目安|日)?[：:]?(?:通常|約|ご注文後)?(${time})`),
    )?.[1] || text.match(new RegExp(`(${time})(?:以内|程度|ほど)?(?:で|に|後)?(?:出荷|発送)`))?.[1];
  return {
    stock: best.stock,
    listedQuantity: best.listedQuantity,
    quantityUnit: best.quantityUnit,
    ...(best.dispatchKind === 'supplier_dispatch' && timing ? { supplierDispatch: timing } : {}),
  };
}
function score(p: PageAvailability) {
  return (
    (['in_stock', 'limited'].includes(p.stock) ? 10 : 0) +
    (p.listedQuantity !== null ? 3 : 0) +
    (p.dispatchKind === 'supplier_dispatch' ? 2 : 0)
  );
}
export function publicSourcing(
  result: ProductSourcing,
  flags: AppSettings['flags'],
): ProductSourcing {
  const a = result.availability;
  return {
    ...result,
    availability: a
      ? {
          ...(flags.showStock
            ? { stock: a.stock, listedQuantity: a.listedQuantity, quantityUnit: a.quantityUnit }
            : {}),
          ...(flags.showLeadTime && a.supplierDispatch
            ? { supplierDispatch: a.supplierDispatch }
            : {}),
        }
      : undefined,
  };
}
export function sourcingReply(result: ProductSourcing, counted: boolean) {
  const lead =
    result.status === 'candidate'
      ? `「${result.model}」の調達候補を確認しました。`
      : result.status === 'identified'
        ? `「${result.model}」の商品掲載を確認しました。`
        : result.status === 'failed'
          ? `「${result.model}」はページの取得が完了せず、在庫を確認できませんでした。`
          : `「${result.model}」は今回の検索では一致する掲載が見つかりませんでした。`;
  const a = result.availability;
  const stock =
    a?.stock && !['unknown', 'conflict'].includes(a.stock)
      ? `${listedStockLabels[a.stock]}${a.listedQuantity !== null && a.listedQuantity !== undefined ? `（${a.listedQuantity}${a.quantityUnit || ''}）` : ''}です。`
      : '';
  const dispatch = a?.supplierDispatch ? `調達先の出荷目安は${a.supplierDispatch}です。` : '';
  const limit =
    stock || dispatch
      ? '掲載情報のため、確保状況と当社からのお届け日はお見積りで確認します。'
      : ['candidate', 'identified'].includes(result.status)
        ? '数量別の在庫・出荷日の掲載は確認できませんでした。'
        : '';
  return [lead, stock + dispatch + limit, counted ? '' : '必要な数量を教えていただけますか？']
    .filter(Boolean)
    .join('\n');
}
