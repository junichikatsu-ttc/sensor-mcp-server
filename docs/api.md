# REST API 仕様

すべてのパスは HTTP トリガーのパス配下に付く（例: `https://xxxx.enebular.com/sensor-mcp-server/v1/sensors`）。
エラーは共通形 `{ "error": { "code", "message", "details?" } }`。

| code | status | 意味 |
| :--- | :--- | :--- |
| `VALIDATION` | 400 | 入力検証エラー。`details` に `path` / `message` の配列 |
| `BAD_REQUEST` | 400 / 413 | JSON が壊れている、ボディが大きすぎる |
| `UNAUTHORIZED` | 401 | `API_KEY` 設定時にキーが無い・違う |
| `CONFIG_MISSING` | 500 | テーブル ID の環境変数が未設定 |
| `DATASTORE` | 503 | データストア操作の失敗。`details.operation` / `kind`（`failed` = 操作エラー, `threw` = 到達不能） |

## 認証

環境変数 `API_KEY` が設定されている環境では、`/v1/health` と画面以外のすべてに次のどちらかが必要。

```
x-api-key: <API_KEY>
Authorization: Bearer <API_KEY>
```

CORS は `Access-Control-Allow-Origin: *`。OPTIONS プリフライトは 204。

## `POST /v1/sensors` — 1 件投入

```http
POST /sensor-mcp-server/v1/sensors
Content-Type: application/json

{ "no": "jksoft0930-1", "ts": 1759276800000, "temperature": 25.1, "humidity": 60 }
```

| フィールド | 必須 | 型 | 説明 |
| :--- | :--- | :--- | :--- |
| `no` | ○ | string | センサー番号。英数字と `_ . : -`、1〜64 文字。メインキー |
| `ts` | — | number \| 数字文字列 | 計測時刻（エポックミリ秒を想定）。省略時はサーバ時刻。サブキー |
| その他 | — | 任意 | そのまま保存される（温度・湿度など） |

- 同じ `no` + `ts` は上書き（put）
- ボディ上限は `SENSOR_BODY_LIMIT_BYTES`（既定 64KB）。データストアの 1 アイテム上限（約 350KB）より十分小さくしている
- 登録簿テーブル（`DS_TABLE_SENSORS`）が設定されていれば、最新値を登録簿にも書く

レスポンス `201`:

```json
{ "item": { "no": "jksoft0930-1", "ts": 1759276800000, "temperature": 25.1, "humidity": 60 } }
```

## `GET /v1/sensors/{no}` — 期間で取得（1 ページ）

`GET /v1/sensors?no={no}&...` でも同じ。

| クエリ | 既定 | 説明 |
| :--- | :--- | :--- |
| `startTime` | なし | エポックミリ秒。`ts >= startTime` |
| `endTime` | なし | エポックミリ秒。`ts <= endTime`。両方指定で `BETWEEN`（元フローと同じ） |
| `limit` | `SENSOR_QUERY_LIMIT`（100） | 1 ページの件数。`SENSOR_QUERY_MAX_LIMIT`（1000）でクランプ |
| `order` | `asc` | `asc`（古い順） / `desc`（新しい順） |
| `startKey` | なし | 前のページの `nextStartKey` |

空文字のパラメータは「指定なし」として扱う。`startTime > endTime` は 400。

レスポンス `200`:

```json
{
  "items": [ { "no": "jksoft0930-1", "ts": 1759276800000, "temperature": 25.1 } ],
  "nextStartKey": "..."
}
```

`nextStartKey` は続きがあるときだけ入る。**1 リクエスト = データストアアクセス 1 回**。
全件が必要なら `nextStartKey` を渡して繰り返す（回数はアクセス数の月次上限を消費する）。

## 互換パス（Node-RED フローと同じ）

| パス | 対応するフロー | レスポンス |
| :--- | :--- | :--- |
| `POST /ttc-iot-sensor` | `sample/sensor-upload` | `200` `{ "result": "success", "params": { "Item": {...} } }` |
| `GET /get-sonsor?no&startTime&endTime&limit&startKey` | `sample/get-sensor` | `200` Items の**配列そのもの** |

入力の扱いは `/v1/sensors` と同じ（検証・上限・認証）。詳細は [migration-from-node-red.md](migration-from-node-red.md)。

## `GET /v1/health` — 稼働確認（認証不要）

```json
{
  "status": "ok",
  "version": "0.1.0",
  "commit": "<git sha>",
  "builtAt": "2026-10-05T06:00:00.000Z",
  "mockMode": false,
  "basicAuth": false,
  "apiKeyAuth": true,
  "datastore": "cloud",
  "mcp": { "tools": ["list_sensors", "get_latest_reading", "query_sensor_readings", "summarize_sensor_readings"], "registry": true },
  "configOk": true,
  "configMissing": 0,
  "limits": { "sensorQueryLimit": 100, "sensorQueryMaxLimit": 1000, "sensorBodyLimitBytes": 65536, "mcpSummaryMaxPages": 5, "mcpListSensorsLimit": 200 }
}
```

- `commit` はデプロイしたビルドの照合に使う（`deploy.mjs` のスモークテスト）
- `configMissing` は件数だけ。不足キー名は起動時ログにのみ出る
- `mcp.registry` が `false` なら `list_sensors` は使えない（`DS_TABLE_SENSORS` 未設定）

## `POST /mcp`

MCP（Model Context Protocol）の Streamable HTTP エンドポイント。[mcp.md](mcp.md) を参照。
