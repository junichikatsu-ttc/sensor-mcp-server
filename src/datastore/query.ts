import type { DataStoreClient } from './client'
import { runOp } from './run'

export type SortOrder = 'asc' | 'desc'

/**
 * SDK の `order` は README（true=昇順）と JSDoc（false=昇順）で意味が食い違う。
 * 本番で実測した結果（@uhuru/enebular-sdk 1.0.1）は **true = 昇順 / false = 降順**。
 * SDK の ProxyClient が `Order: !order` に反転してプロキシへ渡し、プロキシは `ScanIndexForward: !Order` にする。
 * ここ 1 箇所で写像し、呼び出し側は 'asc' | 'desc' だけを使う。
 */
export function toSdkOrder(order: SortOrder): boolean {
  return order === 'asc'
}

/**
 * query の values。キーは**テーブルのメインキー名かサブキー名**でなければならない（pitfalls 13）。
 * 配列は IN / BETWEEN 用に `:名前1`, `:名前2`, … へ展開される。
 */
export type QueryValues = Record<string, string | number | (string | number)[]>

export interface PageOptions {
  tableId: string
  /** 例: '#no = :no AND #ts BETWEEN :ts1 AND :ts2'（values.ts = [start, end]） */
  expression: string
  values: QueryValues
  order: SortOrder
  /** 1 ページの件数。SDK の既定は 10 件なので必ず明示する */
  limit: number
  /** 前のページの nextStartKey をそのまま渡す */
  startKey?: string
}

export interface Page<T> {
  items: T[]
  /** 続きがあるときだけ入る */
  nextStartKey?: string
}

/** LastEvaluatedKey は型が any。文字列ならそのまま、オブジェクトなら JSON にして往復させる */
function toStartKey(next: unknown): string | undefined {
  if (next === undefined || next === null || next === '') return undefined
  return typeof next === 'string' ? next : JSON.stringify(next)
}

/** 1 ページだけ取る（データストアへのアクセスは 1 回）。ページングは呼び出し側に委ねる */
export async function queryPage<T>(client: DataStoreClient, opts: PageOptions): Promise<Page<T>> {
  const params: Parameters<DataStoreClient['query']>[0] = {
    tableId: opts.tableId,
    expression: opts.expression,
    values: opts.values,
    limit: opts.limit,
    order: toSdkOrder(opts.order),
  }
  if (opts.startKey !== undefined) params.startKey = opts.startKey
  const res = await runOp('query', () => client.query(params))
  const page: Page<T> = { items: (res.params?.Items ?? []) as T[] }
  const next = toStartKey(res.params?.LastEvaluatedKey)
  if (next !== undefined) page.nextStartKey = next
  return page
}

export interface QueryOptions extends Omit<PageOptions, 'limit' | 'startKey'> {
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
    const pageOpts: PageOptions = {
      tableId: opts.tableId,
      expression: opts.expression,
      values: opts.values,
      order: opts.order,
      limit: opts.pageSize,
    }
    if (startKey !== undefined) pageOpts.startKey = startKey
    const res = await queryPage<T>(client, pageOpts)
    items.push(...res.items)
    if (res.nextStartKey === undefined) break
    startKey = res.nextStartKey
  }
  return items
}
