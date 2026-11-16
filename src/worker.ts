import { api, json, local } from "./http/api";
import { AppError } from "./domain/model";
import type { Env } from "./adapters/store";
import research from "./research-worker";
export default {
  async fetch(req: Request, e: Env, ctx: ExecutionContext) {
    try {
      if (!local(req, e))
        return json(
          {
            error: "CONFIG_MISSING",
            message: "この構成はループバック限定のローカルデモです。",
          },
          503,
        );
      if (new URL(req.url).pathname.startsWith("/api/"))
        return await api(req, e, ctx);
      const asset = await e.ASSETS.fetch(req);
      const headers = new Headers(asset.headers);
      headers.set(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      );
      headers.set("X-Content-Type-Options", "nosniff");
      return new Response(asset.body, { status: asset.status, headers });
    } catch (err) {
      if (err instanceof AppError)
        return json(
          {
            error: err.code,
            message: messages[err.code] ?? "入力内容と操作を確認してください。",
          },
          err.status,
        );
      console.error("INTERNAL_ERROR");
      return json(
        {
          error: "INTERNAL_ERROR",
          message:
            "処理を完了できませんでした。入力を保持して再試行してください。",
        },
        500,
      );
    }
  },
  queue: research.queue,
  scheduled: research.scheduled,
};
const messages: Record<string, string> = {
  INTAKE_PENDING:
    "同じ入力を処理中です。入力を保持して、少し待ってから再試行してください。",
  REVISION_CONFLICT:
    "別の更新がありました。最新の内容を確認し、もう一度操作してください。",
  NOT_OWNER: "この相談にアクセスできません。",
  EXPIRED: "相談の保管期限が切れたか、削除されています。",
  RATE_LIMITED: "利用上限に達しました。時間をおいて再試行してください。",
  INVALID_INPUT: "入力内容・ファイル形式を確認してください。",
  SPLIT_REQUIRED: "入力を保持しました。3品目以下の別案件へ分割してください。",
  CONFIG_MISSING: "必要な設定がありません。",
};
