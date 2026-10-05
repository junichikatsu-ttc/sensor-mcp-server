import type { MiddlewareHandler } from 'hono'
import { readConfig } from '../config'

/**
 * デモ公開用の簡易ガード。BASIC_AUTH_USER と BASIC_AUTH_PASSWORD が両方そろったときだけ効く。
 * HTML ページにだけ掛ける（CSS / JS は HTML から辿るので守る必要がない）。
 *
 * これは「URL を知っている人に見られない」ためのもので、本番の認証ではない。
 * 本物の認証が要るなら references/recipes.md の「セッション認証」を使う。
 */
export function basicAuthGuard(): MiddlewareHandler {
  return async (c, next) => {
    const cfg = readConfig()
    if (!cfg.basicAuthUser || !cfg.basicAuthPassword) return next()

    const header = c.req.header('authorization') ?? ''
    const m = /^Basic\s+(.+)$/i.exec(header)
    if (m) {
      const [user, ...rest] = Buffer.from(m[1]!, 'base64').toString('utf8').split(':')
      if (user === cfg.basicAuthUser && rest.join(':') === cfg.basicAuthPassword) return next()
    }
    return c.body('Unauthorized', 401, {
      'www-authenticate': 'Basic realm="restricted", charset="UTF-8"',
      'cache-control': 'no-store',
    })
  }
}
