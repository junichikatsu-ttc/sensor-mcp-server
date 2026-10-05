import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { readConfig } from '../config'
import { queryReadings, saveReading } from '../datastore'
import { toQuery, toReading } from '../sensors'

/**
 * 元の Node-RED フロー（sample/）と同じパス・同じレスポンス形の互換ルート。
 * 既にこのパスへ送っているデバイスやダッシュボードを、URL のホスト部分の変更だけで移行させるためのもの。
 * 新規のクライアントは /v1/sensors を使う。
 *
 *   POST /ttc-iot-sensor   sample/sensor-upload/flow.json
 *       元: msg.item = payload → ds-put-item → 200 + put 結果
 *   GET  /get-sonsor       sample/get-sensor/flow.json（パスの綴りは元フローのまま）
 *       元: no / startTime / endTime / limit / startKey → ds-easy-query-item → 200 + Items 配列
 *
 * 元フローと異なる点:
 *   - データストアエラーは 500 ではなく 503（DATASTORE）。入力不正は 400（VALIDATION）
 *   - limit 省略時は SDK 既定の 10 件ではなく SENSOR_QUERY_LIMIT（既定 100）
 *   - startTime / endTime の片方だけでも受ける（元は両方必須で、無いと JSONata が失敗していた）
 */
export const LEGACY_UPLOAD_PATH = '/ttc-iot-sensor'
export const LEGACY_QUERY_PATH = '/get-sonsor'

export function legacyRoutes(): Hono {
  const r = new Hono()

  r.post(
    LEGACY_UPLOAD_PATH,
    (c, next) => bodyLimit({ maxSize: readConfig().sensorBodyLimitBytes })(c, next),
    async (c) => {
      const reading = toReading(await c.req.json())
      await saveReading(reading)
      // ds-put-item ノードは SDK の put 結果（result / params.Item）を payload に出していた
      return c.json({ result: 'success', params: { Item: reading } })
    },
  )

  r.get(LEGACY_QUERY_PATH, async (c) => {
    const { items } = await queryReadings(toQuery(c.req.query(), readConfig()))
    // ds-easy-query-item ノードは Items 配列をそのまま payload に出していた（startKey は msg 側で body に出ない）
    return c.json(items)
  })

  return r
}
