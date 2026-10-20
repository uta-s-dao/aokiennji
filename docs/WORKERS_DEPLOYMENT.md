# UTA-8：Workersの配置と検証

2026-10-20、既存CloudflareアカウントのWorkers Freeに業務アプリを配置した。本番URLは https://aoki-enji.official-b.workers.dev 。有料契約・アカウント変更は行っていない。

## 無料枠についての訂正

以前の「gzip約4.7MiBなので有料化が必要」という説明は、廃止された制限に基づく誤りだった。Cloudflareは2026-09-04に圧縮サイズの3MiB／10MiB制限を廃止し、Free／Paid共通で未圧縮64MiBへ変更した。今回の未圧縮21070.93KiB（約20.6MiB）は範囲内で、無料プランで配置・再配置に成功した。有料化依頼は取り下げた。

無料枠にはCPU 10ms／リクエスト、日次リクエスト数等の制限が残る。今回の基本操作の実HTTP成功は、高負荷時や大きな画像・PDFの処理まで保証するものではない。実際の制限エラーを確認した場合は、処理を軽くする方法や配置先を比較する。有料化を自動実行しない。

## 配置済みの構成

- `npm run build:vinext` が `dist/client` と `dist/server` を生成し、Wranglerで配置する。Worker名は `aoki-enji`、preview URLsは無効。検索公開・デモ・実注文も無効。
- `worker.ts` はリクエストごとにDBプールを作り、レスポンス本文・SSEと `waitUntil` の後処理が完了してから閉じる。Nodeの開発／Next.js実行はプロセスのプールを使う。
- 本番DBの専用 `aoki_runtime` をHyperdrive経由で使う。originはSupabaseの直接接続、Supabase Root 2021 CAを指定した `verify-full`、クエリキャッシュ無効、origin接続上限5。管理用DB接続をWebへ配らない。Hyperdrive IDは `wrangler.jsonc` に記録し、秘密は含めない。
- Workersからの直接TLS接続は失敗したため、この構成を使用する。Hyperdriveの作成時に資格情報・TLS検証が成功し、実Workerからの読取・書込も確認した。Orcaブラウザで同じ承認済みアカウントのCLI認可を更新し、CA登録と配置権限の不足を解消した。
- `createDatabaseScope(env.HYPERDRIVE)` は信頼するプラットフォームbindingを使う。Hyperdrive利用時はprepared statementを有効化し、`.unsafe()`にも明示する。直接のtransaction poolerでは無効。
- 管理パスワードとセッション鍵は新たに生成し、秘密管理へ登録した。開発用のパスワード・DBをコピーしていない。

## メディアと外部取得

PDFはunpdfで文字抽出し、500ページを超える資料とOCRが必要な空テキストを拒否する。画像はimage-sizeで形式・25百万画素・アニメーションを先に検査し、Photon WASMで最大1920pxへ縮小して再符号化する。JPEGはJPEG、PNG／WebPは透過を維持したWebP。EXIFを削除し、Viteだけに `/workerd` のWASMエントリーを指定する。

外部取得は各転送先でURL・ポート・全IP・許可ドメイン・HTTPSの後退・認証ヘッダー・サイズを検査する。Nodeは検査したIPへ接続を固定し、Workersはネイティブfetchを使うためIP固定を行わない。外部取得へプライベートネットワーク／VPCアクセスを与えない。この種のbindingを追加するときはSSRF対策を再評価する。DB専用Hyperdrive bindingはHTTP取得へ公開しない。

## 確認した範囲

- ローカルSupabase：全体27ファイル・367件、その後の関連3ファイル・23件が成功。リクエスト別プール・prepared query・入れ子トランザクションを含む。
- Next.js本番ビルド、vinextビルド、Wrangler dry-run成功。Next.jsとvinextは同じ `.next/types` を生成するため、ビルドを同時実行しない。vinextの後の型チェックには `npm run typecheck`、Next.jsの検証には通常の `npm run build` を使う。
- ローカルworkerd：繰返しリクエスト、会話所有権、受付の同一キー再送、管理認証・失効、WASM画像、実PDF文字抽出、公開HTTP取得、内部IP拒否が成功。ChromiumのハイドレーションとSSE応答表示も成功。
- 本番Supabase：001／002適用、26テーブル全RLS、ブラウザー用権限拒否、専用ロールのDDL拒否、検証付きTLS／pooler、別接続からの永続データ取得が成功。
- 本番Worker：無料プランで配置、管理ログイン・管理API、会話所有権、他人の会話拒否、受付の同一キー再送が成功。再配置後も同じ受付・設定・所有者セッションを読め、SSE応答とログアウト後の失効が成功。ホームのrobotsメタで検索除外を確認した。
- 本番の試験受付・会話・対応する監査／再送キー・セッションは削除済み。開発DB・会社データはコピーしていない。

クラウド上の大きな画像／PDF取込とブラウザー操作一式の検証、会社承認済みの商品・資料の選別登録は残る。会社の未回答条件は正式な販売条件へ変えない。

参考：[Workerサイズ上限の変更](https://developers.cloudflare.com/changelog/post/2026-09-04-increased-worker-size-limit/)、[現在の制限](https://developers.cloudflare.com/workers/platform/limits/)、[Postgres.jsとHyperdrive](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/postgres-js/)、[CAとverify-full](https://developers.cloudflare.com/hyperdrive/configuration/tls-ssl-certificates-for-hyperdrive/)。
