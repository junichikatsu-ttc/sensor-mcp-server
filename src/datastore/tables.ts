import { DataStoreConfigError } from './errors'

/**
 * テーブル定義。キー属性名は enebular コンソールでテーブルを作るときに **この名前・型で** 指定する。
 * テーブル ID は環境変数から解決し、コードに書かない（constraints.md「キー設計の原則」）。
 *
 * sensorData は元の Node-RED フロー（sample/）が使っていたテーブルと同じキー構成にしてある。
 * 既存テーブルの ID をそのまま DS_TABLE_SENSOR_DATA に入れれば、蓄積済みのデータを引き継げる。
 *   - mainKey `no`: センサー番号（string）
 *   - subKey  `ts`: 計測時刻（number）。範囲クエリ（BETWEEN）の軸。string にすると辞書順になり壊れる
 *
 * sensors は「どのセンサーがあるか」の登録簿（任意）。データストアにはメインキーを横断する走査が無いので、
 * LLM が list_sensors で一覧を引けるように、投入時に 1 件書き足して事前計算しておく（E2 / E4）。
 *   - mainKey `scope`: 常に 'all'（単一パーティション）
 *   - subKey  `no`:    センサー番号（string）
 *   テーブル ID 未設定なら登録簿は無効になり、投入 1 件 = データストアアクセス 1 回で済む。
 *
 * ★ 注意: 原則では mainKey の先頭に所有者・テナントを入れるが、既存データとの互換を優先して `no` 単独にしている。
 *   マルチテナントにするときは `tenantId#no` のような複合キーの新テーブルを起こし、移行する。
 *
 * ★ テーブルを足すときはここに 1 行足し、.env.example と .env.deploy.example、deploy.mjs の REQUIRED_FN にも同じ env 名を足す。
 */
export const TABLES = {
  sensorData: { env: 'DS_TABLE_SENSOR_DATA', mainKey: 'no', subKey: 'ts', subKeyType: 'number', optional: false },
  sensors: { env: 'DS_TABLE_SENSORS', mainKey: 'scope', subKey: 'no', subKeyType: 'string', optional: true },
} as const

export type TableName = keyof typeof TABLES
export const TABLE_NAMES = Object.keys(TABLES) as TableName[]

/** .env.example の雛形値。設定済みとみなさない */
const PLACEHOLDER_RE = /^0{8}-0{4}-0{4}-0{4}-0{12}$/

type Resolver = (name: TableName) => string | undefined
let override: Resolver | undefined

/** ローカル（memory）やテストで、環境変数を介さずテーブル ID を決める */
export function setTableIdResolver(fn: Resolver | undefined): void {
  override = fn
}

/** 環境変数から読む。呼び出しのたびに読む（モジュール読み込み時に固めない） */
export function tableIdFromEnv(name: TableName): string | undefined {
  const raw = process.env[TABLES[name].env]?.trim()
  if (!raw || PLACEHOLDER_RE.test(raw)) return undefined
  return raw
}

export function resolveTableId(name: TableName): string {
  const id = override ? override(name) : tableIdFromEnv(name)
  if (!id) throw new DataStoreConfigError(name)
  return id
}

/** 任意テーブルが使える状態か（ID が解決できるか）。throw しない */
export function tableConfigured(name: TableName): boolean {
  return (override ? override(name) : tableIdFromEnv(name)) !== undefined
}

/** 設定漏れ検出用。未設定の必須テーブル名を返す（optional なテーブルは含めない） */
export function missingTableEnvs(): TableName[] {
  if (override) return []
  return TABLE_NAMES.filter((n) => !TABLES[n].optional && tableIdFromEnv(n) === undefined)
}
