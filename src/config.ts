import { dataStoreKind, missingTableEnvs, TABLES } from './datastore'
import { log } from './log'

/**
 * 環境変数の読み取りと設定漏れ検出。
 * - 呼び出しのたびに読む（モジュール読み込み時に固めない）
 * - .env.example の雛形値は未設定と同じ扱い
 * - ここでは throw しない。設定不足で起動を止めると /v1/health すら返らなくなる（pitfalls 8）
 */

const PLACEHOLDERS = new Set(['', 'change-me', '00000000-0000-0000-0000-000000000000'])

function env(name: string): string | undefined {
  const v = process.env[name]?.trim()
  if (v === undefined || PLACEHOLDERS.has(v)) return undefined
  return v
}

function envInt(name: string, fallback: number): number {
  const v = Number(env(name))
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback
}

export interface AppConfig {
  mockMode: boolean
  /** デモ公開時の簡易ガード。両方そろったときだけ HTML に BASIC 認証を掛ける */
  basicAuthUser: string | undefined
  basicAuthPassword: string | undefined
  /**
   * センサー API と MCP のキー。設定したときだけ `x-api-key` ヘッダ（または Bearer）を要求する。
   * 未設定なら元の Node-RED フローと同じく誰でも投入・取得できる
   */
  apiKey: string | undefined
  /** limit 省略時の取得件数 */
  sensorQueryLimit: number
  /** limit の上限。これより大きい指定はクランプする */
  sensorQueryMaxLimit: number
  /** 投入 API / MCP のリクエストボディ上限（バイト）。データストアの 1 アイテム上限（約 350KB）より十分小さく */
  sensorBodyLimitBytes: number
  /** MCP summarize_sensor_readings が 1 回の呼び出しで辿るページ数の上限（= データストアアクセス回数の上限） */
  mcpSummaryMaxPages: number
  /** MCP list_sensors の既定件数 */
  mcpListSensorsLimit: number
}

export function readConfig(): AppConfig {
  const maxLimit = envInt('SENSOR_QUERY_MAX_LIMIT', 1000)
  return {
    mockMode: env('MOCK_MODE') !== 'false', // 未設定はモック（デモ既定）。本番は明示的に false にする
    basicAuthUser: env('BASIC_AUTH_USER'),
    basicAuthPassword: env('BASIC_AUTH_PASSWORD'),
    apiKey: env('API_KEY'),
    sensorQueryLimit: Math.min(envInt('SENSOR_QUERY_LIMIT', 100), maxLimit),
    sensorQueryMaxLimit: maxLimit,
    sensorBodyLimitBytes: envInt('SENSOR_BODY_LIMIT_BYTES', 64 * 1024),
    mcpSummaryMaxPages: envInt('MCP_SUMMARY_MAX_PAGES', 5),
    mcpListSensorsLimit: envInt('MCP_LIST_SENSORS_LIMIT', 200),
  }
}

export function basicAuthEnabled(): boolean {
  const cfg = readConfig()
  return Boolean(cfg.basicAuthUser && cfg.basicAuthPassword)
}

export function apiKeyAuthEnabled(): boolean {
  return Boolean(readConfig().apiKey)
}

/**
 * 動作モードに応じた必須キーのうち、未設定のもの。/v1/health には件数だけ出す。
 * ★ 外部サービスを足したら、ここに「モードに応じた必須」を足す。手作業のチェックリストにしない。
 */
export function missingConfigKeys(): string[] {
  const missing: string[] = []
  const cfg = readConfig()
  if (dataStoreKind() === 'cloud') for (const t of missingTableEnvs()) missing.push(TABLES[t].env)
  // 片方だけ設定されている BASIC 認証は事故なので不足として扱う
  if (Boolean(cfg.basicAuthUser) !== Boolean(cfg.basicAuthPassword)) missing.push('BASIC_AUTH_USER/PASSWORD')
  return missing
}

/** コールドスタート時に 1 回だけ。キー名はここにしか出さない。値はどこにも出さない */
export function logConfigIssues(): void {
  const missing = missingConfigKeys()
  if (missing.length > 0) log.warn('config missing', { keys: missing })
  const cfg = readConfig()
  if (cfg.mockMode) log.info('MOCK_MODE is on')
  if (!cfg.apiKey) log.warn('API_KEY is not set: sensor API and MCP accept unauthenticated requests')
}

/** 実際に効いている上限値。/v1/health に出す */
export function effectiveLimits(): Record<string, number> {
  const cfg = readConfig()
  return {
    sensorQueryLimit: cfg.sensorQueryLimit,
    sensorQueryMaxLimit: cfg.sensorQueryMaxLimit,
    sensorBodyLimitBytes: cfg.sensorBodyLimitBytes,
    mcpSummaryMaxPages: cfg.mcpSummaryMaxPages,
    mcpListSensorsLimit: cfg.mcpListSensorsLimit,
  }
}
