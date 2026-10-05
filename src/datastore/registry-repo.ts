import type { SensorNo, SensorReading } from '../schemas'
import { getDataStoreClient } from './client'
import { queryAll } from './query'
import { runOp } from './run'
import { resolveTableId, tableConfigured } from './tables'

/**
 * センサー登録簿（任意テーブル `sensors`）。
 * データストアはメインキーを横断して走査できないため、「どのセンサーがあるか」は投入時に書いておくしかない。
 * 集計は閲覧時ではなく書き込み時に事前計算する（constraints.md）。
 *
 * 1 センサー = 1 アイテム。投入のたびに上書き（put）するので、アイテム数はセンサー数で頭打ちになる。
 */

const TABLE = 'sensors' as const
const SCOPE = 'all'

export interface SensorMeta {
  scope: typeof SCOPE
  no: SensorNo
  /** 最後に受け取った計測時刻 */
  lastTs: number
  /** 最後に受け取った 1 件（no / ts を含む） */
  lastReading: SensorReading
  /** サーバが登録簿を更新した時刻（エポックミリ秒） */
  updatedAt: number
}

export function registryEnabled(): boolean {
  return tableConfigured(TABLE)
}

/** 投入のたびに呼ぶ。登録簿が無効なら何もしない（アクセス回数を増やさない） */
export async function upsertSensorMeta(reading: SensorReading, now: () => number = Date.now): Promise<void> {
  if (!registryEnabled()) return
  const client = getDataStoreClient()
  const meta: SensorMeta = { scope: SCOPE, no: reading.no, lastTs: reading.ts, lastReading: reading, updatedAt: now() }
  await runOp('putItem', () => client.putItem({ tableId: resolveTableId(TABLE), item: meta }))
}

/** 登録済みセンサーの一覧（no の昇順）。登録簿が無効なら undefined */
export async function listSensorMeta(limit: number): Promise<SensorMeta[] | undefined> {
  if (!registryEnabled()) return undefined
  const client = getDataStoreClient()
  const rows = await queryAll<SensorMeta>(client, {
    tableId: resolveTableId(TABLE),
    expression: '#scope = :scope',
    values: { scope: SCOPE },
    order: 'asc',
    pageSize: Math.min(limit, 100),
    maxPages: Math.max(1, Math.ceil(limit / 100)),
  })
  return rows.slice(0, limit)
}
