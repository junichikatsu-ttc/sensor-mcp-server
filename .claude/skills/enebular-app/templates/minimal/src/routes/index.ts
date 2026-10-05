import { Hono } from 'hono'
import { healthHandler } from './health'
import { itemRoutes } from './items'
import { staticRoutes } from './static-routes'

/**
 * ルート定義の 1 セット。app.ts が `/`・`/:base`・`/:base/` の 3 通りにマウントする。
 *
 * 認証は各ルートファイルに書かず、ここでパス指定してまとめて適用する。
 * 各ルートに書く方式はルート追加時に書き忘れる。忘れられる防御は防御ではない。
 * （例: routes.use('/v1/admin/*', adminAuth()) のように、ここに 1 行で足す）
 */
export function createRoutes(): Hono {
  const routes = new Hono()

  // 認証不要の唯一のエンドポイント
  routes.get('/v1/health', healthHandler)

  routes.route('/', staticRoutes())
  routes.route('/v1/items', itemRoutes())

  return routes
}
