# Node-RED フローからの移行

`sample/` の 2 フローを TypeScript の 1 関数に置き換えた。対応と差分をまとめる。

## 対応表

| 元フロー | 元の入口 | 新しい入口 | 互換パス |
| :--- | :--- | :--- | :--- |
| `sample/sensor-upload/flow.json` | LCDP-in → `req.method` が POST → `msg.item = payload` → `ds-put-item` | `POST /v1/sensors` | `POST /ttc-iot-sensor` |
| 同上（OPTIONS 分岐） | 「プリフライト応答」function → 204 + CORS | `hono/cors` が自動応答 | 同左 |
| `sample/get-sensor/flow.json` | LCDP-in → JSONata で `$number()` → `ds-easy-query-item`（`no` =, `ts` BETWEEN, asc） | `GET /v1/sensors/{no}` | `GET /get-sonsor` |

ノード単位の対応:

| Node-RED ノード | TypeScript |
| :--- | :--- |
| `datastore-config`（テーブル ID） | 環境変数 `DS_TABLE_SENSOR_DATA`（`src/datastore/tables.ts`） |
| `ds-put-item` | `putReading()` / `saveReading()`（`src/datastore/sensor-repo.ts`） |
| `ds-easy-query-item`（mainKey `no`, subKey `ts` between, order asc, limit, startKey） | `queryReadings()` + `buildSensorExpression()` |
| `change`（`$number(startTime)` など） | Zod スキーマ `sensorQueryInputSchema`（`src/schemas.ts`）。数字文字列を数値へ |
| `catch` → `statusCode = 500` | `toErrorResponse()`（`src/errors.ts`）。データストアエラーは 503 `DATASTORE` |
| `change`（CORS ヘッダ） | `cors({ origin: '*' })`（`src/routes/index.ts`） |
| `http response` | Hono の `c.json()` |

## 既存デバイスの移行手順

1. 新しい関数をデプロイし、トリガー URL を得る（例 `https://xxxx.enebular.com/sensor-mcp-server`）
2. デバイスの送信先を `https://<旧ホスト>/ttc-iot-sensor` → `https://xxxx.enebular.com/sensor-mcp-server/ttc-iot-sensor` に変える
   （パスの末尾は同じ。ボディもそのまま）
3. `API_KEY` を設定した環境では `x-api-key` ヘッダを足す。付けられないデバイスがあるうちは `API_KEY` を空にしておく
4. 取得側（ダッシュボード等）は `/get-sonsor` のまま動く。余裕ができたら `/v1/sensors/{no}` に移し、`nextStartKey` でページングする
5. 全デバイスが移ったら元のフロー（クラウド実行環境）を停止する。**データストアのテーブルは同じものを使い続ける**ので、データ移行は不要

## 挙動の差分

| 項目 | 元フロー | 新実装 | 理由 |
| :--- | :--- | :--- | :--- |
| 入力検証 | なし（`payload` をそのまま put） | `no` 必須・形式チェック。不正は 400 `VALIDATION` | キーが欠けた put はデータストア側で失敗し、原因が分かりにくい |
| `ts` 省略 | put が失敗（サブキー欠落） | サーバ時刻を補完 | デバイス側に時計が無い場合に対応 |
| `ts` が文字列 | そのまま文字列で保存され、範囲クエリから外れる | 数値に正規化 | サブキーは数値型 |
| `startTime` / `endTime` 片方だけ | JSONata の `$number(undefined)` で失敗 | `>=` / `<=` で受ける | — |
| `limit` 省略 | SDK 既定の 10 件 | `SENSOR_QUERY_LIMIT`（100）。上限 `SENSOR_QUERY_MAX_LIMIT`（1000） | — |
| エラー時のステータス | 500 | データストア: 503 `DATASTORE` / 入力: 400 / 設定不足: 500 `CONFIG_MISSING` | 原因が切り分けられる |
| ページング | `msg.startKey` に出るが HTTP ボディには出ない | `/v1/sensors` は `nextStartKey` を返す。`/get-sonsor` は元のまま配列のみ | — |
| 認証 | なし | 任意（`API_KEY`） | 既定は元と同じ無認証 |
| ボディ上限 | なし | 64KB（既定） | 1 アイテム 350KB の上限に近づけない |
| 登録簿 | なし | 任意テーブル `sensors` に最新値を書く | MCP の `list_sensors` のため |

## 互換パスのレスポンス形について

- `GET /get-sonsor` の「Items 配列そのもの」は、`ds-easy-query-item` の出力先（`payload`）を `http response` が返す構成から確定している
- `POST /ttc-iot-sensor` の `{ result: 'success', params: { Item } }` は、`ds-put-item` の出力（put 結果）を `payload` に出していたことから、
  SDK の `DsPutItemResult` の形で再現している。元ノードの出力の正確な形は実機で確認していないので、
  **レスポンスボディを読んでいるクライアントがあれば実機の値と突き合わせること**（ステータス 200 だけ見ているなら影響なし）

## 残しているもの

`sample/` のフロー JSON はそのまま残してある（仕様の原本）。新しいフローを足す予定が無ければ、移行完了後に消してよい。
