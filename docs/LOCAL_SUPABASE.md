# 本番データを使わないローカル検証

確認日：2026-10-20。本番はSupabase `aoki_enji`、検証はこの作業環境内の別Postgresとする。既存 `test_multi` と本番を検証に流用しない。

## 起動と停止

Node.jsとnpmがあるLinuxで、リポジトリのルートから実行する。

```bash
node scripts/supabase-local.mjs start
node scripts/supabase-local.mjs status
node scripts/supabase-local.mjs stop
```

ヘルパーはSupabase CLI **2.121.0**を使用し、`supabase/config.toml` の実験的なnative runtimeを起動する。Dockerやsudoは不要。初回は公式サービスのアーカイブを取得する。現時点の構成はPostgres 17、REST、Auth、Storage、Studio、ローカルSMTP。Analytics・Realtime・Edge Functions・poolerは無効。必要になったら該当工程で検証して追加する。

native runtimeはLinux amd64/arm64とApple Silicon macOSに対応し、Windowsネイティブは未対応。この環境ではWSL2上のLinuxとして実行する。各サービスは必要時に起動し、アイドル時には休止する。`sleeping` 表示だけで障害と判断しない。

ヘルパーは子プロセスへ既存の `SUPABASE_*` 環境変数を引き継がず、ローカルの起動・状態確認・停止だけを許可する。ローカルサービスはループバックにのみ待ち受ける。通常の `supabase status` は秘密値も表示するため、出力をチャット・Git・Linearへ貼らない。ヘルパーの状態表示はURLだけに絞り、完全な状態とキーは `~/.config/aokiennji/secrets/supabase-local-status.json`（600）に保存する。

本番の接続情報は別の `supabase-production-connection.json` で保管する。検証アプリにそのファイルや本番APIキーを渡さない。このチェックアウトを `supabase link` で本番へ接続しない。DB変更やダンプで対象がローカルであることを明示する。

## 接続先とSSH

`status` がその環境の実際のポートを表示する。今回確認した値は次のとおり。再構築時に固定値とみなさず読み直す。

| 用途 | ローカルURL／ポート |
| --- | --- |
| API | `http://127.0.0.1:28525` |
| DB | `127.0.0.1:26714` |
| Studio | `http://127.0.0.1:30726` |
| メール検証UI | `http://127.0.0.1:23501` |

ノートパソコンのブラウザーで見る場合、SSHのポート転送で必要なポートだけを手元へ転送する。サーバー側の待受を `0.0.0.0` に変えて公開しない。ローカルSMTPは検証用メール受信箱であり、Resendによる実宛先への到達試験とは別である。

## 実施済みの検証と限界

- 本番資格情報を参照せず、ローカルPostgresへ接続。
- トランザクション内に架空データ1件を書き込み、自動ロールバック後に検証スキーマが残らないことを確認。
- Auth health、REST、メール検証UI APIがHTTP 200。
- ヘルパーによる停止・再起動・状態確認が成功し、同じローカルURLを維持。
- 検査結果は `.data/verification/uta7/supabase-local-readiness.json` に保存。

業務テーブルのマイグレーション・fixture・認可・永続化はUTA-8で実装する。ローカル実行は、クラウドのTLS・transaction pooler・遅延・容量制限・Workers CPU制限の再現ではない。native runtimeは実験的機能であるためCLIを固定し、更新時は再検証する。

公式資料：[native runtime](https://supabase.com/docs/guides/local-development/docker-and-native-runtimes)、[実験的stackの設定](https://supabase.com/docs/guides/local-development/running-multiple-local-projects)。
