// @ts-check
/**
 * API 呼び出し規約。ここは変えない前提で使う。
 * - トリガーのパス配下に置かれるため、ルート相対ではなく「現在のパス」を基準にする
 *   （`/v1/...` を直に叩くとトリガーの外に出る）
 * - 環境変数を一切持たない（同一オリジンなので相対パスで足りる）
 * - 202 Accepted はエラーではなく待機として扱い、retryAfterMs で再送する
 *   （enebular ではストリーミングが使えないため、長い処理はこの形になる。constraints.md E1）
 */

function computeBase() {
  let p = location.pathname
  // /myapp/foo.html → /myapp
  if (/\.html$/.test(p)) p = p.slice(0, p.lastIndexOf('/'))
  if (p.endsWith('/')) p = p.slice(0, -1)
  return p
}

export const API_BASE = computeBase()

export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {unknown} [details]
   */
  constructor(status, code, message, details) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

/**
 * @param {string} path  例: '/v1/items'
 * @param {{ method?: string, body?: unknown, token?: string | null, headers?: Record<string,string> }} [opts]
 * @returns {Promise<any>}
 */
export async function api(path, opts = {}) {
  /** @type {Record<string,string>} */
  const headers = { accept: 'application/json', ...(opts.headers ?? {}) }
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`

  for (let attempt = 0; attempt < 10; attempt++) {
    const res = await fetch(`${API_BASE}${path}`, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })
    if (res.status === 204) return null
    if (res.status === 202) {
      const j = await res.json().catch(() => ({}))
      await sleep(Number(j.retryAfterMs) || 1000)
      continue
    }
    if (res.status === 429) {
      // 同一オリジンなので Retry-After ヘッダが読める（別ホストだと CORS の設定が要る）
      const ra = Number(res.headers.get('retry-after')) || 2
      await sleep(ra * 1000)
      continue
    }
    const text = await res.text()
    const json = parseJson(text)
    if (!res.ok) {
      const e = json && json.error ? json.error : { code: 'HTTP_' + res.status, message: text || res.statusText }
      throw new ApiError(res.status, e.code, e.message, e.details)
    }
    return json
  }
  throw new ApiError(0, 'RETRY_EXHAUSTED', 'サーバの応答待ちがタイムアウトしました')
}

/** @param {string} text @returns {any} */
function parseJson(text) {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
