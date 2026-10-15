# ローカル回答エージェントでの会話テスト（2026-10-15）

OpenAIの残高不足の間も会話テストを進めるため、専用のCodexバックエンドを1プロセス起動し、アプリが使うResponses APIのテキスト生成部分をローカルで受ける構成を追加した。固定文を返すモックではなく、Codexが入力と履歴から回答を生成する。

## 使い方

- 会話テスト用サイト：`http://localhost:3212`
- 管理画面：`http://localhost:3212/admin`（コピー済みのローカル管理パスワード）
- 互換API：`http://127.0.0.1:4010/v1/responses`
- Orcaターミナル：「会話テスト・API回答エージェント」

このターミナルでは回答サーバーと試験用サイトを一緒に起動している。停止はそのターミナルでCtrl+C。再開はプロジェクト直下で次を実行する。

```sh
npm run dev:agent
```

既存のCodex CLIとChatGPTログインを使う。OpenAI APIキーはこの構成では使わず、Codex側の利用枠・接続状態に従う。APIのモデル名 `local-agent` は試験用の識別名であり、`gpt-4.1-mini` を動かしているという意味ではない。回答の実モデルはCodexの既定設定を使う。

同時に処理するリクエストは1件。ほかの会話と混ざらないよう、リクエストごとに一時的なモデル文脈を作り、会話履歴はアプリから渡す。新しい独立した作業エージェントを毎回起動する方式ではない。

## データと実APIの扱い

通常DB `.data/aokienji.sqlite` は読み取り専用でバックアップし、試験DB `.data/verification/agent-api/sandbox/aokienji.sqlite` にコピーした。仕入先知識41件と既存の相談履歴を保持したまま、スキーマ更新・新しい会話・AI利用記録はコピーに保存する。通常DBの内容・設定は変更しない。

試験DBの設定はローカル分類＋OpenAI互換の回答生成。実注文、自動注文、自動見積、外部検索、担当者向けAI調査はオフ。実OpenAI・Jev・Gemini・検索APIのキーを試験用アプリでは無効化し、Codexの子プロセスにも渡さない。

アプリ側の価格・在庫・納期・販売可否の確定処理と、生成文の非公開情報・数値・約束の検査は従来のまま。ローカル接続はdevelopment/testかつ`.data/verification/`の独立DB、デモモード、実注文禁止の場合だけ許可する。一般の外部URL取得に使う `safeFetch` のlocalhost拒否は維持している。

元のOpenAI Authorizationヘッダーはローカルサーバーへ転送しない。ローカル専用のランダムトークンを作り、`/tmp/aoki-agent-api-*/token` に600で保存して両プロセス間で使用する。トークンの値は表示しない。

## 対応するAPI範囲

`POST /v1/responses` のテキスト生成、JSON Schemaによる回答形式、ストリーミング・非ストリーミング、`GET /v1/models`、`GET /health` に対応する。APIとモデル名でローカル試験と識別し、トークン利用量を捏造せず `usage: null` を返す。

アプリが読む `response.output_text.delta` と `response.completed` 等のSSEイベントは、[公式Responses APIのストリーミング形式](https://developers.openai.com/api/docs/guides/streaming-responses)を参考に実装した。Codexとの接続には[公式Codex App Server](https://learn.chatgpt.com/docs/app-server)のstdioプロトコルを使い、実際に導入されたCLI 0.162.1のJSON Schemaでも形式を確認した。

Web検索・ツール呼出・プロバイダー側の履歴保存は未対応として拒否する。Web調査結果や価格・在庫をそれらしく生成して成功扱いにはしない。実OpenAI APIの残高・利用量・応答時間・対象モデルの品質・担当者向けWeb調査の評価は、接続回復後の別試験として残る。

Codexの応答は本来のAPIより待ち時間が長いため、ローカル試験だけ応答上限を約2分に延ばした。通常接続のタイムアウト・再試行条件は変えていない。

## 実装と検証

- `scripts/agent-openai-server.mjs`：専用Codexバックエンドと互換HTTP API。
- `scripts/local-agent-test.mjs`：DBのコピー、試験設定、両サーバーの起動・終了。
- `lib/server/response-transport.ts`：開発専用接続、送信先・認証・タイムアウト制御。
- `scripts/agent-chat-regression.mjs`：試験サイトへ6会話・17問を順番に送る会話確認。
- `tests/local-agent-api.test.ts`：接続制約・認証・認証情報の分離・リダイレクト拒否・SSE等の10件。

```sh
node scripts/agent-chat-regression.mjs
# 中断後、最後まで完了した会話を保持して再開する場合
node scripts/agent-chat-regression.mjs --resume
```

結果は `.data/verification/agent-api/conversation-results.json` と `conversation-checks.json` に保存する。これらの会話試験は専用Codexの実際の生成回答を使う。通常の単体テストとE2Eは実APIを使わない。

型チェック、単体テスト190件（既存180件＋追加10件）、既存E2EのPC・モバイル24件が成功。buildも成功した。

復元DBが存在する状態のbuildで、ファイル追跡にローカルDBが含まれることを実際に確認したため、`next.config.ts` に `.data/`・`.env*`・`.local-admin.txt` の除外を追加した。修正後のAPIルートの出力ファイル一覧に、これらのローカルファイルが0件であることを確認した。データ自体の削除・移動は行っていない。

## 会話・画面の確認結果

専用Codexによる生成回答を使い、6会話・17問を完了した。13問が生成回答、4問が登録値・非公開方針によるローカル回答。対象会話のローカルAPI呼出は14回で、採用13回、業務条件の検査で拒否した下書き1回（書き直し後に採用）。失敗・未完了の呼出は0件、試験中の実OpenAI Responses API呼出も0件だった。

| 会話 | 確認できたこと |
| --- | --- |
| 冷却水バルブ | 比較の説明、短い返事への継続、メーカー不明時に写真で進める案内、25A・40度等を保持した担当者向け要約 |
| ベアリング | NSK・6205DDU・大阪を維持し、40個→60個の訂正を要約へ反映。到着日を作らず、条件によって変わる旨を回答 |
| 別品目への切替 | 鋳物部品からSUS304板へ話題を切り替え、板の寸法・用途で相談を継続 |
| 仕入先の非公開 | パッキン分野の案内は行い、社名・HPの要求には非公開方針を返す。41件の仕入先知識にある名前・URLの漏えい検査は0件 |
| 使用温度が不明 | 温度の数値を作らず、炉の資料・型式・写真等で確認を進める回答 |
| 価格を表示してから別品目へ切替 | コピーDBのデモ商品だけ確認日を一時更新して登録価格を表示し、その価格をSUS304板へ流用しないことを確認。試験後に商品レコードを元の内容へ復元 |

通常の移行データのデモ商品は2026-10-02の確認日であり、現在は確認期限を過ぎている。価格・在庫・納期が担当者確認の案内になるのは既存ルールどおり。元DBの確認日を書き換えて価格を有効にする操作は行っていない。

Playwrightで試験サイトを実際に操作し、生成チャットのSSE・本文表示、390px幅で横はみ出しがないこと、コピー済みのパスワードによるフォームからの管理ログインを確認した。管理画面の商品6件・情報源2件も確認。Orcaの埋め込みブラウザにも試験サイトを開いた。

保存物は `.data/verification/agent-api/` 配下の `conversation-results.json`、`conversation-checks.json`、`browser-checks.json`、`preservation-checks.json`、`agent-chat-desktop.png`、`agent-chat-mobile.png`、`agent-admin.png`。秘密の値を文書やGitに追加していない。

最終の保存確認では、通常DBのファイル全体が受領バックアップと一致し、元DBとコピーDBの整合性はともに `ok`。商品6件・情報源2件・仕入先知識41件・元の会話12件・メッセージ66件の全レコードがコピーにも同じ内容で残っていた。新しい `research_notes` テーブルはコピー側だけで自動作成できた。

今回の台本では、修正が必要な新しいアプリの会話不具合は見つからなかった。実OpenAIの対象モデルでの品質・速度・Web調査、以前から残る広範囲の会話評価や技術説明の正確性は、引き続き別の確認として扱う。
