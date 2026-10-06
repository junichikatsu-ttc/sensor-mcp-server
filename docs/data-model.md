# データモデル

enebular データストアは「メインキー + サブキー」の JSON アイテムストア。JOIN・二次インデックス・集計は無い。
アクセスパターンから逆算してキーを決める（[enebular-app スキル constraints.md](../.claude/skills/enebular-app/references/constraints.md)）。

## アクセスパターン

| 誰が | 何を | どの順で | 使うテーブル / 操作 |
| :--- | :--- | :--- | :--- |
| デバイス | 1 件を保存 | — | `sensorData` put |
| REST / MCP | あるセンサーの期間内のデータ | 時刻順（昇順 / 降順） | `sensorData` query（`#no = :no AND #ts BETWEEN :ts1 AND :ts2`、`values: { no, ts: [start, end] }`。値名はキー属性名に限る） |
| MCP | あるセンサーの最新 1 件 | 降順 1 件 | `sensorData` query（desc, limit 1） |
| MCP | どのセンサーがあるか + 最新値 | `no` 順 | `sensors` query（`scope` = 'all'） |

## テーブル `sensorData`（必須）— 環境変数 `DS_TABLE_SENSOR_DATA`

元の Node-RED フローが使っていたテーブルと同じキー構成。**既存テーブルの ID をそのまま使える。**

| 属性 | 型 | 役割 |
| :--- | :--- | :--- |
| `no` | string | **メインキー**。センサー番号（例 `jksoft0930-1`） |
| `ts` | number | **サブキー**。計測時刻（エポックミリ秒を想定）。範囲クエリの軸 |
| その他 | 任意 | デバイスが送った属性（`temperature`, `humidity` など）をそのまま保存 |

- 1 計測 = 1 アイテム。同じ `no` + `ts` は上書き
- サブキーは**必ず数値型**で作る。文字列にすると範囲クエリが辞書順になり、桁が変わった時点で壊れる
- 1 アイテム約 350KB まで。投入 API はボディを 64KB（既定）で制限している

## テーブル `sensors`（任意）— 環境変数 `DS_TABLE_SENSORS`

「どのセンサーがあるか」の登録簿。データストアはメインキーを横断して走査できないので、投入時に書いておく。

| 属性 | 型 | 役割 |
| :--- | :--- | :--- |
| `scope` | string | **メインキー**。常に `all`（単一パーティション） |
| `no` | string | **サブキー**。センサー番号 |
| `lastTs` | number | 最後に受け取った計測時刻 |
| `lastReading` | object | 最後に受け取った 1 件（`no` / `ts` 含む） |
| `updatedAt` | number | サーバが更新した時刻 |

- 1 センサー = 1 アイテム。投入のたびに上書きするので、アイテム数はセンサー数で頭打ち
- **有効時は投入 1 件 = データストアアクセス 2 回。** 月次上限（フリー 10,000 / エンタープライズ 3,000,000）を見て決める
- テーブル ID が未設定なら登録簿は無効。`/v1/health` の `mcp.registry` が `false` になり、MCP の `list_sensors` は使えない

## コンソールでのテーブル作成

キー属性名と型は `src/datastore/tables.ts` と**完全に一致**させる。

| テーブル | メインキー | サブキー |
| :--- | :--- | :--- |
| センサーデータ | `no`（文字列） | `ts`（数値） |
| センサー登録簿 | `scope`（文字列） | `no`（文字列） |

作成後、設定タブのテーブル ID を `.env.deploy` の `FN_DS_TABLE_SENSOR_DATA` / `FN_DS_TABLE_SENSORS` に入れる。

## アクセス数の見積り

| 操作 | アクセス回数 |
| :--- | :--- |
| 投入 1 件（登録簿なし） | 1 |
| 投入 1 件（登録簿あり） | 2 |
| REST 取得 1 ページ | 1 |
| MCP `get_latest_reading` | 1 |
| MCP `query_sensor_readings` | 1 / ページ |
| MCP `summarize_sensor_readings` | 最大 `MCP_SUMMARY_MAX_PAGES`（既定 5） |
| MCP `list_sensors` | 1〜（100 件ごとに +1） |

例: 1 台が 1 分おきに送ると、投入だけで月 43,200 回（登録簿ありなら 86,400 回）。フリープランの上限を超える。

## 将来の拡張

- **マルチテナント**: メインキーを `tenantId#no` にした新テーブルを起こし、リポジトリ層で `TenantId` ブランド型を要求する。
  既存テーブルは互換パス専用として残し、段階的に移す
- **日次集計**: `summarize_sensor_readings` のアクセス回数が問題になったら、投入時に `dailyStats`（`no`, `day`）へ
  min / max / sum / count を事前計算して書く（閲覧時に集計しない）
