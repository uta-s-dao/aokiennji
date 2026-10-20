# UTA-8：Workers配置の構成と未完了項目

2026-10-20時点。本番DBの移行は適用済み。公開Workerは準備中表示で、業務アプリは未配置。

## 構成

`npm run build:vinext` はVite／vinextで `dist/client` と `dist/server` を生成する。`worker.ts` はリクエストごとにDBプールを作り、レスポンス本文・SSEと `waitUntil` の後処理が完了してから閉じる。Nodeの開発／Next.js実行は従来どおりプロセスのプールを使う。

PDFはunpdfのサーバー用PDF.jsで文字抽出し、500ページを超える資料とOCRが必要な空テキストを拒否する。画像はimage-sizeで形式・25百万画素・アニメーションを先に検査し、Photon WASMで最大1920pxへ縮小して再符号化する。JPEGはJPEG、PNG／WebPは透過を維持したWebP。EXIFを削除する。Viteだけに `/workerd` のWASMエントリーを指定し、動的なWASMコンパイルを避ける。

外部取得は各転送先でURL・ポート・全IP・許可ドメイン・HTTPSの後退・認証ヘッダー・サイズを検査する。Nodeは検査したIPへ接続を固定する。Workersはネイティブfetchを使うためIP固定を行わない。現在の構成は外部取得へプライベートネットワーク／VPCアクセスを与えない。この種のbindingを追加するときはSSRF対策を再評価する。DB専用Hyperdrive bindingはHTTP取得へ公開しない。

## 本番DBの接続

WorkersからSupabase poolerへの直接TLS接続はローカルworkerdで失敗した。NodeではSupabase CAを明示した検証付きTLSが成功した。本番WorkerではHyperdriveがSupabase側のCAとホスト名を検証する構成を使用する。TLS無効化や検証省略で直接接続を通さない。

1. 承認済みCloudflareアカウントを確認する。CLIは本案件用の `XDG_CONFIG_HOME=/home/uta/.config/aokiennji-cloudflare` を使う。現在のOAuthではCAアップロードが認証エラーとなるため、`ssl_certs:write` とデプロイ用 `workers_scripts:write` の認可を整える。
2. Supabase Root 2021 CAの公開証明書をアップロードする。今回の認証エラーでは作成できていないためIDは未確定。
3. 既存Supabaseの専用 `aoki_runtime` 資格情報を使ってHyperdriveを作る。管理ロールの接続文字列を渡さない。originはsession poolerの5432または直接接続とし、Hyperdriveの先にtransaction poolerを重ねない。CAを指定した `sslmode=verify-full`、`caching.disabled=true`、origin接続数の上限を設定する。セッション失効や設定読取をキャッシュしない。
4. 取得したIDを `wrangler.jsonc` の `hyperdrive: [{binding: "HYPERDRIVE", id: "実際のID"}]` に設定して再ビルドする。秘密の接続文字列はGitへ置かない。仮IDは登録していない。

`createDatabaseScope(env.HYPERDRIVE)` が信頼するプラットフォームbindingの接続を選ぶ。WorkerとHyperdriveの区間はプラットフォーム側が扱い、originへのTLSは上記構成で保証する。Hyperdrive利用時はprepared statementを有効にし、`.unsafe()`にも明示する。直接のtransaction poolerでは無効。実際のHyperdrive経由の接続確認は未実施で、ローカル接続を使ったbinding分岐・独立プール・トランザクション試験と区別する。

## 配置前の判断と手順

Wrangler dry-runは成功し、圧縮後4808.46KiB（約4.7MiB）。Freeの3MiBを超える。Workers Paidは月額$5〜＋利用枠超過分で、変更の承認はまだ得ていない。契約・支払操作・アプリのアップロードは行っていない。

承認後、Hyperdriveの実接続とキャッシュ無効設定を確認し、セッション鍵・管理パスワード・HTTPSのSITE_URL／APP_ORIGINを秘密管理に設定する。マイグレーション接続はWebへ配らない。デモ投入・メール送信・実注文・検索公開は、それぞれの承認と設定を確認してから有効化する。その後 `npm run build:vinext` と `npm run deploy:vinext` を実行し、実URLで受付、セッション失効、他人の会話拒否、画像、PDF、SSRF、SSE、再デプロイ後の永続化を検証する。検証データを除去し、結果が揃ってからUTA-8を完了とする。

Next.jsとvinextは同じ `.next/types` を生成するため、ビルドを同時実行しない。vinextの後にNext.jsを検証する場合は通常の `npm run build` で型を再生成する。型チェックだけなら `npm run typecheck` を使う。

## 確認した範囲

- ローカルSupabase：全体27ファイル・367件成功。追加3ファイル・23件も成功し、リクエスト別プールの独立性・prepared query・入れ子トランザクションを確認した。
- Next.js本番ビルド、vinextビルド、Wrangler dry-run成功。
- ローカルworkerd：繰返しリクエスト、会話・所有者、受付の同一キー再送、管理ログイン、ログアウト後の失効、WASM画像、実PDF文字抽出、公開HTTP取得、内部IP拒否が成功。
- Chromium：公開画面のハイドレーション、実SSE相談の応答表示が成功。
- 本番Supabase：001／002適用、26テーブル全RLS、ブラウザー用権限拒否、専用ロールのDDL拒否、TLS／pooler、別接続からの永続データ取得が成功。試験受付を削除済み。
- 未実施：Hyperdriveの作成と実接続、業務Workerのクラウド配置・再デプロイ検証。

参考：[Postgres.jsとHyperdrive](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/postgres-js/)、[CAとverify-full](https://developers.cloudflare.com/hyperdrive/configuration/tls-ssl-certificates-for-hyperdrive/)、[Hyperdrive料金](https://developers.cloudflare.com/hyperdrive/platform/pricing/)、[Workers料金](https://developers.cloudflare.com/workers/platform/pricing/)。
