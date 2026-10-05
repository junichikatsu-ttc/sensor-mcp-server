/**
 * ローカル起動。Lambda を介さず同じ app を @hono/node-server で立てる。
 *
 *   npm run dev:web   # 別ターミナルで web の監視ビルド
 *   npm run dev       # http://localhost:8787
 *
 * データストアはローカルで代替できない（接続情報を実行環境が注入するため）。
 * DATASTORE_MODE=memory のときはインメモリ実装に切り替える。永続化はされない。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { app } from './app'
import { logConfigIssues } from './config'
import { MemoryDataStoreClient, setDataStoreClient, setTableIdResolver } from './datastore'
import { CONTENT_TYPES, setStaticAssetLoader } from './static'
import type { StaticAsset } from './static'

const here = dirname(fileURLToPath(import.meta.url))
const publicDir = join(here, '../web/public')

// リクエストごとにディスクから読む。HTML/CSS を編集したらリロードだけで反映される
setStaticAssetLoader((name): StaticAsset | undefined => {
  const p = join(publicDir, name)
  if (!existsSync(p)) return undefined
  const contentType = CONTENT_TYPES[extname(name)] ?? 'application/octet-stream'
  const binary = !contentType.startsWith('text/')
  return {
    contentType,
    encoding: binary ? 'base64' : 'utf8',
    body: readFileSync(p).toString(binary ? 'base64' : 'utf8'),
  }
})

const useMemory = process.env['DATASTORE_MODE'] === 'memory' || !process.env['ENEBULAR_DS_JWT']
if (useMemory) {
  setDataStoreClient(new MemoryDataStoreClient(), 'memory')
  setTableIdResolver((name) => name)
}

logConfigIssues()

const port = Number(process.env['PORT']) || 8787
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`__APP_NAME__ local: http://localhost:${info.port}/`)
  console.log(`datastore: ${useMemory ? 'memory (not persisted)' : 'cloud'}`)
  if (!existsSync(join(publicDir, 'app.js'))) {
    console.warn('web/public/app.js がありません。別ターミナルで `npm run dev:web` を実行してください')
  }
})
