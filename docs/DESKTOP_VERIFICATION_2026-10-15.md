# デスクトップ移行の確認（2026-10-15）

既存のコードを使った開発・デモ確認は可能。**追記：DBを受領し、通常の保存先への配置と、引き継ぎ記載に一致するデータを確認した。** OpenAIの利用残高不足は前回検証で確認済み。以下の初回検証結果と、今回のDB確認を区別する。

## 追記：受領DBの読み取り確認

2026-10-15、`C:\Users\uta\Downloads\aokienji.sqlite` と、プロジェクトの `.data/aokienji.sqlite` を確認した。両方270,336バイトで、ファイル全体のSHA-256が一致している。通常の保存先へ同じファイルが配置されている。

| 内容 | 受領DB | 引き継ぎ記載 |
| --- | --- | --- |
| 商品 | 6件 | 6件 |
| 情報源 | 2件 | 2件 |
| 仕入先知識 | 41件 | 41件 |
| 相談・会話 | 12件 | 12件 |
| メッセージ | 66件 | 66件 |

両ファイルをSQLiteの読み取り専用・immutableモードで開き、`integrity_check=ok`、外部キー違反0件を確認した。上記5種類のレコードはすべてJSONとして読み取れ、対応する会話がないメッセージも0件。新規デモDBにはない仕入先知識・相談履歴を含み、件数が引き継ぎ記載と一致する。

`research_notes` テーブルはまだ存在しないが、これは引き継ぎに記載された旧DBの状態と一致する。アプリ起動時に追加されるため、DBを作り直す必要はない。受領直後は読み取り確認だけを行った。その後、[ローカル回答エージェントでの会話テスト](LOCAL_AGENT_CHAT_TEST_2026-10-15.md)で受領DBのコピーを使ってアプリを起動し、スキーマ追加・管理ログイン・商品表示・生成チャットを確認した。通常DBは保持し、仕入先知識41件・既存会話12件・メッセージ66件がコピーにも同じ内容で残ることを照合済み。

最初に `AGENTS.md`、`DESKTOP_HANDOFF_2026-10-14.md`、`CHAT_RESEARCH_AND_HISTORY_2026-10-13.md` を読み、`CHAT_ROUTING.md`、仕入先登録の報告も参照した。Next.js同梱の環境変数・Playwright・インストールのガイドを確認した。

## コードとGit

| 項目 | 実測結果 |
| --- | --- |
| 作業フォルダ | `/mnt/c/Users/uta/orca/aokiennji`（Windowsでは `C:\Users\uta\orca\aokiennji`） |
| ブランチ | `main` |
| HEAD | `0b88f5ba3bce420e43c2a52957378ef5f0ac26f1` |
| GitHub main | fetch成功。`6e31f7d57fd47a9573308a095e9fb0e7e3382621` |
| mainとの関係 | ローカルは1コミット遅れ、ローカルだけのコミットは0 |
| `0b88f5b` | 含まれる（現在のHEAD） |
| `6e31f7d` | **まだ含まれない**。追加内容は引き継ぎMDのWSLビルド準備手順のみ |
| 確認開始時の未コミット変更 | 追跡済み106ファイル。すべてLF→CRLFの変更だけ |

106ファイルそれぞれを読み、CRLFをLFへ戻したバイト列が `git show HEAD:<path>` と完全一致することを確認した。PDFの試験資料2件も含む。アプリの実装はHEADと同じだが、Git上の作業ツリーはクリーンではなく、GitHub mainとの完全一致でもない。

今回、pull・reset・改行の一括変換・アプリコードの修正はしていない。テストで自動更新された `next-env.d.ts` は、開始時の内容とCRLFへ戻した。追加した追跡対象候補はこの報告書のみ。コミット・pushはしていない。

対処：106ファイルの改行差分を退避してからLFへ揃え、Gitの改行設定を統一する。その後 `git pull --ff-only origin main` を実行し、`6e31f7d` を取り込む。変更が増えた後に一括restoreを実行すると作業を失うため、その時点の差分を再確認する。

## 開発環境・設定

| 項目 | 結果 |
| --- | --- |
| OS | Ubuntu 26.04 LTS / WSL2、Linux 6.18.40.1 |
| Node.js | v24.20.0（要求の24系） |
| npm | 11.19.0 |
| make | 4.4.1 |
| gcc / g++ | 15.2.0 |
| Python | 3.14.4 |
| Next.js | 16.3.8 |
| 依存 | `npm ls --depth=0` 成功。直接依存の全バージョンがpackage-lockと一致 |
| SQLiteネイティブ依存 | better-sqlite3 13.0.3をロードし、メモリDBへのSQL実行成功 |

依存は既に導入されていたため、今回は `npm ci` での再導入は行わず、実際のロード・テスト・ビルドで検証した。再構築する場合はこのフォルダで `npm ci` を使う。

`.env.local` と `.local-admin.txt` は存在する。Next.jsの `@next/env` で実際に読み込み、以下を確認した。秘密の値は出力していない。

- `DATA_DIR=.data`、`APP_ORIGIN=http://localhost:3000`。
- `DEMO_MODE=true`、`ALLOW_LIVE_ORDERS=false`。
- 管理パスワードのハッシュ形式、SESSION_SECRETの必要な長さを確認。
- メモのパスワードと読み込み後のハッシュが一致し、ブラウザからのログインにも成功。
- OpenAIとJevのキーを読み込み可能。Jevの接続先も引き継ぎ記載どおり。
- `.local-admin.txt` はアプリが設定として読むファイルではなく、ログイン情報のメモ。
- 2ファイルの内容は検証前後のチェックサムが一致。値の書換えはしていない。

両ファイルのモードは777。`chmod 600` を実行しても変わらず、`/mnt/c` のWindowsドライブではこの環境のchmodで制限できていない。Windowsのファイル権限を確認するか、WSLのLinux領域へ配置した環境で600を設定する。APIキー等をGitに追加しない。

## 初回確認時：DBは未移行

確認開始時、プロジェクトに **`.data` ディレクトリ自体がなかった**。環境設定が指すDBも存在しない。ノートPCの元のパス `/home/uta-s-dao/my_project/aokienji` も、このデスクトップには存在しない。

以下を検索したが、`aokienji.sqlite` とアオキ関連の移行アーカイブは見つからなかった。

- `/home/uta`
- `C:\Users\uta\Downloads`、`Desktop`、`Documents`
- `C:\Users\uta\orca`

検索はこれらの範囲で行った。node_modules、Git、キャッシュ等は除外しており、PCの全ドライブを調べたという意味ではない。

引き継ぎ記載の旧DBは、商品6件・情報源2件・仕入先知識41件・会話12件・メッセージ66件。**今回は元ファイルがないため、その内容・整合性・相談履歴の移行を確認できない。** MDに書かれた件数や説明から実データを復元することはできない。

通常の保存先にデモDBを作って移行済みと誤認することを避け、全検証を別のDBで行った。検証後も `.data/aokienji.sqlite` は作成していない。

画面検証のDBは `/tmp/aoki-desktop-verification-2026-10-15/app-db/aokienji.sqlite`。`quick_check=ok`、商品6件・情報源1件・架空仕入先1件・仕入先知識0件。画面検証で作成した会話2件・メッセージ8件がある。**これは今回新規に作ったデモDBで、移行元DBではない。復元用にコピーしない。**

## 自動テスト（実APIを使わない）

| 項目 | 結果・条件 |
| --- | --- |
| `npm run typecheck` | 成功 |
| `npm test` | 最終の全体実行で10ファイル・180件すべて成功 |
| build | `DATA_DIR=/tmp/aoki-desktop-build-db NEXT_DIST_DIR=.next-build npm run build` 成功 |
| E2E | PC・モバイルのChromiumで24件すべて成功（約2分） |

初回の単体テストは179件成功・1件失敗。残高不足のテストで「最新の利用記録」として別の拒否記録を取得した。該当テストの単独実行は成功し、全体再実行も180件成功した。`aiUsageReport` が `created_at DESC, id DESC` で並べ、IDはUUIDであることから、同一ミリ秒の記録順に依存する不安定さが疑われる。機能が恒常的に失敗している結果ではないが、当該呼出のIDやturnIdで記録を特定するテストへの改善が残る。今回はコードを変更していない。

Vite設定には将来のnative config loaderとの互換性警告がある。現在の実行は成功している。

サンドボックスでは子プロセスの標準出力が空になり、最初のbuildでTypeScript `--showConfig` のJSON解析に失敗した。同じ現象を小さい子プロセス実行でも確認。許可された制限外で同じbuildは成功した。E2Eの試験サーバー起動も制限外で行った。

### Chromiumの準備と残るOS設定

開始時はPlaywright用Chromiumが未導入だった。今回は `/tmp/aoki-desktop-playwright` に取得した。その後 `libnspr4.so`、`libnss3.so`、`libnssutil3.so`、`libasound.so.2` の不足でブラウザが起動せず、最初のE2EはAPI系6件成功・ブラウザ系18件起動失敗となった。

`npx playwright install-deps chromium` はsudo認証が必要なため完了できなかった。検証を完了するため `libnspr4`、`libnss3`、`libasound2t64` を取得・展開し、OSを変更せずに以下の環境で24件すべて成功した。

```sh
PLAYWRIGHT_BROWSERS_PATH=/tmp/aoki-desktop-playwright \
LD_LIBRARY_PATH=/tmp/aoki-desktop-browser-libs/extracted/usr/lib/x86_64-linux-gnu \
npm run test:e2e
```

通常の開発環境を整えるには、本人が操作するWSLターミナルで次を実行する。sudoパスワードはそのターミナルへ入力し、チャットへ貼らない。

```sh
npx playwright install-deps chromium
npx playwright install chromium
npm run test:e2e
```

`/tmp` のブラウザとライブラリは一時的なもの。通常コマンドが追加環境変数なしで使える状態への整備は残っている。

## 実ブラウザと実API（自動テストと別）

Chromiumでローカルの `http://localhost:3000` を開き、以下を実際に操作した。外部にデプロイされた本番サイトの検証ではない。

- 公開トップ・画像・商品一覧の6件表示。
- チャットで `DEMO-CAST-01` を照会し、続けて納期を質問。商品の文脈を保ち、登録納期を表示。
- スマートフォン幅で横方向のはみ出しがないこと。
- 未ログイン時の管理画面からログインページへの遷移。
- コピーしたメモの管理パスワードによるフォームからのログイン。
- 管理画面で概要・商品件数等のデータが描画されること。
- OpenAIの残高不足を知らせる管理画面の表示。
- ブラウザの未処理JavaScriptエラーは0件。

試験DBの既定設定はローカル分類・ローカル回答、AI調査オフ、FAQ未登録。キーがあるだけで生成AIが有効になるわけではない。

| 実API | 実測結果 |
| --- | --- |
| OpenAI | `gpt-4.1-mini` の接続確認を1回実行。約6.58秒で `insufficient_quota`。通信のHTTP状態は200だが、ストリーム内のエラーをアプリが残高不足として記録。**生成回答の成功とは扱わない** |
| Jev | `jev-latest` の分類を1回実行。約0.56秒、HTTP 200、応答検証も成功 |

接続試験は既存の管理APIを使い、保存先は試験DBに限定。設定ファイル・通常DBへの変更はない。OpenAIの不足を確認したため、追加の生成会話・担当者向けWeb調査・最終版のAIあり品質評価は実行していない。残高追加後に管理画面の接続確認を行い、試験DBでこれらを再評価する必要がある。

スクリーンショットと機密値を含まない結果JSONは `/tmp/aoki-desktop-verification-2026-10-15/` に保存した（`home-desktop.png`、`products-desktop.png`、`chat-desktop.png`、`chat-mobile.png`、`admin-overview.png`、`browser-results.json`）。試験サーバーは停止済み。

## 見当たらないDBを回収する方法

**`.data/migration/manual-copy-2026-10-15/` はノートPCに作られたGit管理外のバックアップ。デスクトップでGitHubからcloneしても、このフォルダは作られない。** まずノートPC側で次を確認する。

```sh
cd /home/uta-s-dao/my_project/aokienji
ls -lah .data .data/migration/manual-copy-2026-10-15
find .data -type f -name aokienji.sqlite -print
```

`.data` はドットで始まるため、Linuxのファイル管理アプリでは隠しファイル表示（通常Ctrl+H）が必要。パス入力欄へ `/home/uta-s-dao/my_project/aokienji/.data/migration/manual-copy-2026-10-15/` を直接指定してもよい。ノートPCがWSLなら、そのWSL内の上記フォルダから `explorer.exe .` でWindowsのエクスプローラーを開ける。

### バックアップが存在する場合

1. ノートPCのバックアップ `aokienji.sqlite` を、USB等でファイルのまま転送する。
2. デスクトップでアプリを停止した状態にする。
3. `C:\Users\uta\orca\aokiennji\.data` を作り、まず `incoming` サブフォルダへ保存する。
4. 下記の読み取り確認で整合性と件数を確認する。
5. 通常DBが存在しないことを確認してから `.data/aokienji.sqlite` に配置する。既にある場合は先にそのDBをバックアップし、上書きで混ぜない。

```sh
python3 - <<'PY'
from pathlib import Path
import sqlite3
p = Path('.data/incoming/aokienji.sqlite').resolve()
if not p.is_file():
    raise SystemExit('受け取ったDBがありません')
with sqlite3.connect(p.as_uri() + '?mode=ro', uri=True) as db:
    print('quick_check:', db.execute('PRAGMA quick_check').fetchone()[0])
    for table in ['products', 'sources', 'supplier_knowledge', 'conversations', 'messages']:
        print(table, db.execute('SELECT COUNT(*) FROM ' + table).fetchone()[0])
PY
```

引き継ぎ時点の目安は順に6・2・41・12・66件。後日ノートPCで作業した場合は増減し得るため、件数だけでなく元環境と照合する。旧DBに `research_notes` がなくても、アプリ起動時に追加されるので再作成・削除しない。

### バックアップがなく、ノートPCの通常DBだけがある場合

ノートPC側でSQLiteのバックアップAPIから新しいバックアップを作る。下の手順は元DBを読み取り専用で開き、新規のバックアップ名を使う。通常DBのWAL未反映データを取りこぼさないため、稼働中のDB本体だけをコピーしない。

```sh
cd /home/uta-s-dao/my_project/aokienji
python3 - <<'PY'
from pathlib import Path
from datetime import datetime
import sqlite3
source = Path('.data/aokienji.sqlite').resolve()
if not source.is_file():
    raise SystemExit('元DBがありません。空のDBは作成しません。')
folder = Path('.data/migration') / ('recovery-' + datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
folder.mkdir(parents=True, exist_ok=False)
target = folder / 'aokienji.sqlite'
with sqlite3.connect(source.as_uri() + '?mode=ro', uri=True) as old:
    with sqlite3.connect(target) as backup:
        old.backup(backup)
        result = backup.execute('PRAGMA quick_check').fetchone()[0]
        if result != 'ok':
            raise SystemExit('バックアップ整合性確認に失敗')
print('転送するファイル:', target)
PY
```

この新しいファイルを上と同じ方法で転送する。ノートPCの通常DBもバックアップもない場合、GitHubや引き継ぎMDから元の相談履歴を取り戻すことはできない。元端末のディスク／別バックアップを探す必要がある。仕入先Excelの再取込だけでは過去の相談履歴は戻らない。

## 開発再開前の作業

1. DBの回収・整合性検証・配置、および受領DBのコピーを使ったアプリの起動・画面確認は完了。
2. 改行差分を保存・整理し、`6e31f7d` までfast-forwardする。
3. Chromium用OS依存とブラウザを通常の保存先へ導入する。
4. 生成AIの開発・評価にはOpenAIの残高を回復し、接続と最終版の実API試験をやり直す。ローカル処理の開発は先に可能。
5. 単体テストの記録順依存を改善する。FAQの会社確認など、元の引き継ぎ課題も継続する。
