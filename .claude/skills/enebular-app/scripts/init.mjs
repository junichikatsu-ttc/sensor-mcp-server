#!/usr/bin/env node
// @ts-check
/**
 * enebular-app スキルの雛形を展開する。
 *
 *   node .claude/skills/enebular-app/scripts/init.mjs <出力先> [--name myapp] [--title "My App"] [--force]
 *
 * やっていることは「templates/minimal をコピーして 2 つのプレースホルダを置換する」だけ。
 * スクリプトが使えない環境なら手でコピーしてもよい（README に同じ手順がある）。
 *
 *   __APP_NAME__   パッケージ名・ZIP 名・HTTP トリガーのパスの既定値（英数字と - のみ）
 *   __APP_TITLE__  画面に出る表示名
 *
 * dot.xxx というファイル名は .xxx として展開する（テンプレート側で .gitignore や .env が
 * 効いてしまうのを避けるため）。__ASSET_VERSION__ は実行時に使う値なので置換しない。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const templateDir = join(here, '..', 'templates', 'minimal')

const [, , targetArg, ...rest] = process.argv
const flags = new Set(rest.filter((a) => a.startsWith('--')))
const argValue = (/** @type {string} */ name) => {
  const i = rest.indexOf(name)
  return i >= 0 ? rest[i + 1] : undefined
}

function fail(/** @type {string} */ msg) {
  console.error(`\n[init] ERROR: ${msg}`)
  process.exit(1)
}

if (!targetArg) {
  console.log(`使い方: node ${relative(process.cwd(), fileURLToPath(import.meta.url))} <出力先> [--name myapp] [--title "My App"] [--force]`)
  process.exit(0)
}

const target = resolve(process.cwd(), targetArg)
const appName = (argValue('--name') ?? target.split(/[\\/]/).filter(Boolean).pop() ?? 'myapp').toLowerCase()
const appTitle = argValue('--title') ?? appName

// パッケージ名・ZIP 名・トリガーのパスに使うので、通る文字だけに絞る
if (!/^[a-z0-9][a-z0-9-]{0,29}$/.test(appName)) {
  fail(`--name は英小文字・数字・ハイフンの 1〜30 文字にしてください（指定: ${appName}）`)
}
if (!existsSync(templateDir)) fail(`テンプレートがありません: ${templateDir}`)

if (existsSync(target) && readdirSync(target).length > 0 && !flags.has('--force')) {
  fail(`出力先が空ではありません: ${target}\n  上書きするなら --force`)
}

mkdirSync(target, { recursive: true })
cpSync(templateDir, target, { recursive: true, force: true })

/** dot.xxx → .xxx */
function undot(/** @type {string} */ dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) {
      undot(p)
      continue
    }
    if (entry.startsWith('dot.')) renameSync(p, join(dir, entry.slice(3)))
  }
}
undot(target)

const TEXT_EXT = /\.(ts|js|mjs|json|html|css|md|example|gitignore)$|^\.(env|gitignore)/
let replaced = 0

/** プレースホルダを置換する。__ASSET_VERSION__ は配信時に使う値なので触らない */
function substitute(/** @type {string} */ dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) {
      substitute(p)
      continue
    }
    if (!TEXT_EXT.test(entry)) continue
    const before = readFileSync(p, 'utf8')
    const after = before.split('__APP_NAME__').join(appName).split('__APP_TITLE__').join(appTitle)
    if (after !== before) {
      writeFileSync(p, after)
      replaced++
    }
  }
}
substitute(target)

console.log(`
[init] ${target} に雛形を展開しました（置換 ${replaced} ファイル）
  name:  ${appName}
  title: ${appTitle}

次の手順:
  cd ${relative(process.cwd(), target) || '.'}
  npm install
  cp .env.example .env
  npm run dev:web    # 別ターミナル
  npm run dev        # http://localhost:8787

  npm run typecheck && npm test && npm run build

デプロイは README.md と、スキルの references/deploy.md を見てください。`)
