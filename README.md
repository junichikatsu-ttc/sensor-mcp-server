# sensor-mcp-server

センサーデータを enebular データストアへ投入する REST API と、そのデータを LLM から読むための **MCP サーバー**。
enebular クラウド実行環境（ZIP / Node.js 22.x）の 1 関数として動く。
元は `sample/` の Node-RED フロー 2 本（投入・範囲取得）で、それを TypeScript に置き換えたもの。

## エンドポイント

デプロイ先（クラウド実行環境 `lcdp005`、HTTP トリガーのパス `ttc-iot-sensor-mcp`）:

```
https://lcdp005.enebular.com/ttc-iot-sensor-mcp/
```

すべてのパスはこの配下に付く。トリガーのパスを外して `https://lcdp005.enebular.com/v1/health` のように叩くと
**enebular 側が HTML の 404（「ページが見つかりませんでした」）を返す**。関数の 404 は JSON（`error.path` 入り）なので、ボディを見れば切り分けられる。

| 入口 | 用途 |
| :--- | :--- |
| `POST https://lcdp005.enebular.com/ttc-iot-sensor-mcp/v1/sensors` | デバイスからの 1 件投入（`no` 必須、`ts` 省略可、他の属性は自由） |
| `GET  https://lcdp005.enebular.com/ttc-iot-sensor-mcp/v1/sensors/{no}?startTime&endTime&limit&startKey&order` | 期間で取得（1 ページ） |
| `POST https://lcdp005.enebular.com/ttc-iot-sensor-mcp/mcp` | MCP（Streamable HTTP, ステートレス, JSON 応答）。読み取り専用ツール 4 本 |
| `POST https://lcdp005.enebular.com/ttc-iot-sensor-mcp/ttc-iot-sensor` | 元の Node-RED フローと同じパス・形の互換ルート（投入）。**デバイスの送信先はこれ** |
| `GET  https://lcdp005.enebular.com/ttc-iot-sensor-mcp/get-sonsor` | 同上（範囲取得。綴りは元フローのまま） |
| `GET  https://lcdp005.enebular.com/ttc-iot-sensor-mcp/v1/health` | 稼働確認（唯一の認証不要エンドポイント） |
| `GET  https://lcdp005.enebular.com/ttc-iot-sensor-mcp/` | 運用者向けの確認画面（エンドポイント一覧・検索・テスト送信）。**末尾スラッシュ必須** |

稼働確認:

```bash
curl -s https://lcdp005.enebular.com/ttc-iot-sensor-mcp/v1/health
# {"status":"ok","commit":"...","configOk":true,...} が返れば動いている
```

現状は `API_KEY` 未設定（無認証）で運用している。設定する場合は `FN_API_KEY` を入れて `npm run enebular:config` を流し、
クライアント側に `x-api-key` または `Authorization: Bearer` を足す（[docs/api.md](docs/api.md)）。

## Claude から MCP サーバーとして使う

MCP エンドポイントは `https://lcdp005.enebular.com/ttc-iot-sensor-mcp/mcp`（Streamable HTTP）。
ツールは `list_sensors` / `get_latest_reading` / `query_sensor_readings` / `summarize_sensor_readings` の 4 本（すべて読み取り専用）。
ツールの仕様は [docs/mcp.md](docs/mcp.md)。

### Claude Desktop

Claude Desktop の設定ファイルは stdio のサーバーしか起動できないので、`mcp-remote` でリモート HTTP へ橋渡しする（Node.js が必要）。
「設定 → 開発者 → 設定を編集」で設定ファイルを開き、OS に合わせて次のどちらかを書く。**もう一方の OS の例をそのままコピーしても動かない。**

#### Windows

`%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "sensor-data": {
      "command": "cmd",
      "args": [
        "/c", "npx", "-y", "mcp-remote",
        "https://lcdp005.enebular.com/ttc-iot-sensor-mcp/mcp"
      ]
    }
  }
}
```

`npx` を直接 `command` にすると起動に失敗することがあるため `cmd /c` 経由にしている。

#### macOS

`~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "sensor-data": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://lcdp005.enebular.com/ttc-iot-sensor-mcp/mcp"
      ]
    }
  }
}
```

- `cmd` は macOS に存在しない。Windows 版の `"command": "cmd"` を貼ると `Failed to spawn process: No such file or directory` が出て即座に切断される
- Claude Desktop は nvm などで入れた `npx` を PATH から拾えないことがある。その場合は `command` を `which npx` の出力（例: `/Users/<user>/.nvm/versions/node/v20.18.3/bin/npx`）に置き換える。nvm のバージョンを切り替えたらこのパスも直す
- `npm error code EACCES` ... `Your cache folder contains root-owned files` が出る場合は、過去の `sudo npm install` で `~/.npm` に root 所有のファイルが残っている。`sudo chown -R $(id -u):$(id -g) ~/.npm` で直す。sudo を使えないときは `"env": { "npm_config_cache": "/Users/<user>/.npm-mcp" }` を足して別キャッシュに逃がす

#### 共通

- 保存後、Claude Desktop を**完全に終了**して起動し直す（Windows はタスクトレイからも終了、macOS は Cmd+Q）。入力欄のツールアイコンに 4 ツールが並べば接続できている
- うまくいかないときはログを見る。Windows は `%APPDATA%\Claude\logs\mcp-server-sensor-data.log`、macOS は `~/Library/Logs/Claude/mcp-server-sensor-data.log`。`ページが見つかりませんでした` の HTML が出ていれば URL のトリガーパス（`ttc-iot-sensor-mcp`）が違う
- 「カスタムコネクタの追加」は組織で無効になっているため使わない。「開発者」メニュー自体が出ない場合はローカル MCP も無効化されているので、管理者に組織コネクタとして上の URL を登録してもらう
- `API_KEY` を設定した場合は `"--header", "Authorization:${AUTH_HEADER}"` を `args` に足し、`"env": { "AUTH_HEADER": "Bearer <API_KEY>" }` を加える（値を直接書くと Windows で引数の空白が崩れる）

### Claude Code

```bash
claude mcp add --transport http sensor-data https://lcdp005.enebular.com/ttc-iot-sensor-mcp/mcp
```

`API_KEY` 設定時は `--header "Authorization: Bearer <API_KEY>"` を足す。

### 手で確認する

```bash
curl -s -X POST https://lcdp005.enebular.com/ttc-iot-sensor-mcp/mcp \
  -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

ステートレスなので `initialize` 無しで `tools/list` が JSON で返る。
`list_sensors` は登録簿テーブル（`FN_DS_TABLE_SENSORS`）を設定した環境でだけ使える。未設定の現状では `isError` が返り、他の 3 ツールは `no` を指定して使う。

## 構成

```
sensor-mcp-server/
├── src/               関数（Hono）。routes/ mcp/ datastore/ middleware/
├── web/               確認画面（HTML + 素の JS）。public/app.js は生成物
├── test/              統合テスト（データストアだけインメモリ実装に差し替え）
├── docs/              構成・API・MCP・データモデル・デプロイ・移行
├── sample/            元の Node-RED フロー（仕様の原本）
├── build.mjs          ZIP ビルド（web → 関数 → ZIP。require して handler を検証）
├── deploy.mjs         enebular CLI ラッパ（check / init / config / deploy / smoke）
└── zip-package.json   ZIP に同梱する package.json（CommonJS）
```

## ローカル開発

```bash
npm install
cp .env.example .env

npm run dev:web    # 別ターミナル。web の監視ビルド
npm run dev        # http://localhost:8787
```

データストアは**ローカルで代替できない**（接続情報を実行環境が注入するため）。
`DATASTORE_MODE=memory` のときはインメモリ実装に切り替わる。**永続化はされない。**
通しの確認は `test/` の統合テストで行う。

```bash
npm run typecheck && npm test
npm run build       # sensor-mcp-server-function.zip ができる
```

ローカルの MCP 接続先は `http://localhost:8787/mcp`。

## enebular へのデプロイ

手順は [docs/deploy.md](docs/deploy.md)。要約:

1. コンソールでプロジェクトとデータストアのテーブル（メインキー `no` 文字列 / サブキー `ts` 数値。**元フローのテーブルをそのまま使える**）を用意する
2. `cp .env.deploy.example .env.deploy` して ID と `FN_API_KEY` を入れる
3. `npm run enebular:init` → コンソールでクラウド実行環境（Node.js 22.x）を作る → `npm run enebular:config`
4. 以降は `npm run enebular:deploy`

```bash
npm run enebular:check               # 設定の確認（値はマスク表示）
npm run enebular:deploy -- --dry-run # enebular を呼ばずに手順だけ確認
```

> `.env` / `.env.deploy` はコミットしない（`.gitignore` 済み）。`FN_*` は関数の環境変数になり、**送った内容で置き換わる**。

### GitHub Actions

| ワークフロー | 動くとき | 内容 |
| :--- | :--- | :--- |
| `.github/workflows/ci.yml` | `main` への push / PR | typecheck → test → ZIP ビルド。enebular は呼ばない |
| `.github/workflows/deploy.yml` | 手動実行（Run workflow） | GitHub Environment（`staging` / `production`）の Secrets / Variables を使って `deploy.mjs deploy` を実行。スモークテストまで通す |

Environment に登録する値は [docs/deploy.md §5](docs/deploy.md#5-github-actions-でデプロイする)。

## ドキュメント

| ファイル | 内容 |
| :--- | :--- |
| [docs/architecture.md](docs/architecture.md) | 構成と設計判断（ADR）。enebular 固有の制約への対応 |
| [docs/api.md](docs/api.md) | REST API 仕様 |
| [docs/mcp.md](docs/mcp.md) | MCP サーバーの接続方法とツール |
| [docs/data-model.md](docs/data-model.md) | テーブル定義・キー設計・アクセス数の見積り |
| [docs/deploy.md](docs/deploy.md) | デプロイ手順と症状の切り分け |
| [docs/migration-from-node-red.md](docs/migration-from-node-red.md) | Node-RED フローとの対応と挙動の差分 |

設計の背景は `enebular-app` スキル（`.claude/skills/enebular-app/`）の `references/` にある。
`test/app.test.ts` は enebular 固有の挙動を固定しているので消さない。
