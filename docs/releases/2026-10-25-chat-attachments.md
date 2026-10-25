# チャット添付と会社アイコン（2026-10-25）

## 実装

- 入力欄の＋から、カメラで撮影／写真を選択／ファイルを選択。
- 画像はJPEG・PNG・WebP、資料はPDF・docx・xlsx・txt・csv。5MBを超えた場合にエラーを表示し、通常画面に容量制限を常時表示しない。
- 添付は既存の会話所有権で保護。資料の元バイトとファイル名を保存し、顧客・管理者からダウンロードできる。
- 資料本文は最大12,000文字を参考情報として相談処理へ渡す。本文を抽出できない資料も保存し、読取済みとは扱わない。資料を会社の確認済み在庫・価格・販売条件や公開の情報源へ登録しない。
- `202610250002_chat_attachments.sql` で既存の非公開添付表へ content_type/file_name/extracted_text の3列を追加。既存画像には既定値を付ける。

## 会社画像

元画像：`public/images/legacy/header-logo.png`。内蔵 image_gen ツールで元の円形マークを忠実に清書し、形状・青色・白い線を目視確認。

保存先：

- `public/images/brand/emblem-master.png`：生成マスター
- `app/icon.png`：512×512
- `app/apple-icon.png`：180×180
- `app/favicon.ico`：RGBA PNGを内包する48×48 ICO
- `public/images/brand/company-share.png`：1200×630、Open Graph／Twitter共通

社名「アオキエンジ株式会社」と英語表記はローカルフォントで正確に組版。`scripts/generate-brand-assets.mjs` で各サイズ・共有画像を再生成できる。既存ヘッダーロゴは原本として保持。

生成プロンプト：

> Use case: precise-object-edit. Asset type: faithful high-resolution company emblem master for favicon, Apple touch icon and website sharing. Edit target: the small circular blue emblem at the far left of the supplied original AOKI ENG company header. Reproduce ONLY that emblem centered on a pure white square canvas, emblem about 82% of canvas width, crisp polished clean edges. Preserve the EXACT original circular blue outline, inner white geometric strokes, proportions and blue/lavender gradient. The original emblem is the identity and must remain immediately identical; no redesign, no additional lines, no added letters or other marks. Remove all surrounding wordmark, address, phone text and original header border. Flat frontal graphic, no shadow, no mockup, no texture. Output a single square image.

## 検証・配置

元の作業フォルダーには他作業の多数の変更がある。本番の最新版 `b2536f8` を基に `/tmp/aoki-attachments-20261025` へ今回の変更だけを移植し、本番のWASM画像処理、商品相談入口のガード、見積意図の確認、管理操作の監査を維持した。

- 型チェック：成功。
- 関連単体試験：3ファイル21件成功。最終の非対応拡張子ガード追加後、添付4件を再実行して成功。
- PC・スマホE2E：6件成功。撮影用picker・写真選択・削除・撮り直し、資料選択、超過エラー、ダウンロード、所有権、再読込、アイコンと共有メタ情報を確認。
- 本番用vinextビルド：成功。ICO内PNGをRGBAにしてNext.jsの互換性も確認。
- 本番DB：202610250002のみ適用。設定・公開原稿・下書き原稿のハッシュを前後比較し保持を確認。
- 本番：PC・スマホで＋メニュー、カメラcapture指定、写真・資料選択、容量エラー、資料送信・取得、会話再表示、所有権拒否を確認。画像3種のサイズとfavicon配信、OG／Twitter画像URLを確認。
- 最終配置版：`1e629da6-f19c-4465-bfab-4169ea22a29d`、Cloudflare Worker `aoki-enji`。
- 実機カメラのハードウェア操作や、LINE等の外部共有サービス自身のキャッシュ更新は自動試験の対象外。
- 確認に用いた会話・添付データは作成IDを記録して削除。既存の会話には触れない。
