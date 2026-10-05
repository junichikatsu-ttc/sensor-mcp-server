// @ts-check
/**
 * enebular クラウド実行環境（ZIP）向けビルド。処理順を変えないこと。
 *
 *  0) web をビルド（public/app.js は生成物。ここで作らずに読むと古いものが ZIP に入る）
 *  1) zip-package.json に "type": "module" があれば落とす
 *  2) esbuild で src/index.ts → build/index.js（単一 CJS）。静的ファイルは define で埋め込む
 *  3) zip-package.json → build/package.json
 *  4) build/index.js を require して handler が関数か検証（文字列 grep はしない。pitfalls 9）
 *  5) build/ の "中身" を ZIP ルートへ（archive.directory(dir, false) の false が肝）
 *  6) 250MB 以下か確認
 */
import { execFileSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import archiver from 'archiver'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const webDir = join(here, 'web')
const publicDir = join(webDir, 'public')
const buildDir = join(here, 'build')
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))
const zipPath = join(here, `${pkg.name}-function.zip`)
const MAX_ZIP_BYTES = 250 * 1024 * 1024

// ★ src/static.ts の STATIC_ASSET_NAMES と一致させる（test/app.test.ts が食い違いを検出する）
const STATIC_ASSETS = ['index.html', 'styles.css', 'app.js']
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

const step = (/** @type {string} */ msg) => console.log(`\n[build] ${msg}`)

function resolveCommit() {
  // deploy.mjs はデプロイ ID を渡す。git 管理外でも /v1/health の commit で照合できる
  if (process.env.BUILD_COMMIT) return process.env.BUILD_COMMIT
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA
  try {
    return (
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: here, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() ||
      'unknown'
    )
  } catch {
    return 'unknown'
  }
}

// 0) web build
step('web をビルド')
execFileSync(process.execPath, [join(webDir, 'build.mjs')], { cwd: webDir, stdio: 'inherit' })

// 1) zip-package.json
step('zip-package.json を検証')
const zipPkg = JSON.parse(readFileSync(join(here, 'zip-package.json'), 'utf8'))
if (zipPkg.type === 'module') throw new Error('zip-package.json に "type": "module" は書けない（CommonJS 必須）')
if (zipPkg.main !== 'index.js') throw new Error('zip-package.json の main は index.js にする')

// 2) esbuild
step('静的ファイルを収集')
/** @type {Record<string, {contentType: string, encoding: 'utf8'|'base64', body: string}>} */
const assets = {}
for (const name of STATIC_ASSETS) {
  const p = join(publicDir, name)
  // 1 つでも欠けたらビルドを失敗させる。画面が白いままデプロイされる方が損失が大きい
  if (!existsSync(p)) throw new Error(`静的ファイルがありません: ${p}`)
  const contentType = CONTENT_TYPES[extname(name)] ?? 'application/octet-stream'
  const binary = !contentType.startsWith('text/')
  assets[name] = {
    contentType,
    encoding: binary ? 'base64' : 'utf8',
    body: readFileSync(p).toString(binary ? 'base64' : 'utf8'),
  }
  console.log(`  ${name} (${statSync(p).size} bytes)`)
}

const buildInfo = { version: zipPkg.version, commit: resolveCommit(), builtAt: new Date().toISOString() }
step(`esbuild: commit=${buildInfo.commit}`)
rmSync(buildDir, { recursive: true, force: true })
mkdirSync(buildDir, { recursive: true })
await build({
  entryPoints: [join(here, 'src/index.ts')],
  outfile: join(buildDir, 'index.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
  define: {
    __BUILD_INFO__: JSON.stringify(buildInfo),
    __STATIC_ASSETS__: JSON.stringify(assets),
  },
})

// 3) package.json
step('package.json をコピー')
writeFileSync(join(buildDir, 'package.json'), JSON.stringify(zipPkg, null, 2))

// 4) require で検証（esbuild の CJS 出力に "exports.handler" という字面は現れないので grep しない）
step('handler を検証')
const require = createRequire(import.meta.url)
const mod = require(join(buildDir, 'index.js'))
if (typeof mod.handler !== 'function') throw new Error('build/index.js が handler 関数を公開していない')
console.log('  handler: function ✓')

// 5) ZIP
step('ZIP を作成')
rmSync(zipPath, { force: true })
await new Promise((resolve, reject) => {
  const out = createWriteStream(zipPath)
  const archive = archiver('zip', { zlib: { level: 9 } })
  out.on('close', resolve)
  archive.on('error', reject)
  archive.pipe(out)
  archive.directory(buildDir, false)
  archive.finalize()
})

// 6) サイズ
const size = statSync(zipPath).size
if (size > MAX_ZIP_BYTES) throw new Error(`ZIP が 250MB を超えている: ${size} bytes`)
console.log(`\n[build] done: ${zipPath} (${(size / 1024).toFixed(1)} KB)`)
