import { test, expect } from "@playwright/test";
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
    page.getByRole("heading", { name: "何に使うものですか？" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "分からない", exact: true }).click();
  await page.getByRole("button", { name: "この質問を飛ばす" }).click();
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
    page.getByRole("heading", { name: "どの部位・作業をご依頼ですか？" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "この内容で調べる", exact: true })
    .click();
  await expect(page.getByText("承認済みの取扱分野に含まれます。")).toBeVisible({
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
    page.getByText("変更を保存しました。現在の条件で再調査できます。"),
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
    page.getByText("解釈できていない入力を保持しています。"),
  ).toBeVisible();
  await expect(page.getByLabel("回答", { exact: true })).toHaveValue(
    "ガラス 外径10℃",
  );
  await page.getByRole("button", { name: "入力内容でメール文を作成" }).click();
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
    page.getByText("解釈できていない入力を保持しています。"),
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
  await expect(page.getByLabel("件名と本文")).not.toContainText("客先支給");
});
