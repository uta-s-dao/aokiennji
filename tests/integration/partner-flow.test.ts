import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { migrate } from "../helpers/migrate";
import { runJob } from "../../src/research-worker";
import { stmt, type Env } from "../../src/adapters/store";
import type { PartnerRecord } from "../../src/domain/partner-search";
import type { Item, Question, PublicResult } from "../../src/domain/model";
import type { PartnerReport } from "../../src/adapters/partner-research";
import type { ResearchFollowupOffer } from "../../src/domain/research-followup";

let mf: Miniflare, db: D1Database, env: Env;
let sequence = 0;
const origin = "http://127.0.0.1";
const publicHost = "public-machining.jp";
const privateHost = "private-machining.jp";
const publicUrl = `https://${publicHost}/services`;
const privateUrl = `https://${privateHost}/services`;
const basePartners = (): PartnerRecord[] => [
  {
    id: "private-partner-001",
    name: "非公開取引先名",
    normalizedName: "非公開取引先名",
    website: "https://internal-partner.jp/",
    capabilityState: "documented",
    sourceRefs: [
      { fileName: "秘密の取引先.xlsx", sheet: "非公開管理", row: 27 },
    ],
    groups: [
      {
        id: "purchase-gasket",
        kind: "purchase",
        products: ["パッキン"],
        evidence: ["取扱商品 パッキン"],
      },
      {
        id: "turning",
        kind: "processing",
        processes: ["旋盤"],
        materials: ["SUS304"],
        dimensions: {
          outer_diameter: { max: 100, unit: "mm" },
          overall_length: { max: 500, unit: "mm" },
        },
        quantity: { max: 10, unit: "個" },
        evidence: ["旋盤 SUS304 外径100mm 全長500mm 数量10個"],
      },
    ],
  },
];
async function master(partners = basePartners()) {
  const version = `test-master-${++sequence}`;
  await db
    .prepare(
      "INSERT INTO partner_master_versions VALUES(?,'ready',?,'offline','{}','{}',?)",
    )
    .bind(
      version,
      Date.now(),
      JSON.stringify({ counts: { partners: partners.length } }),
    )
    .run();
  for (const partner of partners)
    await db
      .prepare("INSERT INTO partner_master_rows VALUES(?,?,?,?)")
      .bind(
        version,
        partner.id,
        partner.normalizedName,
        JSON.stringify(partner),
      )
      .run();
  await db
    .prepare(
      "UPDATE partner_master_state SET current_version_id=?,revision=revision+1,last_import_status='ready',last_error=NULL WHERE id=1",
    )
    .bind(version)
    .run();
}
type Body = {
  caseId: string;
  revision: number;
  question: Question | null;
  jobId: string | null;
  items: Item[];
  result: PublicResult;
  partnerReport: PartnerReport | null;
  body: string;
  status: number;
  phase: string;
  canResearch: boolean;
  job: { id: string; status: string } | null;
  followup:
    | (Omit<ResearchFollowupOffer, "searchFingerprint"> & { jobId: string })
    | null;
};
async function client() {
  const session = await mf.dispatchFetch(origin + "/api/v2/session");
  const csrf = ((await session.json()) as { csrf: string }).csrf;
  const cookie = session.headers.get("Set-Cookie")!.split(";")[0];
  return async (
    path: string,
    method = "GET",
    body?: unknown,
    adminToken?: string,
  ) => {
    const response = await mf.dispatchFetch(origin + "/api/v2" + path, {
      method,
      headers: {
        Cookie: cookie,
        Origin: origin,
        "X-CSRF-Token": csrf,
        "Content-Type": "application/json",
        "Idempotency-Key": `partner-flow-${++sequence}`,
        ...(adminToken ? { "X-Local-Admin-Token": adminToken } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { ...((await response.json()) as Body), status: response.status };
  };
}
type Client = Awaited<ReturnType<typeof client>>;
async function start(text: string) {
  const call = await client();
  const created = await call("/cases", "POST", {});
  expect(created.status).toBe(201);
  const intake = await call(`/cases/${created.caseId}/answers`, "POST", {
    mutationId: `initial-${++sequence}`,
    expectedRevision: 0,
    questionId: "initial",
    answer: { type: "text", text },
  });
  expect(intake.status).toBe(200);
  return { call, cid: created.caseId, intake };
}
async function answer(
  call: Client,
  cid: string,
  current: Body,
  value:
    | { type: "text"; text: string }
    | { type: "unknown" | "skip" }
    | { type: "option"; optionId: string },
) {
  expect(current.question).not.toBeNull();
  const response = await call(`/cases/${cid}/answers`, "POST", {
    mutationId: `answer-${++sequence}`,
    expectedRevision: current.revision,
    questionId: current.question!.id,
    answer: value,
  });
  expect(response.status).toBe(200);
  return response;
}
async function jobCount(cid: string) {
  return (await stmt(
    env,
    "SELECT COUNT(*) n FROM research_jobs WHERE case_id=?",
    cid,
  ).first<{ n: number }>())!.n;
}
async function research(call: Client, cid: string, revision: number) {
  const response = await call(`/cases/${cid}/research`, "POST", {
    mutationId: `research-${++sequence}`,
    expectedRevision: revision,
  });
  expect(response.status).toBe(200);
  expect(response.jobId).toBeTruthy();
  await runJob(env, response.jobId!);
  const staff = await call(
    `/admin/cases/${cid}`,
    "GET",
    undefined,
    "test-admin",
  );
  expect(staff.status).toBe(200);

  return { response, staff };
}
beforeAll(async () => {
  const bindings = {
    APP_MODE: "local-demo",
    LOCAL_ADMIN_TOKEN: "test-admin",
    INTAKE_PROVIDER: "demo",
    EXTERNAL_ENABLED: "true",
    PARTNER_WEB_ENABLED: "true",
    PARTNER_WEB_PROVIDER: "brave",
    BRAVE_SEARCH_API_KEY: "offline-only",
    PARTNER_WEB_ALLOWED_HOSTS: `${publicHost},${privateHost}`,
    PARTNER_WEB_PUBLIC_HOSTS: publicHost,
  };
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: "dist/worker/worker.js",
      compatibilityDate: "2026-11-16",
      bindings,
      d1Databases: { DB: "partner-flow" },
      r2Buckets: ["FILES"],
      queueProducers: { RESEARCH_QUEUE: "research" },
      outboundService: async () => {
        throw new Error("UNEXPECTED_EXTERNAL_REQUEST");
      },
    }),
  );
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  await migrate(db);
  env = {
    ...bindings,
    DB: db,
    FILES: await mf.getR2Bucket("FILES"),
    RESEARCH_QUEUE: await mf.getQueueProducer("RESEARCH_QUEUE"),
  } as unknown as Env;
});
beforeEach(async () => {
  await master();
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("UNEXPECTED_EXTERNAL_REQUEST");
  });
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await mf?.dispose();
});

it("通常HTTPからパッキン購入を照合し、担当者にはmatchを返し顧客には内部資料を漏らさない", async () => {
  const { call, cid, intake } = await start("パッキンを購入したい");
  const { staff, response } = await research(call, cid, intake.revision);
  expect(staff.partnerReport?.master.status).toBe("completed");
  expect(staff.partnerReport?.master.items[0].match[0].partnerName).toBe(
    "非公開取引先名",
  );
  expect(staff.partnerReport?.webStatus).toBe("not_needed");
  expect(fetch).not.toHaveBeenCalled();
  const current = await call(`/cases/${cid}`);
  const mail = await call(`/cases/${cid}/mail-draft`, "POST", {});
  for (const forbidden of [
    "非公開取引先名",
    "private-partner-001",
    "秘密の取引先.xlsx",
    "非公開管理",
    "internal-partner.jp",
  ])
    expect(JSON.stringify([current, mail])).not.toContain(forbidden);
  await runJob(env, response.jobId!);
  expect(
    (
      await stmt(
        env,
        "SELECT COUNT(*) n FROM partner_reports WHERE job_id=?",
        response.jobId,
      ).first<{ n: number }>()
    )?.n,
  ).toBe(1);
});
it("製作の注文にも取扱品から調達候補を返し、行の根拠を担当者に示してWeb検索を止める", async () => {
  const [supplier] = basePartners();
  supplier.groups = [{
    id: "material-sales",
    kind: "purchase",
    products: ["ステンレス製品"],
    evidence: ["取扱い品：ステンレス製品"],
  }];
  await master([supplier]);
  const { call, cid, intake } = await start(
    "部品を製作したい。材質はSUS304、外径50mm、数量は3個です",
  );
  const { staff } = await research(call, cid, intake.revision);
  const report = staff.partnerReport!;
  expect(report.master.items).toHaveLength(1);
  const [item] = report.master.items;
  expect(item.match).toHaveLength(0);
  expect(item.review).toHaveLength(1);
  expect(item.review[0]).toMatchObject({
    sourcingBasis: "material",
    partnerName: supplier.name,
    sourceRefs: supplier.sourceRefs,
    assessments: expect.arrayContaining([
      expect.objectContaining({ field: "outer_diameter", status: "unconfirmed" }),
      expect.objectContaining({ field: "request_scope", status: "unconfirmed" }),
    ]),
  });
  expect(report.master.webAllowed).toBe(false);
  expect(report.webStatus).toBe("not_needed");
  expect(fetch).not.toHaveBeenCalled();
  const customer = await call(`/cases/${cid}`);
  expect(customer.result.status).toBe("completed");
  expect(customer.result.verdict).toBe("needs_review");
  expect(JSON.stringify(customer)).not.toContain(supplier.name);
  expect(JSON.stringify(customer)).not.toContain(supplier.sourceRefs[0].fileName);
});
it("購入の品名だけでは開始せず、型番・数量・希望日未定まで同一品目を聞き取る", async () => {
  const { call, cid, intake } = await start("パッキンを購入したい");
  expect(intake).toMatchObject({ jobId: null, canResearch: true });
  expect(intake.question?.fieldKey).toBe("model");
  expect(await jobCount(cid)).toBe(0);
  const original = (await call(`/cases/${cid}`)).items[0];

  const modeled = await answer(call, cid, intake, {
    type: "text",
    text: "型番はPK-100です",
  });
  expect(modeled.jobId).toBeNull();
  expect(modeled.question?.fieldKey).toBe("quantity");
  const quantified = await answer(call, cid, modeled, {
    type: "text",
    text: "5個です",
  });
  expect(quantified.jobId).toBeNull();
  expect(quantified.question?.fieldKey).toBe("required_date");
  const ready = await answer(call, cid, quantified, { type: "unknown" });
  expect(ready.question).toBeNull();
  expect(ready.jobId).toBeTruthy();
  expect(await jobCount(cid)).toBe(1);
  const current = await call(`/cases/${cid}`);
  expect(current.items).toHaveLength(1);
  expect(current.items[0]).toMatchObject({
    id: original.id,
    label: "パッキン",
  });
  expect(current.items[0].fields).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        key: "model",
        status: "known",
        value: expect.objectContaining({ text: "PK-100" }),
      }),
      expect.objectContaining({
        key: "quantity",
        value: expect.objectContaining({ number: 5, unit: "個" }),
      }),
      expect.objectContaining({ key: "required_date", status: "unknown" }),
    ]),
  );
});
it("手動調査は残る不足を保持して開始し、完了後に通常の聞き取りを再開しない", async () => {
  const { call, cid, intake } = await start("パッキンを購入したい");
  expect(intake.jobId).toBeNull();
  expect(intake.question).not.toBeNull();
  const { response } = await research(call, cid, intake.revision);
  expect(await jobCount(cid)).toBe(1);
  const current = await call(`/cases/${cid}`);
  expect(current.phase).toBe("completed");
  expect(current.question).toBeNull();
  expect(
    current.items[0].fields.find((f) => f.key === "model")?.status,
  ).not.toBe("known");
  expect(
    current.items[0].fields.find((f) => f.key === "quantity")?.status,
  ).not.toBe("known");
  await runJob(env, response.jobId!);
  expect(await jobCount(cid)).toBe(1);
});
it("断熱ブランケットの明記寸法だけを飛ばし、不明な長さを照会担当へ引き継ぐ", async () => {
  const [supplier] = basePartners();
  supplier.groups = [{
    id: "insulation",
    kind: "purchase",
    products: ["断熱材等"],
    evidence: ["取扱い品：断熱材等"],
  }];
  await master([supplier]);
  const { call, cid, intake } = await start("断熱ブランケットを購入したい");
  let current = intake;
  const visited = new Set<string>();
  for (let i = 0; current.question && i < 12; i++) {
    const key = current.question.fieldKey;
    expect(visited.has(key)).toBe(false);
    visited.add(key);
    current = await answer(call, cid, current, key === "thickness"
      ? { type: "text", text: "厚さ20mm、幅500mmです。" }
      : { type: "unknown" });
  }
  expect([...visited]).toContain("thickness");
  expect([...visited]).toContain("overall_length");
  expect([...visited]).not.toContain("width");
  expect(current.jobId).toBeTruthy();
  await runJob(env, current.jobId!);
  const staff = await call(`/admin/cases/${cid}`, "GET", undefined, "test-admin");
  const report = staff.partnerReport!;
  expect(report.master.items[0].match).toHaveLength(0);
  expect(report.master.items[0].review).toHaveLength(1);
  expect(report.master.items[0].review[0]).toMatchObject({
    partnerName: supplier.name, sourceRefs: supplier.sourceRefs,
  });
  expect(report.webStatus).toBe("not_needed");
  expect(report.followup?.staffTasks).toContainEqual(expect.objectContaining({
    fieldKey: "overall_length", customerFieldStatus: "unknown",
  }));
  expect(report.followup?.offer?.fieldKey).not.toBe("overall_length");
  const customer = await call(`/cases/${cid}`);
  expect(customer.result.items[0].missingFields).not.toContain("overall_length");
  expect(customer.items[0].fields).toEqual(expect.arrayContaining([
    expect.objectContaining({ key: "width", value: { number: 500, unit: "mm", text: "500mm" } }),
    expect.objectContaining({ key: "overall_length", status: "unknown" }),
  ]));
  expect(JSON.stringify(customer)).not.toContain(supplier.name);
  expect(fetch).not.toHaveBeenCalled();
});
it("寸法を聞く前の手動調査では、未確認の厚さ・幅・長さを表示し、元行は社内に限る", async () => {
  const [supplier] = basePartners();
  supplier.groups = [{
    id: "insulation", kind: "purchase", products: ["断熱材等"], evidence: ["取扱い品：断熱材等"],
  }];
  await master([supplier]);
  const { call, cid, intake } = await start("断熱ブランケットを購入したい");
  const { staff } = await research(call, cid, intake.revision);
  const details = staff.partnerReport!;
  expect(details.master.items[0].review).toHaveLength(1);
  const customer = await call(`/cases/${cid}`);
  expect(customer.result.items[0].missingFields).toEqual(
    expect.arrayContaining(["thickness", "width", "overall_length"]),
  );
  expect(details.followup?.staffTasks.filter((task) => task.customerFieldStatus === "not_asked")
    .map((task) => task.fieldKey)).toEqual(["thickness", "width", "overall_length"]);
  expect(JSON.stringify(customer)).not.toContain(supplier.sourceRefs[0].fileName);
  expect(fetch).not.toHaveBeenCalled();
});
it("加工の複数条件回答を同一品目へ保存し、聞き取り後の数量訂正を照合へ渡す", async () => {
  const { call, cid, intake } = await start(
    "SUS304の丸棒を旋盤加工してほしい。300mm、5個です",
  );
  expect(intake.question?.fieldKey).toBe("dimension_unspecified");
  expect(intake.jobId).toBeNull();
  const assigned = await answer(call, cid, intake, {
    type: "text",
    text: "全長です。外径は40mmです",
  });
  expect(assigned.jobId).toBeNull();
  const snapshot = await call(`/cases/${cid}`);
  const item = snapshot.items[0];
  expect(snapshot.items).toHaveLength(1);
  expect(item.fields).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        key: "overall_length",
        value: { text: "300mm", number: 300, unit: "mm" },
      }),
      expect.objectContaining({
        key: "outer_diameter",
        value: { text: "40mm", number: 40, unit: "mm" },
      }),
    ]),
  );
  expect(item.fields.some((f) => f.key === "dimension_unspecified")).toBe(
    false,
  );
  // Settle each remaining intake field deliberately; quantity already supplied must not repeat.
  let ready = assigned;
  const asked: string[] = [];
  for (let i = 0; ready.question && i < 10; i++) {
    asked.push(ready.question.fieldKey);
    expect(ready.question.fieldKey).not.toBe("quantity");
    ready = await answer(call, cid, ready, { type: "unknown" });
  }
  expect(asked).toContain("required_date");
  expect(ready.question).toBeNull();
  expect(ready.jobId).toBeTruthy();
  await runJob(env, ready.jobId!);
  const current = await call(`/cases/${cid}`);
  const corrected = await call(`/cases/${cid}/answers`, "POST", {
    mutationId: `correct-${++sequence}`,
    expectedRevision: current.revision,
    questionId: current.question?.id ?? "initial",
    answer: { type: "text", text: "数量を8個に訂正" },
  });
  expect(corrected.status).toBe(200);
  const { staff } = await research(call, cid, corrected.revision);
  const candidate = staff.partnerReport!.master.items[0].match[0];
  expect(candidate.itemId).toBe(item.id);
  expect(candidate.assessments).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ field: "overall_length", status: "confirmed" }),
      expect.objectContaining({ field: "outer_diameter", status: "confirmed" }),
      expect.objectContaining({
        field: "quantity",
        status: "confirmed",
        reason: expect.stringContaining("8個"),
      }),
    ]),
  );
});
it("品目を指定した訂正は他品目の数量を書き換えない", async () => {
  const { call, cid, intake } = await start(
    "パッキンを購入したい。数量は5個です。\nステンレス板を購入したい。数量は2枚です。",
  );
  const before = await call(`/cases/${cid}`);
  expect(before.items).toHaveLength(2);
  const gasket = before.items.find((i) => i.label === "パッキン")!;
  const plate = before.items.find((i) => i.label === "ステンレス板")!;
  const corrected = await call(`/cases/${cid}/answers`, "POST", {
    mutationId: `correct-${++sequence}`,
    expectedRevision: intake.revision,
    questionId: intake.question!.id,
    answer: { type: "text", text: "パッキンの数量を8個に訂正" },
  });
  expect(corrected.status).toBe(200);
  expect(corrected.jobId).toBeNull();
  const after = await call(`/cases/${cid}`);
  expect(after.items).toHaveLength(2);
  expect(
    after.items
      .find((i) => i.id === gasket.id)
      ?.fields.find((f) => f.key === "quantity")?.value?.number,
  ).toBe(8);
  expect(
    after.items
      .find((i) => i.id === plate.id)
      ?.fields.find((f) => f.key === "quantity")?.value?.number,
  ).toBe(2);
  expect(await jobCount(cid)).toBe(0);
});
it("未確定寸法のreviewを保持し、正常ゼロ扱いでWebへ進まない", async () => {
  const { call, cid, intake } = await start("SUS304を旋盤加工、300mm、5個");
  const { staff } = await research(call, cid, intake.revision);
  expect(staff.partnerReport?.master.items[0].review).toHaveLength(1);
  expect(staff.partnerReport?.master.webAllowed).toBe(false);
  expect(staff.partnerReport?.webStatus).toBe("not_needed");
  expect(fetch).not.toHaveBeenCalled();
});
it("複数品目の一方に候補があれば、他方が正常ゼロでもWebへ進まない", async () => {
  const { call, cid, intake } = await start(
    "パッキンを購入したい\nステンレス板を購入したい",
  );
  const { staff } = await research(call, cid, intake.revision);
  expect(staff.partnerReport?.master.items).toHaveLength(2);
  expect(staff.partnerReport?.master.items[0].match).toHaveLength(1);
  expect(staff.partnerReport?.master.items[1].match).toHaveLength(0);
  expect(staff.partnerReport?.master.webAllowed).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});
it.each(["empty", "failed", "broken-json"])(
  "マスタ%sは未完了として扱いWeb検索を実行しない",
  async (mode) => {
    if (mode === "empty")
      await db
        .prepare(
          "UPDATE partner_master_state SET current_version_id=NULL,last_import_status='empty',revision=0 WHERE id=1",
        )
        .run();
    if (mode === "failed")
      await db
        .prepare(
          "UPDATE partner_master_state SET last_import_status='failed' WHERE id=1",
        )
        .run();
    if (mode === "broken-json")
      await db
        .prepare(
          "UPDATE partner_master_rows SET json='not-json' WHERE version_id=(SELECT current_version_id FROM partner_master_state WHERE id=1)",
        )
        .run();
    const { call, cid, intake } = await start("パッキンを購入したい");
    const { staff } = await research(call, cid, intake.revision);
    expect(staff.partnerReport?.master.status).toBe("unavailable");
    expect(staff.partnerReport?.webStatus).toBe("not_needed");
    expect(fetch).not.toHaveBeenCalled();
  },
);
it("候補ゼロでWebが未設定なら、顧客にも完了した照合と未実施のWeb検索を説明する", async () => {
  const { call, cid, intake } = await start("ステンレス板を購入したい");
  const job = await call(`/cases/${cid}/research`, "POST", {
    mutationId: `offline-web-${++sequence}`,
    expectedRevision: intake.revision,
  });
  expect(job.jobId).toBeTruthy();
  await runJob({ ...env, PARTNER_WEB_ENABLED: "false" }, job.jobId!);
  const current = await call(`/cases/${cid}`);
  expect(current.result.status).toBe("partial");
  expect(current.result.items[0].reason).toContain("登録資料との照合は完了");
  expect(current.result.items[0].reason).toContain("公開サイトの検索は現在利用できない");
  expect(fetch).not.toHaveBeenCalled();
});
it("全品目が正常ゼロのときだけmock公開ページを読み、公開許可URLを結果・メールへ渡す", async () => {
  vi.mocked(fetch).mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "api.search.brave.com")
      return new Response(
        JSON.stringify({
          web: {
            results: [
              { url: publicUrl, title: "板の販売" },
              { url: privateUrl, title: "非公開にした本文" },
            ],
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    if ([publicHost, privateHost].includes(url.hostname))
      return new Response(
        "<body>ステンレス 板を販売しています。一般向け取扱商品です。</body>",
        { headers: { "Content-Type": "text/html" } },
      );
    throw new Error("UNEXPECTED_EXTERNAL_REQUEST");
  });
  const { call, cid, intake } = await start(
    "ステンレス板を購入したい。配送先は秘密工場です。",
  );
  const { staff, response } = await research(call, cid, intake.revision);
  expect(staff.partnerReport?.master.webAllowed).toBe(true);
  expect(staff.partnerReport?.webStatus).toBe("completed");
  expect(staff.partnerReport?.pages).toHaveLength(2);
  expect(
    vi
      .mocked(fetch)
      .mock.calls.map(([url]) => String(url))
      .join(" "),
  ).not.toContain(encodeURIComponent("秘密工場"));
  const current = await call(`/cases/${cid}`);
  expect(current.result.items[0].webFindings?.map((p) => p.url)).toEqual([
    publicUrl,
  ]);
  const mail = await call(`/cases/${cid}/mail-draft`, "POST", {});
  expect(mail.body).toContain(publicUrl);
  expect(JSON.stringify([current, mail])).not.toContain(privateHost);
  expect(JSON.stringify([current, mail])).not.toContain("非公開取引先名");
  const count = vi.mocked(fetch).mock.calls.length;
  await runJob(env, response.jobId!);
  expect(fetch).toHaveBeenCalledTimes(count);
  await db.prepare("UPDATE knowledge SET revision=revision+1 WHERE id=1").run();
  const stale = await call(`/cases/${cid}`);
  expect(stale.result.stale).toBe(true);
  expect(stale.result.items[0].webFindings).toBeUndefined();
  expect(
    (await call(`/admin/cases/${cid}`, "GET", undefined, "test-admin"))
      .partnerReport,
  ).toBeNull();
  expect(
    (await call(`/cases/${cid}/mail-draft`, "POST", {})).body,
  ).not.toContain(publicUrl);
});
it("担当用のマスタと案件レポートは管理者トークンを必須にする", async () => {
  const { call, cid } = await start("パッキンを購入したい");
  for (const path of ["/admin/partners", `/admin/cases/${cid}`]) {
    expect((await call(path)).status).toBe(403);
    expect((await call(path, "GET", undefined, "wrong-token")).status).toBe(
      403,
    );
    expect((await call(path, "GET", undefined, "test-admin")).status).toBe(200);
  }
});

it("マスタ更新で旧ジョブが失効しても、同じ案件で再調査できる", async () => {
  const { call, cid, intake } = await start(
    "パッキンを購入したい。型番はPK-100、数量は5個、希望日は2026-12-01です",
  );
  expect(intake.jobId).toBeTruthy();
  await db.prepare("UPDATE knowledge SET revision=revision+1 WHERE id=1").run();
  await runJob(env, intake.jobId!);
  const latest = await call("/cases/" + cid);
  expect(latest).toMatchObject({
    phase: "collecting",
    job: { status: "superseded" },
  });
  const { staff } = await research(call, cid, latest.revision);
  expect(staff.partnerReport?.master.items[0].review).toHaveLength(1);
  expect(fetch).not.toHaveBeenCalled();
});

it("会社側の資料不足は担当者確認へ残し、受領済み条件を顧客に聞き直さない", async () => {
  const { call, cid, intake } = await start(
    "パッキンを購入したい。型番はPK-100、数量は5個、希望日は2026-12-01です",
  );
  expect(intake.jobId).toBeTruthy();
  await runJob(env, intake.jobId!);
  const current = await call(`/cases/${cid}`);
  expect(current.phase).toBe("completed");
  expect(current.question).toBeNull();
  expect(current.followup).toBeNull();
  const staff = await call(
    `/admin/cases/${cid}`,
    "GET",
    undefined,
    "test-admin",
  );
  expect(staff.partnerReport!.master.items[0].review).toHaveLength(1);
  expect(await jobCount(cid)).toBe(1);
  expect(fetch).not.toHaveBeenCalled();
});
async function equivalentOffer() {
  const partners = basePartners();
  partners[0].groups = [
    {
      id: "another-model",
      kind: "purchase",
      products: ["パッキン"],
      facts: [{ field: "model", text: "PK-200" }],
      quantity: { max: 10, unit: "個" },
      requiredDate: { earliest: "2026-11-01", latest: "2027-12-31" },
      evidence: ["パッキン 型番PK-200"],
    },
  ];
  await master(partners);
  vi.mocked(fetch).mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.hostname !== "api.search.brave.com")
      throw new Error("UNEXPECTED_EXTERNAL_REQUEST");
    return new Response(JSON.stringify({ web: { results: [] } }), {
      headers: { "Content-Type": "application/json" },
    });
  });
  const { call, cid, intake } = await start(
    "パッキンを購入したい。型番はPK-100、数量は5個、希望日は2026-12-01です",
  );
  expect(intake.jobId).toBeTruthy();
  await runJob(env, intake.jobId!);
  const result = await call(`/cases/${cid}`);
  expect(result.question).toBeNull();
  expect(result.followup).toMatchObject({
    jobId: intake.jobId,
    kind: "equivalent_allowed",
    fieldKey: "equivalent_allowed",
  });
  expect(JSON.stringify(result.followup)).not.toContain("searchFingerprint");
  expect(await jobCount(cid)).toBe(1);
  return { call, cid, intake, result };
}
it("調査後は有効な顧客判断を一問だけ提示し、同等品を許可した場合だけ同案件で再照合する", async () => {
  const { call, cid, intake, result } = await equivalentOffer();
  const offer = result.followup!;
  expect(offer.options).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ value: "yes" }),
      expect.objectContaining({ value: "no" }),
    ]),
  );
  const mutationId = `followup-${++sequence}`;
  const payload = {
    mutationId,
    expectedRevision: result.revision,
    jobId: offer.jobId,
    questionId: offer.id,
    answer: {
      status: "known",
      choice: offer.options.find((o) => o.value === "yes")!.value,
    },
  };
  const accepted = await call(`/cases/${cid}/followup`, "POST", payload);
  expect(accepted.status).toBe(200);
  expect(accepted.jobId).toBeTruthy();
  expect(accepted.jobId).not.toBe(intake.jobId);
  expect(accepted.revision).toBe(result.revision + 1);
  expect(await jobCount(cid)).toBe(2);
  const replayed = await call(`/cases/${cid}/followup`, "POST", payload);
  expect(replayed).toEqual(accepted);
  expect(await jobCount(cid)).toBe(2);
  await runJob(env, accepted.jobId!);
  const latest = await call(`/cases/${cid}`);
  expect(latest.caseId).toBe(cid);
  expect(latest.followup).toBeNull();
  expect(latest.question).toBeNull();
  expect(latest.items).toHaveLength(1);
  expect(latest.items[0].fields).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        key: "model",
        hardConstraint: false,
        value: expect.objectContaining({ text: "PK-100" }),
      }),
      expect.objectContaining({
        key: "equivalent_allowed",
        value: expect.objectContaining({ text: "yes" }),
      }),
    ]),
  );
  const staff = await call(
    `/admin/cases/${cid}`,
    "GET",
    undefined,
    "test-admin",
  );
  expect(staff.partnerReport!.master.items[0].match).toHaveLength(1);
  expect(await jobCount(cid)).toBe(2);
});
it.each([
  { status: "known", choice: "no" },
  { status: "unknown" },
  { status: "skipped" },
])(
  "再質問へ$choice$statusと答えた場合は再検索せず、質問を終了する",
  async (value) => {
    const { call, cid, result } = await equivalentOffer();
    const offer = result.followup!;
    const requests = vi.mocked(fetch).mock.calls.length;
    const declined = await call(`/cases/${cid}/followup`, "POST", {
      mutationId: `followup-${++sequence}`,
      expectedRevision: result.revision,
      jobId: offer.jobId,
      questionId: offer.id,
      answer: value,
    });
    expect(declined.status).toBe(200);
    expect(declined.jobId).toBeNull();
    expect(declined.revision).toBe(result.revision);
    expect(await jobCount(cid)).toBe(1);
    const current = await call(`/cases/${cid}`);
    expect(current.followup).toBeNull();
    expect(current.question).toBeNull();
    expect(current.result).toEqual(result.result);
    expect(
      current.items[0].fields.find((f) => f.key === "equivalent_allowed")
        ?.status,
    ).toBe(value.status);
    if (value.choice === "no") {
      const mail = await call(`/cases/${cid}/mail-draft`, "POST", {});
      expect(mail.body).toContain("指定型番のみ");
    }
    expect(fetch).toHaveBeenCalledTimes(requests);
    await runJob(env, offer.jobId);
    expect((await call(`/cases/${cid}`)).followup).toBeNull();
    expect(await jobCount(cid)).toBe(1);
  },
);

it("二つの画面から同じ追質問に別の回答を送っても先着の1回だけを採用する", async () => {
  const { call, cid, result } = await equivalentOffer();
  const offer = result.followup!;
  const responses = await Promise.all(
    ["yes", "no"].map((choice) =>
      call(`/cases/${cid}/followup`, "POST", {
        mutationId: "race-" + choice,
        expectedRevision: result.revision,
        jobId: offer.jobId,
        questionId: offer.id,
        answer: { status: "known", choice },
      }),
    ),
  );
  expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  expect(await jobCount(cid)).toBe(responses[0].status === 200 ? 2 : 1);
});

it("資料更新前の追質問には回答できず、条件・ジョブを増やさない", async () => {
  const { call, cid, result } = await equivalentOffer();
  await db.prepare("UPDATE knowledge SET revision=revision+1 WHERE id=1").run();
  const offer = result.followup!;
  expect((await call(`/cases/${cid}`)).followup).toBeNull();
  expect(
    (
      await call(`/cases/${cid}/followup`, "POST", {
        mutationId: "stale",
        expectedRevision: result.revision,
        jobId: offer.jobId,
        questionId: offer.id,
        answer: { status: "known", choice: "yes" },
      })
    ).status,
  ).toBe(409);
  expect(await jobCount(cid)).toBe(1);
});
