# 商品・製作の取扱確認 — ローカル実装

設計版1.1、契約バージョン2を基に、新しい空のリポジトリから作成した独立アプリです。既存チャットのコード・API・DB・Cookie・プロンプトを利用しません。

短い聞き取り → 一括調査 → 分野と今回の依頼条件を分けた結果 → メール文作成・全文コピー、をローカルで操作できます。**現在は架空資料を使うデモです。会社の実際の取扱可否を保証するものではありません。**

## 起動

Node.js 24で検証しました。依存はpackage-lock.jsonで固定しています。

```bash
cd /home/uta/aoki-availability-v2-local-20261116
npm ci
npm run db:migrate
npm run dev
```

この環境の `http://127.0.0.1:8787` を開きます。D1・R2・Queueはローカルエミュレーターです。アカウント登録・ログイン・Cloudflareリソース作成は不要です。

別のターミナルで架空の判断資料を登録します。

```bash
npm run demo:seed
```

または画面右上「管理」でローカル管理トークン `availability-local-admin` を入力し、「デモ資料を準備」を押します。この固定トークンはローカル専用で、ループバック以外ではアプリ自体が起動を拒否します。

`npm run dev` はUIビルド後にWorkerを起動し、5秒ごとにWranglerのローカル専用scheduledイベントを駆動します。outbox回復、期限切れleaseの再配信、60秒期限、保管期限・削除予約を処理します。UI変更後は再起動すると静的資産が更新されます。停止はCtrl+Cです。

## 動作例

- `AX-100を購入したい`：追加質問0、架空の個別承認に基づく対応可能。
- `名前不明の交換部品です`：補助質問、不明・スキップから担当者確認へ。
- `図面の架台を製作したい。塗料は支給。来月上旬を希望`：取扱分野は対象、今回の製作条件は確認待ち。
- `リング材を支給するので穴加工してほしい`：架空の方式別対応外。「入力内容を確認・修正」で材料手配を当社調達へ変更して再調査すると、旧方式の不可を流用しません。
- 改行で4品目以上入力：全入力を保持し、先頭3品目までを新しい相談へ分割。残りは元の案件へ保持します。

既定の自由文は小さなデモ抽出器です。OpenAI接続コードも実装しましたが、実APIのキー・モデル・利用上限は未設定です。設定と検証範囲は [自由文抽出の接続手順](docs/INTAKE-INTEGRATION.md) を参照してください。一般の日本語相談を網羅する抽出モデルではありません。複雑な部品別条件は各品目の修正欄で明示できます。元発言・変更前後の値は非公開の履歴へ保持し、結果とメール文は現在値から生成します。

## 実装済みの境界

- 4プロフィール、一問中心、最大6問、未登録分野の補助質問最大2問。選択操作はAI・検索・OCRを呼びません。
- 品目IDと属性辞書による更新、訂正履歴、単位・引用・列挙値の検証。不明・スキップの保存。
- `scopeAssessment` と `verdict` の独立判定。期限、承認、資料の役割、個別依頼の必須条件、競合を検証。
- 新しい匿名セッション、Origin/CSRF対策、所有権、頻度制限、revisionと冪等性。
- D1 batchのCASガード、outbox、Queue、lease、期限・知識版・入力版を照合した結果commit。
- 非公開のローカルR2保存、MIMEとシグネチャ・容量検査、所有権、添付差替え、期限・削除処理。PDFはダウンロード扱い。
- 公開結果はallowlist DTO。結果取得とメール生成時に根拠を再検証し、古い肯定を失効。
- ルールのJSON編集・検証・承認状態/期限の更新、撤回。原資料メタデータの登録。管理APIによる案件閲覧。
- メール宛先未設定時も全文コピー可能。宛先設定時のmailto生成とURI長超過時の短縮。送信処理はありません。

## 未接続の機能・今回の合格範囲

実モデル用の抽出adapterは実装済みですが、実API接続・品質評価は未実施です。外部検索、本文取得、OCR・画像/PDF内容解析は未接続です。添付は「受領済み・未解析」とし、添付を使う調査はpartial、対象品目は確認待ちにします。数値・型番を読んだことにはしません。

実資料、実メール原文、現在の会社承認情報は投入していません。実モデル・未知の20相談・会社担当者による判断一致・実端末評価は未実施です。本番用管理者JWT検証・インフラID・費用上限・外部資料利用許可・宛先・会社の保管方針も未設定です。実モデル抽出は、`INTAKE_PROVIDER=openai`、`EXTERNAL_ENABLED=true`、新規APIキー・モデル名・呼出し上限を明示した場合のみ有効です。検索・添付解析はこれらの設定では有効になりません。

したがって、今回の成果は**ローカル機能検証可能なデモ実装**です。設計の全受入条件を満たした実用版・本番公開可能な状態とは分けます。

本番公開、外部リソース作成、メール送信、注文、旧入口切替を行うコマンドは用意していません。`npm run build` 内の `wrangler deploy --dry-run` はローカルでbundleを作るだけです。

## ルール取込

原資料メタデータを管理画面で登録後、CapabilityRuleの配列JSONまたはCSVを読み込みます。既定は検証のみです。

```bash
npm run rules:import -- fixtures/demo/knowledge.json
npm run rules:import -- rules.csv
npm run rules:import -- rules.json --apply
```

CSVのヘッダーはCapabilityRuleのフィールド名です。`predicates` / `modelAliases` / `requiredFields` / `coveredFields` 列はJSON、`isDemo`はtrue/false、`version`は整数です。空の承認者・承認日時・有効期限はnullです。CSV内のJSONは通常のCSV引用規則で引用してください。既存ルールの更新はversionを増やします。承認・撤回は `approvalStatus` を更新し、保存前に検証プレビューで対象・依頼方式・根拠・公開説明を確認します。

管理APIはループバック限定の `X-Local-Admin-Token` と匿名セッションを必要とし、更新にはOrigin/CSRF検証を適用します。ローカル保存先は `.wrangler/state/`、Gitには入りません。案件・添付は作成から30日、本文を含まない監査は90日を暫定値としています。

## 検証コマンド

```bash
npm run check
npm run test:e2e
npm run measure:local
```

| コマンド | 検証対象 |
| --- | --- |
| `typecheck` / `lint` | 型・実装規約 |
| `test:contracts` | 契約版2、不正な肯定、余分な公開フィールドの拒否 |
| `test:domain` | 聞き取り・更新・分野/個別判定・公開DTO・メール文・抽出障害 |
| `test:integration` | 実ローカルD1/R2、CAS競合・outbox・lease・失効・権限・分割 |
| `test:e2e` | ChromiumのPC/モバイル表示、4プロフィールとメール文までの操作 |
| `test:isolation` | 旧コード・旧API・セッションへの依存と許可外endpointの検出 |
| `build` | Vite資産・Workerのdry-run bundle |
| `measure:local` | 外部処理なしの選択100操作・自由文30入力・調査20案件 |
| `eval:live` | 実評価未実施を明示して終了コード2。外部送信を行いません |
| `intake:status` / `intake:resume` | 使用数・停止状態の確認 / 管理者による明示再開 |
| `contracts:generate` | 設計スキーマから型・静的ランタイムvalidatorを再生成 |

E2Eはメールソフトも外部送信も起動しません。`playwright.config.ts` はlocalhostだけを使います。ブラウザが未導入なら `npx playwright install chromium` を実行してください。

詳しい検証結果・制約は [docs/LOCAL-VALIDATION.md](docs/LOCAL-VALIDATION.md)、測定値は [docs/LOCAL-MEASUREMENTS.json](docs/LOCAL-MEASUREMENTS.json) にあります。

## 構成と設計資料

`src/domain/` は判定・更新、`src/adapters/` はローカル保存と抽出、`src/http/` はAPIと認証、`src/ui/` は画面です。`src/worker.ts` がHTTP、`src/research-worker.ts` がQueueと保守を扱います。同じローカルWorkerで両ハンドラを実行し、domainはCloudflare APIに依存しません。

原本を変更せずコピーした [docs/design/README.md](docs/design/README.md) から設計版1.1を参照できます。実装上の補足は [docs/IMPLEMENTATION-NOTES.md](docs/IMPLEMENTATION-NOTES.md) に記録します。
