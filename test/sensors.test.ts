import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { MemoryDataStoreClient, setDataStoreClient, setTableIdResolver } from '../src/datastore'

/**
 * センサー API の統合テスト。データストアだけを fake に差し替え、それ以外は本物を通す。
 * データストアはローカルで代替できないので、通しの確認はここで行う。
 * store.calls でアクセス回数を見れば E4（月次上限）の見積りになる。
 */

const app = createApp()
let store: MemoryDataStoreClient

beforeEach(() => {
  store = new MemoryDataStoreClient()
  setDataStoreClient(store, 'memory')
  setTableIdResolver((name) => name)
  delete process.env['API_KEY']
})

afterEach(() => {
  setDataStoreClient(undefined)
  setTableIdResolver(undefined)
  delete process.env['API_KEY']
})

const json = { 'content-type': 'application/json' }

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, { method: 'POST', headers: { ...json, ...headers }, body: JSON.stringify(body) })
}

async function seed(no: string, count: number, from = 1_700_000_000_000, stepMs = 60_000) {
  for (let i = 0; i < count; i++) {
    const res = await post('/myapp/v1/sensors', { no, ts: from + i * stepMs, temperature: 20 + i, humidity: 50 })
    expect(res.status).toBe(201)
  }
}

describe('POST /v1/sensors（投入）', () => {
  it('no と任意の属性を保存し、ts 省略時はサーバ時刻を入れる', async () => {
    const before = Date.now()
    const res = await post('/myapp/v1/sensors', { no: 'jksoft0930-1', temperature: 25.1 })
    expect(res.status).toBe(201)
    const { item } = (await res.json()) as { item: { no: string; ts: number; temperature: number } }
    expect(item.no).toBe('jksoft0930-1')
    expect(item.temperature).toBe(25.1)
    expect(item.ts).toBeGreaterThanOrEqual(before)
    expect(store.dump('sensorData')).toHaveLength(1)
  })

  it('文字列の ts も数値に正規化して保存する', async () => {
    const res = await post('/myapp/v1/sensors', { no: 'dev-1', ts: '1700000000000', v: 1 })
    expect(res.status).toBe(201)
    expect(store.dump('sensorData')[0]?.['ts']).toBe(1_700_000_000_000)
  })

  it('登録簿テーブルが有効なら最新値も書く（投入 1 件 = アクセス 2 回）', async () => {
    await post('/myapp/v1/sensors', { no: 'dev-1', ts: 1, v: 1 })
    await post('/myapp/v1/sensors', { no: 'dev-1', ts: 2, v: 2 })
    expect(store.calls.putItem).toBe(4)
    const meta = store.dump('sensors')
    expect(meta).toHaveLength(1)
    expect(meta[0]?.['lastTs']).toBe(2)
  })

  it('登録簿テーブルが無い環境では投入 1 件 = アクセス 1 回', async () => {
    setTableIdResolver((name) => (name === 'sensorData' ? name : undefined))
    const res = await post('/myapp/v1/sensors', { no: 'dev-1', ts: 1, v: 1 })
    expect(res.status).toBe(201)
    expect(store.calls.putItem).toBe(1)
  })

  it('no が無い・不正なら 400 VALIDATION', async () => {
    for (const body of [{ temperature: 1 }, { no: 'has space', ts: 1 }, { no: 'dev-1', ts: -1 }]) {
      const res = await post('/myapp/v1/sensors', body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION')
    }
  })

  it('壊れた JSON は 400', async () => {
    const res = await app.request('/myapp/v1/sensors', { method: 'POST', headers: json, body: '{oops' })
    expect(res.status).toBe(400)
  })
})

describe('GET /v1/sensors/:no（範囲取得）', () => {
  it('startTime〜endTime の BETWEEN で絞り、昇順で返す（元フローと同じ）', async () => {
    await seed('dev-1', 10)
    const start = 1_700_000_000_000 + 2 * 60_000
    const end = 1_700_000_000_000 + 5 * 60_000
    const res = await app.request(`/myapp/v1/sensors/dev-1?startTime=${start}&endTime=${end}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: { ts: number }[]; nextStartKey?: string }
    expect(body.items.map((i) => i.ts)).toEqual([start, start + 60_000, start + 120_000, end])
    expect(body.nextStartKey).toBeUndefined()
  })

  it('片側だけの指定と desc 順も受ける', async () => {
    await seed('dev-1', 5)
    const from = 1_700_000_000_000 + 3 * 60_000
    const res = await app.request(`/myapp/v1/sensors/dev-1?startTime=${from}&order=desc`)
    const body = (await res.json()) as { items: { ts: number }[] }
    expect(body.items.map((i) => i.ts)).toEqual([from + 60_000, from])
  })

  it('limit でページングし、nextStartKey で続きが取れる（1 ページ = アクセス 1 回）', async () => {
    await seed('dev-1', 7)
    const before = store.calls.query
    const p1 = (await (await app.request('/myapp/v1/sensors/dev-1?limit=3')).json()) as {
      items: { ts: number }[]
      nextStartKey?: string
    }
    expect(p1.items).toHaveLength(3)
    expect(p1.nextStartKey).toBeDefined()
    expect(store.calls.query - before).toBe(1)

    const p2 = (await (
      await app.request(`/myapp/v1/sensors/dev-1?limit=3&startKey=${encodeURIComponent(p1.nextStartKey!)}`)
    ).json()) as { items: { ts: number }[]; nextStartKey?: string }
    expect(p2.items).toHaveLength(3)
    expect(p2.items[0]!.ts).toBeGreaterThan(p1.items[2]!.ts)

    const p3 = (await (
      await app.request(`/myapp/v1/sensors/dev-1?limit=3&startKey=${encodeURIComponent(p2.nextStartKey!)}`)
    ).json()) as { items: unknown[]; nextStartKey?: string }
    expect(p3.items).toHaveLength(1)
    expect(p3.nextStartKey).toBeUndefined()
  })

  it('他のセンサーのデータは混ざらない（メインキーが一致しないため 0 件）', async () => {
    await seed('dev-1', 3)
    const res = await app.request('/myapp/v1/sensors/dev-2')
    expect(((await res.json()) as { items: unknown[] }).items).toHaveLength(0)
  })

  it('空のクエリ値は無視し、limit は上限でクランプする', async () => {
    await seed('dev-1', 2)
    const res = await app.request('/myapp/v1/sensors?no=dev-1&startTime=&endTime=&limit=999999')
    expect(res.status).toBe(200)
    expect(((await res.json()) as { items: unknown[] }).items).toHaveLength(2)
  })

  it('startTime > endTime は 400', async () => {
    const res = await app.request('/myapp/v1/sensors/dev-1?startTime=10&endTime=5')
    expect(res.status).toBe(400)
  })
})

describe('互換ルート（sample/ の Node-RED フローと同じパス・形）', () => {
  it('POST /ttc-iot-sensor は put 結果の形で 200 を返す', async () => {
    const res = await post('/myapp/ttc-iot-sensor', { no: 'dev-1', ts: 1, temperature: 21 })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: string; params: { Item: { no: string } } }
    expect(body.result).toBe('success')
    expect(body.params.Item.no).toBe('dev-1')
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('GET /get-sonsor は Items 配列をそのまま返す', async () => {
    await seed('dev-1', 3)
    const res = await app.request('/myapp/get-sonsor?no=dev-1&startTime=0&endTime=9999999999999&limit=10')
    expect(res.status).toBe(200)
    const body = (await res.json()) as unknown[]
    expect(Array.isArray(body)).toBe(true)
    expect(body).toHaveLength(3)
  })

  it('OPTIONS プリフライトは 204 + CORS ヘッダ（元フローの function ノード相当）', async () => {
    const res = await app.request('/myapp/ttc-iot-sensor', {
      method: 'OPTIONS',
      headers: { origin: 'https://example.com', 'access-control-request-method': 'POST' },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('access-control-allow-methods')).toContain('POST')
  })
})

describe('API_KEY（設定したときだけ掛かる）', () => {
  it('未設定なら無認証で通る', async () => {
    expect((await post('/myapp/v1/sensors', { no: 'dev-1', ts: 1 })).status).toBe(201)
  })

  it('設定時は x-api-key か Bearer が無いと 401、あれば通る', async () => {
    process.env['API_KEY'] = 'secret-key'
    expect((await post('/myapp/v1/sensors', { no: 'dev-1', ts: 1 })).status).toBe(401)
    expect((await post('/myapp/v1/sensors', { no: 'dev-1', ts: 1 }, { 'x-api-key': 'wrong' })).status).toBe(401)
    expect((await post('/myapp/v1/sensors', { no: 'dev-1', ts: 1 }, { 'x-api-key': 'secret-key' })).status).toBe(201)
    expect(
      (await post('/myapp/ttc-iot-sensor', { no: 'dev-1', ts: 2 }, { authorization: 'Bearer secret-key' })).status,
    ).toBe(200)
    expect((await app.request('/myapp/v1/sensors/dev-1')).status).toBe(401)
    // health は常に認証不要
    expect((await app.request('/myapp/v1/health')).status).toBe(200)
    // プリフライトには掛けない
    const pre = await app.request('/myapp/v1/sensors', {
      method: 'OPTIONS',
      headers: { origin: 'https://example.com', 'access-control-request-method': 'POST' },
    })
    expect(pre.status).toBe(204)
  })

  it('/v1/health の apiKeyAuth に反映される', async () => {
    process.env['API_KEY'] = 'secret-key'
    const h = (await (await app.request('/myapp/v1/health')).json()) as { apiKeyAuth: boolean; mcp: { registry: boolean } }
    expect(h.apiKeyAuth).toBe(true)
    expect(h.mcp.registry).toBe(true)
  })
})
