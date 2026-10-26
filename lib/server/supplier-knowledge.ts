import { asyncFilter } from '@/lib/async-arrays';
import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';
import type {
  AppSettings,
  ChatMessage,
  ImportResult,
  KnowledgeTopic,
  ParsedSource,
  QueryIntent,
  Source,
  SupplierKnowledge,
  SupplierKnowledgeRow,
} from '../contracts';
import { audit, byId, db, list, normalize, now, save, uid } from './db';
import { lockResource } from './db';
import { businessIntents, type BusinessIntent } from '../chat-policy';
import { checklist, consultationTopic, itemMention } from './consultation';

// Deliberately curated public vocabulary: spreadsheet prose, company names,
// hyperlinks and instructions are never copied into a customer response.
const vocabulary: Record<string, string[]> = {
  耐熱金物: ['耐熱金物'],
  電気装置: ['電気装置'],
  パッキン: ['パッキン', 'ぱっきん', 'ガスケット', 'ジョイントシート'],
  溶接材料: ['溶接材料'],
  金網: ['金網'],
  ゴム製品: ['ゴム製品', 'ゴム'],
  耐火材: ['耐火材'],
  耐熱材: ['耐熱材'],
  断熱材: ['断熱材'],
  ガラス製品: ['ガラス製品', 'ガラス'],
  スタッド製品: ['スタッド製品', 'スタッド'],
  鋼板: ['鋼板'],
  建材: ['建材'],
  継手: ['継手', '継ぎ手', 'つぎて'],
  バルブ: ['バルブ', 'ばるぶ'],
  ホース: ['ホース'],
  資材: ['資材'],
  化学品: ['化学品'],
  鉄鋼設備部品: ['鉄鋼設備部品'],
  電気部品: ['電気部品'],
  鏡板: ['鏡板'],
  耐火物製品: ['耐火物製品', '耐火物'],
  ジョイント: ['ジョイント'],
  インバータ: ['インバータ', 'インバーター'],
  銘板: ['銘板'],
  プレート: ['プレート'],
  測量機器: ['測量機器'],
  銅: ['銅'],
  非鉄金属: ['非鉄金属'],
  シート製品: ['シート製品'],
  ステンレス板: ['ステンレス板'],
  チタン: ['チタン'],
  塗料: ['塗料'],
  フィルム: ['フィルム'],
  織金物: ['織金物'],
  マグネット製品: ['マグネット製品', 'マグネット'],
  樹脂製品: ['樹脂製品', '樹脂', 'プラスチック', 'プラ'],
  工業用配管資材: ['工業用配管資材', '配管資材'],
  測定器: ['測定器'],
  工具: ['工具'],
  刃物: ['刃物'],
  ノズル製品: ['ノズル製品', 'ノズル'],
  鋼材: ['鋼材'],
  部品全般: ['部品全般'],
  ポンプ: ['ポンプ', 'ぽんぷ'],
};
export const fieldLabels = Object.keys(vocabulary);

function containsTerm(text: string, term: string) {
  // "青銅" or "黄銅" (bronze, brass) is a material, not the copper field.
  if (term === '銅') return /(?<![青黄赤])銅/.test(text.normalize('NFKC'));
  // A "ジョイントシート" gasket is a packing, not a joint.
  if (term === 'ジョイント') return /ジョイント(?!シート)/.test(text.normalize('NFKC'));
  if (term === 'プラ')
    return /プラ(?:[、,・/／\s。？！?]|を|の|が|は|製品|$)/.test(text.normalize('NFKC'));
  return normalize(text).includes(normalize(term));
}
export function fieldsFromText(text: string): string[] {
  const found = fieldLabels.filter((field) =>
    vocabulary[field].some((term) => containsTerm(text, term)),
  );
  return found.filter((field) => !found.some((other) => other !== field && other.includes(field)));
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Fields of the item the customer asks about. "ポンプのモーター用のベアリング"
// names a pump only as where the item is used.
export function itemFieldsFromText(text: string): string[] {
  const normalized = text.normalize('NFKC');
  return fieldsFromText(normalized).filter((field) =>
    vocabulary[field].some(
      (term) =>
        containsTerm(normalized, term) &&
        itemMention(normalized, new RegExp(escape(term.normalize('NFKC')))),
    ),
  );
}
function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v == null || (typeof v === 'object' && ('formula' in v || 'sharedFormula' in v))) return '';
  return cell.text.normalize('NFKC').trim();
}

export async function parseSupplierWorkbook(name: string, buffer: Buffer): Promise<ParsedSource> {
  if (!name.toLowerCase().endsWith('.xlsx'))
    throw Error('仕入・外注先一覧はExcel（.xlsx）を選択してください');
  if (!buffer.length || buffer.length > 10 * 1024 * 1024)
    throw Error('ファイルは10MB以下にしてください');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const supplierRows: SupplierKnowledgeRow[] = [];
  const warnings: string[] = [];
  let tables = 0;
  for (const sheet of workbook.worksheets) {
    if (sheet.state !== 'visible') continue;
    if (sheet.rowCount > 20000 || sheet.columnCount > 100)
      throw Error('仕入先一覧は各シート20,000行・100列以下にしてください');
    let headerRow = 0,
      companyColumn = 0,
      productsColumn = 0,
      websiteColumn = 0;
    for (let n = 1; n <= Math.min(sheet.rowCount, 20); n++) {
      const columns = new Map<string, number>();
      sheet.getRow(n).eachCell((cell, col) => columns.set(cellText(cell), col));
      const find = (names: string[]) => names.map((s) => columns.get(s)).find(Boolean) || 0;
      const company = find([
        '仕入先',
        '仕入(外注)先',
        '仕入・外注先',
        '会社名',
        '取引先',
        '外注先',
      ]);
      const products = find([
        '取扱い品',
        '主要取扱い製品',
        '主要取扱製品',
        '取扱製品',
        '取扱い製品',
      ]);
      if (company && products) {
        headerRow = n;
        companyColumn = company;
        productsColumn = products;
        websiteColumn = find(['HP', 'ホームページ', 'URL']);
        break;
      }
    }
    if (!headerRow) continue;
    tables++;
    sheet.eachRow((row, n) => {
      if (n <= headerRow || row.hidden) return;
      const productCell = row.getCell(productsColumn);
      if (productCell.isMerged && productCell.master.address !== productCell.address) return;
      const products = cellText(productCell);
      if (!products) return;
      const supplierName = cellText(row.getCell(companyColumn));
      if (!supplierName) {
        warnings.push(`${sheet.name} ${n}行: 会社名がないため取り込みません。`);
        return;
      }
      if (supplierName.length > 300 || products.length > 2000)
        throw Error(`${sheet.name} ${n}行: 文字数が上限を超えています`);
      const hp = websiteColumn ? row.getCell(websiteColumn) : undefined;
      const rawUrl = hp ? hp.hyperlink || cellText(hp) : '';
      let website = '';
      if (rawUrl) {
        try {
          const url = new URL(rawUrl);
          if (
            !['http:', 'https:'].includes(url.protocol) ||
            url.username ||
            url.password ||
            rawUrl.length > 2000
          )
            throw Error();
          website = url.href;
        } catch {
          warnings.push(`${sheet.name} ${n}行: HPの形式が不正なためURLは保存しません。`);
        }
      }
      const fields = fieldsFromText(products);
      if (!fields.length)
        warnings.push(`${sheet.name} ${n}行: 対応する取扱分野がないため回答には使いません。`);
      supplierRows.push({ supplierName, website, products, fields, sheet: sheet.name, row: n });
      if (supplierRows.length > 5000) throw Error('取扱分野の記載は5,000件以下にしてください');
    });
  }
  if (!tables) throw Error('「仕入先／会社名」と「取扱い品／主要取扱製品」の列が見つかりません');
  if (!supplierRows.length) throw Error('取扱分野の記載された行がありません');
  return { headers: [], rows: [], documents: [], supplierRows, warnings };
}

export async function importSupplierKnowledge(
  source: Source,
  rows: SupplierKnowledgeRow[],
  approved: boolean,
): Promise<ImportResult> {
  if (source.kind !== 'supplier_catalog') throw Error('仕入先一覧の情報源を指定してください');
  const importedAt = now();
  const old = (await list<SupplierKnowledge>('supplier_knowledge')).filter(
    (r) => r.sourceId === source.id,
  );
  const result: ImportResult = { imported: 0, updated: 0, documents: 0, errors: [], warnings: [] };
  await db().transaction(async () => {
    await lockResource(`source:${source.id}`);
    await db().prepare('DELETE FROM supplier_knowledge WHERE source_id=?').run(source.id);
    const seen = new Set<string>();
    for (const row of rows) {
      const key = createHash('sha256')
        .update(`${source.id}\0${normalize(row.supplierName)}\0${normalize(row.products)}`)
        .digest('hex');
      if (seen.has(key)) continue;
      seen.add(key);
      const record: SupplierKnowledge = {
        ...row,
        fields: fieldsFromText(row.products),
        id: key,
        sourceId: source.id,
        approved,
        importedAt,
      };
      await save('supplier_knowledge', record, { source_id: source.id });
      if (old.some((r) => r.id === key)) result.updated++;
      else result.imported++;
    }
    await save('sources', {
      ...source,
      visibility: 'internal',
      lastSyncedAt: importedAt,
      lastError: null,
      recordCount: seen.size,
    });
    const summary = `仕入先情報 ${seen.size}件 / 分野の回答利用 ${approved ? '承認済み' : '未承認'}`;
    await save(
      'source_runs',
      {
        id: uid(),
        sourceId: source.id,
        status: 'success',
        count: seen.size,
        message: summary,
        createdAt: importedAt,
      },
      { source_id: source.id },
    );
    await audit('source.imported', source.id, summary);
  })();
  return result;
}

export async function availableFields(): Promise<string[]> {
  const fields = new Set<string>();
  const sources = new Map((await list<Source>('sources')).map((s) => [s.id, s]));
  for (const row of await list<SupplierKnowledge>('supplier_knowledge')) {
    const source = sources.get(row.sourceId);
    if (
      !row.approved ||
      source?.kind !== 'supplier_catalog' ||
      !source.enabled ||
      !source.config.answerEnabled
    )
      continue;
    row.fields.filter((f) => fieldLabels.includes(f)).forEach((f) => fields.add(f));
  }
  return [...fields];
}

export async function privateSupplierQuestion(message: string): Promise<boolean> {
  // "外注先の名前を知りたいわけではない" withdraws the question; "社内加工か外注か"
  // asks how the work is done, which has a fixed public answer.
  const text = message
    .normalize('NFKC')
    .replace(/(?:仕入先|調達先)(?:から|の)(?:出荷|発送)(?:予定)?日/g, '出荷日')
    .replace(
      /[^。、]*(?:知りたい|聞きたい|教えてほしい)(?:わけ|訳)では(?:ない|ありません)[^。、]*/g,
      '',
    );
  // Asking for our public catalog is not asking for a supplier identity.
  // Named private companies and domains are still checked below.
  const publicResource =
    /カタログ|価格表|自社|御社|アオキエンジ/.test(text) &&
    !/仕入|外注|取引先|取引口座|原価|仕切|商社|卸売|全部|一覧/.test(text);
  const privacyText = publicResource ? text.replace(/ホームページ|\bHP\b|\bURL\b/gi, '') : text;
  if (
    /仕入|外注(?:先|業者|会社|の会社|して(?:いる|る)会社)|取引先|取引口座|卸売|原価|仕切り?(?:価格|値|率|単価)|商社|仕入先|ホームページ|\bHP\b|\bURL\b|https?:\/\//i.test(
      privacyText,
    )
  )
    return true;
  return await containsPrivateSupplierIdentity(message);
}

export async function containsPrivateSupplierIdentity(message: string): Promise<boolean> {
  const query = normalize(message);
  return (await list<SupplierKnowledge>('supplier_knowledge')).some((r) => {
    const fullName = normalize(r.supplierName);
    const legalForm = /株式会社|有限会社|\(株\)|\(有\)/g;
    const company = fullName.replace(legalForm, '');
    let domain = '';
    try {
      domain = new URL(r.website).hostname;
    } catch {
      /* no URL */
    }
    return (
      (fullName.length >= 2 && query.includes(fullName)) ||
      (company.length >= 2 && query.replace(legalForm, '').includes(company)) ||
      (!!domain && query.includes(normalize(domain)))
    );
  });
}

export async function knowledgeTopic(
  message: string,
  intent: QueryIntent,
  previous?: ChatMessage,
): Promise<KnowledgeTopic | undefined> {
  if (/一覧|リスト|掲載/.test(message) && /ない|全て|すべて|全部|全取引|網羅/.test(message))
    return { mode: 'scope', fields: [] };
  if (await privateSupplierQuestion(message)) return { mode: 'privacy', fields: [] };
  if (intent.model) return;
  const available = await availableFields();
  const matching = itemFieldsFromText(message).filter((f) => available.includes(f));
  if (matching.length) return { mode: 'fields', fields: matching };
  if (intent.topicField && available.includes(intent.topicField))
    return { mode: 'fields', fields: [intent.topicField] };
  if (
    /取扱.*(分野|製品|商品)|どんな(製品|商品)|何を扱|扱っている(製品|商品)/.test(message) &&
    available.length
  )
    return { mode: 'fields', fields: available.slice(0, 12) };
  // A newly named field is a topic change, even if it is not registered.
  if (itemFieldsFromText(message).length) return;
  if (
    previous?.knowledge &&
    (previous.knowledge.mode === 'fields' || /誰|どこ|社名|取引|一覧/.test(message)) &&
    (intent.referencesPrevious ||
      intent.intent === 'general' ||
      // "まだ型番が分からないのですが、いくらぐらい？" still asks about the field.
      (previous.knowledge.mode === 'fields' && businessIntents(message).length > 0) ||
      /^(?:\d+\s*(?:個|台|枚|本)|必要な仕様)/.test(message.normalize('NFKC')))
  ) {
    const fields = previous.knowledge.fields.filter((f) => available.includes(f));
    if (fields.length || previous.knowledge.mode !== 'fields')
      return { ...previous.knowledge, fields };
  }
}

// How an unregistered price, stock or delivery is answered. Said once per
// conversation; later turns answer in conversation.
export const CONFIRM_PHRASE = '仕様と数量をもとに確認してご案内します。';
export async function knowledgeReply(
  topic: KnowledgeTopic,
  settings: AppSettings,
  facts: BusinessIntent[] = [],
): Promise<string> {
  if (topic.mode === 'scope')
    return 'ご案内している情報は取扱分野の一部です。掲載の有無から取引の有無や対応可否は判断できません。お探しの製品や用途をお知らせいただければ、当社で確認します。';
  if (topic.mode === 'privacy')
    return '仕入・外注先の社名、ホームページ、取引の有無や取引条件は公開していません。お探しの製品や用途をお知らせください。取扱分野をご案内し、具体的な対応は当社で確認します。';
  const fields = await asyncFilter(topic.fields, async (f) =>
    (await availableFields()).includes(f),
  );
  if (!fields.length)
    return '以前ご案内した分野は、現在の登録情報では確認できません。ご希望の製品や用途をお知らせください。当社で確認します。';
  if (facts.includes('order') && !settings.flags.orders)
    return '現在、オンラインの注文受付は休止しています。当社へご相談ください。';
  if (facts.includes('quote') && !settings.flags.quoteRequests)
    return '現在、オンラインの見積受付は休止しています。お電話でのご相談をご利用ください。';
  if (facts.length) {
    const labels = {
      price: '価格',
      stock: '在庫',
      lead_time: 'お届け時期',
      quote: 'お見積り',
      order: 'ご注文',
    };
    const asked = facts.map((f) => labels[f]).join('・');
    return `「${fields.join('」「')}」の${asked}は、${CONFIRM_PHRASE}`;
  }
  const points = fields.length === 1 ? consultationTopic(fields) : undefined;
  return `「${fields.join('」「')}」の分野についてご相談いただけます。\n個別製品の仕様・対応可否、価格・在庫・納期は当社で確認します。${
    points
      ? `選ぶときは、${checklist(points).join('、')}が分かると候補を絞り込めます。どのような用途でお使いになるか教えていただけますか？`
      : '用途や必要な仕様、数量、ご希望の納期をお聞かせください。'
  }${settings.flags.humanHandoff ? '画面下の「相談を依頼する」からもご相談いただけます。' : ''}`;
}
