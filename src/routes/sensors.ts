import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { readConfig } from '../config'
import { queryReadings, saveReading } from '../datastore'
import { toQuery, toReading } from '../sensors'

/**
 * センサーデータ API。
 *
 *   POST /v1/sensors            1 件投入（ボディは JSON。no 必須、ts 省略可、他の属性は自由）
 *   GET  /v1/sensors/:no        範囲取得（?startTime&endTime&limit&startKey&order）
 *   GET  /v1/sensors?no=...     同上（クエリで no を渡す形）
 *
 * 入力は必ず Zod で検証してからリポジトリに渡す。ZodError は toErrorResponse が 400 VALIDATION にする。
 * 認証（API_KEY）と CORS は routes/index.ts で掛けている。ここには書かない。
 */
export function sensorRoutes(): Hono {
  const r = new Hono()

  r.post('/', (c, next) => bodyLimit({ maxSize: readConfig().sensorBodyLimitBytes })(c, next), async (c) => {
    const reading = toReading(await c.req.json())
    await saveReading(reading)
    return c.json({ item: reading }, 201)
  })

  r.get('/', async (c) => {
    const result = await queryReadings(toQuery(c.req.query(), readConfig()))
    return c.json(result)
  })

  r.get('/:no', async (c) => {
    const result = await queryReadings(toQuery({ ...c.req.query(), no: c.req.param('no') }, readConfig()))
    return c.json(result)
  })

  return r
}
