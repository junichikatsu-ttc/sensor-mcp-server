# enebular へのデプロイ

`deploy.mjs`（`npm run enebular:*`）が enebular CLI を呼ぶ。初回だけコンソールでの作業がある。

## 0. 前提

- Node.js 22 以上
- enebular のアクセスキー / シークレットキー（アカウント設定で発行）。
  `~/.enebular/credentials` の `default` プロファイルがあれば `.env.deploy` の `ENEBULAR_ACCESS_KEY` / `SECRET_KEY` は空でよい

## 1. 初回セットアップ

| # | 作業 | 場所 | 得る値（`.env.deploy` のキー） |
| :--- | :--- | :--- | :--- |
| 1 | プロジェクトを作る（既存でも可） | コンソール | `ENEBULAR_PROJECT_ID` |
| 2 | データストアのテーブルを作る。センサーデータ: メインキー `no`（文字列）/ サブキー `ts`（数値）。**元の Node-RED フローのテーブルがあればそれをそのまま使う** | コンソール | `FN_DS_TABLE_SENSOR_DATA` |
| 2' | （任意）登録簿テーブル: メインキー `scope`（文字列）/ サブキー `no`（文字列） | コンソール | `FN_DS_TABLE_SENSORS` |
| 3 | `cp .env.deploy.example .env.deploy` して 1・2 を書く。`FN_API_KEY` を決める（空なら無認証） | 手元 | — |
| 4 | `npm run enebular:init` — ZIP をビルドしてファイルアセットを登録。`ENEBULAR_FILE_ASSET_ID` が書き戻る | CLI | `ENEBULAR_FILE_ASSET_ID` |
| 5 | クラウド実行環境を作る（4 のアセット / ランタイム **Node.js 22.x**） | コンソール | `ENEBULAR_CLOUD_ID` |
| 6 | `npm run enebular:config` — HTTP トリガー・タイムアウト・`connectDataStore`・環境変数を一括設定 | CLI | トリガー URL |
| 7 | トリガー URL を `ENEBULAR_HTTP_TRIGGER_URL` に書く | 手元 | — |

以降は `npm run enebular:deploy` だけ。ビルド → ZIP 差し替え → デプロイ → バージョン記録 → スモークテスト
（`/v1/health` の `commit` が今回のビルドと一致するか）まで通す。

```bash
npm run enebular:check              # 設定の確認（値はマスク表示）
npm run enebular:deploy -- --dry-run   # enebular を呼ばずに手順だけ確認
npm run enebular:smoke              # デプロイ済み環境の確認
```

## 2. 関数の環境変数（`FN_*`）

`.env.deploy` の `FN_` 付きキーが、`FN_` を外して実行環境の envVars になる。**送った内容で置き換わる**ので、
キーを消すと実行環境からも消える。

| キー | 必須 | 説明 |
| :--- | :--- | :--- |
| `FN_MOCK_MODE` | ○ | 本番は `false` |
| `FN_DS_TABLE_SENSOR_DATA` | ○ | センサーデータのテーブル ID |
| `FN_DS_TABLE_SENSORS` | — | 登録簿テーブル ID。設定すると MCP `list_sensors` が使える（投入 1 件 = アクセス 2 回） |
| `FN_API_KEY` | — | 設定すると REST / MCP に `x-api-key` or `Bearer` を要求 |
| `FN_SENSOR_QUERY_LIMIT` / `FN_SENSOR_QUERY_MAX_LIMIT` | — | 取得件数の既定 / 上限（100 / 1000） |
| `FN_MCP_SUMMARY_MAX_PAGES` | — | 要約ツールのアクセス回数上限（5） |
| `FN_BASIC_AUTH_USER` / `FN_BASIC_AUTH_PASSWORD` | — | 画面にだけ掛かる BASIC 認証 |
| `FN_LOG_LEVEL` | — | `INFO` 以下にする（`DEBUG` は入力内容がログに出る） |

`.env.deploy` にはキーが入る。**コミットしない**（`.gitignore` 済み）。

## 3. デプロイ後の確認

```bash
# 稼働と設定
curl -s https://xxxx.enebular.com/sensor-mcp-server/v1/health | jq .
#   commit がビルドと一致 / configOk: true / datastore: "cloud" / mockMode: false

# 投入
curl -s -X POST https://xxxx.enebular.com/sensor-mcp-server/v1/sensors \
  -H 'content-type: application/json' -H 'x-api-key: <API_KEY>' \
  -d '{"no":"test-1","temperature":21.5}'

# 取得
curl -s "https://xxxx.enebular.com/sensor-mcp-server/v1/sensors/test-1?limit=5" -H 'x-api-key: <API_KEY>'

# MCP
curl -s -X POST https://xxxx.enebular.com/sensor-mcp-server/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H 'authorization: Bearer <API_KEY>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

実機でしか確認できないこと（インメモリ実装では代替できない）:

- `query` の `startKey` に、前の応答の `nextStartKey`（`LastEvaluatedKey` を文字列化したもの）を渡して続きが取れるか。
  取れなければ `src/datastore/query.ts` の `toStartKey` を実物の形に合わせる
- `connectDataStore` が有効か（`/v1/health` の `datastore` が `cloud`、投入が 503 にならない）

## 4. 症状の切り分け

| 症状 | 見るところ |
| :--- | :--- |
| デプロイしたのに画面が変わらない | `/v1/health` の `commit`。一致していれば前段キャッシュ。`index.html` の `?v=` が付いているか |
| 関数は動いているのに全部 404 | 404 レスポンスの `error.path`。`app.ts` の 3 通りマウントが崩れていないか |
| 投入・取得が 503 `DATASTORE` | `details.kind`。`failed` = テーブル ID・キー名/型の不一致・スロットリング。`threw` = `connectDataStore` 無効や接続不可。詳細は実行環境のログ |
| 500 `CONFIG_MISSING` | `FN_DS_TABLE_SENSOR_DATA` 未設定。`/v1/health` の `configMissing` |
| MCP クライアントが接続できない | `accept` に `application/json` を含めているか。認証ヘッダ。GET で繋ごうとしていないか（405） |

## 5. GitHub Actions でデプロイする

`.github/workflows/` に 2 本ある。どちらも `deploy.mjs` を呼ぶだけなので、手元のデプロイと手順は同じ。

| ワークフロー | いつ動くか | 何をするか |
| :--- | :--- | :--- |
| `ci.yml` | `main` への push と pull request | typecheck → test → ZIP ビルド（handler 検証）。ZIP を成果物として 7 日保存。enebular は呼ばない |
| `deploy.yml` | **手動実行**（Actions タブ → Deploy to enebular → Run workflow） | 設定チェック → typecheck → test → （任意）実行環境の設定反映 → ZIP 差し替え → デプロイ → バージョン記録 → スモークテスト |

### 5.1 GitHub Environment を作る

リポジトリの Settings → Environments で `staging` と `production` を作る（`production` には Required reviewers を付けるとよい）。
それぞれに次を登録する。**値の前後に空白や改行を入れない**（認証エラーの原因になり、原因表示が出ない。ワークフローの最初のステップで弾く）。

Secrets:

| 名前 | 内容 |
| :--- | :--- |
| `ENEBULAR_ACCESS_KEY` / `ENEBULAR_SECRET_KEY` | enebular のアクセスキー（アカウント設定で発行）。**CI が知るシークレットはこれだけにする**のが原則 |
| `FN_API_KEY` | センサー API / MCP のキー（任意。空なら無認証） |
| `FN_BASIC_AUTH_USER` / `FN_BASIC_AUTH_PASSWORD` | 画面の BASIC 認証（任意） |

Variables:

| 名前 | 内容 |
| :--- | :--- |
| `ENEBULAR_PROJECT_ID` / `ENEBULAR_CLOUD_ID` / `ENEBULAR_FILE_ASSET_ID` | §1 で得た ID。`ENEBULAR_FILE_ASSET_ID` は `npm run enebular:init` で作ったもの |
| `ENEBULAR_HTTP_TRIGGER_URL` | トリガー URL。スモークテストと Environment の URL 表示に使う |
| `ENEBULAR_HTTP_TRIGGER_PATH` / `ENEBULAR_TIMEOUT` | 任意（既定 `sensor-mcp-server` / `30`）。`apply_config` のときに送られる |
| `FN_MOCK_MODE` | `false` |
| `FN_LOG_LEVEL` | `INFO` |
| `FN_DS_TABLE_SENSOR_DATA` | センサーデータのテーブル ID |
| `FN_DS_TABLE_SENSORS` | 登録簿テーブル ID（任意） |
| `FN_SENSOR_QUERY_LIMIT` / `FN_SENSOR_QUERY_MAX_LIMIT` / `FN_MCP_SUMMARY_MAX_PAGES` | 任意 |

> 初回のアセット作成（`enebular:init`）とクラウド実行環境の作成はコンソールと手元で行う（§1）。
> CI はできあがった環境への**差し替えデプロイ**だけを担当する。

### 5.2 実行する

Actions タブ → **Deploy to enebular** → Run workflow で次を選ぶ。

| 入力 | 意味 |
| :--- | :--- |
| `environment` | `staging` / `production` |
| `apply_config` | オンにすると `deploy.mjs config` も実行し、HTTP トリガー・タイムアウト・`connectDataStore`・環境変数（`FN_*`）を反映する。**`FN_*` を変えたときだけオンにする**。envVars は送った内容で置き換わるので、Environment に無い `FN_*` は実行環境から消える |
| `skip_smoke` | スモークテストを省略する（トリガー URL が未設定のときなど） |

デプロイ ID は `gh<実行番号>-<コミット 7 桁>` になり、`/v1/health` の `commit` とバージョン記録の名前に出る。
スモークテストはこの値が実機から返るまで最大 120 秒待って照合する。

同じ Environment への同時実行は `concurrency` で直列化される。

### 5.3 push で自動デプロイしたくなったら

`deploy.yml` の `on.push` のコメントを外す。その場合 `inputs.*` は空になるので、`environment` は `staging`、
`apply_config` と `skip_smoke` はオフとして動く。`production` は手動実行のままにしておくことを勧める。

## 6. 複数環境

staging / production で 5〜7 を繰り返し、**トリガーのパスも変える**。画面もクライアントも相対パスなので設定変更は不要。
GitHub Actions では Environment を増やし、`deploy.yml` の `options` に名前を足す。
