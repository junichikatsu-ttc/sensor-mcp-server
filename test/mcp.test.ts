import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { MemoryDataStoreClient, setDataStoreClient, setTableIdResolver } from '../src/datastore'

/**
 * MCP エンドポイントを公式クライアントで叩く統合テスト。
 * fetch を app.request に差し替えるので、Hono → トランスポート → ツール → fake データストアまで本物を通す。
 * enebular の制約で SSE は使えないため、応答が JSON 1 発で返ること（text/event-stream ではないこと）も固定する。
 */

const app = createApp()
let store: MemoryDataStoreClient

/** ブラウザの fetch の代わりに Hono を直接呼ぶ */
const fakeFetch: typeof fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input)
  return app.request(url, init as RequestInit)
}

async function connect(headers: Record<string, string> = {}): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/myapp/mcp'), {
    fetch: fakeFetch,
    requestInit: { headers },
  })
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  // SDK 側の型が exactOptionalPropertyTypes と噛み合わないためキャストする（実行時は問題ない）
  await client.connect(transport as Transport)
  return client
}

async function put(no: string, ts: number, attrs: Record<string, unknown>) {
  const res = await app.request('/myapp/v1/sensors', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ no, ts, ...attrs }),
  })
  expect(res.status).toBe(201)
}

const T0 = Date.parse('2026-10-01T00:00:00Z')

beforeEach(async () => {
  store = new MemoryDataStoreClient()
  setDataStoreClient(store, 'memory')
  setTableIdResolver((name) => name)
  delete process.env['API_KEY']
  for (let i = 0; i < 6; i++) await put('dev-1', T0 + i * 3_600_000, { temperature: 20 + i, humidity: 60 - i })
  await put('dev-2', T0, { temperature: 99 })
})

afterEach(() => {
  setDataStoreClient(undefined)
  setTableIdResolver(undefined)
  delete process.env['API_KEY']
})

describe('MCP over Streamable HTTP（ステートレス / JSON レスポンス）', () => {
  it('initialize が JSON で返り、SSE もセッション ID も使わない', async () => {
    const res = await app.request('/myapp/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(res.headers.get('mcp-session-id')).toBeNull()
    const body = (await res.json()) as { result: { serverInfo: { name: string }; instructions?: string } }
    expect(body.result.serverInfo.name).toBe('sensor-mcp-server')
    expect(body.result.instructions).toContain('no')
  })

  it('GET（サーバ→クライアントの SSE ストリーム）は 405', async () => {
    const res = await app.request('/myapp/mcp', { headers: { accept: 'text/event-stream' } })
    expect(res.status).toBe(405)
  })

  it('tools/list に 4 つの読み取り専用ツールが出る', async () => {
    const client = await connect()
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_latest_reading',
      'list_sensors',
      'query_sensor_readings',
      'summarize_sensor_readings',
    ])
    for (const t of tools) expect(t.annotations?.readOnlyHint, t.name).toBe(true)
    await client.close()
  })

  it('list_sensors は登録簿から一覧と最新値を返す', async () => {
    const client = await connect()
    const res = await client.callTool({ name: 'list_sensors', arguments: {} })
    expect(res.isError).toBeFalsy()
    const sc = res.structuredContent as { sensors: { no: string; lastTs: number; lastReading: { temperature: number } }[] }
    expect(sc.sensors.map((s) => s.no)).toEqual(['dev-1', 'dev-2'])
    expect(sc.sensors[0]!.lastTs).toBe(T0 + 5 * 3_600_000)
    expect(sc.sensors[0]!.lastReading.temperature).toBe(25)
    await client.close()
  })

  it('list_sensors は登録簿が無い環境では isError で案内を返す', async () => {
    setTableIdResolver((name) => (name === 'sensorData' ? name : undefined))
    const client = await connect()
    const res = await client.callTool({ name: 'list_sensors', arguments: {} })
    expect(res.isError).toBe(true)
    await client.close()
  })

  it('get_latest_reading は最新 1 件（アクセス 1 回）', async () => {
    const client = await connect()
    const before = store.calls.query
    const res = await client.callTool({ name: 'get_latest_reading', arguments: { no: 'dev-1' } })
    expect(store.calls.query - before).toBe(1)
    const sc = res.structuredContent as { found: boolean; reading: { ts: number; tsIso: string } }
    expect(sc.found).toBe(true)
    expect(sc.reading.ts).toBe(T0 + 5 * 3_600_000)
    expect(sc.reading.tsIso).toBe('2026-10-01T05:00:00.000Z')

    const none = await client.callTool({ name: 'get_latest_reading', arguments: { no: 'nobody' } })
    expect((none.structuredContent as { found: boolean }).found).toBe(false)
    await client.close()
  })

  it('query_sensor_readings は ISO 8601 の期間指定を受け、ページングできる', async () => {
    const client = await connect()
    const p1 = await client.callTool({
      name: 'query_sensor_readings',
      arguments: { no: 'dev-1', startTime: '2026-10-01T01:00:00Z', endTime: '2026-10-01T04:00:00+00:00', limit: 2 },
    })
    const s1 = p1.structuredContent as { items: { ts: number }[]; nextStartKey?: string }
    expect(s1.items.map((i) => i.ts)).toEqual([T0 + 3_600_000, T0 + 2 * 3_600_000])
    expect(s1.nextStartKey).toBeDefined()

    const p2 = await client.callTool({
      name: 'query_sensor_readings',
      arguments: {
        no: 'dev-1',
        startTime: '2026-10-01T01:00:00Z',
        endTime: '2026-10-01T04:00:00+00:00',
        limit: 2,
        startKey: s1.nextStartKey,
      },
    })
    const s2 = p2.structuredContent as { items: { ts: number }[]; nextStartKey?: string }
    expect(s2.items.map((i) => i.ts)).toEqual([T0 + 3 * 3_600_000, T0 + 4 * 3_600_000])
    expect(s2.nextStartKey).toBeUndefined()
    await client.close()
  })

  it('解釈できない時刻は isError', async () => {
    const client = await connect()
    const res = await client.callTool({ name: 'query_sensor_readings', arguments: { no: 'dev-1', startTime: 'yesterday' } })
    expect(res.isError).toBe(true)
    await client.close()
  })

  it('summarize_sensor_readings は数値属性の件数・最小・最大・平均を返す', async () => {
    const client = await connect()
    const res = await client.callTool({ name: 'summarize_sensor_readings', arguments: { no: 'dev-1' } })
    const sc = res.structuredContent as {
      count: number
      truncated: boolean
      fields: Record<string, { count: number; min: number; max: number; avg: number }>
    }
    expect(sc.count).toBe(6)
    expect(sc.truncated).toBe(false)
    expect(sc.fields['temperature']).toMatchObject({ count: 6, min: 20, max: 25, avg: 22.5 })
    expect(sc.fields['humidity']).toMatchObject({ min: 55, max: 60 })
    await client.close()
  })

  it('summarize_sensor_readings はページ数の上限で打ち切り truncated を立てる', async () => {
    process.env['SENSOR_QUERY_MAX_LIMIT'] = '2'
    process.env['MCP_SUMMARY_MAX_PAGES'] = '2'
    try {
      const client = await connect()
      const before = store.calls.query
      const res = await client.callTool({ name: 'summarize_sensor_readings', arguments: { no: 'dev-1' } })
      const sc = res.structuredContent as { count: number; truncated: boolean; pagesRead: number }
      expect(sc.pagesRead).toBe(2)
      expect(sc.count).toBe(4)
      expect(sc.truncated).toBe(true)
      expect(store.calls.query - before).toBe(2)
      await client.close()
    } finally {
      delete process.env['SENSOR_QUERY_MAX_LIMIT']
      delete process.env['MCP_SUMMARY_MAX_PAGES']
    }
  })

  it('API_KEY 設定時は Bearer 無しで 401、ありで通る', async () => {
    process.env['API_KEY'] = 'secret-key'
    await expect(connect()).rejects.toThrow()
    const client = await connect({ authorization: 'Bearer secret-key' })
    const { tools } = await client.listTools()
    expect(tools.length).toBe(4)
    await client.close()
  })
})
