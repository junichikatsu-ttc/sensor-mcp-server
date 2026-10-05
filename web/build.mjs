// @ts-check
/**
 * フロントエンドのバンドル。フレームワークなし（素の JS + esbuild）。
 *   node build.mjs           # 1 回ビルド
 *   node build.mjs --watch   # 監視ビルド（ローカル開発）
 *
 * 画面を増やすときは entries に足し、src/static.ts と ../build.mjs の静的ファイル一覧にも足す。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, context } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const watch = process.argv.includes('--watch')

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  format: 'iife', // module にすると index.html 側で type="module" が要る
  minify: false, // 配信される JS は読める状態に保つ（no-cache 配信なので数十 KB の差は出ない）
  sourcemap: false,
  logLevel: 'info',
  banner: { js: '/* 生成物です。編集しないでください。編集先は web/src/ です。 */' },
}

const entries = [{ entryPoints: [join(here, 'src/main.js')], outfile: join(here, 'public/app.js') }]

if (watch) {
  for (const e of entries) {
    const ctx = await context({ ...common, ...e })
    await ctx.watch()
  }
  console.log('[web] watching…')
} else {
  for (const e of entries) await build({ ...common, ...e })
}
