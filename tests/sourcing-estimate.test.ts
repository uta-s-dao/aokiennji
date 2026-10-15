import { expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  DEFAULT_SOURCING_ESTIMATE,
  type ProcurementOffer,
  type SourcingEstimatePolicy,
} from '../lib/contracts';
import { calculateSourcingEstimate, estimateReply } from '../lib/sourcing-estimate';
import { procurementOfferSchema, settingsSchema } from '../lib/server/validation';

const timestamp = Date.parse('2026-10-15T08:30:00Z');
const policy: SourcingEstimatePolicy = {
  ...DEFAULT_SOURCING_ESTIMATE,
  enabled: true,
  markupPercent: 20,
  minimumProfitYen: 1000,
  handlingFeeYen: 100,
  extraBusinessDays: 1,
  roundingYen: 10,
};
const offer: ProcurementOffer = {
  id: 'private-offer',
  model: 'B-300-SCI',
  title: '非公開調達先',
  url: 'https://private.example/item',
  price: 1100,
  taxIncluded: true,
  purchaseTaxRate: 10,
  packQuantity: 1,
  availableQuantity: 20,
  procurementShippingNet: 500,
  customerShippingNet: 800,
  destination: '大阪',
  deliveryMinDays: 2,
  deliveryMaxDays: 3,
  approved: true,
  checkedAt: '2026-10-15T08:00:00Z',
  confirmedAt: '2026-10-15T08:00:00Z',
};

it('calculates net selling prices, shipping, tax and delivery without exposing supplier facts', () => {
  const result = calculateSourcingEstimate(policy, offer, 10, '大阪', timestamp);
  expect(result.missing).toEqual([]);
  expect(result.estimate).toMatchObject({
    unitPrice: 1210,
    subtotal: 12100,
    shipping: 800,
    tax: 1290,
    total: 14190,
    minBusinessDays: 3,
    maxBusinessDays: 4,
  });
  const reply = estimateReply(result.estimate!);
  expect(reply).toContain('合計（税込）：14,190円');
  expect(reply).toContain('3～4営業日');
  expect(JSON.stringify(result)).not.toMatch(
    /private\.example|非公開調達先|markup|procurementShipping|1100/,
  );
});

it('covers pack costs and incoming freight with per-order minimum profit before rounding the unit up', () => {
  const result = calculateSourcingEstimate(
    { ...policy, fulfillment: 'via_company', minimumProfitYen: 5000 },
    { ...offer, packQuantity: 6, price: 6600 },
    12,
    '大阪',
    timestamp,
  );
  // Two packs cost 12,000 net, plus incoming freight 500, profit 5,000 and fee 100.
  expect(result.estimate).toMatchObject({
    unitPrice: 1470,
    subtotal: 17640,
    shipping: 800,
    total: 20284,
  });
  expect(
    calculateSourcingEstimate(policy, { ...offer, packQuantity: 6 }, 10, '大阪', timestamp).missing,
  ).toContain('入数に合う数量（6個単位）');
  expect(
    calculateSourcingEstimate(
      policy,
      { ...offer, packQuantity: 6, availableQuantity: 10 },
      10,
      '大阪',
      timestamp,
    ).missing,
  ).toContain('必要数量分の調達可否');
});

it('uses an explicitly configured shipping rate, including zero, and never treats missing freight as free', () => {
  expect(
    calculateSourcingEstimate(
      policy,
      { ...offer, customerShippingNet: null },
      10,
      '大阪',
      timestamp,
    ).missing,
  ).toContain('送料');
  expect(
    calculateSourcingEstimate(
      { ...policy, shippingRates: [{ destination: '大阪', shippingNet: 0 }] },
      { ...offer, customerShippingNet: null },
      10,
      '大阪',
      timestamp,
    ).estimate?.shipping,
  ).toBe(0);
  expect(calculateSourcingEstimate(policy, offer, 10, '東京', timestamp).estimate).toBeUndefined();
});

it('holds the estimate if tax, units, availability, destination, approval or timing is unknown', () => {
  for (const patch of [
    { taxIncluded: null },
    { purchaseTaxRate: null },
    { packQuantity: null },
    { availableQuantity: 9 },
    { approved: false },
    { confirmedAt: null },
    { deliveryMaxDays: null },
    { deliveryMinDays: 4 },
    { destination: '東京' },
  ]) {
    const result = calculateSourcingEstimate(policy, { ...offer, ...patch }, 10, '大阪', timestamp);
    expect(result.estimate).toBeUndefined();
    expect(result.missing.length).toBeGreaterThan(0);
  }
  expect(
    calculateSourcingEstimate(policy, offer, 10, '大阪', timestamp + 24 * 3600000).estimate,
  ).toBeUndefined();
});

it('rejects undecided or invalid commercial rules, keeps old settings disabled, and validates private edits', () => {
  const { sourcingEstimate: _policy, ...oldSettings } = DEFAULT_SETTINGS;
  expect(settingsSchema.parse(oldSettings).sourcingEstimate.enabled).toBe(false);
  expect(
    settingsSchema.safeParse({
      ...DEFAULT_SETTINGS,
      sourcingEstimate: { ...DEFAULT_SOURCING_ESTIMATE, enabled: true },
    }).success,
  ).toBe(false);
  expect(
    settingsSchema.safeParse({
      ...DEFAULT_SETTINGS,
      sourcingEstimate: { ...policy, markupPercent: -10 },
    }).success,
  ).toBe(false);
  expect(
    settingsSchema.safeParse({
      ...DEFAULT_SETTINGS,
      sourcingEstimate: {
        ...policy,
        shippingRates: [
          { destination: '大阪', shippingNet: 0 },
          { destination: '大阪', shippingNet: 100 },
        ],
      },
    }).success,
  ).toBe(false);
  expect(
    procurementOfferSchema.safeParse({ ...offer, deliveryMinDays: 5, deliveryMaxDays: 2 }).success,
  ).toBe(false);
  expect(
    calculateSourcingEstimate({ ...policy, minimumProfitYen: null }, offer, 10, '大阪', timestamp)
      .estimate,
  ).toBeUndefined();
});

it('uses integer arithmetic and rejects unreasonable quantities and unsafe totals', () => {
  const fractional = calculateSourcingEstimate(
    { ...policy, roundingYen: 1, markupPercent: 0, minimumProfitYen: 0, handlingFeeYen: 0 },
    { ...offer, price: 101 },
    3,
    '大阪',
    timestamp,
  );
  // ceil(303 / 1.1) = 276, so a net unit of 92 covers the actual acquisition cost.
  expect(fractional.estimate?.unitPrice).toBe(92);
  expect(calculateSourcingEstimate(policy, offer, -1, '大阪', timestamp).estimate).toBeUndefined();
  expect(calculateSourcingEstimate(policy, offer, 1.5, '大阪', timestamp).estimate).toBeUndefined();
  expect(
    calculateSourcingEstimate(
      policy,
      { ...offer, price: Number.MAX_SAFE_INTEGER, availableQuantity: 100000 },
      100000,
      '大阪',
      timestamp,
    ).missing,
  ).toContain('金額上限の確認');
});
