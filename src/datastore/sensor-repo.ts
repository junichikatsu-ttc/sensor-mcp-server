import type { SensorNo, SensorQuery, SensorQueryResult, SensorReading } from '../schemas'
import { getDataStoreClient } from './client'
import { queryPage } from './query'
import type { QueryValues } from './query'
import { upsertSensorMeta } from './registry-repo'
import { runOp } from './run'
import { resolveTableId } from './tables'

/**
 * センサーデータのリポジトリ。元の Node-RED フロー 2 本（ds-put-item / ds-easy-query-item）に対応する。
 *
 * 守ること:
 *   - 生の string を受け取らない。ブランド型（SensorNo）だけを受け取る
 *   - query は limit を必ず明示する（SDK の既定は 10 件）
 *   - 1 リクエスト = データストアアクセス 1 回を基本にし、ページングはクライアントに startKey を返して委ねる（E4）
 */

const TABLE = 'sensorData' as const

/**
 * クエリ式の組み立て。純関数なのでデータストアなしでテストできる。
 *
 * ★ データストアのプロキシは `values` のキーが**テーブルのメインキー名 / サブキー名と一致するものだけ**
 *   `#名前` / `:名前` に変換し、それ以外のキーは名前も値も黙って捨てる（pitfalls 13）。
 *   そのため範囲条件の値も `ts` という名前で渡す。BETWEEN は配列で渡すと `:ts1` / `:ts2` に展開される
 *   （公式ノード ds-easy-query-item と同じ形）。`:startTime` のような任意名は使えない。
 *
 *   - no のみ                 → '#no = :no'
 *   - startTime のみ          → '#no = :no AND #ts >= :ts'                 values.ts = startTime
 *   - endTime のみ            → '#no = :no AND #ts <= :ts'                 values.ts = endTime
 *   - 両方（元フローと同じ）   → '#no = :no AND #ts BETWEEN :ts1 AND :ts2'  values.ts = [startTime, endTime]
 */
export function buildSensorExpression(q: Pick<SensorQuery, 'no' | 'startTime' | 'endTime'>): {
  expression: string
  values: QueryValues
} {
  const values: QueryValues = { no: q.no }
  const parts = ['#no = :no']
  if (q.startTime !== undefined && q.endTime !== undefined) {
    parts.push('#ts BETWEEN :ts1 AND :ts2')
    values['ts'] = [q.startTime, q.endTime]
  } else if (q.startTime !== undefined) {
    parts.push('#ts >= :ts')
    values['ts'] = q.startTime
  } else if (q.endTime !== undefined) {
    parts.push('#ts <= :ts')
    values['ts'] = q.endTime
  }
  return { expression: parts.join(' AND '), values }
}

/** 1 件保存。同じ no + ts は上書き（put のセマンティクス。元フローと同じ） */
export async function putReading(reading: SensorReading): Promise<void> {
  const client = getDataStoreClient()
  await runOp('putItem', () => client.putItem({ tableId: resolveTableId(TABLE), item: reading }))
}

/**
 * 投入 API の入口。データ本体を保存し、登録簿が有効なら最新値も書く。
 * 登録簿の書き込みに失敗したらエラーを返す（デバイスの再送で put は冪等に収束する）。
 */
export async function saveReading(reading: SensorReading): Promise<void> {
  await putReading(reading)
  await upsertSensorMeta(reading)
}

/** 1 ページ取得。続きがあれば nextStartKey を返す */
export async function queryReadings(q: SensorQuery): Promise<SensorQueryResult> {
  const client = getDataStoreClient()
  const { expression, values } = buildSensorExpression(q)
  const page = await queryPage<SensorReading>(client, {
    tableId: resolveTableId(TABLE),
    expression,
    values,
    order: q.order,
    limit: q.limit,
    ...(q.startKey !== undefined ? { startKey: q.startKey } : {}),
  })
  const result: SensorQueryResult = { items: page.items }
  if (page.nextStartKey !== undefined) result.nextStartKey = page.nextStartKey
  return result
}

/** 最新 1 件（アクセス 1 回）。無ければ undefined */
export async function latestReading(no: SensorNo): Promise<SensorReading | undefined> {
  const { items } = await queryReadings({ no, limit: 1, order: 'desc' })
  return items[0]
}
