import { describe, expect, it, vi } from "vitest";
import { newItem, makeSnapshot } from "../../src/domain/intake";
import type { Item } from "../../src/domain/model";
import { searchPartnerMaster } from "../../src/domain/partner-search";
import {
  allowedPageUrl,
  BRAVE_SEARCH_URL,
  JINA_READER_URL,
  runPartnerWebSearch,
  type PartnerWebSettings,
} from "../../src/adapters/partner-web";
const settings: PartnerWebSettings = {
  EXTERNAL_ENABLED: "true",
  PARTNER_WEB_ENABLED: "true",
  PARTNER_WEB_PROVIDER: "brave",
  BRAVE_SEARCH_API_KEY: "fixture-brave-secret",
  PARTNER_WEB_ALLOWED_HOSTS: "fixture-supplier.co.jp",
};
function add(
  i: Item,
  key: string,
  text: string,
  number: number | null = null,
  unit: string | null = null,
) {
  i.fields.push({
    key,
    label: key,
    status: "known",
    value: { text, number, unit },
    source: "customer_text",
    eventId: "secret-input",
    quote: text,
    hardConstraint: true,
  });
}
function fixture(kind = "processing") {
  const i = newItem("秘密顧客のパッキン john@example.org");
  add(i, "request_scope", kind);
  add(i, "process", "旋盤");
  add(i, "material", "SUS304");
  add(i, "overall_length", "全長100mm", 100, "mm");
  add(i, "destination", "秘密住所");
  i.notes = ["秘密議事録"];
  const b = makeSnapshot("private-case-id").brief;
  b.items = [i];
  return b;
}
const internal = (b: ReturnType<typeof fixture>) =>
  searchPartnerMaster(b, {
    status: "ready",
    revision: 1,
    versionId: "v1",
    partners: [],
  });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const search = (urls = ["https://fixture-supplier.co.jp/capability"]) =>
  json({
    web: {
      results: urls.map((url) => ({
        url,
        title: "候補会社の案内",
        description: "検索抜粋は根拠にしない SUS304加工可能",
      })),
    },
  });
const html = (text: string) =>
  new Response(`<html><body>${text}</body></html>`, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
const now = () => Date.parse("2026-11-20T12:00:00Z");
describe("外部協力会社検索の送信制御と本文確認", () => {
  it.each([true, false])(
    "穴径・開口径・穴数を依頼数量と別条件で送り、各軸の根拠を混同しない: %s",
    async (matchingHoles) => {
      const b = fixture();
      add(b.items[0], "hole_diameter", "穴径6mm", 6, "mm");
      add(b.items[0], "opening_diameter", "開口径20mm", 20, "mm");
      add(b.items[0], "hole_count", "4か所", 4, "か所");
      add(b.items[0], "quantity", "10個", 10, "個");
      const transport = vi.fn(async (url: RequestInfo | URL) =>
        String(url).startsWith(BRAVE_SEARCH_URL)
          ? search()
          : html(
              `<p>旋盤加工対応 SUS304 全長100mm 開口径20mm ${matchingHoles ? "穴径6mm 穴数4箇所" : "外径6mm 在庫4個"}</p>`,
            ),
      ) as typeof fetch;
      const result = await runPartnerWebSearch(b, internal(b), settings, {
        transport,
        now,
      });
      const query = new URL(
        String(vi.mocked(transport).mock.calls[0][0]),
      ).searchParams.get("q")!;
      expect(query).toContain("穴径 6mm");
      expect(query).toContain("開口径 20mm");
      expect(query).toContain("穴数 4か所");
      expect(query).toContain("依頼数量 10個");
      const candidate = result.items[0].candidates[0];
      expect(
        candidate.confirmed.some((entry) => entry.field === "opening_diameter"),
      ).toBe(true);
      expect(
        candidate.confirmed.some((entry) => entry.field === "hole_diameter"),
      ).toBe(matchingHoles);
      expect(
        candidate.confirmed.some((entry) => entry.field === "hole_count"),
      ).toBe(matchingHoles);
      if (!matchingHoles)
        expect(candidate.unconfirmed).toEqual(
          expect.arrayContaining(["穴径6mm", "穴数4か所"]),
        );
    },
  );
  it("全品目の社内検索が正常完了し両候補ゼロの場合のみ外部へ送信", async () => {
    const b = fixture(),
      r = internal(b),
      transport = vi.fn();
    r.items[0].status = "failed";
    expect(
      (await runPartnerWebSearch(b, r, settings, { transport })).status,
    ).toBe("blocked");
    expect(transport).not.toHaveBeenCalled();
  });
  it.each([
    { ...settings, EXTERNAL_ENABLED: "false" },
    { ...settings, PARTNER_WEB_ENABLED: "false" },
    { ...settings, BRAVE_SEARCH_API_KEY: "" },
    { ...settings, PARTNER_WEB_PROVIDER: "arbitrary" },
  ])("独立設定の不足は実通信0", async (config) => {
    const b = fixture(),
      transport = vi.fn();
    expect(
      (await runPartnerWebSearch(b, internal(b), config, { transport })).status,
    ).toBe("disabled");
    expect(transport).not.toHaveBeenCalled();
  });
  it("許可条件だけを送り、日本語寸法軸を使い、APIキーをページへ渡さない", async () => {
    const b = fixture();
    const calls: { url: string; init?: RequestInit }[] = [];
    const transport = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return String(url).startsWith(BRAVE_SEARCH_URL)
          ? search()
          : html("<p>旋盤加工対応 SUS304 全長100mm</p>");
      },
    ) as typeof fetch;
    const r = await runPartnerWebSearch(b, internal(b), settings, {
      transport,
      now,
    });
    expect(r.status).toBe("completed");
    const q = new URL(calls[0].url).searchParams.get("q")!;
    expect(q).toContain("全長 100mm");
    expect(q).not.toContain("overall_length");
    expect(q).not.toContain("秘密");
    expect(q).not.toContain("john");
    expect(calls[0].init?.headers).toEqual({
      "X-Subscription-Token": "fixture-brave-secret",
      Accept: "application/json",
    });
    expect(JSON.stringify(calls[1])).not.toContain("fixture-brave-secret");
    expect(r.items[0].candidates[0].confirmed.map((c) => c.field)).toContain(
      "overall_length",
    );
    expect(r.items[0].candidates[0].checkedAt).toBe("2026-11-20T12:00:00.000Z");
    expect(r.items[0].candidates[0].unconfirmed).toContain("希望納期の確約");
  });
  it.each([
    "http://fixture-supplier.co.jp/",
    "https://127.0.0.1/",
    "https://[::1]/",
    "https://169.254.169.254/",
    "https://localhost/",
    "https://secret.internal/",
    "https://fixture-supplier.co.jp.evil.org/",
    "https://user:pass@fixture-supplier.co.jp/",
    "https://fixture-supplier.co.jp:444/",
    "https://fixture-supplier.co.jp/?token=secret",
    "https://fixture-supplier.co.jp/#private",
  ])("不正URL %s は取得禁止", (url) => {
    expect(allowedPageUrl(url, ["fixture-supplier.co.jp"])).toBeNull();
  });
  it("未知の公開会社は本文未取得としてURLを残し任意ホストを直接fetchしない", async () => {
    const b = fixture(),
      transport = vi.fn(async () =>
        search(["https://new-supplier.co.jp/products"]),
      );
    const r = await runPartnerWebSearch(
      b,
      internal(b),
      { ...settings, PARTNER_WEB_ALLOWED_HOSTS: "" },
      { transport, now },
    );
    expect(transport).toHaveBeenCalledTimes(1);
    expect(r.items[0].candidates[0].confirmed).toEqual([]);
    expect(r.items[0].candidates[0].url).toBe(
      "https://new-supplier.co.jp/products",
    );
    expect(r.items[0].candidates[0].unconfirmed.join()).toContain("未設定");
  });
  it("明示設定で未知会社を固定Reader経由で本文確認し送信は検索URLだけ", async () => {
    const b = fixture();
    const calls: { url: string; init?: RequestInit }[] = [];
    const transport = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return String(url).startsWith(BRAVE_SEARCH_URL)
          ? search(["https://new-supplier.co.jp/products"])
          : json({
              data: {
                url: "https://new-supplier.co.jp/products",
                content: "旋盤加工対応 SUS304 全長100mm",
              },
            });
      },
    ) as typeof fetch;
    const r = await runPartnerWebSearch(
      b,
      internal(b),
      {
        ...settings,
        PARTNER_WEB_ALLOWED_HOSTS: "",
        PARTNER_WEB_READER: "jina",
        JINA_API_KEY: "fixture-reader-key",
      },
      { transport, now },
    );
    expect(calls.map((c) => new URL(c.url).origin)).toEqual([
      new URL(BRAVE_SEARCH_URL).origin,
      new URL(JINA_READER_URL).origin,
    ]);
    expect(JSON.parse(calls[1].init!.body as string)).toEqual({
      url: "https://new-supplier.co.jp/products",
      respondWith: "text",
      noCache: true,
    });
    expect(calls[1].init?.method).toBe("POST");
    expect(JSON.stringify(calls[1])).not.toContain("fixture-brave-secret");
    expect(JSON.stringify(calls[1])).not.toContain("秘密");
    expect(
      r.items[0].candidates[0].confirmed.some((c) => c.field === "material"),
    ).toBe(true);
  });
  it("Readerが別URLの本文を返した場合は根拠化しない", async () => {
    const b = fixture(),
      transport = vi.fn(async (url: RequestInfo | URL) =>
        String(url).startsWith(BRAVE_SEARCH_URL)
          ? search(["https://new-supplier.co.jp/products"])
          : json({
              data: {
                url: "https://other.co.jp/",
                content: "旋盤加工対応 SUS304 全長100mm",
              },
            }),
      ) as typeof fetch;
    const r = await runPartnerWebSearch(
      b,
      internal(b),
      {
        ...settings,
        PARTNER_WEB_READER: "jina",
        PARTNER_WEB_ALLOWED_HOSTS: "",
      },
      { transport },
    );
    expect(r.items[0].candidates[0].confirmed).toEqual([]);
    expect(r.status).toBe("incomplete");
  });
  it.each([
    "<p>旋盤加工 SUS304不可</p>",
    "<script>旋盤加工対応 SUS304</script>",
    "<p>旋盤加工は対応していません SUS304</p>",
  ])("否定・scriptを肯定条件にしない", async (body) => {
    const b = fixture(),
      transport = vi.fn(async (url: RequestInfo | URL) =>
        String(url).startsWith(BRAVE_SEARCH_URL) ? search() : html(body),
      ) as typeof fetch;
    const r = await runPartnerWebSearch(b, internal(b), settings, {
      transport,
    });
    expect(r.items[0].candidates).toEqual([]);
  });
  it("別設備の材質と寸法を転用しない", async () => {
    const b = fixture(),
      transport = vi.fn(async (url: RequestInfo | URL) =>
        String(url).startsWith(BRAVE_SEARCH_URL)
          ? search()
          : html(
              "<p>旋盤加工対応 アルミ</p><p>フライス加工対応 SUS304 全長100mm</p>",
            ),
      ) as typeof fetch;
    const r = await runPartnerWebSearch(b, internal(b), settings, {
      transport,
    });
    expect(
      r.items[0].candidates[0].confirmed.map((c) => c.field),
    ).not.toContain("material");
    expect(
      r.items[0].candidates[0].confirmed.map((c) => c.field),
    ).not.toContain("overall_length");
  });
  it("購入は指定型番と同じ商品ブロックにある在庫・出荷目安だけページ表記として示す", async () => {
    const b = fixture("purchase");
    add(b.items[0], "model", "PK-100");
    const transport = vi.fn(async (url: RequestInfo | URL) =>
      String(url).startsWith(BRAVE_SEARCH_URL)
        ? search()
        : html(
            "<p>パッキン PK-100 販売 在庫あり 出荷目安：2営業日</p><p>パッキン PK-200 販売 在庫なし</p>",
          ),
    ) as typeof fetch;
    const r = await runPartnerWebSearch(b, internal(b), settings, {
      transport,
      now,
    });
    const c = r.items[0].candidates[0];
    expect(
      c.confirmed.find((e) => e.field === "page_stock_information")?.condition,
    ).toBe("ページ記載：在庫あり");
    expect(
      c.confirmed.find((e) => e.field === "page_shipping_information")
        ?.condition,
    ).toContain("2営業日");
    expect(c.notice).toContain("保証ではありません");
  });
  it("型番不一致の購入ページを根拠化しない", async () => {
    const b = fixture("purchase");
    add(b.items[0], "model", "PK-100");
    const transport = vi.fn(async (url: RequestInfo | URL) =>
      String(url).startsWith(BRAVE_SEARCH_URL)
        ? search()
        : html("<p>パッキン PK-1000 販売 在庫あり</p>"),
    ) as typeof fetch;
    const r = await runPartnerWebSearch(b, internal(b), settings, {
      transport,
    });
    expect(r.items[0].candidates).toEqual([]);
  });
  it("3品目でも検索は試行含め2回、本文は4件で制限", async () => {
    const b = fixture();
    b.items.push(
      { ...structuredClone(b.items[0]), id: "i2" },
      { ...structuredClone(b.items[0]), id: "i3" },
    );
    const transport = vi.fn(async (url: RequestInfo | URL) =>
      String(url).startsWith(BRAVE_SEARCH_URL)
        ? search([
            "https://fixture-supplier.co.jp/a",
            "https://fixture-supplier.co.jp/b",
            "https://fixture-supplier.co.jp/c",
          ])
        : html("<p>旋盤加工対応 SUS304</p>"),
    ) as typeof fetch;
    const budget = { searchRequests: 0, pageRequests: 0 };
    const r = await runPartnerWebSearch(b, internal(b), settings, {
      transport,
      budget,
    });
    expect(budget).toEqual({ searchRequests: 2, pageRequests: 4 });
    expect(transport).toHaveBeenCalledTimes(6);
    expect(r.items[2].status).toBe("failed");
    expect(r.status).toBe("incomplete");
  });
  it("429の再試行も検索2回枠に含める", async () => {
    const b = fixture();
    b.items.push({ ...structuredClone(b.items[0]), id: "i2" });
    let count = 0;
    const transport = vi.fn(async (url: RequestInfo | URL) =>
      String(url).startsWith(BRAVE_SEARCH_URL)
        ? ++count === 1
          ? json({}, 429)
          : search([])
        : html(""),
    ) as typeof fetch;
    const budget = { searchRequests: 0, pageRequests: 0 };
    await runPartnerWebSearch(b, internal(b), settings, { transport, budget });
    expect(count).toBe(2);
    expect(budget.searchRequests).toBe(2);
  });
  it("リダイレクトを追跡せず未確認として保持", async () => {
    const b = fixture(),
      calls: string[] = [];
    const transport = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push(String(url));
        expect(init?.redirect).toBe("manual");
        return String(url).startsWith(BRAVE_SEARCH_URL)
          ? search()
          : new Response(null, {
              status: 302,
              headers: { Location: "http://127.0.0.1/private" },
            });
      },
    ) as typeof fetch;
    const r = await runPartnerWebSearch(b, internal(b), settings, {
      transport,
    });
    expect(calls).toHaveLength(2);
    expect(r.items[0].candidates[0].confirmed).toEqual([]);
  });
  it.each([
    "バルブ",
    "ベアリング",
    "工具",
    "ノズル",
    "継手",
    "ホース",
    "耐火材",
    "断熱材",
    "金網",
    "測定器",
  ])("未登録の一般商品%sを顧客情報なしで検索する", async (name) => {
    const b = fixture("purchase");
    b.items[0].label = `秘密社の${name}を購入したい`;
    b.items[0].fields = b.items[0].fields.filter(
      (f) => !["process", "material", "overall_length"].includes(f.key),
    );
    const transport = vi.fn(async (url: RequestInfo | URL) => {
      const query = new URL(String(url)).searchParams.get("q")!;
      expect(query).toContain(name);
      expect(query).not.toContain("秘密");
      expect(query).not.toContain("住所");
      return search([]);
    }) as typeof fetch;
    expect(
      (await runPartnerWebSearch(b, internal(b), settings, { transport }))
        .status,
    ).toBe("completed");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each(["研磨", "放電加工", "レーザー加工", "ワイヤーカット"])(
    "通常加工%sを安全な一般語で検索する",
    async (name) => {
      const b = fixture();
      b.items[0].label = "秘密社の特殊対象";
      b.items[0].fields.find((f) => f.key === "process")!.value!.text = name;
      const transport = vi.fn(async (url: RequestInfo | URL) => {
        const query = new URL(String(url)).searchParams.get("q")!;
        expect(query).toContain(name);
        expect(query).not.toContain("秘密");
        return search([]);
      }) as typeof fetch;
      await runPartnerWebSearch(b, internal(b), settings, { transport });
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );
  it("安全な検索語を生成できない品名は日本語の担当確認理由を返して送信0", async () => {
    const b = fixture("purchase");
    b.items[0].label = "秘密社専用の未知品";
    b.items[0].fields = b.items[0].fields.filter(
      (f) => f.key === "request_scope",
    );
    const transport = vi.fn();
    const r = await runPartnerWebSearch(b, internal(b), settings, {
      transport,
    });
    expect(transport).not.toHaveBeenCalled();
    expect(r.items[0].status).toBe("incomplete");
    expect(r.items[0].reason).toContain("担当者が品名・型番");
  });
  it("商品IDクエリを保持して追跡クエリだけ除去し通販ページを取得できる", async () => {
    const b = fixture("purchase"),
      urls: string[] = [];
    const transport = vi.fn(async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return String(url).startsWith(BRAVE_SEARCH_URL)
        ? search([
            "https://fixture-supplier.co.jp/goods?id=123&utm_source=mail&gclid=tracking",
          ])
        : html("<p>パッキン販売 在庫あり</p>");
    }) as typeof fetch;
    const r = await runPartnerWebSearch(b, internal(b), settings, {
      transport,
    });
    expect(urls[1]).toBe("https://fixture-supplier.co.jp/goods?id=123");
    expect(r.items[0].candidates[0].url).toBe(urls[1]);
  });
  it.each(["外径300mm未満", "外径300mm超", "外径300mmを超える"])(
    "境界外の記述%sを一致寸法と表示しない",
    async (limit) => {
      const b = fixture();
      add(b.items[0], "outer_diameter", "外径300mm", 300, "mm");
      const transport = vi.fn(async (url: RequestInfo | URL) =>
        String(url).startsWith(BRAVE_SEARCH_URL)
          ? search()
          : html(`<p>旋盤加工対応 SUS304 ${limit}</p>`),
      ) as typeof fetch;
      const r = await runPartnerWebSearch(b, internal(b), settings, {
        transport,
      });
      expect(
        r.items[0].candidates[0].confirmed.some(
          (c) => c.field === "outer_diameter",
        ),
      ).toBe(false);
    },
  );
  it("SUS304LをSUS304の根拠にしない", async () => {
    const b = fixture();
    const transport = vi.fn(async (url: RequestInfo | URL) =>
      String(url).startsWith(BRAVE_SEARCH_URL)
        ? search()
        : html("<p>旋盤加工対応 SUS304L</p>"),
    ) as typeof fetch;
    const r = await runPartnerWebSearch(b, internal(b), settings, {
      transport,
    });
    expect(
      r.items[0].candidates[0].confirmed.some((c) => c.condition === "SUS304"),
    ).toBe(false);
  });
  it("SUS304を除くという記述を肯定根拠にしない", async () => {
    const b = fixture();
    const transport = vi.fn(async (url: RequestInfo | URL) =>
      String(url).startsWith(BRAVE_SEARCH_URL)
        ? search()
        : html("<p>旋盤加工対応 SUS304を除く</p>"),
    ) as typeof fetch;
    const r = await runPartnerWebSearch(b, internal(b), settings, {
      transport,
    });
    expect(r.items[0].candidates).toEqual([]);
  });
  it("締切を過ぎた実行は外部送信0", async () => {
    const b = fixture(),
      transport = vi.fn();
    const r = await runPartnerWebSearch(b, internal(b), settings, {
      transport,
      now,
      deadline: now() - 1,
    });
    expect(transport).not.toHaveBeenCalled();
    expect(r.status).toBe("failed");
  });
});
