import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { MemoryDataStoreClient, runGet, setDataStoreClient, setTableIdResolver } from '../src/datastore'

/**
 * 主要導線の統合テスト。データストアだけを fake に差し替え、それ以外は本物を通す。
 * データストアはローカルで代替できないので、通しの確認はこの 1 本で行う。
 */

const app = createApp()
let store: MemoryDataStoreClient

beforeEach(() => {
  store = new MemoryDataStoreClient()
  setDataStoreClient(store, 'memory')
  setTableIdResolver((name) => name)
})

afterEach(() => {
  setDataStoreClient(undefined)
  setTableIdResolver(undefined)
})

const owner = { 'x-owner-id': 'alice-001' }
const other = { 'x-owner-id': 'bob-002' }

describe('items', () => {
  it('作成 → 一覧 → 削除', async () => {
    const created = await app.request('/myapp/v1/items', {
      method: 'POST',
      headers: { ...owner, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    })
    expect(created.status).toBe(201)
    const { item } = (await created.json()) as { item: { createdAt: number } }

    const listed = await app.request('/myapp/v1/items', { headers: owner })
    expect(listed.status).toBe(200)
    expect(((await listed.json()) as { items: unknown[] }).items).toHaveLength(1)

    const deleted = await app.request(`/myapp/v1/items/${item.createdAt}`, { method: 'DELETE', headers: owner })
    expect(deleted.status).toBe(204)
    expect(store.dump('items')).toHaveLength(0)
  })

  it('他人のアイテムは見えない（メインキーが一致しないため 0 件）', async () => {
    await app.request('/myapp/v1/items', {
      method: 'POST',
      headers: { ...owner, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'secret' }),
    })
    const listed = await app.request('/myapp/v1/items', { headers: other })
    expect(((await listed.json()) as { items: unknown[] }).items).toHaveLength(0)
  })

  it('入力検証は 400（VALIDATION）で返る', async () => {
    const res = await app.request('/myapp/v1/items', {
      method: 'POST',
      headers: { ...owner, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '' }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION')
  })
})

describe('getItem の "Not found"（pitfalls 6）', () => {
  it('正常系として undefined に落ちる（503 にしない）', async () => {
    // ここを 503 にするとサインアップのような「初回は必ず無い」導線が原理的に成立しない
    const res = await runGet(() => store.getItem({ tableId: 'items', key: { ownerId: 'nobody', createdAt: 1 } }))
    expect(res).toBeUndefined()
  })
})
