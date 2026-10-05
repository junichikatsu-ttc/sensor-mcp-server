import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { readConfig } from '../config'
import { latestReading, listSensorMeta, queryReadings, registryEnabled } from '../datastore'
import { sensorNoSchema, sortOrderSchema } from '../schemas'
import type { SensorQuery, SensorReading } from '../schemas'
import { parseTimeInput, summarizeReadings, toIso } from '../sensors'
import { buildInfo } from '../static'

/**
 * LLM 向け MCP サーバー。センサーデータの読み取り専用ツールを公開する。
 *
 * enebular の制約（E1: レスポンスはバッファされ SSE は使えない）に合わせ、
 * Streamable HTTP の **ステートレス + JSON レスポンス** モードで動かす（routes/mcp.ts）。
 * サーバーインスタンスはリクエストごとに作って捨てる（Lambda では状態を持てないため）。
 *
 * ツールはすべて読み取り専用。書き込みはデバイス向けの REST（POST /v1/sensors）だけに限定する。
 * データストアへのアクセス回数（E4）を意識し、各ツールの説明に「何回アクセスするか」を書いておく。
 */

const SERVER_INSTRUCTIONS = `センサーの時系列データを読み取るためのサーバーです。
- センサーは「no」（センサー番号の文字列）で識別します。まず list_sensors で一覧を取るか、ユーザーから no を聞いてください。
- 計測時刻 ts はエポックミリ秒です。各レコードには tsIso（ISO 8601, UTC）も付けて返します。
- 時刻の指定は ISO 8601 文字列（例 "2026-10-01T00:00:00+09:00"）かエポックミリ秒のどちらでも受け付けます。
- 期間が長いときは query_sensor_readings で全件を取るより summarize_sensor_readings で要約を取ってください。
- query_sensor_readings の結果に nextStartKey があれば続きがあります。必要なときだけ startKey に渡して次ページを取ってください。`

function withIso(item: SensorReading): SensorReading & { tsIso: string } {
  return { ...item, tsIso: toIso(item.ts) }
}

function ok(structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured }
}

function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

const timeInput = z
  .union([z.string(), z.number()])
  .optional()
  .describe('ISO 8601 文字列（例 "2026-10-01T00:00:00+09:00"）またはエポックミリ秒')

const readingOutput = z.looseObject({ no: z.string(), ts: z.number(), tsIso: z.string() })

function resolveRange(startTime: string | number | undefined, endTime: string | number | undefined) {
  const start = parseTimeInput(startTime)
  const end = parseTimeInput(endTime)
  if (startTime !== undefined && start === undefined) return { error: `startTime を時刻として解釈できません: ${String(startTime)}` }
  if (endTime !== undefined && end === undefined) return { error: `endTime を時刻として解釈できません: ${String(endTime)}` }
  if (start !== undefined && end !== undefined && start > end) return { error: 'startTime は endTime 以下にしてください' }
  return { start, end }
}

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'sensor-mcp-server', version: buildInfo().version },
    { instructions: SERVER_INSTRUCTIONS },
  )

  server.registerTool(
    'list_sensors',
    {
      title: 'センサー一覧',
      description:
        '登録されているセンサーの一覧と、各センサーの最新の計測値を返します。' +
        '登録簿テーブル（DS_TABLE_SENSORS）が設定されている環境でのみ使えます。データストアアクセス 1〜数回。',
      inputSchema: {
        limit: z.number().int().min(1).max(1000).optional().describe('最大件数（既定 200）'),
      },
      outputSchema: {
        sensors: z.array(
          z.object({
            no: z.string(),
            lastTs: z.number(),
            lastTsIso: z.string(),
            lastReading: readingOutput,
          }),
        ),
        count: z.number(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ limit }) => {
      const rows = await listSensorMeta(limit ?? readConfig().mcpListSensorsLimit)
      if (rows === undefined) {
        return fail(
          'センサー登録簿（DS_TABLE_SENSORS）が設定されていないため一覧を取得できません。' +
            'センサー番号（no）をユーザーに確認し、get_latest_reading か query_sensor_readings を使ってください。',
        )
      }
      return ok({
        sensors: rows.map((r) => ({ no: r.no, lastTs: r.lastTs, lastTsIso: toIso(r.lastTs), lastReading: withIso(r.lastReading) })),
        count: rows.length,
      })
    },
  )

  server.registerTool(
    'get_latest_reading',
    {
      title: '最新の計測値',
      description: '指定したセンサーの最新 1 件を返します。データストアアクセス 1 回。',
      inputSchema: { no: z.string().describe('センサー番号') },
      outputSchema: { no: z.string(), found: z.boolean(), reading: readingOutput.optional() },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ no }) => {
      const parsed = sensorNoSchema.safeParse(no)
      if (!parsed.success) return fail(`no が不正です: ${parsed.error.issues[0]?.message ?? ''}`)
      const reading = await latestReading(parsed.data)
      return ok(reading ? { no: parsed.data, found: true, reading: withIso(reading) } : { no: parsed.data, found: false })
    },
  )

  server.registerTool(
    'query_sensor_readings',
    {
      title: '期間を指定して取得',
      description:
        '指定したセンサーの計測値を期間で絞って返します（1 ページ分、データストアアクセス 1 回）。' +
        '結果に nextStartKey があれば続きがあり、同じ条件 + startKey で次のページを取れます。' +
        '長い期間の傾向を知りたいだけなら summarize_sensor_readings を使ってください。',
      inputSchema: {
        no: z.string().describe('センサー番号'),
        startTime: timeInput,
        endTime: timeInput,
        limit: z.number().int().min(1).optional().describe(`1 ページの件数（既定・上限はサーバ設定）`),
        order: sortOrderSchema.optional().describe('asc: 古い順（既定） / desc: 新しい順'),
        startKey: z.string().optional().describe('前のページの nextStartKey'),
      },
      outputSchema: {
        no: z.string(),
        items: z.array(readingOutput),
        count: z.number(),
        nextStartKey: z.string().optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ no, startTime, endTime, limit, order, startKey }) => {
      const parsed = sensorNoSchema.safeParse(no)
      if (!parsed.success) return fail(`no が不正です: ${parsed.error.issues[0]?.message ?? ''}`)
      const range = resolveRange(startTime, endTime)
      if ('error' in range) return fail(range.error)
      const cfg = readConfig()
      const q: SensorQuery = {
        no: parsed.data,
        limit: Math.min(limit ?? cfg.sensorQueryLimit, cfg.sensorQueryMaxLimit),
        order: order ?? 'asc',
      }
      if (range.start !== undefined) q.startTime = range.start
      if (range.end !== undefined) q.endTime = range.end
      if (startKey) q.startKey = startKey
      const res = await queryReadings(q)
      return ok({
        no: parsed.data,
        items: res.items.map(withIso),
        count: res.items.length,
        ...(res.nextStartKey !== undefined ? { nextStartKey: res.nextStartKey } : {}),
      })
    },
  )

  server.registerTool(
    'summarize_sensor_readings',
    {
      title: '期間の要約',
      description:
        '指定したセンサー・期間の数値属性ごとに件数・最小・最大・平均・最初・最後を返します。' +
        'サーバ側でページを辿って集計するので、LLM に生データを渡さずに傾向が分かります。' +
        'データストアアクセスは最大 maxPages 回（既定はサーバ設定）。上限に達したら truncated: true になります。',
      inputSchema: {
        no: z.string().describe('センサー番号'),
        startTime: timeInput,
        endTime: timeInput,
        maxPages: z.number().int().min(1).optional().describe('辿るページ数の上限（サーバ設定でさらに制限）'),
      },
      outputSchema: {
        no: z.string(),
        count: z.number(),
        firstTs: z.number().optional(),
        firstTsIso: z.string().optional(),
        lastTs: z.number().optional(),
        lastTsIso: z.string().optional(),
        fields: z.record(
          z.string(),
          z.object({ count: z.number(), min: z.number(), max: z.number(), avg: z.number(), first: z.number(), last: z.number() }),
        ),
        truncated: z.boolean(),
        pagesRead: z.number(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ no, startTime, endTime, maxPages }) => {
      const parsed = sensorNoSchema.safeParse(no)
      if (!parsed.success) return fail(`no が不正です: ${parsed.error.issues[0]?.message ?? ''}`)
      const range = resolveRange(startTime, endTime)
      if ('error' in range) return fail(range.error)
      const cfg = readConfig()
      const pageCap = Math.min(maxPages ?? cfg.mcpSummaryMaxPages, cfg.mcpSummaryMaxPages)

      const items: SensorReading[] = []
      let startKey: string | undefined
      let pagesRead = 0
      let truncated = false
      for (;;) {
        const q: SensorQuery = { no: parsed.data, limit: cfg.sensorQueryMaxLimit, order: 'asc' }
        if (range.start !== undefined) q.startTime = range.start
        if (range.end !== undefined) q.endTime = range.end
        if (startKey !== undefined) q.startKey = startKey
        const res = await queryReadings(q)
        pagesRead++
        items.push(...res.items)
        if (res.nextStartKey === undefined) break
        if (pagesRead >= pageCap) {
          truncated = true
          break
        }
        startKey = res.nextStartKey
      }
      const first = items[0]
      const last = items[items.length - 1]
      return ok({
        no: parsed.data,
        count: items.length,
        ...(first ? { firstTs: first.ts, firstTsIso: toIso(first.ts) } : {}),
        ...(last ? { lastTs: last.ts, lastTsIso: toIso(last.ts) } : {}),
        fields: summarizeReadings(items),
        truncated,
        pagesRead,
      })
    },
  )

  return server
}

/** /v1/health 用。MCP の構成を一目で分かるようにする */
export function mcpInfo(): { tools: string[]; registry: boolean } {
  return {
    tools: ['list_sensors', 'get_latest_reading', 'query_sensor_readings', 'summarize_sensor_readings'],
    registry: registryEnabled(),
  }
}
