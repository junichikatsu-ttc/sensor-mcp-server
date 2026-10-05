import { Hono } from 'hono'
import { toErrorResponse } from './errors'
import { createRoutes } from './routes'

export function createApp(): Hono {
  const app = new Hono()

  // HTTP トリガーはトリガーのパスを含めてハンドラを呼ぶ（pitfalls 2）。
  // トリガーのパスを環境変数で持たず、:base で吸収する。ここは触らない。
  app.route('/', createRoutes()) //        /v1/health            ローカル・テスト
  app.route('/:base', createRoutes()) //   /__APP_NAME__/v1/...  トリガー経由
  app.route('/:base/', createRoutes()) //  /__APP_NAME__/        トリガーのルート URL

  app.onError((err, c) => toErrorResponse(err, c))
  // 受け取ったパスとメソッドを返す。イベント形式の想定違いをログ無しで切り分けられる
  app.notFound((c) =>
    c.json({ error: { code: 'NOT_FOUND', message: 'Not Found', path: c.req.path, method: c.req.method } }, 404),
  )

  return app
}

export const app = createApp()
