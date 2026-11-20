import type { ResearchBrief } from "../domain/model";
import {
  maySearchWeb,
  publicSearchConditions,
  type PartnerSearchResult,
  type PublicSearchConditions,
} from "../domain/partner-search";

export type PartnerWebSettings = {
  EXTERNAL_ENABLED?: string;
  PARTNER_WEB_ENABLED?: string;
  PARTNER_WEB_PROVIDER?: string;
  BRAVE_SEARCH_API_KEY?: string;
  PARTNER_WEB_ALLOWED_HOSTS?: string;
  PARTNER_WEB_READER?: string;
  JINA_API_KEY?: string;
};
export type WebConditionEvidence = {
  field: string;
  condition: string;
  excerpt: string;
};
export type PartnerWebCandidate = {
  url: string;
  title: string;
  checkedAt: string;
  kind: "processing" | "purchase";
  confirmed: WebConditionEvidence[];
  unconfirmed: string[];
  notice: string;
};
export type PartnerWebResult = {
  status: "completed" | "disabled" | "blocked" | "failed" | "incomplete";
  items: {
    itemId: string;
    status: "completed" | "failed" | "incomplete";
    candidates: PartnerWebCandidate[];
    reason?: string;
  }[];
  reason?: string;
};
export const BRAVE_SEARCH_URL =
  "https://api.search.brave.com/res/v1/web/search";
export const JINA_READER_URL = "https://r.jina.ai/";
const MAX_RESPONSE_BYTES = 200_000;
export function allowedPageUrl(
  raw: string,
  allowedHosts: string[],
): URL | null {
  try {
    if (
      raw.length > 2000 ||
      Array.from(raw).some(
        (character) => character.charCodeAt(0) <= 32 || character === "\\",
      )
    )
      return null;
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443") ||
      url.hash ||
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ||
      /(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)$/.test(
        host,
      )
    )
      return null;
    const allowedKeys = new Set([
      "id",
      "item",
      "item_id",
      "product",
      "product_id",
      "pid",
      "sku",
      "code",
      "page",
      "p",
      "goods",
      "goods_id",
    ]);
    for (const [key, value] of [...url.searchParams.entries()]) {
      if (
        /^(?:utm_|fbclid$|gclid$|msclkid$|ref$|referrer$|campaign$)/i.test(key)
      ) {
        url.searchParams.delete(key);
        continue;
      }
      if (
        !allowedKeys.has(key.toLowerCase()) ||
        !/^[A-Za-z0-9_.-]{1,80}$/.test(value)
      )
        return null;
    }
    // Exact operator-owned allowlist only: no wildcard, IP, subdomain expansion or redirects.
    if (!allowedHosts.includes(host)) return null;
    return url;
  } catch {
    return null;
  }
}
function config(settings: PartnerWebSettings) {
  if (
    settings.EXTERNAL_ENABLED !== "true" ||
    settings.PARTNER_WEB_ENABLED !== "true" ||
    settings.PARTNER_WEB_PROVIDER !== "brave" ||
    !settings.BRAVE_SEARCH_API_KEY?.trim()
  )
    return null;
  const hosts = [
    ...new Set(
      (settings.PARTNER_WEB_ALLOWED_HOSTS ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (
    hosts.length > 20 ||
    hosts.some((host) => !allowedPageUrl(`https://${host}/`, hosts))
  )
    return null;
  if (
    settings.PARTNER_WEB_READER &&
    !["disabled", "jina"].includes(settings.PARTNER_WEB_READER)
  )
    return null;
  return {
    key: settings.BRAVE_SEARCH_API_KEY,
    hosts,
    reader: settings.PARTNER_WEB_READER === "jina",
    readerKey: settings.JINA_API_KEY,
  };
}
export function partnerWebConfigured(settings: PartnerWebSettings): boolean {
  return config(settings) !== null;
}
export function partnerWebQuery(
  conditions: PublicSearchConditions,
): string | null {
  if (
    !conditions.kind ||
    (!conditions.products.length &&
      !conditions.processes.length &&
      !conditions.model)
  )
    return null;
  return [
    conditions.kind === "processing" ? "受託加工" : "販売 購入",
    ...(conditions.model ? [conditions.model] : []),
    ...conditions.products,
    ...(conditions.kind === "processing" ? conditions.processes : []),
    ...conditions.materials,
    ...conditions.dimensions.map(
      (d) => `${dimensionLabels[d.key]} ${d.value}${d.unit}`,
    ),
    ...(conditions.holeCount
      ? [`穴数 ${conditions.holeCount.value}${conditions.holeCount.unit}`]
      : []),
    ...(conditions.quantity
      ? [`依頼数量 ${conditions.quantity.value}${conditions.quantity.unit}`]
      : []),
    ...(conditions.requiredDate ? [`希望納期 ${conditions.requiredDate}`] : []),
  ]
    .join(" ")
    .slice(0, 500);
}
async function boundedText(response: Response) {
  const length = Number(response.headers.get("content-length"));
  if (length > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("PAGE_TOO_LARGE");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  let size = 0,
    text = "";
  const decoder = new TextDecoder();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("PAGE_TOO_LARGE");
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel();
  }
}
function bodyText(html: string) {
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i)?.[1] ?? "";
  return body
    .replace(
      /<(script|style|nav|header|footer|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
      " ",
    )
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(?:p|div|tr|section|article|li|h[1-6])>|<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .trim();
}
const dimensionLabels: Record<string, string> = {
  overall_length: "全長",
  outer_diameter: "外径",
  inner_diameter: "内径",
  opening_diameter: "開口径",
  hole_diameter: "穴径",
  width: "幅",
  height: "高さ",
  depth: "奥行",
  thickness: "厚さ",
};
function verifyPage(
  text: string,
  conditions: PublicSearchConditions,
): Omit<PartnerWebCandidate, "url" | "title" | "checkedAt" | "kind"> | null {
  const confirmed: WebConditionEvidence[] = [],
    unconfirmed: string[] = [];
  const kind = conditions.kind;
  if (!kind) return null;
  const operation =
    kind === "processing"
      ? /受託|受注|加工対応|加工可能|加工承り|旋盤加工|フライス加工|切削加工|穴あけ加工|溶接加工|曲げ加工|放電加工|レーザー加工|レーザー切断|ワイヤーカット|研磨加工|研削加工|マシニング加工|プレス加工|表面処理|熱処理/
      : /販売|購入|通販|注文|取扱商品/;
  const anchors = conditions.model
    ? [conditions.model]
    : kind === "processing"
      ? conditions.processes
      : conditions.products;
  // Only the block for the requested product/model or process is evidence. Other machines/products are isolated.
  const blocks = text
    .split(/\n\s*\n|\n|。/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 1500);
  const matchesIdentity = (block: string) =>
    anchors.some((term) => {
      if (conditions.model) {
        const position = block.indexOf(term);
        return (
          position >= 0 &&
          !/[A-Za-z0-9_.-]/.test(block[position - 1] ?? " ") &&
          !/[A-Za-z0-9_.-]/.test(block[position + term.length] ?? " ")
        );
      }
      return block.includes(term);
    });
  const relevant = blocks.filter(
    (block) => matchesIdentity(block) && operation.test(block),
  );
  if (!relevant.length) return null;
  const positive = (block: string) =>
    !/(?:不可|未対応|終了|停止|対応外|対象外|していません|できません|ありません|在庫なし|欠品|除く|以外|非対応)/.test(
      block,
    );
  const evidenceBlocks = relevant.filter(positive);
  if (!evidenceBlocks.length) return null;
  const body = evidenceBlocks.join("\n");
  const excerpt = (term: string) => {
    const block = evidenceBlocks.find((s) => s.includes(term)) ?? "";
    const i = block.indexOf(term);
    return block.slice(Math.max(0, i - 40), i + term.length + 100);
  };
  confirmed.push({
    field: "request_scope",
    condition: kind === "processing" ? "加工の案内" : "購入・販売の案内",
    excerpt: evidenceBlocks[0].slice(0, 180),
  });
  if (conditions.model)
    confirmed.push({
      field: "model",
      condition: conditions.model,
      excerpt: excerpt(conditions.model),
    });
  for (const [field, values] of [
    ["product_name", conditions.products],
    ["process", kind === "processing" ? conditions.processes : []],
    ["material", conditions.materials],
  ] as [string, string[]][]) {
    for (const value of values) {
      const termPresent =
        conditions.materials.includes(value) && /^SUS\d/.test(value)
          ? new RegExp(`${value}(?![A-Za-z0-9])`).test(body)
          : body.includes(value);
      if (
        termPresent &&
        !relevant.some((s) => s.includes(value) && !positive(s))
      )
        confirmed.push({ field, condition: value, excerpt: excerpt(value) });
      else unconfirmed.push(`${field}：${value}`);
    }
  }
  for (const d of conditions.dimensions) {
    const term = `${dimensionLabels[d.key]}${d.value}${d.unit}`;
    const block = evidenceBlocks.find((s) => {
      const compact = s.replace(/\s+/g, ""),
        position = compact.indexOf(term);
      return (
        position >= 0 &&
        !/^(?:未満|超|より小|より大|を超|以下を除|以上を除)/.test(
          compact.slice(position + term.length),
        )
      );
    });
    if (block)
      confirmed.push({
        field: d.key,
        condition: term,
        excerpt: block.slice(0, 180),
      });
    else unconfirmed.push(term);
  }
  if (!conditions.materials.length) unconfirmed.push("材質");
  if (conditions.holeCount) {
    const count = conditions.holeCount.value;
    const holePattern = new RegExp(
      `(?:穴数[：:]?${count}(?:か所|箇所|個|穴)?(?![0-9.])|(?<![0-9.])${count}穴(?![0-9.]))`,
    );
    const block = evidenceBlocks.find((entry) => {
      const compact = entry.replace(/\s+/g, "");
      const match = holePattern.exec(compact);
      return (
        match &&
        !/^(?:未満|超|より小|より大|を超|以下を除|以上を除)/.test(
          compact.slice(match.index + match[0].length),
        )
      );
    });
    if (block)
      confirmed.push({
        field: "hole_count",
        condition: `穴数${count}${conditions.holeCount.unit}`,
        excerpt: block.slice(0, 180),
      });
    else unconfirmed.push(`穴数${count}${conditions.holeCount.unit}`);
  }
  if (!conditions.dimensions.length) unconfirmed.push("寸法・単位");
  if (kind === "purchase") {
    for (const block of evidenceBlocks) {
      const stock = block.match(/在庫あり|在庫有り|在庫有/);
      const shipping = block.match(
        /(?:出荷目安|発送目安|納期目安)[：: ]?[^。\n]{1,45}/,
      );
      if (stock)
        confirmed.push({
          field: "page_stock_information",
          condition: `ページ記載：${stock[0]}`,
          excerpt: block.slice(0, 180),
        });
      if (shipping)
        confirmed.push({
          field: "page_shipping_information",
          condition: `ページ記載：${shipping[0]}`,
          excerpt: block.slice(0, 180),
        });
    }
  }
  unconfirmed.push(
    "今回の数量の受注可否",
    "現在の在庫・生産余力の確約",
    "希望納期の確約",
  );
  return {
    confirmed,
    unconfirmed,
    notice:
      "公開ページで確認できた案内です。在庫・出荷目安は確認時のページ記載で、今回の受注・納期の保証ではありません。",
  };
}
export async function runPartnerWebSearch(
  brief: ResearchBrief,
  internal: PartnerSearchResult,
  settings: PartnerWebSettings,
  options: {
    transport?: typeof fetch;
    now?: () => number;
    signal?: AbortSignal;
    deadline?: number;
    budget?: { searchRequests: number; pageRequests: number };
  } = {},
): Promise<PartnerWebResult> {
  if (
    !maySearchWeb(
      internal,
      brief.items.map((i) => i.id),
    )
  )
    return {
      status: "blocked",
      items: [],
      reason: "INTERNAL_SEARCH_NOT_EMPTY_OR_INCOMPLETE",
    };
  const cfg = config(settings);
  if (!cfg)
    return { status: "disabled", items: [], reason: "WEB_NOT_CONFIGURED" };
  const transport = options.transport ?? fetch,
    now = options.now ?? Date.now;
  const deadline = Math.min(options.deadline ?? Infinity, now() + 25_000);
  const budget = options.budget ?? { searchRequests: 0, pageRequests: 0 };
  const fetchText = async (
    url: URL,
    headers: Record<string, string>,
    retry: boolean,
    body?: string,
  ): Promise<string> => {
    for (let attempt = 0; attempt < (retry ? 2 : 1); attempt++) {
      const remaining = deadline - now();
      if (remaining <= 0) throw new Error("WEB_DEADLINE");
      const signal = options.signal
        ? AbortSignal.any([
            options.signal,
            AbortSignal.timeout(Math.min(4000, remaining)),
          ])
        : AbortSignal.timeout(Math.min(4000, remaining));
      const requestKind =
        url.origin === new URL(BRAVE_SEARCH_URL).origin ? "search" : "page";
      const countKey =
        requestKind === "search" ? "searchRequests" : "pageRequests";
      if (budget[countKey] >= (requestKind === "search" ? 2 : 4))
        throw new Error("WEB_BUDGET_EXHAUSTED");
      budget[countKey]++;
      const response = await transport(url.toString(), {
        method: body ? "POST" : "GET",
        ...(body ? { body } : {}),
        headers,
        redirect: "manual",
        signal,
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (
          retry &&
          attempt === 0 &&
          (response.status === 429 || response.status >= 500)
        )
          continue;
        throw new Error("WEB_RESPONSE_FAILED");
      }
      const type = response.headers.get("content-type") ?? "";
      if (
        !([
          new URL(BRAVE_SEARCH_URL).origin,
          new URL(JINA_READER_URL).origin,
        ].includes(url.origin)
          ? type.includes("application/json")
          : /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(type))
      ) {
        await response.body?.cancel();
        throw new Error("WEB_CONTENT_TYPE");
      }
      return boundedText(response);
    }
    throw new Error("WEB_RESPONSE_FAILED");
  };
  const items: PartnerWebResult["items"] = [];

  for (const item of brief.items) {
    const conditions = publicSearchConditions(item),
      query = partnerWebQuery(conditions);
    if (!query) {
      items.push({
        itemId: item.id,
        status: "incomplete",
        candidates: [],
        reason:
          "外部検索に使える一般的な品名・加工名または型番を確認できません。担当者が品名・型番と依頼範囲を確認してください。",
      });
      continue;
    }
    try {
      const search = new URL(BRAVE_SEARCH_URL);
      search.searchParams.set("q", query);
      search.searchParams.set("count", "5");
      search.searchParams.set("safesearch", "strict");
      search.searchParams.set("country", "JP");
      search.searchParams.set("search_lang", "jp");
      const raw: unknown = JSON.parse(
        await fetchText(
          search,
          { "X-Subscription-Token": cfg.key, Accept: "application/json" },
          true,
        ),
      );
      const web = (raw as { web?: { results?: unknown[] } })?.web;
      if (!web || !Array.isArray(web.results))
        throw new Error("INVALID_WEB_RESULTS");
      const candidates: PartnerWebCandidate[] = [],
        seen = new Set<string>();
      let failed = false,
        skipped = false;
      for (const value of web.results.slice(0, 5)) {
        const result = value as { url?: unknown; title?: unknown };
        if (typeof result.url !== "string") continue;
        const discovery = (() => {
          try {
            return allowedPageUrl(result.url, [
              new URL(result.url).hostname.toLowerCase(),
            ]);
          } catch {
            return null;
          }
        })();
        if (!discovery || seen.has(discovery.toString()) || !conditions.kind)
          continue;
        seen.add(discovery.toString());
        const direct = allowedPageUrl(result.url, cfg.hosts);
        const basic = {
          url: discovery.toString(),
          title:
            typeof result.title === "string"
              ? result.title.replace(/<[^>]*>/g, "").slice(0, 160)
              : discovery.hostname,
          checkedAt: new Date(now()).toISOString(),
          kind: conditions.kind,
        };
        const unverified = (reason: string) =>
          candidates.push({
            ...basic,
            confirmed: [],
            unconfirmed: [
              reason,
              "取扱品・加工内容",
              "材質・寸法・数量・納期",
              "現在の在庫・生産余力",
            ],
            notice: "検索で発見したURLです。本文および受注可否は未確認です。",
          });
        if (!direct && !cfg.reader) {
          unverified("公開ページ本文（本文取得が未設定）");
          continue;
        }
        if (budget.pageRequests >= 4) {
          skipped = true;
          unverified("公開ページ本文（取得件数の上限）");
          continue;
        }
        try {
          let body: string;
          if (direct)
            body = bodyText(
              await fetchText(
                direct,
                { Accept: "text/html, application/xhtml+xml" },
                false,
              ),
            );
          else {
            // Only a public URL returned by this search is sent to the fixed Reader origin.
            const headers: Record<string, string> = {
              Accept: "application/json",
              "Content-Type": "application/json",
            };
            if (cfg.readerKey)
              headers.Authorization = `Bearer ${cfg.readerKey}`;
            const raw: unknown = JSON.parse(
              await fetchText(
                new URL(JINA_READER_URL),
                headers,
                false,
                JSON.stringify({
                  url: discovery.toString(),
                  respondWith: "text",
                  noCache: true,
                }),
              ),
            );
            const data = (
              raw as { data?: { url?: unknown; content?: unknown } }
            )?.data;
            if (
              !data ||
              data.url !== discovery.toString() ||
              typeof data.content !== "string" ||
              data.content.length > MAX_RESPONSE_BYTES
            )
              throw new Error("INVALID_READER_RESPONSE");
            body = data.content;
          }
          const checked = verifyPage(body, conditions);
          if (checked)
            candidates.push({
              ...basic,
              checkedAt: new Date(now()).toISOString(),
              ...checked,
            });
        } catch {
          failed = true;
          unverified("公開ページ本文（取得または検証に失敗）");
        }
      }
      items.push({
        itemId: item.id,
        status: failed || skipped ? "incomplete" : "completed",
        candidates,
      });
    } catch {
      items.push({ itemId: item.id, status: "failed", candidates: [] });
    }
  }
  return {
    status: items.every((i) => i.status === "completed")
      ? "completed"
      : items.every((i) => i.status === "failed")
        ? "failed"
        : "incomplete",
    items,
  };
}
