# MCP サーバー

LLM クライアントからセンサーデータを読むための MCP（Model Context Protocol）サーバー。
エンドポイントは `POST <トリガー URL>/mcp`。トランスポートは **Streamable HTTP**。

## 接続

enebular の制約でレスポンスはバッファされるため、**ステートレス + JSON レスポンス**モードで動く。

- POST ごとに JSON を 1 発返す（`text/event-stream` は返さない）
- セッション ID（`Mcp-Session-Id`）は発行しない
- GET（サーバ→クライアントのストリーム）は `405`
- `API_KEY` 設定時は `Authorization: Bearer <key>` または `x-api-key: <key>` が必要

### クライアント設定の例

Claude Code:

```bash
claude mcp add --transport http sensor-data https://xxxx.enebular.com/sensor-mcp-server/mcp \
  --header "Authorization: Bearer <API_KEY>"
```

`mcpServers` 形式（Claude Desktop・Cursor など）:

```json
{
  "mcpServers": {
    "sensor-data": {
      "type": "http",
      "url": "https://xxxx.enebular.com/sensor-mcp-server/mcp",
      "headers": { "Authorization": "Bearer <API_KEY>" }
    }
  }
}
```

stdio しか話せないクライアントは `mcp-remote` を挟む:

```json
{
  "mcpServers": {
    "sensor-data": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://xxxx.enebular.com/sensor-mcp-server/mcp", "--header", "Authorization: Bearer <API_KEY>"]
    }
  }
}
```

### 手で叩く

```bash
curl -s -X POST https://xxxx.enebular.com/sensor-mcp-server/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H 'authorization: Bearer <API_KEY>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

> ステートレスなので `initialize` を先に送らなくても `tools/list` / `tools/call` は応答する。

## サーバーの instructions

接続時にクライアントへ渡す説明。ツールの使い分けと時刻の扱いを書いてある（`src/mcp/server.ts`）。

- センサーは `no`（文字列）で識別する。まず `list_sensors`、無理ならユーザーに `no` を聞く
- `ts` はエポックミリ秒。各レコードに `tsIso`（ISO 8601, UTC）も付ける
- 時刻の指定は ISO 8601 文字列でもエポックミリ秒でもよい
- 長い期間は `query_sensor_readings` で全件を取らず `summarize_sensor_readings` を使う

## ツール（すべて読み取り専用）

| ツール | 入力 | 返すもの | データストアアクセス |
| :--- | :--- | :--- | :--- |
| `list_sensors` | `limit?` | 登録済みセンサーの `no` と最新値 | 1〜数回（200 件まで 2 回） |
| `get_latest_reading` | `no` | 最新 1 件 | 1 回 |
| `query_sensor_readings` | `no`, `startTime?`, `endTime?`, `limit?`, `order?`, `startKey?` | 1 ページ分の生データ + `nextStartKey` | 1 回 |
| `summarize_sensor_readings` | `no`, `startTime?`, `endTime?`, `maxPages?` | 数値属性ごとの count / min / max / avg / first / last | 最大 `MCP_SUMMARY_MAX_PAGES` 回（既定 5） |

- `list_sensors` は登録簿テーブル（`DS_TABLE_SENSORS`）が設定されている環境でのみ使える。
  未設定なら `isError: true` で「`no` をユーザーに確認して他のツールを使う」よう LLM に案内する
- `summarize_sensor_readings` は 1 ページ `SENSOR_QUERY_MAX_LIMIT`（既定 1000 件）× `maxPages` まで読む。
  上限に達したら `truncated: true`。既定では 1 回の呼び出しで最大 5,000 件・5 アクセス
- 各ツールは `structuredContent`（`outputSchema` 付き）と、同じ内容の JSON テキストの両方を返す
- 入力の不正（`no` の形式、解釈できない時刻、`startTime > endTime`）は例外ではなく `isError: true` で返す

## 使えないもの

- 進捗通知・サーバ発のメッセージ・リソース購読（SSE が使えないため）
- セッション（Lambda インスタンス間で共有できないため）。クライアントは毎回フル情報で呼ぶ
- 書き込みツール（意図的に無い。[architecture.md ADR-2](architecture.md)）

## テスト

`test/mcp.test.ts` が公式クライアント（`@modelcontextprotocol/sdk/client`）の `fetch` を Hono に差し替えて、
初期化 → `tools/list` → 各ツールの呼び出しまで通す。JSON 応答であること・GET が 405 であることも固定している。
