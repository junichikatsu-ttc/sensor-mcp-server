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

describe('query の values はキー属性名だけが有効（pitfalls 13）', () => {
  const seed = async (store: MemoryDataStoreClient) => {
    for (const ts of [1, 2, 3, 4]) await store.putItem({ tableId: 'sensorData', item: { no: 'a', ts } })
  }

  it(':startTime のような任意名はプロキシと同じく ValidationException になる（本番で実際に起きた）', async () => {
    const store = new MemoryDataStoreClient()
    await seed(store)
    await expect(
      runOp('query', () =>
        store.query({
          tableId: 'sensorData',
          expression: '#no = :no AND #ts BETWEEN :startTime AND :endTime',
          values: { no: 'a', startTime: 2, endTime: 3 },
        }),
      ),
    ).rejects.toMatchObject({ kind: 'failed', reason: expect.stringContaining('attribute name: #ts') })
  })

  it('配列の値は :ts1 / :ts2 に展開され、BETWEEN が効く', async () => {
    const store = new MemoryDataStoreClient()
    await seed(store)
    const res = await store.query({
      tableId: 'sensorData',
      expression: '#no = :no AND #ts BETWEEN :ts1 AND :ts2',
      values: { no: 'a', ts: [2, 3] },
      order: true,
      limit: 10,
    })
    expect(res.params?.Items?.map((i: { ts: number }) => i.ts)).toEqual([2, 3])
  })

  it('order は true = 昇順 / false = 降順（SDK 1.0.1 の実測）', async () => {
    const store = new MemoryDataStoreClient()
    await seed(store)
    const q = (order: boolean) =>
      store.query({ tableId: 'sensorData', expression: '#no = :no', values: { no: 'a' }, order, limit: 2 })
    expect((await q(true)).params?.Items?.map((i: { ts: number }) => i.ts)).toEqual([1, 2])
    expect((await q(false)).params?.Items?.map((i: { ts: number }) => i.ts)).toEqual([4, 3])
  })
})
