import { expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type PageAvailability, type ProductSourcing } from '../lib/contracts';
import { listingAvailability, publicSourcing, sourcingReply } from '../lib/server/sourcing-reply';

const page: PageAvailability = {
  version: 1,
  model: 'ABC-100',
  contentHash: 'private-hash',
  stock: 'in_stock',
  listedQuantity: 12,
  quantityUnit: '個',
  dispatchKind: 'supplier_dispatch',
  dispatchText: '非公開仕入先：3営業日以内に出荷します。',
  verification: 'jev',
  reasons: [],
  evidence: [],
};
const source: ProductSourcing = {
  model: 'ABC-100',
  status: 'candidate',
  checkedAt: new Date().toISOString(),
  availability: listingAvailability([page]),
};
it('shows verified listing quantities and supplier dispatch without exposing private text or claiming Aoki delivery', () => {
  const reply = sourcingReply(source, true);
  expect(reply).toContain('掲載上は在庫あり（12個）');
  expect(reply).toContain('調達先の出荷目安は3営業日');
  expect(reply).toContain('当社からのお届け日はお見積りで確認');
  expect(JSON.stringify(source)).not.toMatch(/非公開仕入先|private-hash/);
});
it('keeps a single source together, rejects held and conflicting data, and does not turn arrival or shop policies into supplier dispatch', () => {
  expect(listingAvailability([{ ...page, verification: 'held' }])).toBeUndefined();
  expect(listingAvailability([{ ...page, stock: 'conflict' }])).toBeUndefined();
  const other = { ...page, listedQuantity: 2, dispatchText: '即日出荷' };
  expect(listingAvailability([other, page])).toMatchObject({
    listedQuantity: 2,
    supplierDispatch: '即日',
  });
  for (const dispatchKind of ['general_policy', 'customer_arrival'] as const)
    expect(listingAvailability([{ ...page, dispatchKind }])?.supplierDispatch).toBeUndefined();
});
it('reapplies visibility flags to stored sourcing outcomes', () => {
  const flags = { ...DEFAULT_SETTINGS.flags, showStock: false, showLeadTime: false };
  const masked = publicSourcing(source, flags);
  expect(JSON.stringify(masked.availability)).not.toMatch(/12|3営業日|in_stock/);
  expect(sourcingReply(masked, true)).not.toMatch(/12個|3営業日|在庫あり/);
});
it('reports a failed lookup without claiming no stock or ending the conversation with a fixed disclaimer', () => {
  const reply = sourcingReply({ ...source, status: 'failed', availability: undefined }, false);
  expect(reply).toContain('在庫を確認できませんでした');
  expect(reply).toContain('必要な数量を教えて');
  expect(reply).not.toMatch(/在庫なし|担当者|現時点では必要数量分の在庫・発送日は未確定/);
});
