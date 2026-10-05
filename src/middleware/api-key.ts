import { timingSafeEqual } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import { readConfig } from '../config'
import { unauthorized } from '../errors'

/**
 * センサー API の任意認証。環境変数 API_KEY を設定したときだけ効く。
 *   - `x-api-key: <key>` または `authorization: Bearer <key>`
 *   - CORS のプリフライト（OPTIONS）には掛けない（ブラウザはヘッダを付けられない）
 *
 * 未設定なら素通し。元の Node-RED フローは無認証だったので、既定の挙動を変えないためにこうしている。
 * routes/index.ts で 1 箇所にまとめて適用する（各ルートに書く方式は書き忘れる）。
 */
export function apiKeyGuard(): MiddlewareHandler {
  return async (c, next) => {
    const { apiKey } = readConfig()
    if (!apiKey) return next()
    if (c.req.method === 'OPTIONS') return next()

    const presented = c.req.header('x-api-key') ?? bearerToken(c.req.header('authorization'))
    if (presented && safeEqual(presented, apiKey)) return next()
    throw unauthorized('API key required')
  }
}

function bearerToken(header: string | undefined): string | undefined {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? '')
  return m?.[1]?.trim()
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}
