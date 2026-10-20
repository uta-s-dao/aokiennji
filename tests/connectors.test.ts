import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { readFileSync } from 'node:fs';
import { parseUpload, mapRows, suggestMapping } from '../lib/server/connectors';
import { safeFetch, validateExternalUrl } from '../lib/server/safe-fetch';
import { classifyQuery, localIntent, dispatchSupplierOrder } from '../lib/server/providers';
import { DEFAULT_SETTINGS, type Order, type Quote, type Supplier } from '../lib/contracts';
describe('source formats and mappings', () => {
  it('extracts real PDF and DOCX fixtures and identifies a PDF requiring OCR', async () => {
    expect(
      (await parseUpload('catalog.pdf', readFileSync('tests/fixtures/catalog.pdf'))).documents[0]
        .content,
    ).toContain('ABC-123');
    expect(
      (await parseUpload('catalog.docx', readFileSync('tests/fixtures/catalog.docx'))).documents[0]
        .content,
    ).toContain('耐熱ガラス');
    await expect(
      ((parseUpload('scanned.pdf', readFileSync('tests/fixtures/scanned.pdf')))),
    ).rejects.toThrow('OCR');
  });
  it('parses an actual XLSX workbook and ignores formulas', async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('商品');
    sheet.addRow(['商品名', '型番', '販売価格', '確認日時']);
    sheet.addRow(['部品', 'ABC-123', 1200, '2026-10-02T00:00:00Z']);
    sheet.addRow(['数式商品', 'ABC-456', { formula: '1+2', result: 3 }, '']);
    const parsed = await parseUpload('test.xlsx', Buffer.from(await wb.xlsx.writeBuffer()));
    expect(parsed.rows[1]['販売価格']).toBe('');
    const mapped = mapRows(parsed.rows, suggestMapping(parsed.headers));
    expect(mapped.products[0].price).toBe(1200);
    expect(mapped.products[0].verifiedAt).toBeTruthy();
    expect(mapped.products[0].approved).toBe(false);
  });
  it('rejects negative price and reports row errors', () => {
    const result = mapRows(
      [
        { 商品名: '部品', 型番: 'A-1', 価格: '-100' },
        { 商品名: '正しい部品', 型番: 'A-2', 価格: '1,200円' },
      ],
      { name: '商品名', model: '型番', price: '価格' },
    );
    expect(result.errors[0].row).toBe(2);
    expect(result.products[0].price).toBe(1200);
  });
  it('extracts text and rejects unsupported extensions', async () => {
    expect(
      (await parseUpload('catalog.txt', Buffer.from('耐熱ガラス ABC-123'))).documents[0].content,
    ).toContain('ABC-123');
    await expect(((parseUpload('macro.xlsm', Buffer.from('fake'))))).rejects.toThrow('形式');
  });
});
describe('network boundaries and classifier', () => {
  it.each([
    'http://127.0.0.1',
    'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.1',
    'http://[::1]',
    'http://2130706433',
  ])('blocks internal destinations %s', async (url) => {
    await expect(((safeFetch(url)))).rejects.toThrow();
  });
  it('rejects credentials, unapproved protocols and port hopping', () => {
    for (const url of [
      'file:///etc/passwd',
      'http://secret@example.com',
      'https://example.com:5432',
    ])
      expect(() => validateExternalUrl(url)).toThrow();
  });
  it('supports Japanese business intents and preserves exact model numbers', () => {
    expect(localIntent('ABC-123の在庫はありますか')).toMatchObject({
      intent: 'stock',
      model: 'ABC-123',
    });
    expect(localIntent('図面から製作できますか').intent).toBe('custom');
  });
  it('falls back honestly without API keys', async () => {
    const key = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    try {
      const result = await classifyQuery('ABC-123の価格', {
        ...DEFAULT_SETTINGS,
        decisionProvider: 'jev',
      });
      expect(result.provider).toBe('local');
      expect(result.warning).toBeTruthy();
    } finally {
      if (key) process.env.TYPESAFE_API_KEY = key;
    }
  });
  it('never sends orders while demo is enabled', async () => {
    process.env.DEMO_MODE = 'true';
    await expect(
      ((dispatchSupplierOrder({ isDemo: true } as Order, {} as Quote, {} as Supplier))),
    ).rejects.toThrow('無効');
  });
});
