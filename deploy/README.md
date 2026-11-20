# 既存本番サイト内の管理者向け試用（2026-11-19）

公開先: https://aoki-enji.official-b.workers.dev/availability-v2/

既存サイトの `/admin` でログインした管理者だけが使用できます。旧チャットはそのままです。この環境は架空デモ資料・規則による応答で、AI生成・外部検索・メール送信を行いません。実資料での取扱判定や実モデルの品質を保証する環境ではありません。

## 接続と保存先

- 既存 Worker `aoki-enji` の入口に `src/hosted/site-gateway.ts` を追加。対象は `/availability-v2/` と `/api/v2/` のみ。
- 毎回、旧アプリ自身の `/api/admin/settings` を内部呼び出しして管理セッションを検証する。旧アプリの Cookie は専用 Worker に渡さない。
- Service Binding `AVAILABILITY_V2` → `aoki-availability-v2-admin-trial`。専用 Worker は workers.dev・プレビュー URL・公開ルートを持たない。
- 共通のランダムな秘密値を既存側 `AVAILABILITY_V2_PROXY_TOKEN`、専用側 `TRIAL_PROXY_TOKEN` に設定。秘密値をリポジトリへ保存しない。
- 専用 D1 `aoki-availability-v2-admin-trial`（ID は設定ファイル参照）、R2 `aoki-availability-v2-admin-trial-files`、Queue `aoki-availability-v2-admin-trial-research`。会社の既存 DB は使用しない。
- `src/hosted/trial-worker.ts` が秘密値・元の Origin・デモ設定を検証した後で既存エンジンを呼ぶ。元のローカル専用ガードは維持。試用側の管理 API は拒否する。
- `av2_session` は HttpOnly / Secure / SameSite=Strict、Path=/api/v2。変更 API は Origin と CSRF を確認する。
- API/資産応答は private/no-store、検索対象外。設定は `wrangler.trial.jsonc` に独立して置く。

## 反映した版と復旧

- 元の本番版: `04c1fb1e-587d-4e24-9ea8-e5160d023728`
- 今回の本番版: `95f13992-7dbb-44aa-b28d-9eecaf0459c0`（100%）
- 専用 Worker 版: `16f98db2-1a28-4339-816a-eb56576a8a83`

元の本番から取得した全403モジュールと既存資産・バインディングを保ったまま、新しい入口と接続モジュールだけを追加した。旧ソースの `.git` は参照先が消失しているため、旧サイト全体の再ビルド・再配置は行っていない。再ビルド用の接続コードは旧プロジェクトの `worker.ts` と `lib/server/availability-v2-gateway.ts` にも保存した。

復旧は Cloudflare の `aoki-enji` の配信版を上記「元の本番版」へ戻す。既存会社 DB の移行・変更はない。専用データは独立しているため復旧時にも既存データの復元操作は不要。新しい設定・資料や別作業が入っていないか確認してから実施する。

配信モジュール・設定・ハッシュ・操作スクリプト・検証ログの保全先は `/home/uta/.local/share/aoki-deployments/production-v2-trial-20261119`。Cloudflare 認証トークンや管理者パスワード、共通秘密値は含めない。操作スクリプトは当日の厳密な旧版照合を含む記録であり、そのまま将来の再配置に流用しない。

## 専用 Worker の将来の更新

プロジェクトルートで以下を実行する。通常プレビューの設定・データを使わない。

```sh
npx vite build --base=/availability-v2/ --outDir dist/hosted-trial-ui
npx wrangler deploy --config deploy/wrangler.trial.jsonc
```

これは専用 Worker の更新だけを行う。既存サイト側の更新は公開版を再取得して差分と資産・バインディングを検証し、未配信版としてアップロードした後で切り替える。共有秘密値を再発行する場合は両側を一致させる。通常のローカル `wrangler.jsonc` を本番へ deploy しない。

## 検証結果

- 基本・契約・本番接続217件、既存 API 30件、画面 E2E 26件が成功（計273件）。追加の経路拒否を含む本番接続8件も再確認済み。
- v2 型検査・lint、旧サイトの型検査が成功。
- 本番実画面: AX-100購入→数量2個から3個への訂正→結果・保存値・メール本文の一致。ガラス相談で不明・スキップ・温度訂正を確認。
- 未ログイン・偽セッションは401、試用の管理 API と不正 Origin は403、入れ子の API 経路は404。
- 既存公開ページ・設定・確認した3資産のハッシュ、および既存会社資料・履歴・予算10テーブルのハッシュが切替前後で一致。
- 専用 D1 の有料生成累計0、非デモ資料0。確認に使った専用相談2件は API で削除し、画面を新しい相談へ戻した。
- 評価枠40回の記録、通常プレビュー設定・既存資産・既存未コミット変更を保持。

## 残る確認事項

実モデルの評価はしていない。デモでは「200度くらいです」を温度として認識せず、「200℃」なら受理する場面を確認した。結果・メール表示は取り消し前の仕様を維持しており、結果カードの簡略化や専用メール画面は再適用していない。メール宛先を未設定とし、本文のコピーだけを試せる。
