import ExcelJS from 'exceljs';
import { parse as parseCsv } from 'csv-parse/sync';
import mammoth from 'mammoth';
import * as cheerio from 'cheerio';
import type { ImportRowError, ParsedSource, ProductInput, Source } from '@/lib/contracts';
import { safeFetch } from './safe-fetch';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 5000;
const MAX_COLUMNS = 100;
const MAX_CELL = 10000;
const MAX_DOCUMENT = 200000;
const empty = (): ParsedSource => ({ headers: [], rows: [], documents: [], warnings: [] });
const normalized = (value: unknown) =>
  String(value ?? '')
    .normalize('NFKC')
    .trim();
const cellText = (value: ExcelJS.CellValue): string => {
  if (value == null) return '';
  if (typeof value === 'object') {
    if ('formula' in value || 'sharedFormula' in value) return ''; // Never evaluate or trust cached formula results.
    if ('richText' in value) return value.richText.map((part) => part.text).join('');
    if ('text' in value) return String(value.text);
    if (value instanceof Date) return value.toISOString();
  }
  return String(value);
};

function table(headers: string[], data: string[][]): ParsedSource {
  if (headers.length > MAX_COLUMNS) throw new Error('列数が上限を超えています');
  if (data.length > MAX_ROWS) throw new Error('行数が5000行を超えています');
  const cleanHeaders = headers.map((value, index) => normalized(value) || `列${index + 1}`);
  if (new Set(cleanHeaders).size !== cleanHeaders.length) throw new Error('重複する列名があります');
  const rows = data
    .filter((row) => row.some((value) => normalized(value)))
    .map((row) =>
      Object.fromEntries(
        cleanHeaders.map((header, index) => {
          const value = normalized(row[index]);
          if (value.length > MAX_CELL) throw new Error('セルの文字数が上限を超えています');
          return [header, value];
        }),
      ),
    );
  return { headers: cleanHeaders, rows, documents: [], warnings: [] };
}

function parseCsvBuffer(buffer: Buffer): ParsedSource {
  const records = parseCsv(buffer.toString('utf8').replace(/^\uFEFF/, ''), {
    bom: true,
    relax_quotes: false,
    skip_empty_lines: true,
    relax_column_count: true,
  }) as string[][];
  if (!records.length) return empty();
  return table(records[0], records.slice(1));
}

async function parseXlsx(buffer: Buffer): Promise<ParsedSource> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('Excelにシートがありません');
  if (sheet.rowCount > MAX_ROWS + 1) throw new Error('行数が5000行を超えています');
  const rows: string[][] = [];
  sheet.eachRow((row) => {
    const values: string[] = [];
    for (let i = 1; i <= Math.min(row.cellCount, MAX_COLUMNS + 1); i++)
      values.push(cellText(row.getCell(i).value));
    rows.push(values);
  });
  if (!rows.length) return empty();
  return table(rows[0], rows.slice(1));
}

async function parsePdf(buffer: Buffer, title: string): Promise<ParsedSource> {
  // The worker installs DOMMatrix and the other canvas globals before PDF.js loads.
  // Load PDF dependencies only for PDF imports so a failure cannot disable every API.
  const { CanvasFactory, getData } = await import('pdf-parse/worker');
  const { PDFParse } = await import('pdf-parse');
  PDFParse.setWorker(getData());
  const parser = new PDFParse({ data: new Uint8Array(buffer), CanvasFactory });
  try {
    const result = await parser.getText();
    const content = normalized(result.pages.map((p) => p.text).join('\n')).slice(0, MAX_DOCUMENT);
    if (!content) throw new Error('PDFから文字を抽出できません。OCRが必要です');
    return { ...empty(), documents: [{ title, content }] };
  } finally {
    await parser.destroy();
  }
}

async function parseDocx(buffer: Buffer, title: string): Promise<ParsedSource> {
  const result = await mammoth.extractRawText({ buffer });
  const content = normalized(result.value).slice(0, MAX_DOCUMENT);
  if (!content) throw new Error('Word文書から文字を抽出できません');
  return {
    ...empty(),
    documents: [{ title, content }],
    warnings: result.messages.map((message) => message.message).slice(0, 10),
  };
}

export async function parseUpload(fileName: string, buffer: Buffer): Promise<ParsedSource> {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MAX_BYTES)
    throw new Error('ファイルサイズは1バイト以上10MB以下にしてください');
  const name = fileName.split(/[\\/]/).pop() || 'document';
  const ext = name.toLowerCase().split('.').pop();
  switch (ext) {
    case 'csv':
      return parseCsvBuffer(buffer);
    case 'xlsx':
      return parseXlsx(buffer);
    case 'pdf':
      return parsePdf(buffer, name);
    case 'docx':
      return parseDocx(buffer, name);
    case 'txt':
    case 'text': {
      const content = normalized(buffer.toString('utf8')).slice(0, MAX_DOCUMENT);
      if (!content) throw new Error('テキストが空です');
      return { ...empty(), documents: [{ title: name, content }] };
    }
    default:
      throw new Error('対応していないファイル形式です');
  }
}

function jsonPath(root: unknown, path: string | undefined): unknown {
  if (!path) return root;
  return path
    .replace(/^\$\.?/, '')
    .split('.')
    .reduce<unknown>((value, key) => {
      if (value == null || typeof value !== 'object') return undefined;
      return (value as Record<string, unknown>)[key];
    }, root);
}

function jsonRows(buffer: Buffer, itemsPath?: string): ParsedSource {
  let value: unknown;
  try {
    value = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new Error('JSONを解析できません');
  }
  const items = jsonPath(value, itemsPath);
  if (!Array.isArray(items)) throw new Error('itemsPathは配列を指す必要があります');
  if (items.length > MAX_ROWS) throw new Error('行数が5000行を超えています');
  const objects = items.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new Error('商品データはオブジェクトの配列にしてください');
    return item as Record<string, unknown>;
  });
  const headers = [...new Set(objects.flatMap((item) => Object.keys(item)))];
  return table(
    headers,
    objects.map((item) =>
      headers.map((key) => {
        const value = item[key];
        return value == null
          ? ''
          : typeof value === 'object'
            ? JSON.stringify(value)
            : String(value);
      }),
    ),
  );
}

function htmlDocument(buffer: Buffer, title: string, url: string): ParsedSource {
  const $ = cheerio.load(buffer.toString('utf8'));
  $('script,style,noscript,svg,iframe,form').remove();
  const pageTitle = normalized($('title').first().text()) || title;
  const content = normalized(
    ($('main').first().text() || $('body').text()).replace(/\s+/g, ' '),
  ).slice(0, MAX_DOCUMENT);
  if (!content) throw new Error('ページから本文を抽出できません');
  return { ...empty(), documents: [{ title: pageTitle, content, url }] };
}

function googleCsvUrl(raw: string): string {
  const url = new URL(raw);
  if (url.hostname !== 'docs.google.com') return raw;
  const match = url.pathname.match(/^\/spreadsheets\/d\/([a-zA-Z0-9_-]+)\//);
  if (!match) return raw;
  const gid = url.searchParams.get('gid') || '0';
  return `https://docs.google.com/spreadsheets/d/${match[1]}/export?format=csv&gid=${encodeURIComponent(gid)}`;
}

export async function fetchSource(source: Source): Promise<ParsedSource> {
  if (!source.enabled) throw new Error('情報源は無効です');
  if (source.kind === 'manual') {
    const content = normalized(source.config.text).slice(0, MAX_DOCUMENT);
    if (!content) throw new Error('手動テキストが空です');
    return { ...empty(), documents: [{ title: source.name, content }] };
  }
  if (['csv', 'xlsx', 'supplier_catalog', 'pdf', 'docx', 'text'].includes(source.kind))
    throw new Error('この情報源はファイルアップロードで取り込んでください');
  const url = source.kind === 'csv_url' ? googleCsvUrl(source.url) : source.url;
  const headers: Record<string, string> = {};
  if (source.config.authEnv) {
    if (!/^SOURCE_[A-Z0-9_]{1,120}$/.test(source.config.authEnv))
      throw new Error('認証用環境変数名が正しくありません');
    const secret = process.env[source.config.authEnv];
    if (!secret) throw new Error('情報源の認証キーが未設定です');
    headers.Authorization = `Bearer ${secret}`;
  }
  const response = await safeFetch(url, {
    headers,
    allowedDomains: source.config.allowedDomains,
    maxBytes: MAX_BYTES,
  });
  if (response.status < 200 || response.status >= 300)
    throw new Error(`情報源の取得に失敗しました (${response.status})`);
  switch (source.kind) {
    case 'csv_url':
      return parseCsvBuffer(response.body);
    case 'json_api':
      return jsonRows(response.body, source.config.itemsPath);
    case 'website':
      return htmlDocument(response.body, source.name, response.url);
    default:
      throw new Error('未対応の情報源です');
  }
}

const fields: (keyof ProductInput)[] = [
  'name',
  'model',
  'manufacturer',
  'category',
  'description',
  'specifications',
  'image',
  'availability',
  'price',
  'stock',
  'leadTime',
  'visibility',
  'verifiedAt',
];
const aliases: Record<string, string[]> = {
  name: ['商品名', '製品名', '品名', 'name'],
  model: ['型番', '品番', 'model'],
  manufacturer: ['メーカー', '製造元', 'manufacturer'],
  category: ['カテゴリ', '分類', 'category'],
  description: ['説明', '概要', 'description'],
  specifications: ['仕様', 'スペック', 'specifications'],
  image: ['画像', '画像URL', 'image'],
  availability: ['取扱', '取扱状態', 'availability'],
  price: ['価格', '販売価格', '単価', 'price'],
  stock: ['在庫', '在庫数', 'stock'],
  leadTime: ['納期', 'leadtime'],
  visibility: ['公開区分', 'visibility'],
  verifiedAt: ['確認日', '確認日時', 'verifiedat'],
};
export function suggestMapping(headers: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const field of fields) {
    const found = headers.find((header) =>
      aliases[field]?.includes(normalized(header).replace(/\s+/g, '').toLowerCase()),
    );
    if (found) result[field] = found;
  }
  return result;
}

export function mapRows(
  rows: Record<string, string>[],
  mapping: Record<string, string>,
): { products: ProductInput[]; errors: ImportRowError[] } {
  const products: ProductInput[] = [];
  const errors: ImportRowError[] = [];
  const seen = new Set<string>();
  if (rows.length > MAX_ROWS) throw new Error('行数が5000行を超えています');
  for (const [index, row] of rows.entries()) {
    const get = (field: string) => normalized(row[mapping[field] || field]);
    const name = get('name');
    const model = get('model').replace(/[\s‐‑‒–—―−ー－-]+/g, '-');
    const manufacturer = get('manufacturer');
    if (!name || !model) {
      errors.push({ row: index + 2, message: '商品名と型番は必須です' });
      continue;
    }
    if (name.length > 200 || model.length > 120 || !/^[\p{L}\p{N}_.+/#()\-]+$/u.test(model)) {
      errors.push({ row: index + 2, message: '商品名または型番の形式が正しくありません' });
      continue;
    }
    const key = `${manufacturer.toLowerCase()}|${model.toLowerCase()}`;
    if (seen.has(key)) {
      errors.push({ row: index + 2, message: '同じファイル内にメーカーと型番の重複があります' });
      continue;
    }
    seen.add(key);
    const numeric = (field: 'price' | 'stock'): number | null => {
      const raw = get(field).replace(/[¥￥,円\s]/g, '');
      if (!raw) return null;
      const value = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 0)
        throw new Error(`${field === 'price' ? '価格' : '在庫'}は0以上の整数にしてください`);
      return value;
    };
    try {
      const price = numeric('price');
      const stock = numeric('stock');
      const rawAvailability = get('availability').toLowerCase();
      const availability =
        (
          {
            available: 'available',
            orderable: 'orderable',
            needs_review: 'needs_review',
            unavailable: 'unavailable',
            取扱あり: 'available',
            取り寄せ: 'orderable',
            取り寄せ対応: 'orderable',
            要確認: 'needs_review',
            取扱対象外: 'unavailable',
          } as Record<string, ProductInput['availability']>
        )[rawAvailability] || 'needs_review';
      const rawDate = get('verifiedAt');
      const verifiedAt =
        rawDate && !Number.isNaN(Date.parse(rawDate)) ? new Date(rawDate).toISOString() : null;
      if (rawDate && !verifiedAt) throw new Error('確認日の形式が正しくありません');
      products.push({
        name,
        model,
        manufacturer,
        category: get('category'),
        description: get('description'),
        specifications: get('specifications'),
        image: get('image'),
        availability,
        price,
        stock,
        leadTime: get('leadTime'),
        sourceId: null,
        supplierId: null,
        approved: false,
        visibility: get('visibility') === 'internal' ? 'internal' : 'public',
        verifiedAt,
        isDemo: false,
      });
    } catch (error) {
      errors.push({
        row: index + 2,
        message: error instanceof Error ? error.message : '値が正しくありません',
      });
    }
  }
  return { products, errors };
}
