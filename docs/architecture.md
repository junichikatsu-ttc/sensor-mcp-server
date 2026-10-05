# 構成と設計判断

センサーデータを enebular データストアへ投入する REST API と、そのデータを LLM から読むための MCP サーバーを、
enebular クラウド実行環境（ZIP / Node.js 22.x / Lambda ベース）の **1 つの関数**として動かす。
元は `sample/` にある Node-RED フロー 2 本（投入・範囲取得）だった。移行の対応は [migration-from-node-red.md](migration-from-node-red.md)。

```
デバイス ──POST /v1/sensors──┐
                              │        ┌──────────────────────────────┐      ┌──────────────────┐
LLM クライアント ──POST /mcp──┼──────▶ │ Hono (hono/aws-lambda)        │ ───▶ │ enebular データストア │
                              │        │  routes/sensors  routes/mcp   │      │  sensorData (no, ts) │
ブラウザ ──GET /────────────┘        │  routes/legacy   static        │      │  sensors  (scope, no)│
                                       └──────────────────────────────┘      └──────────────────┘
```

| レイヤ | 採用 | 理由 |
| :--- | :--- | :--- |
| 関数 | TypeScript + Hono（`hono/aws-lambda`） | Lambda のイベント形式を吸収し、ローカルでは同じ app を `@hono/node-server` で起動できる |
| MCP | `@modelcontextprotocol/sdk` の `McpServer` + `WebStandardStreamableHTTPServerTransport` | Web 標準 `Request`/`Response` で動くので Hono と直結できる。追加のアダプタ不要 |
| バンドル | esbuild → 単一 CommonJS `index.js` | ZIP は `"type": "module"` 不可・ルート直下に `index.js` 必須（E3） |
| フロント | HTML + 素の JS（esbuild のみ）。関数が同一オリジンで配信 | 運用者向けの小さな確認画面だけなのでフレームワーク不要。CORS・別デプロイが消える |
| 入力検証 | Zod（REST と MCP ツールで共有） | 契約を 1 箇所に置く |
| テスト | Vitest。データストアだけインメモリ実装に差し替えた統合テスト | データストアはローカルで代替できない |

ディレクトリ:

```
src/
├── index.ts            Lambda ハンドラ（hono/aws-lambda）
├── local.ts            ローカル起動（同じ app を node-server で）
├── app.ts              3 通りマウント（/ ・ /:base ・ /:base/）。触らない
├── routes/
│   ├── index.ts          ルートの束ね。CORS と API キー認証をここで一括適用
│   ├── sensors.ts        POST /v1/sensors, GET /v1/sensors[/:no]
│   ├── mcp.ts            POST /mcp（Streamable HTTP, ステートレス, JSON 応答）
│   ├── legacy.ts         /ttc-iot-sensor, /get-sonsor（Node-RED フロー互換）
│   ├── health.ts         GET /v1/health（唯一の認証不要エンドポイント）
│   └── static-routes.ts  画面の配信
├── mcp/server.ts       MCP ツール定義（読み取り専用 4 本）
├── sensors.ts          純関数（入力の正規化・時刻解釈・要約）
├── schemas.ts          Zod スキーマ = API 契約
├── config.ts           環境変数の読み取りと設定漏れ検出（throw しない）
├── middleware/         api-key.ts / basic-auth.ts
└── datastore/          SDK ラッパ・テーブル定義・リポジトリ・インメモリ実装
```

## 設計判断（ADR）

### ADR-1: MCP は Streamable HTTP の「ステートレス + JSON レスポンス」モードで提供する

- **状況**: enebular の関数は `{ statusCode, body }` を return し、レスポンスはバッファされる。SSE もストリーミングも使えない（E1）。
  Lambda のインスタンス間でメモリを共有できないので、セッションも持てない。
- **決定**: `sessionIdGenerator` を渡さず（ステートレス）、`enableJsonResponse: true` で POST ごとに JSON を 1 発返す。
  GET（サーバ→クライアントの通知ストリーム）はトランスポートが 405 を返す。サーバーとトランスポートはリクエストごとに生成して捨てる。
- **帰結**: 進捗通知やサーバ発のメッセージは使えない。ツールは「呼んだら結果が返る」ものだけにする。
  リソースの購読（subscribe）も使えない。Streamable HTTP に対応した MCP クライアント（Claude、Cursor、`mcp-remote` など）から接続できる。

### ADR-2: ツールは読み取り専用。書き込みは REST だけ

- **決定**: MCP からデータストアへ書く手段を用意しない。投入はデバイス向けの `POST /v1/sensors`（と互換パス）だけ。
- **理由**: LLM の誤操作で計測データが汚れる経路を作らない。各ツールに `readOnlyHint: true` を付けている。

### ADR-3: テーブルのキーは元フローと同じ `no` / `ts` にする

- **決定**: `sensorData` のメインキーは `no`（string）、サブキーは `ts`（number）。既存テーブルをそのまま使う。
- **理由**: 蓄積済みデータを移行なしで引き継げる。
- **トレードオフ**: スキルの原則「メインキーの先頭に所有者・テナントを入れる」から外れる。
  マルチテナントが必要になったら `tenantId#no` を持つ新テーブルを起こす（[data-model.md](data-model.md)）。

### ADR-4: 「どのセンサーがあるか」は投入時に登録簿へ書く（任意）

- **状況**: データストアにメインキーを横断する走査が無い（E2）ので、`list_sensors` に相当する問い合わせが成立しない。
- **決定**: 任意テーブル `sensors`（`scope='all'`, `no`）に投入のたびに最新値を put する。テーブル ID 未設定なら何もしない。
- **帰結**: 有効時は投入 1 件 = データストアアクセス 2 回。アクセス数の月次上限（E4）を見て選ぶ。
  無効時は `list_sensors` が「使えない」と LLM に説明を返し、`no` をユーザーに聞く導線に落ちる。

### ADR-5: 認証は任意の API キー 1 本

- **決定**: 環境変数 `API_KEY` を設定したときだけ、`/v1/sensors*`・`/mcp`・互換パスに `x-api-key` または `Authorization: Bearer` を要求する。
  未設定なら元フローと同じく無認証。
- **理由**: 元フローは無認証で動いていた。既定の挙動を変えず、必要なら 1 変数で閉じられるようにする。
  OAuth（MCP 仕様の認可フロー）はクライアント側の対応状況を見てから検討する。

### ADR-6: 互換パスを残す

- **決定**: `POST /ttc-iot-sensor` と `GET /get-sonsor` を元のレスポンス形のまま残す（[migration-from-node-red.md](migration-from-node-red.md)）。
- **理由**: 既にこのパスへ送っているデバイスは、送信先のホスト（トリガー URL）を変えるだけで移行できる。

## 守っていること（enebular 固有）

| # | 事項 | 実装 |
| :--- | :--- | :--- |
| 1 | 前段キャッシュが `.css` / `.js` を 4 時間キャッシュする | `index.html` の `?v=__ASSET_VERSION__` を配信時にコミットハッシュへ置換。`test/app.test.ts` で固定 |
| 2 | HTTP トリガーはトリガーのパスを含めて呼ぶ | `app.ts` の 3 通りマウント。トリガーのパスを環境変数で持たない |
| 3 | `getItem` の "Not found" は正常系 | `datastore/run.ts` の `runGet` |
| 4 | SDK は文字列を throw することがある | `datastore/errors.ts` で `failed` / `threw` に正規化 |
| 5 | 設定不足で起動を止めない | `config.ts` は throw せず、`/v1/health` が `configOk: false` を返す |
