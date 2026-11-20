import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "相談を始める" }),
  ).toBeVisible();
  // Seed through the guarded local admin API; no external service or mail client is opened.
  await page.evaluate(async () => {
    const s = (await (await fetch("/api/v2/session")).json()) as {
      csrf: string;
      extraction?: string;
      externalEnabled?: boolean;
    };
    if (s.externalEnabled || s.extraction === "openai")
      throw new Error(
        "実APIが有効なため、このデモ用試験を中止しました。INTAKE_PROVIDER=demo・EXTERNAL_ENABLED=falseで起動した環境を使ってください。",
      );
    await fetch("/api/v2/admin/demo", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": s.csrf,
        "X-Local-Admin-Token": "availability-local-admin",
      },
      body: "{}",
    });
  });
});
test("型番品は0問で結果、メール全文を作り送信しない", async ({ page }) => {
  const calls: string[] = [];
  const localOrigin = new URL(page.url()).origin;
  page.on("request", (r) => {
    if (new URL(r.url()).origin !== localOrigin) calls.push(r.url());
  });
  await page.getByLabel("ご希望の内容").fill("AX-100を購入したい");
  await page.getByRole("button", { name: "相談を始める" }).click();
  await expect(
    page.getByRole("heading", { name: "当社で取扱対応できます" }),
  ).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: "メールで相談する" }).click();
  await expect(page.getByLabel("件名と本文")).toContainText("AX-100");
  await expect(
    page.getByRole("link", { name: "メールソフトを開く" }),
  ).toHaveCount(0);
  expect(calls).toEqual([]);
  await page.screenshot({
    path: `test-results/${test.info().project.name}-result.png`,
    fullPage: true,
  });
});
test("名称不明品は不明とスキップを尊重して調査しメール文へ進む", async ({
  page,
}) => {
  await page.getByLabel("ご希望の内容").fill("名前不明の交換部品です");
  await page.getByRole("button", { name: "相談を始める" }).click();
  await expect(
    page.getByRole("heading", { name: /は何に使いますか？/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "分からない", exact: true }).click();
  await page.getByRole("button", { name: "この質問を飛ばす" }).click();
  await expect(page.getByLabel("回答", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "この内容で調べる", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "担当者確認が必要です", exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: "メールで相談する" }).click();
  await expect(page.getByLabel("件名と本文")).toContainText("分からない");
  await expect(page.getByLabel("件名と本文")).toContainText("スキップ");
});
test("製作相談は分野だけ確認し、希望日と支給塗料を保持", async ({ page }) => {
  await page
    .getByLabel("ご希望の内容")
    .fill("図面の架台を製作したい。塗料は支給。来月上旬を希望");
  await page.getByRole("button", { name: "相談を始める" }).click();
  await expect(
    page.getByRole("heading", {
      name: /のどの部分を、どこまで製作・加工してほしいですか？/,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "この内容で調べる", exact: true })
    .click();
  await expect(
    page.getByText(/取扱いをご相談いただける分野です。/),
  ).toBeVisible({
    timeout: 15000,
  });
  await expect(
    page.getByRole("heading", { name: "担当者確認が必要です", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "メールで相談する" }).click();
  await expect(page.getByLabel("件名と本文")).toContainText("来月上旬");
  await expect(page.getByLabel("件名と本文")).toContainText("塗料は支給");
});
test("支給材加工から当社調達へ訂正すると旧結果が失効", async ({ page }) => {
  await page
    .getByLabel("ご希望の内容")
    .fill("リング材を支給するので穴加工してほしい");
  await page.getByRole("button", { name: "相談を始める" }).click();
  const research = page.getByRole("button", {
    name: "この内容で調べる",
    exact: true,
  });
  await expect(research).toBeVisible();
  await research.click();
  await expect(
    page.getByRole("heading", { name: "今回の依頼は対応範囲外です" }),
  ).toBeVisible({ timeout: 15000 });
  await page
    .getByRole("button", { name: "入力内容を確認・修正", exact: true })
    .click();
  const editor = page
    .locator("form")
    .filter({ has: page.getByLabel("材料手配", { exact: false }) });
  await editor.locator("select").selectOption({ label: "当社調達" });
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    page.getByText(/材料手配を「当社調達」に変更しました。/),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "この内容で調べる", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "担当者確認が必要です", exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: "メールで相談する" }).click();
  await expect(page.getByLabel("件名と本文")).toContainText("当社調達");
  await expect(page.getByLabel("件名と本文")).not.toContainText("客先支給");
});
test("200%拡大相当・キーボード操作で横にはみ出さない", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.getByLabel("ご希望の内容").focus();
  await page.keyboard.type("AX-100");
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "相談を始める" }),
  ).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 320, height: 320 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("解釈失敗で原入力を残し、メール文へ引き継ぐ", async ({ page }) => {
  await page.getByLabel("ご希望の内容").fill("ガラス 外径10℃");
  await page.getByRole("button", { name: "相談を始める" }).click();
  await expect(
    page.getByText("確認できる条件を、チャットで続けて伺います。"),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "入力内容を確認・修正", exact: true })
    .click();
  await expect(
    page.getByText(
      "追加相談前の条件です。変更が未定なら、このままメールで相談できます。",
    ),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "入力内容の編集を閉じる", exact: true })
    .click();
  await expect(page.getByLabel("回答", { exact: true })).toHaveValue(
    "ガラス 外径10℃",
  );
  await page
    .getByText("ここまでの内容で担当者へ相談する場合", { exact: true })
    .click();
  await page.getByRole("button", { name: "このままメールで相談する" }).click();
  await expect(page.getByLabel("件名と本文")).toContainText("ガラス 外径10℃");
  await expect(
    page.getByRole("heading", { name: "当社で取扱対応できます" }),
  ).toHaveCount(0);
});

test("未確定の調達相談をメールへ引き継ぎ、旧方式の対応外を出さない", async ({
  page,
}) => {
  await page
    .getByLabel("ご希望の内容")
    .fill("リング材を客先支給して穴加工を依頼します。");
  await page.getByRole("button", { name: "相談を始める" }).click();
  const text =
    "材料も御社で調達できますか。リング材の加工も一緒に依頼したいです。";
  await page.getByLabel("回答", { exact: true }).fill(text);
  await page.getByRole("button", { name: "次へ", exact: true }).click();
  await expect(
    page.getByText("確認できる条件を、チャットで続けて伺います。"),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "この内容で調べる", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "担当者確認が必要です", exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await expect(
    page.getByRole("heading", { name: "今回の依頼は対応範囲外です" }),
  ).toHaveCount(0);
  await page.getByText("根拠・確認した条件", { exact: true }).click();
  await expect(
    page.getByText("材料手配：客先支給", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "メールで相談する" }).click();
  await expect(page.getByLabel("件名と本文")).toContainText(text);
  await expect(page.getByLabel("件名と本文")).toContainText(
    "追加相談前の発言（現在の確定条件ではありません）",
  );
  await expect(page.getByLabel("件名と本文")).not.toContainText(
    "材料手配：客先支給",
  );
});

test("保存中は回答欄を無効にし、保存直後の次の回答を消さない", async ({
  page,
}) => {
  let release!: () => void;
  let saved!: () => void;
  let first = true;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const responseHeld = new Promise<void>((resolve) => {
    saved = resolve;
  });
  await page.route("**/api/v2/cases/*/answers", async (route) => {
    if (!first) return route.continue();
    first = false;
    const response = await route.fetch();
    saved();
    await released;
    await route.fulfill({ response });
  });
  try {
    await page
      .getByLabel("ご希望の内容")
      .fill("リング材を客先支給して穴加工を依頼します。");
    await page.getByRole("button", { name: "相談を始める" }).click();
    await responseHeld;
    await expect(page.getByRole("textbox")).toBeDisabled();
  } finally {
    release();
  }
  const text =
    "材料も御社で調達できますか。リング材の加工も一緒に依頼したいです。";
  await expect(
    page.getByRole("button", { name: "次へ", exact: true }),
  ).toBeVisible();
  await page.getByLabel("回答", { exact: true }).fill(text);
  await page.getByRole("button", { name: "次へ", exact: true }).click();
  await expect(
    page.getByText("確認できる条件を、チャットで続けて伺います。"),
  ).toBeVisible();
  await expect(page.getByLabel("回答", { exact: true })).toHaveValue(text);
});

test("温度訂正を返答し、実画面・保存値・結果・メールへ引き継ぐ", async ({
  page,
}) => {
  const turns: { speaker: string; text: string }[] = [];
  const first = "ガラス 通常温度780℃";
  await page.getByLabel("ご希望の内容").fill(first);
  await page.getByRole("button", { name: "相談を始める" }).click();
  await expect(
    page.getByRole("heading", { name: /は何に使いますか？/ }),
  ).toBeVisible();
  turns.push({ speaker: "お客様", text: first });
  await expect(page.locator(".notice[role=status]")).toHaveCount(0);
  turns.push({
    speaker: "システム",
    text: await page.locator(".question-card h1").innerText(),
  });
  const correction = "ガラス 通常温度680℃、最高温度820℃";
  await page.getByLabel("回答", { exact: true }).fill(correction);
  await page.getByRole("button", { name: "次へ", exact: true }).click();
  await expect(page.getByText(/通常温度を680℃に変更しました。/)).toBeVisible();
  turns.push({ speaker: "お客様", text: correction });
  turns.push({
    speaker: "システム",
    text: await page.locator(".notice[role=status]").first().innerText(),
  });
  turns.push({
    speaker: "システム",
    text: await page.locator(".question-card h1").innerText(),
  });
  const purpose = "用途は点検窓です";
  await page.getByLabel("回答", { exact: true }).fill(purpose);
  await page.getByRole("button", { name: "次へ", exact: true }).click();
  turns.push({ speaker: "お客様", text: purpose });
  await page
    .getByRole("button", { name: "この内容で調べる", exact: true })
    .click();
  await expect(page.locator(".notice[role=status]")).toHaveCount(0);
  await expect(page.locator(".result h1")).toHaveText("担当者確認が必要です", {
    timeout: 15000,
  });
  await expect(page.locator(".result article")).toContainText(
    "通常温度（680℃）",
  );
  await expect(page.locator(".result article")).toContainText(
    "最高温度（820℃）",
  );
  await expect(page.locator(".result article")).not.toContainText("780℃");
  await expect(
    page.getByRole("button", { name: "不足条件を修正する" }),
  ).toHaveCount(0);
  turns.push({
    speaker: "システム",
    text: await page.locator(".result").innerText(),
  });
  const cid = await page.evaluate(() => localStorage.getItem("av2_case"));
  const state = (await (
    await page.request.get(`/api/v2/cases/${cid}`)
  ).json()) as { revision: number; items: unknown; result: unknown };
  await page.getByRole("button", { name: "メールで相談する" }).click();
  const mail = await page.getByLabel("件名と本文").inputValue();
  expect(mail).toContain("通常温度：680℃");
  expect(mail).toContain("最高温度：820℃");
  expect(mail).toContain("用途：点検窓です");
  expect(mail).not.toContain("用途：ガラス 通常温度");
  expect(mail).not.toContain("780℃");
  const recordPath = test
    .info()
    .outputPath("customer-temperature-conversation.json");
  await writeFile(
    recordPath,
    JSON.stringify({ kind: "actual_local_ui", turns, state, mail }, null, 2),
  );
  await test.info().attach("customer-temperature-conversation", {
    path: recordPath,
    contentType: "application/json",
  });
  await page.screenshot({
    path: `test-results/${test.info().project.name}-customer-temperature.png`,
    fullPage: true,
  });
});

test("部品別の条件を読みやすく説明し、会社確認と未入力を分ける", async ({
  page,
}) => {
  const input =
    "カバーは4組、塗装不要、配送先は大阪です。ネックは8組、外装塗装、配送先は神戸です。";
  await page.getByLabel("ご希望の内容").fill(input);
  await page.getByRole("button", { name: "相談を始める" }).click();
  await expect(page.locator(".question-card h1")).toContainText(
    "カバーは何に使いますか？",
  );
  await expect(page.locator(".notice[role=status]")).toHaveCount(0);
  const notice = "";
  await page
    .getByRole("button", { name: "この内容で調べる", exact: true })
    .click();
  await expect(page.locator(".result h1")).toHaveText("担当者確認が必要です", {
    timeout: 15000,
  });
  const articles = page.locator(".result article");
  await articles.nth(0).locator("summary").click();
  await articles.nth(1).locator("summary").click();
  await expect(articles.nth(0)).toContainText("数量（4組）");
  await expect(articles.nth(0)).not.toContainText("8組");
  await expect(articles.nth(0)).toContainText("塗装不要");
  await expect(articles.nth(0)).toContainText("大阪");
  await expect(articles.nth(0)).not.toContainText("神戸");
  await expect(articles.nth(1)).toContainText("数量（8組）");
  await expect(articles.nth(1)).not.toContainText("4組");
  await expect(articles.nth(1)).toContainText("外装塗装");
  await expect(articles.nth(1)).toContainText("神戸");
  await expect(articles.nth(1)).not.toContainText("大阪");
  await expect(
    page.getByRole("button", { name: "不足条件を修正する" }),
  ).toHaveCount(0);
  const text = await page.locator(".result").innerText();
  await page.getByRole("button", { name: "メールで相談する" }).click();
  const mail = await page.getByLabel("件名と本文").inputValue();
  expect(mail).toContain("数量：4組");
  expect(mail).toContain("数量：8組");
  expect(mail).toContain("塗装：塗装不要");
  expect(mail).toContain("塗装：外装塗装");
  expect(mail).toContain("納入先：大阪です");
  expect(mail).toContain("納入先：神戸です");
  const recordPath = test.info().outputPath("customer-parts-conversation.json");
  await writeFile(
    recordPath,
    JSON.stringify(
      {
        kind: "actual_local_ui",
        input,
        notice,
        detailsExpanded: true,
        resultText: text,
        mail,
      },
      null,
      2,
    ),
  );
  await test.info().attach("customer-parts-conversation", {
    path: recordPath,
    contentType: "application/json",
  });
});

test("6問を超えて聞き取りを続け、結果後の追加相談も受け付ける", async ({
  page,
}) => {
  await page.getByLabel("ご希望の内容").fill("名前不明の交換部品です");
  await page.getByRole("button", { name: "相談を始める" }).click();
  const seen = new Set<string>();
  for (let n = 0; n < 8; n++) {
    const text = await page.locator(".question-card h1").innerText();
    expect(seen.has(text)).toBe(false);
    seen.add(text);
    await page
      .getByRole("button", {
        name: n % 2 ? "この質問を飛ばす" : "分からない",
        exact: true,
      })
      .click();
    await expect(page.locator(".question-card h1")).not.toHaveText(text);
    await expect(page.locator(".result")).toHaveCount(0);
  }
  await page
    .getByRole("button", { name: "この内容で調べる", exact: true })
    .click();
  await expect(page.locator(".result h1")).toBeVisible({ timeout: 15000 });
  await expect(page.getByLabel("回答", { exact: true })).toBeVisible();
  await page.getByLabel("回答", { exact: true }).fill("数量は2個です");
  await page.getByRole("button", { name: "次へ", exact: true }).click();
  await expect(page.getByLabel("回答", { exact: true })).toBeVisible();
  const cid = await page.evaluate(() => localStorage.getItem("av2_case"));
  const state = await (await page.request.get(`/api/v2/cases/${cid}`)).json();
  expect(state.items[0].fields).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        key: "quantity",
        value: expect.objectContaining({ number: 2 }),
      }),
    ]),
  );
});

test("単位を省いた旧値と新値の訂正を画面・メールへ反映する", async ({
  page,
}) => {
  await page
    .getByLabel("ご希望の内容")
    .fill("ガラス 外径100mm、通常温度780℃、数量3枚を購入したいです。");
  await page.getByRole("button", { name: "相談を始める" }).click();
  await page
    .getByLabel("回答", { exact: true })
    .fill(
      "点検窓に使います。外径は100ではなく120mm、通常温度は780ではなく680℃、最高820℃、数量は3ではなく2枚です。",
    );
  await page.getByRole("button", { name: "次へ", exact: true }).click();
  await expect(page.locator(".notice[role=status]")).toContainText("120mm");
  await expect(page.locator(".notice[role=status]")).toContainText("680℃");
  await page
    .getByRole("button", { name: "この内容で調べる", exact: true })
    .click();
  await expect(page.locator(".result h1")).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: "メールで相談する" }).click();
  const mail = await page.getByLabel("件名と本文").inputValue();
  expect(mail).toContain("外径：120mm");
  expect(mail).toContain("通常温度：680℃");
  expect(mail).toContain("最高温度：820℃");
  expect(mail).toContain("数量：2枚");
  expect(mail).not.toContain("780℃");
});

test("先に答えた用途や刻印を再質問せず、写真での特定の限界に返答する", async ({
  page,
}) => {
  await page
    .getByLabel("ご希望の内容")
    .fill(
      "ポンプの漏れ止めに使うパッキンを購入したいです。型番もメーカーも分かりません。刻印なし。ゴム、外径80mm、厚さ3mm、4枚、塗装なし、配送先は千葉工場、来月上旬。",
    );
  await page.getByRole("button", { name: "相談を始める" }).click();
  await expect(page.locator(".result h1")).toBeVisible({ timeout: 15000 });
  await page
    .getByLabel("回答", { exact: true })
    .fill("写真があればここで名前を絞れますか。");
  await page.getByRole("button", { name: "送信", exact: true }).click();
  await expect(page.locator(".notice[role=status]")).toContainText(
    "写真から部品名を自動で特定できません",
  );
});
