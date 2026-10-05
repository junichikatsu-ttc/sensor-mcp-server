import type { Item, OwnerId } from '../schemas'
import { getDataStoreClient } from './client'
import { queryAll } from './query'
import { runGet, runOp } from './run'
import { resolveTableId } from './tables'

/**
 * リポジトリ層のお手本。新しいテーブルを足すときはこのファイルを写して作る。
 *
 * 守ること:
 *   - 生の string を受け取らない。ブランド型（OwnerId）だけを受け取る。
 *     文字列連結でキーを作るコードがコンパイルを通らなくなる
 *   - メインキーの先頭に所有者・テナントを置く。他人のデータは 0 件しか返らない
 *     （アプリ層のフィルタリングに頼らない）
 *   - query は limit を必ず明示する（SDK の既定は 10 件）
 */

const TABLE = 'items' as const

export async function putItem(item: Item): Promise<void> {
  const client = getDataStoreClient()
  await runOp('putItem', () => client.putItem({ tableId: resolveTableId(TABLE), item }))
}

export async function getItem(ownerId: OwnerId, createdAt: number): Promise<Item | undefined> {
  const client = getDataStoreClient()
  // "Not found" は正常系。runGet が undefined に落とす（pitfalls 6）
  const res = await runGet(() => client.getItem({ tableId: resolveTableId(TABLE), key: { ownerId, createdAt } }))
  return res?.params?.Item as Item | undefined
}

/** 新しい順。所有者のアイテムだけが返る（メインキーが一致しないため） */
export async function listItems(ownerId: OwnerId, limit: number): Promise<Item[]> {
  const client = getDataStoreClient()
  const rows = await queryAll<Item>(client, {
    tableId: resolveTableId(TABLE),
    expression: '#ownerId = :ownerId',
    values: { ownerId },
    order: 'desc',
    pageSize: Math.min(limit, 100),
    maxPages: 1,
  })
  return rows.slice(0, limit)
}

export async function deleteItem(ownerId: OwnerId, createdAt: number): Promise<void> {
  const client = getDataStoreClient()
  await runOp('deleteItem', () => client.deleteItem({ tableId: resolveTableId(TABLE), key: { ownerId, createdAt } }))
}
