import type { DataStoreOperation } from './errors'
import { classifyDataStoreError, DataStoreError, isNotFoundError } from './errors'

interface SdkResult {
  result?: 'success' | 'fail'
  error?: string
}

/** SDK は `result: 'fail'` を throw せず返すこともありうるので、ここで失敗に揃える */
function assertSuccess<T extends SdkResult>(operation: DataStoreOperation, res: T): T {
  if (res.result === 'fail' || res.error) {
    throw new DataStoreError(operation, 'failed', res.error ?? 'result: fail')
  }
  return res
}

export async function runOp<T extends SdkResult>(operation: DataStoreOperation, fn: () => Promise<T>): Promise<T> {
  try {
    return assertSuccess(operation, await fn())
  } catch (err) {
    throw classifyDataStoreError(operation, err)
  }
}

/**
 * getItem 専用。"Not found" は正常系なので undefined に落とす（pitfalls 6）。
 * putItem / query / deleteItem の not found は設定ミスの可能性があるので吸収しない。
 */
export async function runGet<T extends SdkResult>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return assertSuccess('getItem', await fn())
  } catch (err) {
    if (isNotFoundError(err)) return undefined
    if (err instanceof DataStoreError && err.kind === 'failed' && isNotFoundError(err.reason)) return undefined
    throw classifyDataStoreError('getItem', err)
  }
}
