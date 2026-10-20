# アオキエンジ Webサイト・商品相談システム 実装計画書

作成日: 2026-10-02。依頼者の承認済み範囲: この計画書を作成した後、そのまま実装を開始する。実装は下位モデルに委譲し、主担当が統合・検証する。

## 1. 目指す完成形

アオキエンジ株式会社の会社案内を、製品・サービス・実績が探しやすい日本語サイトに刷新する。トップ画面に商品相談の入力欄を配置し、お客様が商品名・型番・用途を入力すると、根拠のある取扱回答、製作相談、見積依頼、見積確認、注文依頼まで進める。

社員は管理画面から、商品、仕入先、Excel等の情報源、チャット履歴、引継ぎ案件、見積、注文、機能設定を操作する。情報源・検索サービス・判断モデルは交換可能。管理画面のスイッチは表示とサーバー処理の両方に適用され、再起動後も保存される。

**完成の基準は動作する業務フローである。** ボタンだけのモック、localStorageだけの業務データ、固定応答だけの「AI接続済み」表示を完成扱いしない。API契約と以下の受入条件を実装者の共通基準とする。

## 2. 確定事項・前提

- 自社ExcelとWeb検索の両方が必要。複数形式を取り込む共通コネクターを用意する。
- 取扱回答、価格、在庫、納期、見積、注文の全機能を実装し、それぞれ管理者が有効化できる。
- 実在する仕入先の認証情報、商品表、販売条件、API仕様は未提供。初期状態は明示されたデモデータとデモ注文を使用する。
- 外部連携コードと設定画面は作る。鍵のない接続は「未設定」、未検証は「未検証」と表示する。実データとの照合・実発注・本番公開は今回実施したと表示しない。
- 汎用REST/CSV URLコネクターを用意し、特定ERP、非公開ログインサイト、独自OAuthの接続は同じインターフェースで拡張できる。未実装の独自接続まで対応済みとしない。
- 通常の公開ページには開発用語や構成説明を出さない。デモモードのみ「デモ環境：商品・価格・注文は確認用です」を簡潔に表示する。
- 既存ドメインへのデプロイ、外部へのメール送信、実発注はこの作業では行わない。

## 3. 現行サイトから移行する情報

取得元: http://www.aokieng.co.jp/ 、/products/ 、/profile/ （2026-10-02確認）。

- 社名: アオキエンジ株式会社 / AOKI ENG CO., LTD.
- 住所: 〒800-0037 福岡県北九州市門司区原町別院1番26号
- 電話: 093-382-2110 / FAX: 093-382-2175
- 事業: 鋼構造物及び機械装置の設計・製作・据付、耐熱ガラス、炉内金物、鋳物、スタッド及び取付工事、土木建築工事、太陽光発電設備の設置工事。
- 実績例: 貯蔵サイロ、屋外タンク、工業炉の耐火材施工、搬送台車、排ガスダクト、熱交換器。
- 1990年創立。最新性が不明な人数・取引先の取引条件等は勝手に補完しない。
- 写真は現行サイトの実績写真をローカルに取得して使用し、取得元を記録する。架空の製造設備を実績写真として使わない。
- 現行URL `/products/`, `/profile/`, `/contact/` を維持する。新しい実績一覧は `/projects/`。

## 4. デザインと画面の完成条件

### 公開画面

工業分野の信頼感を出す。深いネイビー #102a43、青 #1464e8、白/淡いグレーを基本に、実績写真を大きく扱う。和文本文16px以上、強い見出し、広い余白、細い罫線、控えめな丸角。過度なグラデーションや絵文字主体の装飾は避ける。

| パス              | 必須内容                                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/`               | ロゴ・ナビ、工場写真と「ものづくりの、その先まで。」の主見出し、設計から据付までの説明、ファーストビュー内の商品相談フォーム、相談例チップ、事業カード、実績写真、依頼の流れ、会社・連絡先 |
| `/products`       | 事業カテゴリ、型番/商品名検索、商品カード、検索なし/結果なし、確認できる取扱状態、個別相談ボタン                                                                                           |
| `/products/[id]`  | 商品の仕様・用途、情報確認日、取扱状態、ONにした価格/在庫/納期、見積依頼。デモ商品は明示                                                                                                   |
| `/projects`       | 写真付き実績一覧、カテゴリ絞り込み、相談への導線                                                                                                                                           |
| `/profile`        | 会社情報・事業・所在地への地図リンク                                                                                                                                                       |
| `/contact`        | 名前、会社、メール、相談内容、同意付き問い合わせ。保存後に受付番号                                                                                                                         |
| `/quotes/[token]` | 推測困難な専用リンク、見積明細/税込合計/期限/状態、内容確認チェックと注文依頼ボタン。失効・重複も扱う                                                                                      |
| `/privacy`        | このプロトタイプが保存する連絡先・会話・利用目的、運用開始前の正式方針確認が必要な旨                                                                                                       |

共通チャットは全公開ページ右下に固定。トップの入力欄と同じ会話を開く。モバイルはほぼ全画面、デスクトップは右側パネル。閉じる/Escape/キーボード/フォーカス復帰、送信中、再試行、空入力、エラー、長文折返しに対応。会話ごとにサーバー側の匿名セッション所有権を検証する。

### 管理画面

`/admin/login` からパスワード認証し、`/admin` のサイドバー/タブで以下を操作。直接URL/APIも認証必須。

| 項目       | 必須操作                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------- |
| 概要       | 商品/情報源/相談/見積/注文の実件数、確認待ち案件、直近活動                                                        |
| 商品       | 一覧・検索・追加・編集、仕様/価格/在庫/納期/取扱状態/承認/確認日/公開設定                                         |
| 情報源     | manual / csv / xlsx / pdf / docx / text / website / csv_url / json_api を追加・編集・無効化、取得履歴、エラー表示 |
| インポート | ファイル選択→列名とサンプル確認→列対応付け→プレビュー→確定。行エラーは行番号と理由。上書き対象を確認できる        |
| 仕入先     | 名称、許可ドメイン、取引承認、注文Webhook URL/秘密の環境変数名、有効化                                            |
| 相談       | 会話履歴、情報根拠、担当者への引継ぎ、相談状態と担当メモ                                                          |
| 見積       | 依頼詳細、明細/数量/単価/送料/税率/有効期限編集、確定・専用リンク表示、印刷                                       |
| 注文       | 見積から作成した注文、確認/承認/送信、デモと実送信の表示、失敗状態と再試行、履歴                                  |
| 設定       | 機能スイッチ、検索プロバイダー、判断プロバイダー、モデル名、鮮度期限、デモ運用表示、接続状態                      |

空一覧でも追加/取込/相談開始への操作を用意。全保存に成功/失敗を表示。設定は取得中の初期値で上書きしない。

## 5. 情報源とAIの選択

| 方式                   | 役割                                     | この実装での扱い                                                                 |
| ---------------------- | ---------------------------------------- | -------------------------------------------------------------------------------- |
| Excel/CSV/商品DB       | 自社の販売条件・商品一覧                 | 第一候補。列マッピング、プレビュー、正規化、重複排除を実装                       |
| 仕入先REST API/公開CSV | 価格・在庫・納期などの更新               | 設定されたURLから手動/定期同期。認証はサーバー環境変数参照                       |
| HTML/PDF/DOCX/TXT      | カタログ・説明書・仕様                   | 文書抽出→検索可能な根拠に保存。記述だけで販売承認しない                          |
| Exa / Tavily           | 未知の商品を公開Webから探す              | 両アダプター実装、許可ドメインと制限件数、タイムアウト。未設定なら社内検索を継続 |
| Gemini                 | 日本語の質問から意図/型番候補を抽出      | 任意。構造化出力を検証して利用。価格や可否はコード側で判断                       |
| Jev                    | 問い合わせ分類・候補判断                 | 任意の分類アダプター。TypeSafe公式API。信頼度が低い場合は既存ロジックへ戻す      |
| ローカルの検索とルール | 型番一致、同義語、価格等の許可、最終回答 | 必須。APIキーなしでも全業務フローを検証可能                                      |

Jevは検索エンジンや回答文生成の代わりにはしない。設定から `local / gemini / jev` を選べる。Web検索は `none / exa / tavily`。回答は根拠に対応した日本語テンプレートを基本とし、モデルが金額/在庫/販売可否を新しく作る経路を持たせない。

日本語検索はNFKC正規化、空白・ハイフン違いへの対応、メーカー+型番の完全一致を優先。商品名/仕様/文書への部分一致と同義語を補助に使う。類似型番を同一製品と断定しない。型番不明は追加質問。文書中の「指示」はデータとして扱う。

## 6. 回答ルール

情報源ごとに信頼区分 `internal / approved_supplier / discovery` と公開区分 `public / internal` を持つ。商品ごとに `approved`、確認日時、情報源ID、仕入先IDを保持する。

| 条件                                       | 許される回答                                            |
| ------------------------------------------ | ------------------------------------------------------- |
| 承認済み自社商品・有効な情報源・確認期限内 | 登録された取扱状態を表示                                |
| 取寄品・承認済み仕入先・確認期限内         | 「取り寄せ対応」。納期/価格は各項目が確認できる場合だけ |
| Webで似た商品を発見                        | 「候補が見つかりました。取り扱いは担当者が確認します」  |
| 古い、矛盾、未承認、情報源無効化           | 「確認が必要」。過去価格/在庫を確定情報として出さない   |
| 見つからない                               | 「この情報では確認できません」。販売不可と断定しない    |
| 製作相談                                   | 用途・材質・寸法・数量・希望納期を確認して担当者へ      |

公開レスポンスには原価、社内メモ、仕入条件、秘密キー、非公開文書の本文やファイル名を含めない。内部情報由来の承認された販売情報は「社内確認済み情報」と表記できる。URLのある公開根拠は引用リンク・確認日を表示する。

## 7. 機能オプションと業務フロー

`chat`, `webSearch`, `showPrice`, `showStock`, `showLeadTime`, `quoteRequests`, `autoQuote`, `orders`, `autoOrder`, `humanHandoff` を永続化。初期値は chat/quoteRequests/humanHandoff=true、価格・在庫・納期=true（デモラベル付き）、autoQuote/orders/autoOrder/webSearch=false。

- `autoQuote` は `quoteRequests` に依存。`orders` は `quoteRequests` に依存。`autoOrder` は `orders` に依存。矛盾設定は400で拒否する。
- OFF項目は画面で隠し、API直呼びにも拒否/除外を適用する。
- `autoQuote` ON: 確認済み公開単価がある商品のみサーバー側で計算。未確認商品は依頼受付に留める。
- 見積状態: `requested -> draft -> issued -> accepted`。取消 `cancelled`、期限超過は受注不可。
- 明細金額は整数円×正整数数量、税率0/8/10、税は合計へのfloor。見積確定時にスナップショットを保存し、顧客が送った金額は使わない。
- 顧客は専用リンクの明細・期限を確認し、明示的に注文依頼する。受諾はトランザクション＋一意制約で重複注文を防ぐ。
- 注文状態: `pending_approval -> approved -> dispatched / simulated / failed`。外部応答が不確かな場合 `needs_reconciliation` として二重送信を防止する。
- `autoOrder` は承認済み仕入先・確定見積・金額上限・有効情報の条件を満たす場合だけ承認処理を自動化する。
- 実送信にはサーバー `ALLOW_LIVE_ORDERS=true`、デモOFF、注文ON、承認済み注文、仕入先連携設定の全条件が必要。環境変数を管理画面から変更できない。
- 初期デモでは承認→送信の全操作を実行できるが、通信せず `simulated` と保存する。確認用と実発注を同じ成功表示にしない。
- 引継ぎは会話と連絡先を管理画面に保存する。メール送信済みと表示しない。

## 8. 技術構成と永続化

- Next.js App Router / React / TypeScript / 素のCSS / lucide-react。
- Node 24、SQLite (better-sqlite3)。単一常駐Nodeサーバーと永続ディスクを前提にする。サーバーレスの一時ファイル領域を本番DBにしない。
- DBは `DATA_DIR` (標準 `.data`) 配下。WAL、外部キー、起動時の冪等マイグレーション、パラメータ付きSQL。デモ初期化は一度だけ。
- エンティティ: settings, products, sources, source_runs, documents, suppliers, conversations, messages, inquiries, quotes, orders, audit_events, sessions。JSON保存カラムを併用してよいがID/所有者/一意制約はDBで守る。
- ファイル解析: ExcelJS (`.xlsx`/CSV)、csv-parse、unpdf、mammoth。画像PDFは空テキストを成功扱いせず「OCRが必要」と通知する。OCRサービスは将来アダプター拡張点として明記する。
- コネクターは取得/解析のみ担当。共通取り込み処理が検証・保存・監査を担当する。
- 同期ジョブ: `npm run sync` を用意し、期限が来た有効ソースを更新。cron等から実行できる。手動同期も同じ処理を使う。失敗時に前回データを消さない。
- 認証: 管理パスワードのscryptハッシュ、HttpOnly/SameSite Cookie、有効期限。開発初期設定スクリプトがランダムパスワードとSESSION_SECRETを `.env.local` に生成し、資格情報を `.local-admin.txt` に保存 (gitignore)。ソースに共通初期パスワードを書かない。
- 匿名顧客セッションもHttpOnly Cookie。会話ID単独で他人の履歴を読めない。
- 変更APIはOrigin確認、認証、Zod検証。ログイン/チャット/問い合わせはレート制限。
- URL取得はhttp(s)のみ、loopback/private/link-local/メタデータ宛/認証情報付URLを拒否。DNS解決とリダイレクト先を毎回検証し、サイズ/時間/件数を制限。APIの秘密ヘッダーを異なるホストに転送しない。
- APIキーは環境変数で保存し、管理画面には設定有無と変数名だけを返す。

## 9. 実装分担とファイル境界

すべて同じ作業フォルダを使用。実装前にこの計画書と `lib/contracts.ts` を読む。共有契約の変更は主担当へ連絡する。担当外ファイルを上書きしない。

1. 主担当: 計画書、`lib/contracts.ts`, `lib/company.ts`, パッケージ/設定、写真取得、統合、E2E、README、最終結果。
2. 下位モデルA: `app/`（`app/api/`以外）と `components/`。公開画面・管理画面・チャット・CSS。
3. 下位モデルB: `lib/server/` のDB/認証/業務サービス、`app/api/`、`scripts/`、業務テスト。Cの担当ファイル以外。
4. 下位モデルC: `lib/server/connectors.ts`, `lib/server/providers.ts`, `lib/server/safe-fetch.ts`、それらのテスト。純粋関数/アダプターとしてDB非依存。

APIは下記契約を優先。実装の都合で変更する場合はUIと計画を同時更新する。

## 10. API契約

成功は `{ data: T }`、失敗は `{ error: { code, message } }`。型は `lib/contracts.ts`。認証/機能OFFは403/401、検証400、見つからない404、競合409、上限429、未設定503。

| Method / URL                          | 入力 → data                                               |
| ------------------------------------- | --------------------------------------------------------- |
| GET `/api/config`                     | → PublicConfig                                            |
| GET `/api/products?q=&category=`      | → Product[] (公開用フィールドに整形)                      |
| GET `/api/products/:id`               | → Product (公開用)                                        |
| POST `/api/chat`                      | `{message, conversationId?}` → ChatResponse               |
| GET `/api/chat/:id`                   | → `{conversation, messages}` (所有者のみ)                 |
| POST `/api/inquiries`                 | InquiryInput → Inquiry                                    |
| POST `/api/quotes`                    | QuoteRequestInput → Quote (依頼者用。token含む)           |
| GET `/api/quotes/:token`              | → Quote (顧客用。内外のメモを混ぜない)                    |
| POST `/api/quotes/:token/accept`      | `{confirmed:true,idempotencyKey}` → Order (顧客用)        |
| POST `/api/auth/login`                | `{password}` → `{authenticated:true}`                     |
| POST `/api/auth/logout`               | → `{authenticated:false}`                                 |
| GET `/api/admin/overview`             | → Overview                                                |
| GET/PUT `/api/admin/settings`         | AppSettings → AppSettings                                 |
| GET `/api/admin/providers`            | → ProviderStatus[] (環境変数設定状態、実疎通とは区別)     |
| GET/POST `/api/admin/products`        | ProductInput → Product[] / Product                        |
| PUT/DELETE `/api/admin/products/:id`  | ProductInput → Product / `{deleted:true}`                 |
| GET/POST `/api/admin/sources`         | SourceInput → Source[] / Source                           |
| PUT/DELETE `/api/admin/sources/:id`   | SourceInput → Source / `{deleted:true}`                   |
| POST `/api/admin/sources/:id/sync`    | → ImportResult                                            |
| GET `/api/admin/sources/:id/runs`     | → SourceRun[]                                             |
| POST `/api/admin/import/preview`      | FormData: file, sourceId → ImportPreview                  |
| POST `/api/admin/import/commit`       | `{previewId,mapping,approved}` → ImportResult             |
| GET/POST `/api/admin/suppliers`       | SupplierInput → Supplier[] / Supplier                     |
| PUT `/api/admin/suppliers/:id`        | SupplierInput → Supplier                                  |
| GET `/api/admin/conversations`        | → Conversation[]                                          |
| GET `/api/admin/conversations/:id`    | → `{conversation,messages}`                               |
| GET `/api/admin/inquiries`            | → Inquiry[]                                               |
| PUT `/api/admin/inquiries/:id`        | `{status,notes}` → Inquiry                                |
| GET `/api/admin/quotes`               | → Quote[]                                                 |
| PUT `/api/admin/quotes/:id`           | `{lines,shipping,taxRate,expiresAt,notes,status}` → Quote |
| GET `/api/admin/orders`               | → Order[]                                                 |
| POST `/api/admin/orders/:id/approve`  | → Order                                                   |
| POST `/api/admin/orders/:id/dispatch` | → Order                                                   |
| GET `/api/admin/audit`                | → AuditEvent[]                                            |

コネクター関数: `parseUpload(fileName: string, buffer: Buffer): Promise<ParsedSource>`、`fetchSource(source: Source): Promise<ParsedSource>`、`mapRows(rows, mapping): {products: ProductInput[], errors: ImportRowError[]}`。

プロバイダー関数: `classifyQuery(message: string, settings: AppSettings): Promise<QueryIntent>`、`searchWeb(query: string, settings: AppSettings, domains: string[]): Promise<Evidence[]>`、`providerStatuses(): ProviderStatus[]`、`dispatchSupplierOrder(order: Order, quote: Quote, supplier: Supplier): Promise<DispatchResult>`。通信するかの条件判定は業務層の責任。

## 11. 受入テスト（完了判定）

| ID         | シナリオ                                          | 必須結果                                            |
| ---------- | ------------------------------------------------- | --------------------------------------------------- |
| UI-01      | 1440px/390pxで公開ページと管理画面                | 横スクロールなし、主なCTA/チャットが操作可能        |
| UI-02      | トップの相談例を選び送信                          | チャットに質問と根拠付き回答、送信中/失敗状態あり   |
| DATA-01    | 日本語列のCSV/XLSXをプレビュー・対応付け・取込    | 商品として検索可能。行エラー/重複を説明             |
| DATA-02    | PDF/DOCX/TXT取込、URL/REST解析テスト              | 抽出内容保存。解析不可を成功扱いしない              |
| DATA-03    | ソース停止/古い確認日/未承認商品                  | 公開回答で確定販売・価格・在庫を出さない            |
| CHAT-01    | 正しい型番、似た型番、不明商品、製作相談          | それぞれ正しい候補/追加質問/確認依頼に分岐          |
| CHAT-02    | APIキーなし/外部検索失敗                          | 社内検索継続。外部取得できたと偽らない              |
| OPT-01     | 設定OFF→公開API直接呼び出し                       | 無効機能で情報漏れ・見積・注文を作れない            |
| FLOW-01    | 相談→見積依頼→管理者確定→顧客受諾→承認→デモ送信   | DBに全状態保存、実通信なし、再受諾/再送信で重複なし |
| FLOW-02    | 期限切れ/数量不正/金額改ざん/無効見積             | サーバーで拒否、金額は保存済み明細から算出          |
| AUTH-01    | 未認証管理API、別匿名セッションの会話             | 401/403/404。履歴・秘密・原価が返らない             |
| NET-01     | private URL、redirect、タイムアウト、秘密ヘッダー | 取得を拒否/制限、秘密が流出しない                   |
| PERSIST-01 | 保存後の再読み込み/プロセス再起動                 | 設定・商品・相談・見積・注文が維持される            |

検証: `npm run typecheck`, `npm test`, `npm run build`, `npm run test:e2e`。実APIは鍵がなければ契約をモックで検証し、その制約を結果に記録する。画面だけ・モックだけで本番の仕入先連携確認済みとしない。

## 12. 起動・運用・引継ぎ

READMEに `npm install` → `npm run setup` → `npm run dev` を記載。初期パスワードの保存場所、環境変数一覧、情報源追加例、CSVテンプレート、機能依存、定期同期、DBバックアップ、デモから本番への切替条件、コネクター追加方法を記載する。

SQLiteファイルとアップロードの永続領域をバックアップ。実運用前に商品データ責任者が取扱承認、価格・在庫の更新周期、注文上限、仕入先エンドポイントを確認する。ホスト/ドメイン/本番資格情報は未提供のため公開環境の移行は別途。

## 13. 調査した公式資料（2026-10-02）

- Jevの役割: https://docs.typesafe.ai/introduction
- Jev HTTP API: https://docs.typesafe.ai/introduction/quickstart (`POST https://api.typesafe.ai/v1/systemone`, `model: jev-latest`, `questions`/`answers`)
- Jevの制約: https://docs.typesafe.ai/model-jaggedness/jev-1.13
- Exa Search: https://exa.ai/docs/reference/search
- Tavily Search: https://docs.tavily.com/documentation/api-reference/endpoint/search
- Gemini 構造化出力: https://ai.google.dev/gemini-api/docs/structured-output
- Gemini Web検索: https://ai.google.dev/gemini-api/docs/google-search
- Next.js: https://nextjs.org/docs/app/getting-started/installation
- ExcelJS: https://github.com/exceljs/exceljs

## 14. 実装状況

- [x] 現行サイト調査・Jevと代替方式の調査
- [x] 詳細計画・画面仕様・API契約・受入条件の確定
- [x] 実装担当への引継ぎ（GPT-6-solに画面・業務・情報源を分担）
- [x] 公開画面・管理画面
- [x] 業務API・永続化・認証
- [x] 情報源コネクター・AI/検索アダプター
- [x] 統合・業務テスト・ブラウザー確認
- [x] README・実装結果・残る接続条件の記録

実装中に下位モデルの利用上限に到達したため、保存済みの作業を主担当が引き継ぎ、統合・修正・検証まで完了した。実装の確認範囲と本番接続に必要な作業は [実装結果](IMPLEMENTATION_REPORT.md) を参照。

## 15. チャット改善（2026-10-03）

利用者の画面確認を受け、納期の言い換え・直前の商品参照・候補選択・数量回答と、パネルの専用領域・折りたたみ式商品カード・入力欄の非重複を実装した。画面仕様のチャット部分は [チャット改善記録](CHAT_IMPROVEMENTS.md) を優先する。APIキーは未設定で、自由な文章を生成するAIの実接続はまだ行っていない。

## 16. 生成AI・Jevによる資料判断・応答速度（2026-10-06）

ユーザーの要求は、資料に基づき会話として相談を続けるチャットである。初期の分類と定型文だけではこの要件を満たしていなかった。Jevへ承認済み分野・公開可能な文書候補を渡し、OpenAI/Geminiへ根拠と履歴を渡して回答文を生成する。型番確定時の即答、分類とWeb検索の並行実行、OpenAIの検査済み段落の途中表示、通信期限を実装する。

詳細な処理・API契約・必要な設定・実装ファイル・テスト条件は [AI接続・実装仕様](AI_SETUP.md)。完了判定を「接続コードとモック検証」「キー設定後の実接続・回答品質・速度検証」に分け、後者の未実施を隠さない。今後の実装担当もこの仕様を引き継ぐ。

追加指示により、ローカルで確定する事実と、AIが補助する相談を [振り分け仕様](CHAT_ROUTING.md) に明文化した。`lib/chat-policy.ts` を振り分けの共通実装とする。事実＋相談の複合質問は、確定本文を先に表示してAI補足を追加する。APIキーの有無に関係なく、登録済みの明確な事実質問では外部APIを呼ばないことを受入条件に加える。
