import type {
  DsDeleteItemResult,
  DsDeleteParams,
  DsGetItemResult,
  DsGetParams,
  DsPutItemResult,
  DsPutParams,
  DsQueryItemResult,
  DsQueryParams,
} from '@uhuru/enebular-sdk'
import type { DataStoreClient } from './client'
import { TABLES } from './tables'
import type { TableName } from './tables'

/**
 * インメモリ実装。ローカル起動と統合テストで使う。
 *
 * 実物との違いを小さくするため、SDK の振る舞いをなるべく模倣する:
 *   - getItem で無ければ **文字列** 'Not found' を throw（runGet が undefined に落とす）
 *   - 未知のテーブル ID は文字列 'Table not found' を throw
 *   - query の expression は `#a = :a [AND #b (=|<|<=|>|>=) :b | AND #b BETWEEN :x AND :y]` のみ対応
 *   - limit / startKey / LastEvaluatedKey によるページング
 *   - order: true = 降順（query.ts の toSdkOrder と同じ解釈）
 * 永続化はしない。プロセスが終わると消える。
 */

type KeyValue = string | number
type Item = Record<string, unknown>

interface TableSpec {
  mainKey: string
  subKey: string
}

interface Cond {
  field: string
  op: '=' | '<' | '<=' | '>' | '>=' | 'between'
  a: KeyValue
  b?: KeyValue
}

const COND_RE = /^#(\w+)\s*(=|<=|>=|<|>)\s*:(\w+)$/
const BETWEEN_RE = /^#(\w+)\s+BETWEEN\s+:(\w+)\s+AND\s+:(\w+)$/i

function parseExpression(expression: string, values: Record<string, KeyValue>): Cond[] {
  // BETWEEN は内部に AND を含むので先に退避する
  const conds: Cond[] = []
  const between = BETWEEN_RE.exec(expression.trim())
  if (between) {
    const [, field, a, b] = between
    return [{ field: field!, op: 'between', a: values[a!]!, b: values[b!]! }]
  }
  const parts = expression.split(/\s+AND\s+/i)
  for (const part of parts) {
    const p = part.trim()
    const bt = BETWEEN_RE.exec(p)
    if (bt) {
      conds.push({ field: bt[1]!, op: 'between', a: values[bt[2]!]!, b: values[bt[3]!]! })
      continue
    }
    const m = COND_RE.exec(p)
    if (!m) throw `Unsupported expression: ${p}`
    const value = values[m[3]!]
    if (value === undefined) throw `Missing value: ${m[3]}`
    conds.push({ field: m[1]!, op: m[2] as Cond['op'], a: value })
  }
  return conds
}

function matches(item: Item, c: Cond): boolean {
  const v = item[c.field] as KeyValue | undefined
  if (v === undefined) return false
  switch (c.op) {
    case '=':
      return v === c.a
    case '<':
      return v < c.a
    case '<=':
      return v <= c.a
    case '>':
      return v > c.a
    case '>=':
      return v >= c.a
    case 'between':
      return v >= c.a && v <= (c.b as KeyValue)
  }
}

function compareKey(a: KeyValue, b: KeyValue): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
}

export class MemoryDataStoreClient implements DataStoreClient {
  private readonly specs = new Map<string, TableSpec>()
  private readonly tables = new Map<string, Map<string, Item>>()
  /** 呼び出し回数。テストで E4（アクセス数上限）の見積りに使える */
  public readonly calls = { getItem: 0, putItem: 0, query: 0, deleteItem: 0 }

  /** テーブル ID → キー仕様。省略時は TABLES の名前をそのままテーブル ID として登録する */
  constructor(specs?: Record<string, TableSpec>) {
    const src = specs ?? Object.fromEntries((Object.keys(TABLES) as TableName[]).map((n) => [n, TABLES[n]]))
    for (const [id, spec] of Object.entries(src)) {
      this.specs.set(id, { mainKey: spec.mainKey, subKey: spec.subKey })
      this.tables.set(id, new Map())
    }
  }

  private table(tableId: string): { spec: TableSpec; rows: Map<string, Item> } {
    const spec = this.specs.get(tableId)
    const rows = this.tables.get(tableId)
    if (!spec || !rows) throw 'Table not found'
    return { spec, rows }
  }

  private rowKey(spec: TableSpec, key: Item): string {
    const main = key[spec.mainKey]
    const sub = key[spec.subKey]
    if (main === undefined || sub === undefined) throw 'Invalid key'
    return `${JSON.stringify(main)}|${JSON.stringify(sub)}`
  }

  async getItem(params: DsGetParams): Promise<DsGetItemResult> {
    this.calls.getItem++
    const { spec, rows } = this.table(params.tableId)
    const item = rows.get(this.rowKey(spec, params.key as Item))
    if (!item) throw 'Not found'
    return { result: 'success', params: { Item: structuredClone(item) } }
  }

  async putItem(params: DsPutParams): Promise<DsPutItemResult> {
    this.calls.putItem++
    const { spec, rows } = this.table(params.tableId)
    const item = structuredClone(params.item as Item)
    rows.set(this.rowKey(spec, item), item)
    return { result: 'success', params: { Item: structuredClone(item) } }
  }

  async deleteItem(params: DsDeleteParams): Promise<DsDeleteItemResult> {
    this.calls.deleteItem++
    const { spec, rows } = this.table(params.tableId)
    const k = this.rowKey(spec, params.key as Item)
    const item = rows.get(k)
    if (!item) throw 'Not found'
    rows.delete(k)
    return { result: 'success', params: { Item: item } }
  }

  async query(params: DsQueryParams): Promise<DsQueryItemResult> {
    this.calls.query++
    const { spec, rows } = this.table(params.tableId)
    const conds = parseExpression(params.expression, params.values as Record<string, KeyValue>)
    const desc = params.order === true || params.order === 'true'
    const list = [...rows.values()].filter((it) => conds.every((c) => matches(it, c)))
    list.sort((a, b) => compareKey(a[spec.subKey] as KeyValue, b[spec.subKey] as KeyValue) * (desc ? -1 : 1))
    const limit = Number(params.limit) || 10
    let start = 0
    if (params.startKey) {
      const sk = JSON.parse(params.startKey) as { offset: number }
      start = sk.offset
    }
    const page = list.slice(start, start + limit)
    const res: DsQueryItemResult = {
      result: 'success',
      params: { Items: page.map((it) => structuredClone(it)), Count: page.length },
    }
    if (start + limit < list.length) res.params!.LastEvaluatedKey = JSON.stringify({ offset: start + limit })
    return res
  }

  /** テスト用: 全テーブルを空にする */
  clear(): void {
    for (const rows of this.tables.values()) rows.clear()
  }

  /** テスト用: テーブル内の全アイテム */
  dump(tableId: string): Item[] {
    return [...this.table(tableId).rows.values()].map((it) => structuredClone(it))
  }
}
