# enebular 側セットアップとデプロイ

雛形の `deploy.mjs` が CLI 呼び出しを引き受ける。**手順の実体はこのファイルと同じ**なので、
CI を組むときもここに書いた順序をそのまま使う。

## 1. 初回セットアップ

CLI は既存のプロジェクトと実行環境に対して動くため、いくつかはコンソールで作る。
**この手順はプロジェクトの `docs/` にも書き残すこと。**

| # | 作業 | 場所 | 取得する値 |
| :--- | :--- | :--- | :--- |
| 1 | プロジェクトを作成 | コンソール | `ENEBULAR_PROJECT_ID` |
| 2 | データストアのテーブルを作成（キー名と型を `tables.ts` と一致させる） | コンソール | テーブル ID × N |
| 3 | アクセスキー / シークレットキーを発行 | コンソール（アカウント設定） | `ENEBULAR_ACCESS_KEY` / `ENEBULAR_SECRET_KEY` |
| 4 | `.env.deploy` に 1〜3 を書く | 手元 | — |
| 5 | ZIP をビルドしてファイルアセットを登録 | `npm run enebular:init` | `ENEBULAR_FILE_ASSET_ID`（自動で書き戻る） |
| 6 | ZIP 向けクラウド実行環境を作成（そのアセット / ランタイム Node.js 22.x） | コンソール | `ENEBULAR_CLOUD_ID` |
| 7 | HTTP トリガー・タイムアウト・`connectDataStore`・`envVars` を設定 | `npm run enebular:config` | トリガー URL |
| 8 | トリガー URL を `ENEBULAR_HTTP_TRIGGER_URL` に書く | 手元 | — |

以降は `npm run enebular:deploy` だけ。

> 手順 6 はアセットの実体を要求するので、5 を先に済ませる必要がある。
> 実装前に環境だけ用意したいなら、雛形をそのまま登録して後から差し替えればよい。

環境ごと（staging / development）に 6〜8 を繰り返し、**トリガーのパスも変える**。
フロントは相対パスなので画面側の設定は不要。

> **`envVars` に API キーが含まれるなら、`.env.deploy` をリポジトリにコミットしないこと。**
> CI を使う場合、**CI が知るシークレットは enebular のアクセスキーだけ**にする。

## 2. `deploy.mjs` のコマンド

| コマンド | 何をするか |
| :--- | :--- |
| `enebular:check` | 設定の確認（値はマスク表示）。`FN_*` の不足・雛形値・予約プレフィックスを警告する |
| `enebular:init` | ZIP をビルド → ファイルアセットを新規作成 → `ENEBULAR_FILE_ASSET_ID` を書き戻す |
| `enebular:config` | HTTP トリガー / タイムアウト / `connectDataStore` / `envVars` を一括設定 |
| `enebular:deploy` | ビルド → アセット更新 → デプロイ → バージョン記録 → スモークテスト |
| `enebular:smoke` | `/v1/health` を叩いて `commit`・`configOk` を確認 |

オプション: `--dry-run`（enebular を呼ばない）`--skip-build` `--no-smoke` `--force` `--no-write` `--commit <id>`

**`envVars` は送った内容で置き換わる。** `.env.deploy` から `FN_*` を消すと、実行環境からもそのキーが消える。

## 3. CLI を直接叩く場合の順序

```bash
enebular update file  --project-id … --asset-id … --file "$ZIP_PATH" --json
enebular deploy cloud --project-id … --cloud-id … --asset-id … --asset-type file --json
enebular add file-version --project-id … --asset-id … --name … --comment … --json
```

- **`--json` を必ず付ける**（無いと確認プロンプトで止まる。`--yes` でも可）
- **`--asset-type` は `file`**（`flow` は Node-RED 用。ブログ記事の例に引きずられない）
- `add file-version` の `--name` は **1〜30 文字の英数字・アンダースコア・ハイフンのみ**。
  ブランチ名（`feat/xxx`）やタグ（`v1.0.0`）はそのままでは通らない。
  **弾かずに整形する**（`tr -c 'A-Za-z0-9_-' '-'` → 前後のハイフン除去 → 30 文字カット → 空なら既定値）。
  ここで失敗させると「ZIP のデプロイは済んでいるのにバージョン記録だけ落ちる」分かりにくい壊れ方になる
- アクセスキーの**値の前後に空白や改行があると認証エラー**になる。原因表示が出ないので先に弾く

## 4. ZIP レイアウトの機械検証（デプロイ前に必ず入れる）

`deploy.mjs` の `verifyZip()` がやっていること。CI でも同じものを入れる。

1. ルート直下に `index.js` と `package.json` があるか（ZIP の中央ディレクトリを読んで完全一致で確認）
2. ZIP 内 `package.json` に `"type": "module"` が**ない**か
3. 展開して `require()` し、`typeof m.handler === 'function'` か（`build.mjs` 側で実施）
4. 250MB 以下か

## 5. デプロイ後のスモークテスト

`GET $HTTP_TRIGGER_URL/v1/health` を叩き、次を確認する。反映には数十秒かかるので待ちを入れる
（`deploy.mjs` は最大 120 秒、5 秒間隔でポーリングする）。

- `200` が返るか
- **`commit` が今回のビルドの ID と一致するか**（ZIP 差し替え漏れの検出。**これが効く**）
- `configOk` が true か
- `datastore` が `cloud` か
- ルート URL の HTML に `app.js?v=` が入っているか（前段キャッシュ対策が生きているか）

## 6. GitHub Actions を使う場合

`deploy.mjs` で足りるなら要らない。チームで使う・push で自動デプロイしたいときだけ足す。

### `ci.yml`

checkout → pnpm/action-setup（または setup-node のみ）→ setup-node(22, cache) →
install → typecheck → lint → test → **ZIP ビルド（dry run）**

### `deploy-function.yml`

デプロイ先は **GitHub Environment** で切り替える。

- Secrets（Environment ごと）: `ENEBULAR_ACCESS_KEY` / `ENEBULAR_SECRET_KEY`
  → **値の前後の空白や改行**で認証エラーになるため、冒頭で空チェックする
- Variables（Environment ごと）: `ENEBULAR_PROJECT_ID` / `ENEBULAR_CLOUD_ID` /
  `ENEBULAR_FILE_ASSET_ID` / `ENEBULAR_HTTP_TRIGGER_URL`
- 最初は **`workflow_dispatch` のみ**にして、push トリガーはコメントアウトで置いておく
  （意図しないタイミングでデモ環境が入れ替わるのを避ける）
- `concurrency` で同一環境への同時デプロイを止める
- `FN_*` は **Environment の Variables/Secrets から環境変数として渡す**（`deploy.mjs` は環境変数を優先する）
