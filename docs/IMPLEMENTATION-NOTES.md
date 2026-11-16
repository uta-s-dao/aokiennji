# 設計版1.1に対するローカル実装の補足

2026年11月16日。設計原本の意味・契約フィールド・合否基準は変更していません。公開契約は `urn:aoki:availability-v2:contracts:2`、ResearchBrief.schemaVersionは2です。

- `PATCH /fields` の応答は、主要スキーマに型がないため補助DTO `{kind:"field_update",caseId,revision,canResearch,notice}` としました。保存だけで再調査せず、顧客の明示操作を待ちます。回答・調査開始の応答はIntakeResponse、結果はPublicResultをランタイム検証します。
- 分野対象外のbusiness_scopeルールだけでは個別依頼のout_of_scopeを生成しません。個別依頼の肯定・否定はrequestルールが必要で、両者の意味を分離します。
- ルール承認には、原資料の売り手の役割と現在の方針への確認段階を要求します。過去メール、買い手としての購入、照会中の資料を直接承認根拠へ転用できません。架空資料にはisDemoを付け、画面でもデモを明示します。
- 一つのローカルWorkerにHTTP・Queue・scheduledハンドラを載せています。consumerの実装は別モジュールです。実用環境用の別Worker分離・実インフラ設定は今回未作成です。
- D1 CASは、期待revisionなどを検査するCHECK制約付きのwrite_guards挿入をbatch先頭に置き、不一致ならbatch全体をrollbackします。0行UPDATEを成功扱いにする構成ではありません。結果commitにも入力版・知識版・leaseToken・lease期限・60秒期限・案件有効性のガードがあります。
- 訂正前後の値と入力イベント参照はcase_events.event_jsonに保存し、現在スナップショットとは分離します。メール文は現在のフィールドから作ります。暫定保管期限の処理時は履歴・結果・ジョブも削除します。
- 添付の差替えは、顧客が「最新図面に差し替える」を選んだ操作として記録し、元の品目との対応を維持します。ファイル名だけで版を選びません。解析adapterは未接続なので添付から寸法を取り込みません。
- 質問設定と属性辞書は読み取り専用コードです。自由文は既定のデモ抽出、または設定済みのOpenAI adapterを1回だけ呼び、3秒の期限を設けます。障害時は元入力を保持します。実モデルの品質を検証したことにはしません。
- raw JSONをコピーして機密フィールドを削除する方法を避け、公開結果はallowlist DTOとして組み立てます。
- ローカルでは5秒間隔でWranglerのローカルscheduledイベントを駆動します。製品画面の進捗は保存されたジョブ状態だけを使います。
- 既定の通信はローカルだけです。OpenAIの明示設定時には抽出用endpointだけを使用します。公開根拠の型はHTTPS URLに対応しますが、このデモの社内ルール根拠は公開説明と確認日時だけを返します。元資料URL・ファイル保存キーは返しません。

技術上の確認には、Cloudflare公式の[React構成](https://developers.cloudflare.com/workers/framework-guides/web-apps/react/)、[D1ローカル開発](https://developers.cloudflare.com/d1/best-practices/local-development/)、[D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)、[ローカルcron試験](https://developers.cloudflare.com/workers/configuration/cron-triggers/#test-cron-triggers-locally)を参照しました。この実装はViteでUIをビルドし、WranglerでローカルWorkerと静的資産を配信します。

段階4の接続・利用上限・未確認入力の扱いは [INTAKE-INTEGRATION.md](INTAKE-INTEGRATION.md) に追記しました。公開契約版2と設計原本は変更していません。


## 実モデル評価後の修正

未確定変更は非公開snapshotのpendingChanges（eventId/itemId/key）とunresolvedInputsに保存します。対応欄を明示更新した場合だけ関連保留を解消し、無関係な入力は保留を消しません。保留中はResearchBriefへ未確認入力のmarkerを渡し、判定・根拠・旧条件の表示を保留します。メールは旧構造化値と結果を列挙せず、最新未確認原文を渡します。公開契約版2とDBスキーマは維持しました。過去のsnapshotを一括変換する処理は行っていません。

分類は型番aliasと明示対応表から候補を決め、最終判定で承認・seller資料・期限・全必須条件を再検証します。fixtures/demo/classification.jsonは架空のdemo-source/ruleに限った名称対応で、会社本番の分類管理機能ではありません。モデルのcategory指定単独では確定しません。

引用の補正は原文の一意な文へ限定します。属性名・数値・単位・品目との対応を検査し、不明/非開示の言い回しを拡張しました。最新の検証・費用・未達は[LIVE-REPAIR-20261116.md](LIVE-REPAIR-20261116.md)を参照してください。
