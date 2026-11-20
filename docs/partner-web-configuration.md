# 協力会社のWeb調査設定

Web調査は初期状態で無効です。社内マスタを全品目で正常に検索でき、一致候補と要確認候補が案件全体で両方とも0件だった場合だけ実行します。マスタ未登録・取込失敗・検索失敗・未完了はWeb調査へ進みません。

```dotenv
EXTERNAL_ENABLED=true
PARTNER_WEB_ENABLED=true
PARTNER_WEB_PROVIDER=brave
BRAVE_SEARCH_API_KEY=サーバーの秘密設定へ登録

# 未登録の会社も本文確認する場合。未設定なら検索で発見したURLだけを未確認として保持。
PARTNER_WEB_READER=jina
# 任意。Reader側の認証を利用する場合のみ設定。
JINA_API_KEY=サーバーの秘密設定へ登録

# 任意。管理者が許可した公開サイトのみHTTPS本文を直接取得。
# 完全一致のみ。ワイルドカード、IP、内部名、ポート、資格情報、機密クエリ、fragmentは不可。商品id等の安全な識別子クエリは保持し、utm等の追跡クエリを除去。
PARTNER_WEB_ALLOWED_HOSTS=www.company-a.co.jp,www.company-b.co.jp
```

Brave検索APIの固定originへ、認識した品名・加工・材質、型番、数値・単位、希望日だけを送ります。顧客名、案件ID、会話、メモ、住所、添付、原文全体は送りません。辞書外の自由文はクエリに流しません。上記ホストの事前登録は未知の会社の発見には不要です。

Readerを有効にした場合、検索の応答に実在した安全なHTTPS公開URLだけを、固定の `https://r.jina.ai/` にPOSTします。送信JSONはURLと本文取得方式の固定設定だけです。アプリの実行環境から未知サイトへ直接接続しません。Readerの応答URLが対象URLと一致しない場合は本文を根拠にしません。直接取得のHTTPリダイレクトも追いません。

試行を含め1ジョブあたり検索2回・本文4件、全体25秒・1要求4秒、応答200KB以内に制限します。親ワーカーの永続予約により、同じジョブの再配信時には外部調査を再実行しません。検索の429/5xxのみ残り検索枠内で1回再試行し、本文取得は再試行しません。

公開ページ本文の同じ商品・型番または加工ブロック内で確認できた条件だけを、URLと確認日時、未確認条件と併記します。別商品・別設備の材質や寸法、検索抜粋、script、否定記載を肯定根拠に使いません。型番の末尾違いも区別します。同じ商品ブロックの在庫・出荷目安は「ページ記載」と明示し、今回の在庫確保・受注・納期を保証しません。

公開結果へのホスト許可は `PARTNER_WEB_PUBLIC_HOSTS` によって結果の保存時と取得時に確認します。取得できたことだけで顧客向け公開は許可されません。

仕様確認元： [Brave Web Search](https://api-dashboard.search.brave.com/api-reference/web/search/get)、[Jina Reader API](https://r.jina.ai/docs)。fixtureテストは通信transportを差し替え、外部への実送信を行いません。
