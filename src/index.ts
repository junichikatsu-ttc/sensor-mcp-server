import { handle } from 'hono/aws-lambda'
import { app } from './app'
import { logConfigIssues } from './config'

// コールドスタート時に 1 回だけ設定漏れをログへ（キー名はここにしか出さない）
logConfigIssues()

// enebular 側のハンドラ指定は index.handler。esbuild が CJS へ変換し module.exports.handler になる
export const handler = handle(app)
