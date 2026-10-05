import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { Hono } from 'hono'
import { readConfig } from '../config'
import { log } from '../log'
import { createMcpServer } from '../mcp/server'

/**
 * MCP エンドポイント（Streamable HTTP）。
 *
 * enebular のハンドラはレスポンスをバッファして返す（E1）ので SSE は使えない。そのため:
 *   - sessionIdGenerator を渡さない → ステートレス（Lambda のインスタンス間で状態を共有できないため必須）
 *   - enableJsonResponse: true     → POST の応答を SSE ではなく 1 つの JSON で返す
 *   - GET（サーバ→クライアントの通知ストリーム）と DELETE（セッション終了）は **トランスポートに渡す前に 405 で返す**。
 *     SDK はステートレスでも GET に SSE ストリームを開こうとするため、Lambda ではタイムアウトまで応答が返らなくなる
 *
 * サーバーとトランスポートはリクエストごとに作って捨てる。コールドスタート 1 回あたりの生成コストは小さい。
 * 認証（API_KEY）と CORS は routes/index.ts で掛けている。
 */
export const MCP_PATH = '/mcp'

function methodNotAllowed(message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }),
    { status: 405, headers: { 'content-type': 'application/json', allow: 'POST, OPTIONS' } },
  )
}

export function mcpRoutes(): Hono {
  const r = new Hono()

  r.get('/', () => methodNotAllowed('Method not allowed. This server is stateless and does not offer an SSE stream; use POST.'))
  r.delete('/', () => methodNotAllowed('Method not allowed. This server is stateless and has no sessions to terminate.'))

  r.post('/', async (c) => {
    // sessionIdGenerator を渡さない = ステートレス（exactOptionalPropertyTypes のためキー自体を省く）
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      maxRequestBodySize: readConfig().sensorBodyLimitBytes,
    })
    const server = createMcpServer()
    try {
      await server.connect(transport)
      return await transport.handleRequest(c.req.raw)
    } finally {
      // レスポンス生成後に閉じる。ステートレスなので保持しない
      void server.close().catch((err: unknown) => log.warn('mcp close failed', { message: String(err) }))
    }
  })

  return r
}
