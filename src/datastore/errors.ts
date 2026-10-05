export type DataStoreOperation = 'getItem' | 'putItem' | 'query' | 'deleteItem'

/**
 * SDK の失敗は 2 通りの伝わり方をする（pitfalls 5）。
 *   - 文字列を throw → データストア操作がエラーを返した（テーブル不在・キー不正・Not found）= failed
 *   - Error を throw  → プロキシ Lambda に到達できない = threw
 * 両方をここ 1 箇所で正規化する。`reason` は SDK の生メッセージで、ログにだけ出す。
 */
export class DataStoreError extends Error {
  constructor(
    public readonly operation: DataStoreOperation,
    public readonly kind: 'failed' | 'threw',
    public readonly reason: string,
    public readonly errorName?: string,
  ) {
    super(`datastore ${operation} ${kind}`)
    this.name = 'DataStoreError'
  }
}

/** テーブル ID の環境変数が無い。リクエスト単位のエラーにする（起動は止めない） */
export class DataStoreConfigError extends Error {
  constructor(public readonly tableName: string) {
    super(`datastore table not configured: ${tableName}`)
    this.name = 'DataStoreConfigError'
  }
}

export function classifyDataStoreError(operation: DataStoreOperation, err: unknown): DataStoreError {
  if (err instanceof DataStoreError) return err
  if (typeof err === 'string') return new DataStoreError(operation, 'failed', err)
  if (err instanceof Error) return new DataStoreError(operation, 'threw', err.message, err.name)
  return new DataStoreError(operation, 'threw', String(err))
}

/**
 * getItem の「アイテムが無い」だけを拾う。部分一致にすると "Table not found"（設定ミス）まで
 * 正常系に化けるので、メッセージ全体が "Not found" のときだけ true。
 */
export function isNotFoundError(err: unknown): boolean {
  return typeof err === 'string' && /^not\s*found\.?$/i.test(err.trim())
}
