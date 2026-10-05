import { describe, expect, it } from 'vitest'
import { MemoryDataStoreClient, runGet, runOp, DataStoreError } from '../src/datastore'

/** enebular データストア SDK の挙動に合わせたラッパの固定（pitfalls 5 / 6） */

describe('getItem の "Not found"（pitfalls 6）', () => {
  it('正常系として undefined に落ちる（503 にしない）', async () => {
    const store = new MemoryDataStoreClient()
    const res = await runGet(() => store.getItem({ tableId: 'sensorData', key: { no: 'nobody', ts: 1 } }))
    expect(res).toBeUndefined()
  })
})

describe('文字列 throw と Error throw の正規化（pitfalls 5）', () => {
  it('文字列は failed、Error は threw に分類される', async () => {
    const store = new MemoryDataStoreClient()
    await expect(runOp('query', () => store.query({ tableId: 'nope', expression: '#no = :no', values: { no: 'x' } }))).rejects.toMatchObject({
      name: 'DataStoreError',
      kind: 'failed',
      reason: 'Table not found',
    } satisfies Partial<DataStoreError>)
    await expect(
      runOp('putItem', async () => {
        throw new Error('ECONNREFUSED')
      }),
    ).rejects.toMatchObject({ kind: 'threw', reason: 'ECONNREFUSED' })
  })
})
