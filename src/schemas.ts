import { z } from 'zod'

/**
 * API 契約。サーバの入力検証に使い、フロントの JSDoc からも参照できるよう 1 箇所にまとめる。
 *
 * 元の Node-RED フロー（sample/）が扱っていたデータの形をそのまま引き継ぐ:
 *   - センサー番号 `no`（文字列）がメインキー
 *   - 計測時刻 `ts`（数値。エポックミリ秒を想定）がサブキー
 *   - それ以外の属性（温度・湿度など）は自由。デバイスが送ったものをそのまま保存する
 */

/** センサー番号。メインキーに入る。parse でしか作れないブランド型 */
export const sensorNoSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.:-]{1,64}$/, 'no は英数字・_ . : - の 1〜64 文字')
  .brand<'SensorNo'>()
export type SensorNo = z.infer<typeof sensorNoSchema>

/** 数値、または数値として読める文字列（クエリ文字列や文字列で送ってくるデバイス向け） */
const numeric = z.union([z.number(), z.string().trim().regex(/^-?\d+(\.\d+)?$/, '数値にしてください').transform(Number)])

/** 計測時刻。負の値と非有限値は弾く。整数は強制しない（秒単位の小数で送るデバイスを想定） */
export const timestampSchema = numeric.pipe(z.number().finite().nonnegative())

/**
 * 投入 API の入力。`no` 以外のキーは検証せずそのまま通す（looseObject）。
 * `ts` を省略した場合はサーバ時刻（Date.now()）が入る（routes 側で補完）。
 */
export const sensorReadingInputSchema = z.looseObject({
  no: sensorNoSchema,
  ts: timestampSchema.optional(),
})
export type SensorReadingInput = z.infer<typeof sensorReadingInputSchema>

/** データストアに保存される 1 件 */
export type SensorReading = {
  no: SensorNo
  ts: number
  [attribute: string]: unknown
}

export const sortOrderSchema = z.enum(['asc', 'desc'])
export type SortOrder = z.infer<typeof sortOrderSchema>

/**
 * 範囲取得 API の入力。クエリ文字列から来るので値はすべて文字列でもよい。
 * limit の上限は設定（config.ts）で決めるため、ここでは下限だけ見る。
 */
export const sensorQueryInputSchema = z
  .object({
    no: sensorNoSchema,
    startTime: timestampSchema.optional(),
    endTime: timestampSchema.optional(),
    limit: numeric.pipe(z.number().int().min(1)).optional(),
    startKey: z.string().min(1).max(4096).optional(),
    order: sortOrderSchema.default('asc'),
  })
  .refine((q) => q.startTime === undefined || q.endTime === undefined || q.startTime <= q.endTime, {
    message: 'startTime は endTime 以下にしてください',
    path: ['startTime'],
  })
export type SensorQueryInput = z.infer<typeof sensorQueryInputSchema>

/** リポジトリに渡す確定済みの条件。limit は上限でクランプ済み */
export interface SensorQuery {
  no: SensorNo
  startTime?: number
  endTime?: number
  limit: number
  startKey?: string
  order: SortOrder
}

export interface SensorQueryResult {
  items: SensorReading[]
  /** 続きがあるときだけ入る。そのまま次のリクエストの startKey に渡す */
  nextStartKey?: string
}

export interface Health {
  status: 'ok'
  version: string
  commit: string
  builtAt: string
  mockMode: boolean
  basicAuth: boolean
  apiKeyAuth: boolean
  datastore: 'cloud' | 'memory'
  mcp: { tools: string[]; registry: boolean }
  configOk: boolean
  configMissing: number
  limits: Record<string, number>
}
