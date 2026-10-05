// @ts-check
/**
 * enebular へのローカルデプロイ。CLI（@uhuru/enebular-cli）を叩くだけなので CI も同じ順序で書ける。
 *
 *   npm run enebular:check    設定の確認（値はマスク表示）
 *   npm run enebular:init     ZIP をビルドしてファイルアセットを新規作成 → ASSET_ID を .env.deploy に書き戻す
 *   npm run enebular:config   HTTP トリガー / タイムアウト / connectDataStore / 環境変数(FN_*) を一括設定
 *   npm run enebular:deploy   ビルド → アセット更新 → デプロイ → バージョン記録 → スモークテスト
 *   npm run enebular:smoke    /v1/health を叩いて commit・configOk を確認
 *
 * 設定は環境変数、またはリポジトリ直下の .env.deploy（雛形: .env.deploy.example）。環境変数が優先。
 * オプション: --dry-run（enebular を呼ばない） --skip-build --no-smoke --force --no-write --commit <id>
 *
 * 先にコンソールで作るもの: プロジェクト / データストアのテーブル / クラウド実行環境
 * （実行環境はアセット作成後に、そのアセットを選んで Node.js 22.x で作る）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const zipPath = join(root, `${pkg.name}-function.zip`)
const ENV_FILE = process.env.DEPLOY_ENV_FILE || join(root, '.env.deploy')
const EXAMPLE_FILE = join(root, '.env.deploy.example')

/**
 * ★ 関数側で必須の環境変数。テーブルや外部サービスを足したらここにも足す。
 *   ここは事前チェックで、最終的な判定は /v1/health の configOk（src/config.ts）が持つ。
 */
const REQUIRED_FN = ['DS_TABLE_ITEMS']

const [, , command = 'help', ...rest] = process.argv
const flags = new Set(rest.filter((a) => a.startsWith('--')))
const argValue = (/** @type {string} */ name) => {
  const i = rest.indexOf(name)
  return i >= 0 ? rest[i + 1] : undefined
}
const DRY = flags.has('--dry-run')

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

/** KEY=VALUE の最小パーサ。# 行と空行は無視。値の前後の引用符を外す。空値は未設定扱い */
function loadEnvFile(/** @type {string} */ path) {
  /** @type {Record<string, string>} */
  const out = {}
  if (!existsSync(path)) return out
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (value !== '') out[key] = value
  }
  return out
}

const fileEnv = loadEnvFile(ENV_FILE)
/** 環境変数 > .env.deploy */
const env = (/** @type {string} */ key) => {
  const v = process.env[key] ?? fileEnv[key]
  return v === undefined || v.trim() === '' ? undefined : v.trim()
}

const cfg = {
  accessKey: env('ENEBULAR_ACCESS_KEY'),
  secretKey: env('ENEBULAR_SECRET_KEY'),
  projectId: env('ENEBULAR_PROJECT_ID'),
  cloudId: env('ENEBULAR_CLOUD_ID'),
  assetId: env('ENEBULAR_FILE_ASSET_ID'),
  assetName: env('ENEBULAR_FILE_ASSET_NAME') ?? `${pkg.name}-function`,
  triggerPath: env('ENEBULAR_HTTP_TRIGGER_PATH') ?? pkg.name,
  triggerUrl: env('ENEBULAR_HTTP_TRIGGER_URL'),
  timeout: Number(env('ENEBULAR_TIMEOUT') ?? 30),
  cloudName: env('ENEBULAR_CLOUD_NAME'),
}

/** 関数に渡す環境変数。FN_ プレフィックスを外して envVars にする */
function functionEnvVars() {
  /** @type {Record<string, string>} */
  const out = {}
  const merged = { ...fileEnv, ...process.env }
  for (const [k, v] of Object.entries(merged)) {
    if (!k.startsWith('FN_') || !v || v.trim() === '') continue
    out[k.slice(3)] = v.trim()
  }
  return out
}

const PLACEHOLDERS = new Set(['change-me', '00000000-0000-0000-0000-000000000000'])
const SECRET_RE = /SECRET|PASSWORD|TOKEN|KEY/i
const mask = (/** @type {string | undefined} */ v) =>
  !v ? '(未設定)' : v.length <= 8 ? '****' : `${v.slice(0, 4)}…${v.slice(-2)}`

function fail(/** @type {string} */ msg) {
  console.error(`\n[deploy] ERROR: ${msg}`)
  process.exit(1)
}

const step = (/** @type {string} */ msg) => console.log(`\n[deploy] ${msg}`)

function need(/** @type {Array<keyof typeof cfg>} */ keys) {
  const names = {
    accessKey: 'ENEBULAR_ACCESS_KEY',
    secretKey: 'ENEBULAR_SECRET_KEY',
    projectId: 'ENEBULAR_PROJECT_ID',
    cloudId: 'ENEBULAR_CLOUD_ID',
    assetId: 'ENEBULAR_FILE_ASSET_ID',
    triggerUrl: 'ENEBULAR_HTTP_TRIGGER_URL',
  }
  const missing = keys.filter((k) => !cfg[k]).map((k) => names[/** @type {keyof typeof names} */ (k)] ?? k)
  if (missing.length) {
    fail(`設定が不足しています: ${missing.join(', ')}\n  ${ENV_FILE} に書くか環境変数で渡してください（雛形: ${EXAMPLE_FILE}）`)
  }
  // 値の前後に空白や改行があると認証エラーになる。原因表示が出ないので先に弾く
  for (const k of keys) {
    const v = cfg[k]
    if (typeof v === 'string' && v !== v.replace(/\s/g, '')) fail(`${String(k)} に空白または改行が含まれています`)
  }
}

// ---------------------------------------------------------------------------
// enebular CLI
// ---------------------------------------------------------------------------

const cliBin = (() => {
  const require = createRequire(import.meta.url)
  return join(dirname(require.resolve('@uhuru/enebular-cli/package.json')), 'dist/bin/enebular.js')
})()

/**
 * CLI を --json で呼び、{ result: 'success', ... } を返す。失敗は例外。
 * --json を外すと確認プロンプトで止まる。
 * @param {string[]} args
 */
function enebular(args) {
  const shown = `enebular ${args.join(' ')} --json`
  if (DRY) {
    console.log(`  (dry-run) ${shown}`)
    return { result: 'success', dryRun: true }
  }
  console.log(`  $ ${shown}`)
  const full = [cliBin, ...args, '--json']
  if (cfg.accessKey && cfg.secretKey) full.push('--access-key', cfg.accessKey, '--secret-key', cfg.secretKey)
  else console.log('  （アクセスキー未設定: CLI の ~/.enebular/credentials または環境変数で認証します）')
  const r = spawnSync(process.execPath, full, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const stdout = (r.stdout ?? '').trim()
  const stderr = (r.stderr ?? '').trim()
  /** @type {any} */
  let json = null
  const start = stdout.indexOf('{')
  if (start >= 0) {
    try {
      json = JSON.parse(stdout.slice(start))
    } catch {
      json = null
    }
  }
  if (r.status !== 0 || !json || json.result !== 'success') {
    const detail = json ? `${json.message ?? ''} (${json.code ?? ''})` : stdout || stderr || `exit ${r.status}`
    throw new Error(`${shown}\n  → 失敗: ${detail}`)
  }
  return json
}

function cliVersion() {
  const r = spawnSync(process.execPath, [cliBin, 'version'], { encoding: 'utf8' })
  return (r.stdout || r.stderr || '').trim()
}

// ---------------------------------------------------------------------------
// ビルドと検証
// ---------------------------------------------------------------------------

function newDeployId() {
  // /v1/health の commit と file-version 名に使う。英数字のみ・12 文字以内（?v= の版にもそのまま使える）
  return `d${Date.now().toString(36)}`
}

function build(/** @type {string} */ deployId) {
  step(`ZIP をビルド（deployId=${deployId}）`)
  const r = spawnSync(process.execPath, [join(root, 'build.mjs')], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, BUILD_COMMIT: deployId },
  })
  if (r.status !== 0) fail('ビルドに失敗しました')
}

/** ZIP の中央ディレクトリからエントリ名を読む（unzip コマンドに依存しない） */
function zipEntries(/** @type {string} */ path) {
  const buf = readFileSync(path)
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('ZIP の終端が見つかりません')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  /** @type {string[]} */
  const names = []
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP の中央ディレクトリが壊れています')
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    names.push(buf.subarray(p + 46, p + 46 + nameLen).toString('utf8'))
    p += 46 + nameLen + extraLen + commentLen
  }
  return names
}

function verifyZip() {
  step('ZIP レイアウトを検証')
  if (!existsSync(zipPath)) fail(`ZIP がありません: ${zipPath}`)
  const names = zipEntries(zipPath).sort()
  if (!names.includes('index.js') || !names.includes('package.json')) {
    fail(`ルート直下に index.js / package.json がありません: ${names.join(', ')}`)
  }
  const zipPkg = JSON.parse(readFileSync(join(root, 'build/package.json'), 'utf8'))
  if (zipPkg.type === 'module') fail('ZIP の package.json に "type": "module" があります')
  const size = statSync(zipPath).size
  if (size > 250 * 1024 * 1024) fail(`ZIP が 250MB を超えています: ${size}`)
  console.log(`  entries: ${names.join(', ')}  size: ${(size / 1024).toFixed(1)} KB ✓`)
}

// ---------------------------------------------------------------------------
// コマンド
// ---------------------------------------------------------------------------

function fnWarnings(/** @type {Record<string, string>} */ fn) {
  const w = []
  for (const k of REQUIRED_FN) {
    if (!fn[k]) w.push(`FN_${k} が未設定（/v1/health が configOk:false になります）`)
    else if (PLACEHOLDERS.has(fn[k])) w.push(`FN_${k} が雛形値のままです`)
  }
  if (fn.LOG_LEVEL && !['ERROR', 'WARN', 'INFO'].includes(fn.LOG_LEVEL.toUpperCase())) {
    w.push('FN_LOG_LEVEL が DEBUG 以上だと入力内容がログに出ます')
  }
  if (fn.MOCK_MODE !== 'false') w.push('FN_MOCK_MODE が false ではありません（デモ設定のまま公開していないか）')
  for (const k of Object.keys(fn)) {
    if (/^(ENEBULAR_|AWS_|LAMBDA_)/.test(k)) w.push(`${k} は予約プレフィックスのため envVars に設定できません`)
  }
  return w
}

function cmdCheck() {
  step('設定')
  console.log(`  設定ファイル: ${ENV_FILE} ${existsSync(ENV_FILE) ? '(あり)' : '(なし。環境変数のみ)'}`)
  console.log(`  enebular CLI: ${cliVersion()}`)
  const rows = [
    ['ENEBULAR_ACCESS_KEY', mask(cfg.accessKey)],
    ['ENEBULAR_SECRET_KEY', mask(cfg.secretKey)],
    ['ENEBULAR_PROJECT_ID', cfg.projectId ?? '(未設定)'],
    ['ENEBULAR_CLOUD_ID', cfg.cloudId ?? '(未設定)'],
    ['ENEBULAR_FILE_ASSET_ID', cfg.assetId ?? '(未設定 → enebular:init で作成)'],
    ['ENEBULAR_FILE_ASSET_NAME', cfg.assetName],
    ['ENEBULAR_HTTP_TRIGGER_PATH', cfg.triggerPath],
    ['ENEBULAR_HTTP_TRIGGER_URL', cfg.triggerUrl ?? '(未設定 → スモークテストはスキップ)'],
    ['ENEBULAR_TIMEOUT', String(cfg.timeout)],
    ['ENEBULAR_CLOUD_NAME', cfg.cloudName ?? '(変更しない)'],
  ]
  for (const [k, v] of rows) console.log(`  ${k.padEnd(28)} ${v}`)
  step('関数の環境変数（FN_* → envVars）')
  const fn = functionEnvVars()
  const keys = Object.keys(fn).sort()
  if (keys.length === 0) console.log('  (なし)')
  for (const k of keys) console.log(`  ${k.padEnd(28)} ${SECRET_RE.test(k) ? mask(fn[k]) : fn[k]}`)
  const warnings = fnWarnings(fn)
  if (warnings.length) {
    console.log('\n  注意:')
    for (const w of warnings) console.log(`  - ${w}`)
  }
}

function writeBackAssetId(/** @type {string} */ assetId) {
  if (flags.has('--no-write')) return
  let text = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : ''
  if (/^ENEBULAR_FILE_ASSET_ID=.*$/m.test(text)) {
    text = text.replace(/^ENEBULAR_FILE_ASSET_ID=.*$/m, `ENEBULAR_FILE_ASSET_ID=${assetId}`)
  } else {
    text += `${text.endsWith('\n') || text === '' ? '' : '\n'}ENEBULAR_FILE_ASSET_ID=${assetId}\n`
  }
  writeFileSync(ENV_FILE, text)
  console.log(`  ${ENV_FILE} に ENEBULAR_FILE_ASSET_ID を書き込みました`)
}

function cmdInit() {
  need(['projectId'])
  if (cfg.assetId && !flags.has('--force')) {
    fail(
      `ENEBULAR_FILE_ASSET_ID は既に設定されています（${cfg.assetId}）。ZIP の差し替えは enebular:deploy で行います。別アセットを作るなら --force`,
    )
  }
  const deployId = newDeployId()
  if (!flags.has('--skip-build')) build(deployId)
  verifyZip()
  step('ファイルアセットを作成')
  const res = enebular([
    'add',
    'file',
    '--project-id',
    /** @type {string} */ (cfg.projectId),
    '--file',
    zipPath,
    '--deploy-type',
    'cloud',
    '--handler',
    'index.handler',
    '--name',
    cfg.assetName,
    '--detail',
    `${pkg.name} (Node.js 22 / ZIP)。初回 ${deployId}`,
  ])
  if (DRY) return
  const assetId = res.assetId
  if (!assetId) fail(`アセット ID を取得できませんでした: ${JSON.stringify(res)}`)
  console.log(`  assetId: ${assetId}`)
  writeBackAssetId(assetId)
  console.log(`
次の手順:
  1. enebular コンソールでクラウド実行環境を作成する（アセット: ${cfg.assetName} / ランタイム: Node.js 22.x）
  2. その ID を ENEBULAR_CLOUD_ID に設定する
  3. npm run enebular:config   （HTTP トリガー・connectDataStore・環境変数を設定）
  4. npm run enebular:deploy   （以降はこれだけ）`)
}

function cmdConfig() {
  need(['projectId', 'cloudId'])
  const fn = functionEnvVars()
  /** @type {Record<string, unknown>} */
  const config = {
    httpTriggerStatus: true,
    httpTriggerPath: cfg.triggerPath,
    timeout: cfg.timeout,
    connectDataStore: true,
    envVars: fn,
  }
  if (cfg.cloudName) config.name = cfg.cloudName
  step('クラウド実行環境の設定（bulk-update cloud-config）')
  const masked = {
    ...config,
    envVars: Object.fromEntries(Object.entries(fn).map(([k, v]) => [k, SECRET_RE.test(k) ? mask(v) : v])),
  }
  console.log(JSON.stringify(masked, null, 2).replace(/^/gm, '  '))
  for (const w of fnWarnings(fn)) console.log(`  注意: ${w}`)
  if (!Number.isInteger(cfg.timeout) || cfg.timeout < 1 || cfg.timeout > 900) fail('ENEBULAR_TIMEOUT は 1〜900 の整数')
  const tmp = join(tmpdir(), `${pkg.name}-cloud-config-${process.pid}.json`)
  writeFileSync(tmp, JSON.stringify(config))
  try {
    enebular([
      'bulk-update',
      'cloud-config',
      '--project-id',
      /** @type {string} */ (cfg.projectId),
      '--cloud-id',
      /** @type {string} */ (cfg.cloudId),
      '--config-file',
      tmp,
    ])
  } finally {
    try {
      unlinkSync(tmp)
    } catch {
      /* ignore */
    }
  }
  if (!DRY) console.log('  反映しました。envVars は送った内容で置き換わります（FN_* を消したキーは実行環境からも消えます）')
}

async function cmdDeploy() {
  need(['projectId', 'cloudId', 'assetId'])
  const deployId = argValue('--commit') ?? newDeployId()
  if (!flags.has('--skip-build')) build(deployId)
  verifyZip()
  step('アセットの ZIP を差し替え')
  enebular([
    'update',
    'file',
    '--project-id',
    /** @type {string} */ (cfg.projectId),
    '--asset-id',
    /** @type {string} */ (cfg.assetId),
    '--file',
    zipPath,
  ])
  step('クラウド実行環境へデプロイ')
  enebular([
    'deploy',
    'cloud',
    '--project-id',
    /** @type {string} */ (cfg.projectId),
    '--cloud-id',
    /** @type {string} */ (cfg.cloudId),
    '--asset-id',
    /** @type {string} */ (cfg.assetId),
    '--asset-type',
    'file', // flow は Node-RED 用。file を使う
  ])
  step('バージョンを記録')
  // --name は 1〜30 文字の英数字・_・- のみ。弾かずに整形する
  const name = deployId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 30) || 'deploy'
  try {
    enebular([
      'add',
      'file-version',
      '--project-id',
      /** @type {string} */ (cfg.projectId),
      '--asset-id',
      /** @type {string} */ (cfg.assetId),
      '--name',
      name,
      '--comment',
      `local deploy ${new Date().toISOString()} by ${userInfo().username}`,
    ])
  } catch (err) {
    // デプロイ自体は済んでいるので、バージョン記録の失敗で全体を落とさない
    console.warn(`  警告: バージョン記録に失敗しました（デプロイは完了）: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (DRY) return
  if (flags.has('--no-smoke')) return console.log(`\n[deploy] 完了: deployId=${deployId}（スモークテストはスキップ）`)
  if (!cfg.triggerUrl) {
    return console.log(`\n[deploy] 完了: deployId=${deployId}。ENEBULAR_HTTP_TRIGGER_URL を設定すると health で照合できます`)
  }
  await smoke(deployId)
}

/** @param {string | undefined} expectedCommit */
async function smoke(expectedCommit) {
  need(['triggerUrl'])
  const base = /** @type {string} */ (cfg.triggerUrl).replace(/\/+$/, '')
  step(`スモークテスト: ${base}/v1/health${expectedCommit ? `（commit=${expectedCommit} を待つ）` : ''}`)
  const deadline = Date.now() + 120_000
  /** @type {any} */
  let health = null
  let lastNote = ''
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/v1/health`, { headers: { accept: 'application/json' } })
      if (res.ok) {
        health = await res.json()
        if (!expectedCommit || health.commit === expectedCommit) break
        lastNote = `commit=${health.commit}（旧版が応答中）`
      } else lastNote = `HTTP ${res.status}`
    } catch (err) {
      lastNote = err instanceof Error ? err.message : String(err)
    }
    process.stdout.write(`  待機中… ${lastNote}\r`)
    await new Promise((r) => setTimeout(r, 5000))
  }
  console.log('')
  if (!health) fail(`health が取得できませんでした: ${lastNote}`)
  console.log(`  ${JSON.stringify(health)}`)
  const problems = []
  // これが効く。ZIP の差し替え漏れはここでしか気づけない
  if (expectedCommit && health.commit !== expectedCommit) {
    problems.push(`commit が一致しません（期待 ${expectedCommit} / 実際 ${health.commit}）→ ZIP の差し替え漏れ`)
  }
  if (health.configOk !== true) {
    problems.push(`configOk=false（不足 ${health.configMissing} 件。実行環境のログにキー名が出ます。enebular:config を確認）`)
  }
  if (health.datastore !== 'cloud') problems.push(`datastore=${health.datastore}`)
  try {
    const fn = functionEnvVars()
    /** @type {Record<string, string>} */
    const headers = {}
    if (fn.BASIC_AUTH_USER && fn.BASIC_AUTH_PASSWORD) {
      headers.authorization = `Basic ${Buffer.from(`${fn.BASIC_AUTH_USER}:${fn.BASIC_AUTH_PASSWORD}`).toString('base64')}`
      const noAuth = await fetch(`${base}/`, { redirect: 'follow' })
      if (noAuth.status === 401) console.log('  GET /（認証なし）→ 401 ✓  BASIC 認証が有効')
      else problems.push(`BASIC 認証が設定されているのに認証なしで ${noAuth.status} が返ります（config を反映しましたか）`)
    } else if (health.basicAuth === true) {
      problems.push('実行環境は BASIC 認証が有効ですが、手元に FN_BASIC_AUTH_* が無いためルート URL を確認できません')
    }
    const res = await fetch(`${base}/`, { redirect: 'follow', headers })
    const html = await res.text()
    // ?v= が無いと前段キャッシュで「デプロイしたのに画面が変わらない」になる（pitfalls 1）
    if (!res.ok || !html.includes('app.js?v=')) problems.push(`ルート URL で index.html が返りません（HTTP ${res.status}）`)
    else console.log(`  GET / → ${res.status} ✓  (app.js?v=${/app\.js\?v=([^"]+)/.exec(html)?.[1] ?? '?'})`)
  } catch (err) {
    problems.push(`ルート URL の取得に失敗: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (problems.length) {
    for (const p of problems) console.error(`  ✗ ${p}`)
    process.exit(1)
  }
  console.log(`\n[deploy] OK: ${base}/  mockMode=${health.mockMode}`)
}

function help() {
  console.log(`使い方: node deploy.mjs <check|init|config|deploy|smoke> [--dry-run] [--skip-build] [--no-smoke] [--force] [--no-write] [--commit <id>]
設定: ${ENV_FILE}（雛形 ${EXAMPLE_FILE}）または環境変数`)
}

try {
  switch (command) {
    case 'check':
      cmdCheck()
      break
    case 'init':
      cmdInit()
      break
    case 'config':
      cmdConfig()
      break
    case 'deploy':
      await cmdDeploy()
      break
    case 'smoke':
      await smoke(argValue('--commit'))
      break
    default:
      help()
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err))
}
