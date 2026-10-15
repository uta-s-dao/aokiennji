import * as cheerio from 'cheerio';
import { z } from 'zod';
import {
  RESEARCH_ASPECT_LABELS,
  type AiUsageContext,
  type ResearchAspect,
  type ResearchFinding,
  type ResearchNote,
  type Source,
  type SupplierKnowledge,
} from '../contracts';
import { company } from '../company';
import { byId, db, list, now, save, uid } from './db';
import { safeFetch } from './safe-fetch';
import { beginAiCall, openaiQuotaPaused, pauseOpenaiForQuota, quotaError } from './ai-usage';
import { jevEndpoint } from './jev-config';
import { jsonRequest } from './providers';

// Staff-only research of prices, stock, lead times and shipping on the web,
// replacing the first look-up a salesperson does in a browser. Customers never
// see these notes: the staff confirms them before quoting.
//
// Jev decides (cheap, typed): whether the turn needs research and which
// aspects, and whether each page found is about the requested item.
// OpenAI searches and reads the web (Jev cannot). Each value is then checked
// against the page fetched by this server.

const ASPECTS = ['price', 'lead_time', 'stock', 'shipping'] as const;
const MAX_NOTES_PER_CONVERSATION = 3;
const checkOrder = { matched: 0, partial: 1, unreachable: 2, mismatch: 3 };

export interface ResearchRequest {
  conversationId: string;
  turnId: string;
  message: string;
  // The customer's own statements, oldest first. Private questions excluded.
  customerTexts: string[];
  // What to look up: a registered product or the customer's description.
  subject: string;
  // Approved field labels of the item, used to choose supplier sites.
  fields: string[];
  destination?: string;
  // Quantities as the customer wrote them, such as "10個、6個".
  quantity?: string;
  // The rule-based judgment, used when Jev is not available.
  local: { research: boolean; aspects: ResearchAspect[] };
}

export function researchNotes(conversationId: string): ResearchNote[] {
  return (
    db()
      .prepare('SELECT json FROM research_notes WHERE conversation_id=? ORDER BY created_at')
      .all(conversationId) as { json: string }[]
  ).map((r) => JSON.parse(r.json));
}
function store(note: ResearchNote) {
  save('research_notes', note, {
    conversation_id: note.conversationId,
    created_at: note.createdAt,
  });
}
function bigrams(text: string) {
  const t = squash(text);
  return new Set(Array.from({ length: Math.max(0, t.length - 1) }, (_, i) => t.slice(i, i + 2)));
}
// The share of the earlier text found in the later one.
function contained(earlier: string, later: string) {
  const before = bigrams(earlier);
  const after = bigrams(later);
  return before.size ? [...before].filter((g) => after.has(g)).length / before.size : 0;
}
const squash = (s: string) =>
  s
    .normalize('NFKC')
    .replace(/[\s,、]/g, '')
    .replace(/[〜～~]/g, '〜');

const prefectures =
  '北海道|青森|岩手|宮城|秋田|山形|福島|茨城|栃木|群馬|埼玉|千葉|東京|神奈川|新潟|富山|石川|福井|山梨|長野|岐阜|静岡|愛知|三重|滋賀|京都|大阪|兵庫|奈良|和歌山|鳥取|島根|岡山|広島|山口|徳島|香川|愛媛|高知|福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島|沖縄';
const cities: Record<string, string> = {
  名古屋: '愛知',
  横浜: '神奈川',
  川崎: '神奈川',
  札幌: '北海道',
  仙台: '宮城',
  神戸: '兵庫',
  北九州: '福岡',
  博多: '福岡',
};
// Where the goods are sent from ("北九州から帯広まで") is not a destination.
const origin = /(?:北九州|福岡|九州|門司|御社|そちら)(?:市|県)?(?:から|発|より)/g;
// The latest place the customer named as a delivery destination. A prefecture
// named in the same message wins over a city ("北海道帯広市").
export function destinationIn(texts: string[]): string | undefined {
  for (const raw of [...texts].reverse()) {
    const text = raw.normalize('NFKC').replace(origin, '');
    const found = text.match(new RegExp(`(${prefectures})(?:都|道|府|県)?`));
    if (found) return found[1];
    const city = Object.keys(cities).find((c) => text.includes(c));
    if (city) return cities[city];
  }
}
// Quantities the customer asked for, as written ("10個、6個"). "1本いくら" or
// "1枚あたり" is a unit price, not an amount to buy.
export function statedQuantities(texts: string[]): string | undefined {
  const found: string[] = [];
  for (const text of texts)
    for (const m of text
      .normalize('NFKC')
      .matchAll(
        /(\d{1,6})\s*(個|台|枚|本|セット|巻|pcs)(?!\s*(?:あたり|当たり|につき|いくら|の(?:価格|単価|値段)|[でに]?(?:いくら|おいくら)))/gi,
      )) {
      const value = `${m[1]}${m[2]}`;
      if (Number(m[1]) > 0 && !found.includes(value)) found.push(value);
    }
  return found.length ? found.slice(-6).join('、') : undefined;
}

// --- decision (Jev) --------------------------------------------------------

async function decide(request: ResearchRequest, context: AiUsageContext) {
  const local = { ...request.local, decidedBy: 'local' as const };
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) return local;
  let endpoint: ReturnType<typeof jevEndpoint>;
  try {
    endpoint = jevEndpoint();
  } catch {
    return local;
  }
  const questions = {
    wanted: {
      type: 'noul',
      instructions:
        'The customer wants the price, stock, delivery time or shipping of a specific item, or wants to buy it or get a quote.',
    },
    identifiable: {
      type: 'noul',
      instructions:
        'The item is described specifically enough to look it up on the web: a maker, a model number, a size or a specification such as 25A, M8 or SUS304.',
    },
    price: {
      type: 'noul',
      instructions: 'The customer asks about the price, cost, budget, discount or a quote.',
    },
    lead_time: {
      type: 'noul',
      instructions:
        'The customer asks when it can be shipped or delivered, the lead time or a deadline.',
    },
    stock: {
      type: 'noul',
      instructions: 'The customer asks whether it is in stock or how many are available.',
    },
    shipping: {
      type: 'noul',
      instructions:
        'The customer asks about the shipping cost, delivery to a place or how many days delivery takes.',
    },
  };
  const body = {
    model: 'jev-latest',
    state: JSON.stringify({
      latestMessage: request.message.slice(0, 1000),
      customerMessages: request.customerTexts.slice(-6).map((t) => t.slice(0, 400)),
      item: request.subject.slice(0, 400),
    }),
    questions,
  };
  const usage = beginAiCall({
    provider: 'jev',
    purpose: 'research_decision',
    model: body.model,
    endpoint,
    body: JSON.stringify(body),
    context,
    requestShape: {
      contentType: 'application/json',
      authentication: 'Bearer (value omitted)',
      bodyKeys: ['model', 'state', 'questions'],
      questions: Object.keys(questions),
    },
  });
  try {
    const result = await jsonRequest(
      endpoint,
      { Authorization: `Bearer ${key}` },
      body,
      4000,
      undefined,
      usage.response,
    );
    usage.usage(result.usage);
    const p = (id: string) => result.answers?.[id]?.noul;
    if (typeof p('wanted') !== 'number' || typeof p('identifiable') !== 'number')
      throw Error('invalid_classification');
    usage.finish(true);
    const aspects = ASPECTS.filter((a) => (p(a) ?? 0) >= 0.5);
    return {
      research: p('wanted') >= 0.6 && p('identifiable') >= 0.5,
      aspects: aspects.length ? aspects : local.aspects,
      decidedBy: 'jev' as const,
    };
  } catch (error) {
    usage.finish(false, error);
    return local;
  }
}

// --- search (OpenAI web search) ---------------------------------------------

const instructions = `あなたは工業部品を扱う商社の購買担当者を手伝う調査係です。指定された品目について、Web検索で価格・在庫表示・出荷や納期・配送日数や送料の記載を集めます。
- valueには、価格・在庫・日数・送料の記載だけを、ページの表記のまま入れる（例: "¥18,700(税込)"、"通常2～3日で出荷"、"在庫あり"、"翌日配達"）。サイト名や商品名だけの記載、推測・計算・要約は入れない。在庫数と「欠品中」のように同じ欄に別の記載があれば両方入れる。
- 品目が複数（サイズ違い・型番違い）のときは、それぞれ別のfindingにする。同じ品目でもサイズ・型式・材質・形状（例: 内パッキンと全面パッキン）が違うものは、noteの先頭に「別型式:」「別サイズ:」と違いを書く。
- 送料・配送日数は、発送元から届け先までの区間とサイズ・重量の条件が分かるものだけ。区間が違う表（例: 関東発）はnoteに区間を書く。
- urlは実際に開いたページ。sourceはメーカー=maker、通販=retailer、運送会社=carrier、仕入先として指定されたサイト=supplier、その他=other。
- summaryは担当者向けに200字以内の事実の要約。見つかったこと、見つからなかったこと、品目違いなどの注意点だけを書く。依頼・質問・許可を求める文（「〜してください」「〜いただければ」）や、ページで確認できない推測は書かない。`;
const outputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['matched_item', 'summary', 'findings'],
  properties: {
    matched_item: { type: 'string' },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['aspect', 'value', 'note', 'title', 'url', 'source'],
        properties: {
          aspect: { type: 'string', enum: ASPECTS },
          value: { type: 'string' },
          note: { type: 'string' },
          title: { type: 'string' },
          url: { type: 'string' },
          source: { type: 'string', enum: ['maker', 'retailer', 'carrier', 'supplier', 'other'] },
        },
      },
    },
  },
};
const resultSchema = z.object({
  matched_item: z.string().max(300),
  summary: z.string().max(1000),
  findings: z
    .array(
      z.object({
        aspect: z.enum(ASPECTS),
        value: z.string().min(1).max(200),
        note: z.string().max(400),
        title: z.string().max(300),
        url: z.string().max(2000),
        source: z.enum(['maker', 'retailer', 'carrier', 'supplier', 'other']),
      }),
    )
    .max(12),
});
// Models sometimes write a URL as a Markdown link with a tracking parameter.
const cleanUrl = (raw: string) => {
  const found = raw.match(/https?:\/\/[^\s)\]>"']+/)?.[0];
  if (!found) return '';
  try {
    const url = new URL(found);
    url.searchParams.delete('utm_source');
    return url.toString();
  } catch {
    return '';
  }
};
const pageKey = (raw: string) => {
  try {
    const url = new URL(raw);
    return `${url.hostname.replace(/^www\./, '')}${url.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return '';
  }
};

async function search(
  request: ResearchRequest,
  aspects: ResearchAspect[],
  context: AiUsageContext,
  domains: string[] = [],
) {
  const key = process.env.OPENAI_API_KEY!;
  const model = process.env.OPENAI_RESEARCH_MODEL || 'gpt-5-mini';
  // GPT-4.1 models cannot restrict the search to given sites; the sites are
  // named in the request and the results are filtered below instead.
  const filters = !model.startsWith('gpt-4');
  const input = [
    `調べる品目: ${request.subject}`,
    `知りたいこと: ${aspects.map((a) => RESEARCH_ASPECT_LABELS[a]).join('、')}`,
    request.quantity ? `数量: ${request.quantity}` : '',
    request.destination && aspects.includes('shipping')
      ? `お届け先: ${request.destination}（発送元は${company.address.slice(0, 7)}。この区間の配送日数・送料の目安）`
      : '',
    domains.length
      ? `次のサイトの中から探す: ${filters ? '指定のサイト' : domains.join('、')}`
      : 'メーカー公式サイト・カタログ、通販サイト（モノタロウ、ミスミ、アスクル等）、運送会社（ヤマト運輸、佐川急便、西濃運輸、福山通運、日本郵便）の情報を優先する。',
  ]
    .filter(Boolean)
    .join('\n');
  const body = JSON.stringify({
    model,
    store: false,
    ...(model.startsWith('gpt-5') ? { reasoning: { effort: 'low' } } : {}),
    tools: [
      {
        type: 'web_search',
        user_location: { type: 'approximate', country: 'JP' },
        ...(domains.length && filters ? { filters: { allowed_domains: domains } } : {}),
      },
    ],
    tool_choice: 'required',
    include: ['web_search_call.action.sources'],
    instructions,
    input,
    max_output_tokens: 3000,
    text: { format: { type: 'json_schema', name: 'research', strict: true, schema: outputSchema } },
  });
  const usage = beginAiCall({
    provider: 'openai',
    purpose: 'research',
    model,
    body,
    context,
    requestShape: {
      contentType: 'application/json',
      authentication: 'Bearer (value omitted)',
      bodyKeys: [
        'model',
        'store',
        'tools',
        'tool_choice',
        'include',
        'instructions',
        'input',
        'text',
      ],
      tool: 'web_search',
      scope: domains.length ? 'supplier_sites' : 'public_web',
      allowedDomains: domains.length,
      aspects,
    },
  });
  try {
    const response = await safeFetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body,
      timeoutMs: 30000,
      maxBytes: 2000000,
      maxRedirects: 0,
      httpsOnly: true,
      onResponse: usage.response,
    });
    usage.response(response.status, response.headers);
    if (response.status !== 200) {
      if (!quotaError(response.body.toString('utf8'))) throw Error('generation_failed');
      pauseOpenaiForQuota();
      throw Error('insufficient_quota');
    }
    const data = JSON.parse(response.body.toString('utf8'));
    usage.usage(data.usage);
    const consulted = new Set<string>();
    let text = '';
    for (const item of data.output || []) {
      if (item.type === 'web_search_call')
        for (const source of item.action?.sources || []) consulted.add(pageKey(source.url));
      if (item.type === 'message')
        for (const part of item.content || []) {
          if (part.type === 'output_text') {
            text += part.text;
            for (const note of part.annotations || []) consulted.add(pageKey(note.url));
          }
        }
    }
    const parsed = resultSchema.parse(JSON.parse(text));
    usage.finish(true);
    // A site the search never visited is an invented source, and a supplier
    // search keeps only pages on those sites. The value itself is checked
    // against the page afterwards.
    const visited = new Set([...consulted].map((key) => key.split('/')[0]));
    const findings = parsed.findings
      .map((f) => ({ ...f, url: cleanUrl(f.url) }))
      .filter((f) => {
        const host = pageKey(f.url).split('/')[0];
        return (
          !!host &&
          (consulted.has(pageKey(f.url)) || visited.has(host)) &&
          (!domains.length || domains.some((d) => host === d || host.endsWith(`.${d}`)))
        );
      });
    return { ...parsed, findings, dropped: parsed.findings.length - findings.length };
  } catch (error) {
    usage.finish(false, error instanceof SyntaxError ? Error('invalid_research') : error);
    throw error;
  }
}

// --- verification -----------------------------------------------------------

function decode(body: Buffer, contentType: string | null) {
  const head = body.subarray(0, 4096).toString('latin1');
  const charset = (
    /charset=["']?([\w-]+)/i.exec(contentType || '')?.[1] ||
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ||
    'utf-8'
  ).toLowerCase();
  const label = /shift[_-]?jis|sjis|windows-31j|cp932/.test(charset)
    ? 'shift_jis'
    : /euc-?jp/.test(charset)
      ? 'euc-jp'
      : 'utf-8';
  try {
    return new TextDecoder(label).decode(body);
  } catch {
    return body.toString('utf8');
  }
}
async function pageText(url: string) {
  const response = await safeFetch(url, {
    timeoutMs: 8000,
    maxBytes: 3000000,
    maxRedirects: 3,
    headers: {
      'User-Agent': `Mozilla/5.0 (compatible; AokiEngResearch/1.0; +${company.sourceUrl})`,
    },
  });
  if (response.status !== 200) throw Error(`http_${response.status}`);
  const $ = cheerio.load(decode(response.body, response.headers.get('content-type')));
  $('script,style,noscript,svg,iframe').remove();
  return $('body').text().normalize('NFKC').replace(/\s+/g, ' ');
}
const numberTokens = (text: string) =>
  (
    text
      .normalize('NFKC')
      .replace(/,/g, '')
      .match(/\d+(?:\.\d+)?/g) || []
  ).map((n) => (n.includes('.') ? String(Number(n)) : n));
const amountPattern =
  /[¥￥]\d[\d,]*|\d[\d,]*(?:\.\d+)?(?:\s*[〜～~-]\s*\d+)?\s*(?:円|営業日|日|週間|か月|ヶ月)/g;
// How well the fetched page supports the value. An amount or period ("¥18,700",
// "2〜3日") must appear with its unit; other numbers ("600×1200", "66.0%") as
// numbers. matched: all of them. partial: some, or a short word such as
// "翌日" that alone proves little. mismatch: none.
export function checkOnPage(value: string, page: string): 'matched' | 'partial' | 'mismatch' {
  const text = squash(page);
  const normalized = value.normalize('NFKC');
  const amounts = [...new Set((normalized.match(amountPattern) || []).map(squash))];
  // Single digits appear on almost any page and prove nothing alone.
  const others = [...new Set(numberTokens(normalized.replace(amountPattern, ' ')))].filter(
    (n) => n.replace('.', '').length >= 2,
  );
  const pageNumbers = new Set(numberTokens(page));
  const total = amounts.length + others.length;
  const hits =
    amounts.filter((a) => text.includes(a)).length +
    others.filter((n) => pageNumbers.has(n)).length;
  if (total) return hits === total ? 'matched' : hits ? 'partial' : 'mismatch';
  const parts = normalized
    .split(/[/／・、]|または/)
    .map(squash)
    .filter((p) => p.length >= 2);
  const found = parts.filter((p) => text.includes(p));
  if (!found.length) return 'mismatch';
  // "在庫あり" or "翌日" on a page does not show it is said of this item.
  return found.length === parts.length && squash(normalized).length >= 6 ? 'matched' : 'partial';
}
export function valueOnPage(value: string, page: string) {
  return checkOnPage(value, page) === 'matched';
}
// Model numbers, sizes and grades of the requested item ("6305ZZC3", "50A",
// "SUS316"). A page without any of them may be about another variant.
export function itemOnPage(subject: string, page: string): boolean | undefined {
  const tokens = [
    ...new Set(
      (subject.normalize('NFKC').match(/[A-Za-z]*\d[\dA-Za-z.-]*|[A-Za-z]{2,}\d*/g) || []).filter(
        (t) => t.length >= 3 && /\d/.test(t) && !/^\d+(?:個|台|枚|本)?$/.test(t),
      ),
    ),
  ];
  if (!tokens.length) return undefined;
  const text = squash(page).toUpperCase();
  return tokens.some((t) => text.includes(squash(t).toUpperCase()));
}
function excerpt(value: string, page: string) {
  const first = value.normalize('NFKC').match(/\d[\d,]*/)?.[0];
  const at = first ? page.indexOf(first) : -1;
  return at >= 0 ? page.slice(Math.max(0, at - 250), at + 250) : page.slice(0, 500);
}

async function relevance(
  subject: string,
  destination: string | undefined,
  findings: (ResearchFinding & { excerpt: string })[],
  context: AiUsageContext,
): Promise<(number | null)[]> {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key || !findings.length) return findings.map(() => null);
  let endpoint: ReturnType<typeof jevEndpoint>;
  try {
    endpoint = jevEndpoint();
  } catch {
    return findings.map(() => null);
  }
  // Fan-out: one question per finding, all against the same state.
  const questions = Object.fromEntries(
    findings.map((f, i) => [
      `f${i}`,
      {
        type: 'noul',
        instructions:
          f.aspect === 'shipping'
            ? `Finding f${i} gives a shipping cost or delivery time for sending from Kitakyushu, Fukuoka (Kyushu) to the destination. A table for another origin (for example from Kanto) or another destination is not.`
            : `Finding f${i} is about the requested item itself: the same maker and model, or the same kind of product with matching size, material and shape. A different product, a different size or variant, or a general page is not.`,
      },
    ]),
  );
  const body = {
    model: 'jev-latest',
    state: JSON.stringify({
      requestedItem: subject.slice(0, 400),
      origin: '福岡県北九州市',
      destination: destination || 'unknown',
      findings: findings.map((f, i) => ({
        id: `f${i}`,
        aspect: f.aspect,
        value: f.value,
        pageTitle: f.title,
        note: f.note,
        excerpt: f.excerpt.slice(0, 500),
      })),
    }),
    questions,
  };
  const usage = beginAiCall({
    provider: 'jev',
    purpose: 'research_decision',
    model: body.model,
    endpoint,
    body: JSON.stringify(body),
    context,
    requestShape: {
      contentType: 'application/json',
      authentication: 'Bearer (value omitted)',
      bodyKeys: ['model', 'state', 'questions'],
      questions: findings.length,
      check: 'page_matches_item',
    },
  });
  try {
    const result = await jsonRequest(
      endpoint,
      { Authorization: `Bearer ${key}` },
      body,
      6000,
      undefined,
      usage.response,
    );
    usage.usage(result.usage);
    usage.finish(true);
    return findings.map((_, i) => {
      const value = result.answers?.[`f${i}`]?.noul;
      return typeof value === 'number' ? Math.round(value * 100) / 100 : null;
    });
  } catch (error) {
    usage.finish(false, error);
    return findings.map(() => null);
  }
}

// Approved supplier sites that handle the item's field. Their names are shown
// to staff only.
function supplierSites(fields: string[]) {
  const sites = new Map<string, string>();
  for (const row of list<SupplierKnowledge>('supplier_knowledge')) {
    const source = byId<Source>('sources', row.sourceId);
    if (!row.approved || !source?.enabled || !row.website) continue;
    if (!row.fields.some((f) => fields.includes(f))) continue;
    try {
      sites.set(new URL(row.website).hostname.replace(/^www\./, ''), row.supplierName);
    } catch {
      // A malformed URL is skipped.
    }
  }
  return sites;
}

export async function researchForStaff(request: ResearchRequest, context: AiUsageContext) {
  // Without credits the search cannot run; the admin overview says so.
  if (!process.env.OPENAI_API_KEY || openaiQuotaPaused()) return;
  const previous = researchNotes(request.conversationId).filter((note) => !note.sourcing);
  if (previous.length >= MAX_NOTES_PER_CONVERSATION) return;
  const decision = await decide(request, context);
  if (!decision.research) return;
  // The subject grows as the customer adds details, so a previous subject
  // mostly contained in this one is the same item. Research it again only
  // for a new aspect, destination or quantity.
  const same = previous.some(
    (n) =>
      n.status !== 'failed' &&
      contained(n.subject, request.subject) >= 0.6 &&
      decision.aspects.every((a) => n.aspects.includes(a)) &&
      (!request.destination || n.destination === request.destination) &&
      (!request.quantity || String(n.quantity) === request.quantity),
  );
  if (same) return;
  const note: ResearchNote = {
    id: uid(),
    conversationId: request.conversationId,
    turnId: request.turnId,
    createdAt: now(),
    completedAt: null,
    status: 'running',
    subject: request.subject.slice(0, 600),
    aspects: decision.aspects,
    ...(request.destination ? { destination: request.destination } : {}),
    ...(request.quantity ? { quantity: request.quantity } : {}),
    findings: [],
    summary: '',
    decidedBy: decision.decidedBy,
  };
  store(note);
  try {
    const suppliers = supplierSites(request.fields);
    const domains = [...suppliers.keys()].slice(0, 20);
    // Supplier sites have no carrier tables, so shipping is looked up publicly.
    const supplierAspects = decision.aspects.filter((a) => a !== 'shipping');
    const results = await Promise.allSettled([
      search(request, decision.aspects, context),
      ...(domains.length && supplierAspects.length
        ? [search(request, supplierAspects, context, domains)]
        : []),
    ]);
    // A finding must state a value: an amount, a period, stock or shipping.
    const stated = (f: { aspect: ResearchAspect; value: string }) =>
      f.aspect === 'price'
        ? /\d/.test(f.value)
        : /\d|在庫|当日|翌日|即日|出荷|発送|お届け|送料|無料|込/.test(f.value);
    const found = results
      .flatMap((r, i) =>
        r.status === 'fulfilled'
          ? r.value.findings.map((f) => ({
              ...f,
              source: i === 1 ? ('supplier' as const) : f.source,
            }))
          : [],
      )
      .filter(stated)
      .slice(0, 10);
    if (results.every((r) => r.status === 'rejected'))
      throw Error(
        results.some((r) => r.status === 'rejected' && r.reason?.message === 'insufficient_quota')
          ? 'insufficient_quota'
          : 'research_failed',
      );
    const checked = await Promise.all(
      found.map(async (f) => {
        const host = pageKey(f.url).split('/')[0];
        const supplierName = [...suppliers].find(
          ([d]) => host === d || host.endsWith(`.${d}`),
        )?.[1];
        let page = '';
        try {
          page = await pageText(f.url);
        } catch {
          // Sites that refuse automated access are left for a person to check.
        }
        // A page drawn by scripts shows this server almost no text and no
        // numbers: it was not read, so it is not a mismatch either.
        if (!/\d/.test(page)) page = '';
        const item =
          page && f.aspect !== 'shipping' ? itemOnPage(request.subject, page) : undefined;
        return {
          ...f,
          check: !page ? ('unreachable' as const) : checkOnPage(f.value, page),
          relevance: null,
          ...(item === undefined ? {} : { itemOnPage: item }),
          excerpt: page ? excerpt(f.value, page) : f.note,
          ...(supplierName ? { supplierName, source: 'supplier' as const } : {}),
        };
      }),
    );
    const scores = await relevance(note.subject, request.destination, checked, context);
    note.findings = checked
      .map(({ excerpt: _excerpt, ...f }, i) => ({ ...f, relevance: scores[i] }))
      .sort(
        (a, b) =>
          checkOrder[a.check] - checkOrder[b.check] || (b.relevance ?? 0) - (a.relevance ?? 0),
      )
      .slice(0, 8);
    // Only facts for the staff: requests such as "検索を許可ください" are dropped,
    // as are sentences repeating a value the page did not show; a search that
    // found nothing adds no summary.
    const rejected = note.findings
      .filter((f) => f.check === 'mismatch')
      .flatMap((f) => numberTokens(f.value).filter((n) => n.length >= 3));
    note.summary = results
      .map((r) =>
        r.status === 'fulfilled' && r.value.findings.length
          ? r.value.summary
              .split(/(?<=。)/)
              .filter(
                (s) =>
                  !/ください|いただければ|いただけますか|許可|お知らせ|ご確認を/.test(s) &&
                  !numberTokens(s).some((n) => rejected.includes(n)),
              )
              .join('')
              .trim()
          : '',
      )
      .filter(Boolean)
      .join('\n')
      .slice(0, 800);
    note.status = 'done';
  } catch (error) {
    note.status = 'failed';
    note.error = error instanceof Error ? error.message.slice(0, 200) : 'research_failed';
  }
  note.completedAt = now();
  store(note);
}
