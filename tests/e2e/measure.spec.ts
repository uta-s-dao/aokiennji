import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
test("ローカルの選択100操作・自由文30入力・調査20案件を計測", async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "相談を始める" }),
  ).toBeVisible();
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
    const r = await fetch("/api/v2/admin/demo", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": s.csrf,
        "X-Local-Admin-Token": "availability-local-admin",
      },
      body: "{}",
    });
    if (!r.ok) throw new Error("seed failed");
  });
  const selection: number[] = [],
    freeText: number[] = [],
    research: number[] = [],
    questions: number[] = [];
  // Each group uses a fresh anonymous session, preserving the configured per-session limit.
  for (let i = 0; i < 50; i++) {
    if (i % 10 === 0) {
      await page.context().clearCookies();
      await page.reload();
      await expect(
        page.getByRole("button", { name: "相談を始める" }),
      ).toBeVisible();
    }
    await page.getByLabel("ご希望の内容").fill("名前不明の交換部品です");
    const t = performance.now();
    await page.getByRole("button", { name: "相談を始める" }).click();
    await expect(
      page.getByRole("heading", { name: /は何に使いますか？/ }),
    ).toBeVisible();
    if (freeText.length < 30) freeText.push(performance.now() - t);
    let t2 = performance.now();
    await page.getByRole("button", { name: "分からない", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "取付方法は分かりますか？" }),
    ).toBeVisible();
    selection.push(performance.now() - t2);
    t2 = performance.now();
    await page.getByRole("button", { name: "この質問を飛ばす" }).click();
    await expect(
      page.getByRole("heading", { name: "担当者確認が必要です", exact: true }),
    ).toBeVisible();
    selection.push(performance.now() - t2);
    await page.getByRole("button", { name: "新しい相談" }).click();
  }
  await page.context().clearCookies();
  await page.reload();
  for (let i = 0; i < 20; i++) {
    await page.getByLabel("ご希望の内容").fill("AX-100を購入したい");
    const t = performance.now();
    await page.getByRole("button", { name: "相談を始める" }).click();
    await expect(
      page.getByRole("heading", { name: "当社で取扱対応できます" }),
    ).toBeVisible();
    research.push(performance.now() - t);
    questions.push(0);
    await page.getByRole("button", { name: "新しい相談" }).click();
  }
  const stats = (a: number[]) => {
    const s = [...a].sort((a, b) => a - b);
    return {
      n: s.length,
      p50Ms: Math.round(s[Math.ceil(s.length * 0.5) - 1]),
      p95Ms: Math.round(s[Math.ceil(s.length * 0.95) - 1]),
      maxMs: Math.round(s.at(-1)!),
    };
  };
  await writeFile(
    "docs/LOCAL-MEASUREMENTS.json",
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        environment:
          "WSL Linux / Chromium desktop / loopback / local workerd+D1+R2+Queue / warm; 外部AI・検索なし",
        selection: stats(selection),
        freeTextDemo: stats(freeText),
        researchFromSubmitToVisible: stats(research),
        questionsForKnownModel: questions,
        limitations: [
          "デモ抽出の計測。実モデル性能ではない",
          "選択のうち50操作は調査・結果表示まで含む",
          "型番調査時間は初回送信から表示までを計測し、調査受付だけを分離していない",
          "実端末・国内回線・coldの測定、100ms視覚反応、実課金は未検証",
        ],
      },
      null,
      2,
    ) + "\n",
  );
});
