# 利用枠・Stripe定期払い（UTA-9）

管理画面の「利用枠・お支払い」（`/admin?tab=billing`）で、API原価の使用額・処理中/未精算の予約額・残額・月末見込み・停止状態・変更履歴を確認する。

## 現在の配置状態（2026-10-21、UTA-9）

最新のUTA-8統合済みmainへ利用枠機能を移植し、本番Supabaseに `202610210001` を適用、本番Workersへ配置した。5つの追加テーブルのRLS有効化を確認。初期API原価上限は3,000円、Stripe課金と実メール通知はUTA-15で保留。本書の「未配置」「未適用」は下記の過去時点の検証記録であり、現在の状態はこの節を優先する。

- 管理画面： https://aoki-enji.official-b.workers.dev/admin?tab=billing
- 配置版： `d343d8b9-349d-4c43-9a66-1b204b920efb`
- 移植時の全体試験：398件中397件成功。旧モデル名を使う履歴試験を登録済みモデルへ更新し、利用枠枯渇時の登録情報案内の試験も含め該当ファイル16件成功。他の28ファイルは再実行していない。
- 型チェック、Workers用ビルド、Wrangler dry-run成功。
- 本番APIの未ログイン拒否・別Origin拒否・未設定決済の503・未認証通知起動の401・ログアウト失効を確認。1440px／390pxの管理画面、申込ボタンの無効化、横はみ出しなし、ブラウザー例外なしを確認。証跡は `.data/verification/uta9/production-result.json` と `production-desktop.png`／`production-mobile.png`。
- 本番で上限3,000円を確認し、2つの同時変更で200/409、停止・上限2,999円の保存、使用/予約額維持、元の3,000円・再開への復元を確認。操作履歴は監査記録として保持する。
- 本番アカウントへの実課金、APIキーの追加、実メール送信は行っていない。UTA-15は別途完了が必要。

## 金額と公開前の設定

- 月額請求額：5,000円／10,000円／20,000円、JPY・税込・毎月の定額プラン。
- API原価上限：請求額とは別。Stripe未接続の初期運用上限は3,000円。各販売プランの配分は環境変数で明示し、未設定なら申込不可。テストの3,000／6,000／12,000円は模擬値であり、会社合意済みの内訳ではない。
- 会社確認事項はQ015・Q018。販売条件・税区分・手数料・入金口座・通知先は確認してから本番設定する。
- 一社一サイト・一つの専用Stripe顧客を前提とする。共通管理者パスワードを持つ担当者は契約画面へ進める。会社内の決済権限者にアクセスを限定する。マルチテナント課金ではない。

## 予算管理

日本時間の暦月ごとに集計する。呼出し前にDBトランザクションで最大使用見込みを予約し、使用量が返れば精算する。複数インスタンスも同じDBのロックを使用する。月途中のプラン変更・上限変更・停止/再開では使用額や予約額を消さない。月をまたいだ処理は予約元の月に精算する。

対象はOpenAI回答・分類・商品検索・追加調査、Gemini、Jev、Exa、Tavily。接続試験・再試行にも毎回別の枠を予約する。ローカル検証用のループバックAIだけは、既存の隔離環境検証を通したうえで課金対象外とする。

料金表 `2026-10-21-v1`、初期換算1 USD=160円、安全余裕25%。換算値は為替の現在値ではない。小数の端数をマイクロ円で切上げる。固定サーバー費・Stripe手数料・ドメイン等はAPI集計外。外部請求額を厳密に上限以下へ保証する仕組みではない。専用APIキーを使い、外部の請求と定期照合する。

- GPT-4.1 / mini、GPT-5 mini、Gemini 2.5 Flashの標準テキスト料金を登録。
- GPT-6 Astra/Sol/Lunaのテキストは長文側の高い標準単価を保守的に適用。GPT-6の検索ツール料金上限は未登録で停止する。
- 入力テキストはUTF-8バイト数＋構造分、出力は要求上限で予約。Geminiは思考分も含めモデル最大出力を予約する。
- OpenAI検索は`max_tool_calls=3`、各反復の最大コンテキストと検索料金を予約するため、実際の精算額より大きな枠が必要。mini検索は1回8,000入力トークン分も加算する。使用量に検索分が含まれるケースは保守的な過大計上になり得る。
- Exa auto（10件以下・ハイライトのみ）は$0.007/回。Tavily basic（自動パラメーターなし）は$0.008/回。無料枠を割引として計算しない。
- Jevは確認済み公開単価がないため初期状態で停止。契約上の最大単価と版を`AI_JEV_MAX_CALL_USD`、`AI_JEV_PRICE_VERSION`で設定後に予約できるが、精算根拠がないため予約を維持する。
- 不明モデル・未対応ツール・料金方式は呼出し前に停止。使用量欠落・タイムアウト・不正な使用量は予約を維持する。自動的に期限切れ解放しない。
- 提供元の使用量が予約計算の入力・出力・ツール回数の上限を超えた場合は、後続の有料処理も一時停止し、監査履歴へ記録する。料金計算と提供元の使用量を確認してから再開する。

未精算の詳細は管理画面に表示する。提供元の使用量と照合するまで予約は残す。今回、未確認費用を管理画面のボタンだけで無料解放する操作は設けていない。

## Stripeの準備

2026-10-21の追加指示で、受取側は新しい専用Stripeアカウントを作成する方針。既存の別サービス用アカウントは転用しない。登録後、指定された名義・メールと対象アカウントを照合してから設定する。

1. 受取側のStripeアカウントを確認し、入金先・本人/事業確認を設定する。テスト環境と本番環境を分離する。
2. 対象会社専用の顧客を作成し、`STRIPE_CUSTOMER_ID`へ設定する。既存の他社顧客を転用しない。
3. プランごとに商品を分け、それぞれ月額Priceを1つ作成する（Portalは同一商品内の同じ請求間隔の複数Priceを拒否することを実APIで確認）。JPY・固定額・税込(`inclusive`)・月1回・数量1。`BILLING_*_PRICE_ID`と各API原価枠を設定する。価格IDから取得した金額・環境・課金方式を申込時に検証する。
4. 専用Customer Portal設定を作成し、許可するPriceを上記3つに限定する。更新項目は`price`のみ、`proration_behavior=always_invoice`、`billing_cycle_anchor=unchanged`、減額は`schedule_at_period_end.conditions=[{type:decreasing_item_amount}]`、解約は`at_period_end`とする。カード変更と請求履歴表示を有効にする。IDを`STRIPE_PORTAL_CONFIGURATION_ID`へ設定する。
5. SDK **stripe 23.0.0**、API **2026-09-30.endive** を使用する。`/api/billing/webhook`へ次のイベントを送るWebhookを同じAPI版で登録し、署名秘密値を`STRIPE_WEBHOOK_SECRET`へ設定する：
   `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`。
6. `APP_ORIGIN`を確定したHTTPS URLに設定する。申込はStripe Checkout、契約変更はStripe Customer Portalへ遷移する。カード番号をこのアプリへ送信・保存しない。
7. 本番運用時は`BILLING_REQUIRED=true`、本番販売の準備が整ってから`BILLING_LIVE_ENABLED=true`。キー未設定でも`BILLING_REQUIRED=true`なら有料APIは支払い確認まで停止する。

支払い完了の戻りURLは枠を増やさない。署名付きWebhookを検証し、専用顧客の現在の契約と最新請求書をStripeから取得する。支払済み請求書の対象プランと期間を照合して枠を付与する。重複イベントは一度だけ反映し、遅れて届いた古いイベントも現在の契約状態で評価する。未払いの増額は以前の支払済み枠・期限を維持する。利用期限は毎回のAPI予約で検査するため、更新通知欠落でも無期限には使えない。

同時申込は共通ロックとStripe idempotency keyで集約する。結果不明の申込を23時間以上経って自動再送しない。Stripe側の申込/契約を照合してから復旧する。DBに保存された`checkoutAttempt`を未確認のまま削除しない。

### テストアカウントの初期設定準備

`node scripts/stripe-billing-fixture.mjs`は、Stripe CLI用のJSONを標準出力するだけで外部通信しない。3商品・3価格・架空顧客・専用Portal設定をまとめて生成する。個人情報・カード・APIキー・未承認のAPI原価配分は含めない。

生成物は、本人の新アカウントを確認し、Stripeの**テスト環境**を選んだ後に使用する。fixtureを実行するたびに新しいリソースができるため、実行結果のIDを保存し、失敗時に全体を無条件で再実行しない。本番用の設定としては使わない。2026-10-21に下記アカウントへ設定済み。

この開発端末には公式Stripe CLI 1.54.1を`/home/uta/.local/share/aokiennji-tools/`へ導入済み。公開先のCloudflare Workerはまだ準備中表示のため、Webhook転送によるローカル接続試験を行った。

### 実Stripeテスト環境の接続記録（2026-10-21）

本人が登録したメールとの一致をStripeの個人情報画面で確認後、K-STRIVEのテスト環境に接続した。本番の本人・事業確認や入金口座登録は未完了。APIキー・Webhook秘密値はリポジトリ外の当端末の秘密設定へ保存し、通常の`.env.local`へは適用していない。

| 対象 | テスト環境のID |
| --- | --- |
| アカウント | `acct_1UShhpRjY57ygz7m` |
| 5,000円 | `price_1UShm7RjY57ygz7mvPnrtMhW` |
| 10,000円 | `price_1UShnDRjY57ygz7mqqEYgvp4` |
| 20,000円 | `price_1UShnERjY57ygz7mGXK2dNyd` |
| 架空顧客 | `cus_VTf6JCpcJiRI4T` |
| Portal設定 | `bpc_1UShnERjY57ygz7m08BcnfuD` |

実際のCheckout/PortalをOrcaブラウザーで操作し、Stripe CLIの署名付きWebhookをアプリの`stripeWebhook`へ転送した。専用ローカルDB `aoki_stripe_uta9`を使用し、通常の開発DBと分離した。戻り先とWebhook受信口は検証用HTTPサーバーであり、本番サイトの公開試験ではない。

- 5,000円の申込・テストカード決済成功 → API枠3,000円。
- Portalで10,000円へ増額・差額決済成功 → API枠6,000円。
- Stripe APIで20,000円への増額を決済失敗にする → 未払い通知を受信し、API枠6,000円を維持。
- 同じ請求書の支払いを成功させる → API枠12,000円。
- Portalで5,000円へ減額予約 → 期間終了時の変更スケジュールを確認し、支払済み枠12,000円を維持。
- Portalで解約予約 → 期間終了時の解約を確認。最後にテスト契約をAPIで即時終了し、解約通知で利用枠0円になることを確認。テスト契約は継続中のまま残していない。

枠3,000/6,000/12,000円は引き続きテスト用。実資金の請求・引落し・入金は行っていない。3DSと次の請求期間への時間進行は、今回の実Stripe試験には含めていない。

実接続で判明した2点を修正した。同一商品・同期間の複数PriceをPortalが拒否するため商品を分離し、アプリのPortal設定取得に`expand: ['features.subscription_update.products']`を追加。変更後の型チェックと決済関連13試験は成功。証跡は`.data/verification/uta9/stripe-*`。

### 本番接続先の変更（2026-10-21）

ユーザーがノートPCの外部ブラウザーで指定・認証した「アオキエンジ」`acct_1UShTVDsvf0a3EnJ`へStripe CLIを接続した。上記K-STRIVEのテスト環境とは別アカウントであり、テストの価格・顧客・Portal IDを本番へ流用しない。このStripe作業ではユーザー指示によりOrca内ブラウザーを使わず、本人情報はノートPC、サービス操作はCLI/APIで進める。

APIで所在地JP、事業形態individual、`details_submitted=true`、`charges_enabled=true`、`payouts_enabled=false`を確認。ユーザーの書類提出後に再取得し、`currently_due=[]`・`past_due=[]`・`pending_verification=[individual.verification.document]`へ変わったことを確認。書類はStripeの確認待ちで、`disabled_reason=requirements.pending_verification`、`payouts_enabled=false`が続いている。入金可能になったことは未確認。CLI認証はアプリ用の本番秘密キー設定を意味しない。

本番の商品・価格・Portal設定・Webhookは各0件であることを確認した。未確認の販売条件・税区分・API枠を確定扱いせず、本番リソース作成とアプリ接続は未実施。実請求は行っていない。

ユーザー指示で、この本番化と実メール通知接続は後続の [UTA-15](https://linear.app/uta-s-dao/issue/UTA-15) へ分離した。審査待ちをUTA-9のローカル利用枠実装・検証の待機理由にしない。本番公開・本番決済の完了とは区別する。

分離後の仕上げで、API呼び出し管理の入口から「HTTP成功後にキャンセルされた処理は使用量が返っていても予約を維持し、再試行を上限で拒否する」回帰試験を追加した。独立DB `aoki_billing_unit_test` で予算・課金の26試験が成功。証跡は `.data/verification/uta9/budget-deferred-stripe-tests.log`。

## 通知

80%・90%・上限到達・次の処理の枠不足・月末超過予測をDBへ保存する。予測は月開始から1日以上の使用額の平均ペース＋予約額。通知は月・設定版・種類ごとに重複を防ぐ。

`BUDGET_ALERT_FROM`（確認済みの送信元）、`BUDGET_ALERT_TO`（ユーザー本人/運用担当者）、`RESEND_API_KEY`、32文字以上の`BUDGET_CRON_SECRET`を設定する。デプロイ先のスケジューラーで5分ごとに`GET`または`POST /api/billing/notifications`を呼び、AuthorizationヘッダーでBearer秘密値を渡す。URLや公開コードへ秘密値を含めない。ホスティング側の定期実行の登録は別途必要。

未設定なら通知をDBと管理画面に保持する。送信失敗は5分後に再試行し、同じResend idempotency keyを使う。23時間を超えた不明な送信は`review`にして自動再送を止める。メール到達および定期実行自体の監視は本番導入時に確認する。

## 検証コマンド

```
npm run db:local:migrate
node scripts/database-local.mjs npx vitest run tests/ai-budget.test.ts tests/billing.test.ts tests/postgres-integration.test.ts
node scripts/database-local.mjs npx playwright test tests/e2e/billing.spec.ts
npm run typecheck
npm run build
```

自動試験は独立したローカルPostgresと模擬Stripe APIを使う。Webhook署名はStripe SDKの実際の検証処理を使う。本番の請求・引落し・銀行入金・メール到達を証明するものではない。実Stripeテスト環境でのCheckout/3DS/未払い/Portal/更新/解約/Webhook再送の試験は、アカウント接続と価格設定後に行う。

2026-10-21の確認結果：

- ローカルDB migration、型チェック、本番用ビルド成功。
- 全28ファイル・385件を実行し、383件成功。履歴試験の旧ダミー入力による2件失敗を修正し、該当ファイル3件を再実行して全件成功。他の27ファイルは再実行していない。
- 管理画面のPC・スマートフォン試験成功。上限変更・停止/再開・保存後の再読込・横はみ出しを確認。PCのheadless環境で描画フレーム待ちが止まるため、操作をキーボード、画像取得をCDPに変更した。
- 証跡は`.data/verification/uta9/`。この初回確認後に上記の実Stripeテストを実施。本番アプリと本番DBへの反映、実メール送信は未実施。

公式資料（2026-10-21確認）：[Stripe Checkout](https://docs.stripe.com/payments/checkout)、[Customer Portal](https://docs.stripe.com/customer-management)、[Webhook](https://docs.stripe.com/billing/subscriptions/webhooks)、[OpenAI料金](https://developers.openai.com/api/docs/pricing)、[Gemini料金](https://ai.google.dev/gemini-api/docs/pricing)、[Exa料金](https://exa.ai/pricing)、[Tavily料金](https://docs.tavily.com/documentation/api-credits)、[Resend重複防止](https://resend.com/docs/dashboard/emails/idempotency-keys)。
