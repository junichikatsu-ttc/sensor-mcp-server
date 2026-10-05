import type { DataStoreClient } from './client'
import { runOp } from './run'

export type SortOrder = 'asc' | 'desc'

/**
 * SDK の `order` は README（true=昇順）と JSDoc（true=降順）で意味が食い違う。実測では **true = 降順**。
 * ここ 1 箇所で写像し、呼び出し側は 'asc' | 'desc' だけを使う。
 */
export function toSdkOrder(order: SortOrder): boolean {
  return order === 'desc'
}

export interface QueryOptions {
  tableId: string
  /** 例: '#ownerId = :ownerId' */
  expression: string
  values: Record<string, string | number>
  order: SortOrder
  /** 1 ページの件数。SDK の既定は 10 件なので必ず明示する */
  pageSize: number
  /** ページ数の上限。E4（アクセス数の月次上限）を守るための安全弁 */
  maxPages?: number
}

/** ページングしながら集める。上限に達したら打ち切る（例外にはしない） */
export async function queryAll<T>(client: DataStoreClient, opts: QueryOptions): Promise<T[]> {
  const items: T[] = []
  let startKey: string | undefined
  const maxPages = opts.maxPages ?? 20
  for (let page = 0; page < maxPages; page++) {
    const params: Parameters<DataStoreClient['query']>[0] = {
      tableId: opts.tableId,
      expression: opts.expression,
      values: opts.values,
      limit: opts.pageSize,
      order: toSdkOrder(opts.order),
    }
    if (startKey !== undefined) params.startKey = startKey
    const res = await runOp('query', () => client.query(params))
    for (const it of res.params?.Items ?? []) items.push(it as T)
    const next = res.params?.LastEvaluatedKey
    if (!next) break
    startKey = typeof next === 'string' ? next : JSON.stringify(next)
  }
  return items
}
