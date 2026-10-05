import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { apiKeyGuard } from '../middleware/api-key'
import { healthHandler } from './health'
import { LEGACY_QUERY_PATH, LEGACY_UPLOAD_PATH, legacyRoutes } from './legacy'
import { MCP_PATH, mcpRoutes } from './mcp'
import { sensorRoutes } from './sensors'
import { staticRoutes } from './static-routes'

/**
 * ルート定義の 1 セット。app.ts が `/`・`/:base`・`/:base/` の 3 通りにマウントする。
 *
 * 認証と CORS は各ルートファイルに書かず、ここでパス指定してまとめて適用する。
 * 各ルートに書く方式はルート追加時に書き忘れる。忘れられる防御は防御ではない。
 */
export function createRoutes(): Hono {
  const routes = new Hono()

  // 認証不要の唯一のエンドポイント
  routes.get('/v1/health', healthHandler)

  routes.route('/', staticRoutes())

  // センサー API（新 + 互換）と MCP。元の Node-RED フローは Access-Control-Allow-Origin: * を返していたので踏襲する。
  // cors() は OPTIONS プリフライトに 204 を返す（元フローの「プリフライト応答」function ノード相当）
  const apiCors = cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Accept', 'X-Api-Key', 'Authorization', 'Mcp-Session-Id', 'MCP-Protocol-Version'],
    exposeHeaders: ['Mcp-Session-Id'],
    maxAge: 86400,
  })
  const guard = apiKeyGuard()
  for (const path of ['/v1/sensors', '/v1/sensors/*', LEGACY_UPLOAD_PATH, LEGACY_QUERY_PATH, MCP_PATH]) {
    routes.use(path, apiCors, guard)
  }

  routes.route('/v1/sensors', sensorRoutes())
  routes.route(MCP_PATH, mcpRoutes())
  routes.route('/', legacyRoutes())

  return routes
}
