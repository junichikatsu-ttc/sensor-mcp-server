# sensor-mcp-server

センサーデータを enebular データストアへ投入する REST API と、そのデータを LLM から読むための **MCP サーバー**。
enebular クラウド実行環境（ZIP / Node.js 22.x）の 1 関数として動く。
元は `sample/` の Node-RED フロー 2 本（投入・範囲取得）で、それを TypeScript に置き換えたもの。

| 入口 | 用途 |
| :--- | :--- |
| `POST /v1/sensors` | デバイスからの 1 件投入（`no` 必須、`ts` 省略可、他の属性は自由） |
| `GET /v1/sensors/{no}?startTime&endTime&limit&startKey&order` | 期間で取得（1 ページ） |
| `POST /mcp` | MCP（Streamable HTTP, ステートレス, JSON 応答）。読み取り専用ツール 4 本 |
| `POST /ttc-iot-sensor` / `GET /get-sonsor` | 元の Node-RED フローと同じパス・形の互換ルート |
| `GET /v1/health` | 稼働確認（唯一の認証不要エンドポイント） |
| `GET /` | 運用者向けの確認画面（エンドポイント一覧・検索・テスト送信） |

MCP ツール: `list_sensors` / `get_latest_reading` / `query_sensor_readings` / `summarize_sensor_readings`。
接続方法は [docs/mcp.md](docs/mcp.md)。

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
