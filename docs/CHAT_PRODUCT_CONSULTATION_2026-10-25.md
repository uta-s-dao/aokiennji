# 商品相談チャットの改修・検証記録（2026-10-25）

当初は実装・検証まで承認。その後「本番環境にデプロイしていいよ。メインにつなげていいよ。」と公開・main統合の承認を受けた。作業前の関連ファイルは `/tmp/aoki-chat-baseline` にコピーし、既存の広範囲の未コミット変更を保持した。前回の `/tmp/aoki-customer-20261022.md` は見つからなかった。

## 会話と照会の境界

- 共通方針を `lib/consultation-policy.ts` に置き、定型文、構造化解釈、画像読取、回答生成で共有する。新しい商品相談経路は特定のモデル名に依存しない。既存の段階的相談からも移行可能。
- 型番入力、図面・部品表・箱・タグ・銘板の表示確認、写真、用途・形状からの特定を優先する。固定の温度→材質→寸法巡回をやめ、短い数値は意味・単位を確認する。
- 型番・メーカー・数量・単位・配送先と訂正前の型番を会話状態に保持する。新商品の話題では旧条件を引き継がない。見積不要を会話終了と扱わない。
- AIは意味解釈と回答表現を担当し、照会・販売条件・見積案内の決定はサーバーが行う。回答生成は根拠、数値、公開権限、未実行の約束、不要な見積誘導、許可した追加質問を検証する。検証不合格時は共通方針の定型回答へ戻る。
- 登録商品・公開可能な登録在庫と、既存の `sourceProduct()` による調達照会を使用する。外部検索無効時は過去の仕入先ページ再取得も行わない。数量・配送先に応じた概算は、価格を尋ねられた場合に既存の承認済み調達条件から算出する。正式見積依頼は顧客の明示希望後。
- 取扱分野、個別商品の販売・調達可否、自社登録在庫、仕入先掲載在庫、確保数量を区別する。照会結果がなければ販売不可と断定しない。登録値の確認日を示し、実在庫・確保数量とは区別する。

終了条件は、(1)商品を特定し確認できた範囲と未確認事項を返す、(2)資料・条件から特定できなければ不足と次の確認方法を示す、(3)画像は顧客確認待ちにする、のいずれか。見積への移行だけを成功とは扱わない。

## 顧客写真

- 「写真を選ぶ」「カメラで撮る」、送信前プレビュー・削除・撮り直しを追加。カメラ非対応・使用不可でも写真選択が使える。
- JPEG／PNG／WebP、5MB、2,500万画素を検証し、向き補正・最大1920px・WebP再生成で元ファイルのメタデータを除去する。APIは1ターン3枚まで、UIは1枚ずつ送信。
- 新しい非公開テーブル `chat_images` に保存する。会話所有者または管理者認証済み社員だけが閲覧できる。公開用 `site_images` や商品検索用資料には入れない。レスポンスは `private, no-store`。一会話12枚、全体100MBの技術的上限を設ける。
- 読取結果は対象部品・メーカー・表示文字・番号の種類・判読状態に分ける。図面番号／部品番号を自動で注文用型番にしない。複数対象は番号を確認し、顧客確認・訂正後だけ照会する。曖昧な文字は確定せず拡大を依頼する。
- 画像読取はOpenAI回答プロバイダー設定時に既存AI利用枠へ予約・精算する。画像料金上限を見積もれる `gpt-4.1`／`gpt-4.1-mini`／`gpt-5-mini` の高詳細入力だけを許可し、不明なモデル・モダリティは送信前に拒否する。読取不可時も文字で相談を続けられる。
- `supabase/migrations/202610250001_chat_images.sql` はローカル検証DBのみ適用済み。本番マイグレーション、デプロイ、保存期間の自動運用は未実施。

## 実行環境と検証

公開サイト `/api/config` を読み取り、`webSearch=false`、`aiResearch=false` を再確認した。コードの存在と本番での有効化は別で、本番設定は変更していない。公開APIでは回答モデル名は取得できない。

実OpenAI画像入力で、合成した箱ラベル・タグ・複数部品の図面・文字を強くぼかした画像の4件を検証し、型番候補・部品番号の区別・判読不能時の推測抑制を確認した。`scripts/verify-chat-vision.ts` は読取内容の検証を含む。関連単体・統合テスト7ファイル105件、PC／モバイルE2E10件、型チェックが成功。最後に訂正後の引継ぎ文を明確にし、対象単体テストを追加し、13件の再確認も成功した。内部コードを知らせない顧客役エージェントによる最終評価は3ケース・計7往復で重点項目すべて合格。初回評価で見つかった写真なしループ、既知形状の再質問、旧型番条件の確認応答を修正して再評価した。[最終会話記録](research/chat-customer-2026-10-25.json)には認証Cookie・所有者IDを含めていない。未知金具の詳細依頼がやや広いという軽微な改善余地は残る。実メール送信、正式見積発行、注文の実行はしない。既存業務テストは隔離されたローカルDBとモックを使う。

## 別計画と公開前の確認

社員回答を同じ顧客チャットへ届ける処理は今回未実装。[別計画](CHAT_INQUIRY_STAFF_REPLY_PLAN.md)に境界・受入条件・会社確認との対応を記載した。Q007〜Q009・Q016・Q018の既存未回答事項を使用し、質問票の重複追加はしない。

実機確認はiOS／Androidのカメラ起動、撮影キャンセル、権限拒否、HEIC等の非対応写真、実際の箱・銘板・図面の判読精度。合成画像・ブラウザーのモバイルエミュレーションによる確認を、実機撮影の検証済みとは扱わない。

設計参考：[OpenAI agent guide](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf)、[Evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices)、[Anthropic Building effective agents](https://www.anthropic.com/research/building-effective-agents)。目的・使える照会・権限・終了条件を分離し、顧客の目的達成と実行トレースを照合する。[OpenAI Images and vision](https://developers.openai.com/api/docs/guides/images-vision)を画像入力と料金上限の確認に使用した。

## 検証コマンド

- `node scripts/database-local.mjs npx vitest run tests/product-inquiry.test.ts tests/chat-ux-regressions.test.ts tests/chat-request.test.ts tests/ai-budget.test.ts tests/conversation-history.test.ts tests/ai-responses.test.ts tests/sourcing.test.ts`：105件成功。引継ぎ文の訂正条件を先頭に明示する最終変更後、`tests/product-inquiry.test.ts` 13件を再実行して成功（追加1件を含む）。
- `LD_LIBRARY_PATH=/tmp/aoki-chat-browser-libs/usr/lib/x86_64-linux-gnu node scripts/database-local.mjs npx playwright test tests/e2e/chat-photos.spec.ts tests/e2e/chat.spec.ts`：10件成功。初回のOS共有ライブラリ不足を検証専用ディレクトリへの展開で解消。
- `node scripts/database-local.mjs npx tsx scripts/verify-chat-vision.ts`：実OpenAI画像入力4件の内容検証に成功。合成フィクスチャのみ。
- `npm run typecheck`、`git diff --check`：成功。
- ローカル検証サーバーは検証後に停止。本番DB・本番設定・公開URLへの書き込みは行っていない。

## main統合・本番公開（追記）

- 最新main `771b8c8` を起点に `/tmp/aokiennji-release-20261025` へ今回の差分と必要な再送・引継ぎ依存を移植。既存作業フォルダーは変更しない。
- 写真のサーバー処理は本番の既存画像処理と同じPhoton/WASMへ変更し、Workersでnative sharpを使用しない。APIの画像形式・サイズ・所有権制限を維持。
- 本番設定の実測は `responseProvider=local`、`responseModel=""`、`webSearch=false`、`aiResearch=false`。設定を維持するため、本番で画像AI文字読み取りは有効にならない。写真送信・保存・権限確認と文字による商品照会は利用可能。
- 統合時に問い合わせフォームの保存キー互換を修正。単体106件（105件成功＋不合格だった1件を含む11件の再実行成功）、PC/スマホ10件の該当修正後再検証、型チェック、vinext build、Wrangler dry-runを確認。
- 指定の売買集計Excelは今回未登録・未検証。社員回答を同じチャットへ戻す機能は別計画のまま。
