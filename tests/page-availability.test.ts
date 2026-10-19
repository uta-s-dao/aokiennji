import { expect, it } from 'vitest';
import {
  extractAvailability,
  assessAvailability,
  availabilityQuestions,
} from '../lib/server/page-availability';
import { availabilityCases } from './fixtures/availability-cases';

it('does not mistake model numbers and short-lead-time marketing for a dispatch period', () => {
  const result = assessAvailability(
    extractAvailability(
      '<main><h1>YM4</h1><p>YM4は数量によって超短納期での出荷が可能です。</p></main>',
      'YM4',
    ),
  );
  expect(result.dispatchKind).toBe('unknown');
});

it.each(['在庫なし。在庫数：5個', '在庫あり。在庫数：0個'])(
  'holds contradictory availability and quantity: %s',
  (text) => {
    const result = assessAvailability(
      extractAvailability(`<main><h1>ABC-100</h1><p>${text}</p></main>`, 'ABC-100'),
    );
    expect(result.stock).toBe('conflict');
    expect(result.listedQuantity).toBeNull();
  },
);

it.each(availabilityCases)('extracts scoped listing facts: $id', (item) => {
  const input = extractAvailability(item.html, item.model);
  const result = assessAvailability(input);
  expect({
    stock: result.stock,
    quantity: result.listedQuantity,
    dispatch: result.dispatchKind,
  }).toEqual(item.expected);
  expect(result).not.toHaveProperty('approved');
});

it('holds rather than inventing facts when Jev disagrees or sends an unknown evidence id', () => {
  const input = extractAvailability('<main><h1>ABC-100</h1><p>在庫：12個</p></main>', 'ABC-100');
  for (const answer of [
    { choice: 'none', probabilities: { none: 0.99, b0: 0.01 } },
    { choice: 'b0', probabilities: { none: 0.4, b0: 0.6 } },
    { choice: 'invented', probabilities: { invented: 1 } },
    { choice: 'b0', probabilities: { none: 0, b0: 5 } },
    { choice: 'b0', probabilities: { none: 0, b0: 0.9, extra: 0.1 } },
    { choice: 'b0' },
  ]) {
    const result = assessAvailability(input, { page_stock: answer, page_quantity: answer });
    expect(result.stock).toBe('unknown');
    expect(result.listedQuantity).toBeNull();
    expect(result.verification).toBe('held');
  }
});

it('accepts matching evidence ids while retaining the literal quantity and source fingerprint', () => {
  const input = extractAvailability(
    '<main><h1>ABC-100</h1><p>在庫：12個。2営業日で出荷</p></main>',
    'ABC-100',
  );
  const answer = { choice: 'b0', probabilities: { none: 0.03, b0: 0.97 } };
  const result = assessAvailability(input, {
    page_stock: answer,
    page_quantity: answer,
    page_dispatch: answer,
  });
  expect(result).toMatchObject({
    stock: 'in_stock',
    listedQuantity: 12,
    dispatchKind: 'supplier_dispatch',
    verification: 'jev',
  });
  expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
  expect(result.evidence[0].text).toContain('在庫:12個');
  expect(availabilityQuestions(input, 'page').page_quantity.criteria).toHaveProperty('b0');
});
