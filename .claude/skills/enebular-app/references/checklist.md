# 完了報告の前のチェックリスト

実装完了を報告する前に全項目をレビューする。**確認していない項目を確認済みと書かない。**

雛形（`templates/minimal`）から始めた場合、1〜4・10・12 は最初から満たされている。
**満たされていた前提が崩れていないか**を見る。

## ZIP

| # | 項目 | 確かめ方 |
| :--- | :--- | :--- |
| 1 | ルート直下に `index.js` と `package.json` があるか（親フォルダで包んでいないか） | `deploy.mjs` の `verifyZip` |
| 2 | ZIP 内 `package.json` に `"type": "module"` が**ない**か | 同上 |
| 3 | `require` して `handler` が関数として公開されているか | `build.mjs` の handler 検証 |
| 4 | ZIP が 250MB 以下か | `build.mjs` / `verifyZip` |

## デプロイ後

| # | 項目 |
| :--- | :--- |
| 5 | `/v1/health` の `commit` がデプロイしたビルドと一致するか |
| 6 | `configOk` が true か（不足キー名は実行環境のログにのみ出ているか） |
| 7 | `connectDataStore` が有効か（`/v1/health` の `datastore` が `cloud`） |
| 8 | HTTP トリガーのパスが enebular インスタンス内で一意か |
| 9 | `timeout` が想定レイテンシより長いか |
| 10 | `index.html` の CSS / JS 参照に `?v=` が付いているか（前段キャッシュ対策） |
| 11 | トリガーのルート URL（末尾スラッシュなし）で CSS / JS が読めるか |

## 安全側

| # | 項目 |
| :--- | :--- |
| 12 | フロントのソースで `innerHTML` を使っていないか（lint で禁止されているか） |
| 13 | シークレットがレスポンス・ログのどちらにも出ていないか |
| 14 | `LOG_LEVEL` が `INFO` 以下か（`DEBUG` 以上は入力内容がログに出うる） |
| 15 | `mockMode` が本番で `false` になっているか |
| 16 | `.env` / `.env.deploy` をコミットしていないか |

## テストで固定されているか

- 3 通りマウント（`/v1/health` と `/<base>/v1/health` の両方が 200）
- `?v=__ASSET_VERSION__` の置換（外すと前段キャッシュ問題がそのまま戻る）
- `getItem` の "Not found" が `undefined` に落ちること
- fake データストアに差し替えた主要導線の統合テスト 1 本

雛形の `test/app.test.ts` と `test/items.test.ts` がこれに当たる。**機能を足しても消さない。**
