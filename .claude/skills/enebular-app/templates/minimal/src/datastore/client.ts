import { CloudDataStoreClient } from '@uhuru/enebular-sdk'
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

/**
 * 使う操作だけに絞ったインターフェース。CloudDataStoreClient を直接持ち回らない（pitfalls 7）。
 * テストとローカルはこのインターフェースの別実装（MemoryDataStoreClient）に差し替える。
 */
export interface DataStoreClient {
  getItem(params: DsGetParams): Promise<DsGetItemResult>
  putItem(params: DsPutParams): Promise<DsPutItemResult>
  query(params: DsQueryParams): Promise<DsQueryItemResult>
  deleteItem(params: DsDeleteParams): Promise<DsDeleteItemResult>
}

export type DataStoreKind = 'cloud' | 'memory'

let injected: { client: DataStoreClient; kind: DataStoreKind } | undefined
let cached: DataStoreClient | undefined

/** テスト・ローカル用の差し替え。undefined で解除 */
export function setDataStoreClient(client: DataStoreClient | undefined, kind: DataStoreKind = 'memory'): void {
  injected = client ? { client, kind } : undefined
}

export function dataStoreKind(): DataStoreKind {
  return injected?.kind ?? 'cloud'
}

export function getDataStoreClient(): DataStoreClient {
  if (injected) return injected.client
  if (cached) return cached
  // 生成は初回アクセス時まで遅らせる。接続情報は実行環境が注入する。
  // ENEBULAR_DS_JWT / ENEBULAR_DS_PROXY_ARN が無いと throw するため、
  // モジュール読み込み時に作ると /v1/health すら返らなくなる（pitfalls 7）
  cached = new CloudDataStoreClient() as DataStoreClient
  return cached
}
