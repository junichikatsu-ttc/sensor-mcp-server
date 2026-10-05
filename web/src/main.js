// @ts-check
/**
 * 画面の配線。運用者向けの小さなページ:
 *   - /v1/health の状態とエンドポイント URL の表示（MCP クライアントの設定例を含む）
 *   - センサーデータの検索（ページング付き）
 *   - テスト送信
 * 本体は API と MCP なので、ここは最小限にとどめる。
 */
import { api, API_BASE, ApiError } from './api.js'
import { byId, el, formatDateTime, replaceChildren } from './dom.js'

const API_KEY_STORAGE = 'sensor-mcp-server:apiKey'
const apiKeyInput = /** @type {HTMLInputElement} */ (byId('api-key'))
try {
  apiKeyInput.value = localStorage.getItem(API_KEY_STORAGE) ?? ''
} catch {
  /* private window など。保存できなくても動く */
}
apiKeyInput.addEventListener('change', () => {
  try {
    if (apiKeyInput.value) localStorage.setItem(API_KEY_STORAGE, apiKeyInput.value)
    else localStorage.removeItem(API_KEY_STORAGE)
  } catch {
    /* noop */
  }
})

/** @returns {Record<string,string>} */
function authHeaders() {
  const key = apiKeyInput.value.trim()
  return key ? { 'x-api-key': key } : {}
}

/** @param {unknown} err */
function showError(err) {
  const box = byId('error')
  box.textContent = err instanceof ApiError ? `${err.code}: ${err.message}` : String(err)
  box.hidden = false
}

function clearError() {
  byId('error').hidden = true
}

// ---------------------------------------------------------------------------
// エンドポイント表示
// ---------------------------------------------------------------------------

const origin = location.origin + API_BASE

/** @param {string} term @param {string} desc */
function endpointRow(term, desc) {
  return [el('dt', { text: term }), el('dd', { text: desc })]
}

replaceChildren(byId('endpoints'), [
  ...endpointRow('MCP', `${origin}/mcp  (POST, Streamable HTTP / JSON レスポンス)`),
  ...endpointRow('投入', `POST ${origin}/v1/sensors`),
  ...endpointRow('取得', `GET  ${origin}/v1/sensors/{no}?startTime&endTime&limit&startKey&order`),
  ...endpointRow('互換', `POST ${origin}/ttc-iot-sensor  /  GET ${origin}/get-sonsor`),
  ...endpointRow('稼働', `GET  ${origin}/v1/health`),
])

byId('mcp-config').textContent = JSON.stringify(
  {
    mcpServers: {
      'sensor-data': {
        type: 'http',
        url: `${origin}/mcp`,
        headers: { Authorization: 'Bearer <API_KEY>' },
      },
    },
  },
  null,
  2,
)

async function loadHealth() {
  const box = byId('health')
  try {
    const h = await api('/v1/health')
    const parts = [
      `commit ${String(h.commit).slice(0, 12)}`,
      `datastore ${h.datastore}`,
      h.configOk ? 'config OK' : `config 不足 ${h.configMissing} 件`,
      h.apiKeyAuth ? 'API キー認証あり' : 'API キー認証なし',
    ]
    box.textContent = parts.join(' / ')
    box.className = `health ${h.configOk ? 'ok' : 'warn'}`
  } catch (err) {
    box.textContent = 'health 取得失敗'
    box.className = 'health warn'
    showError(err)
  }
}

// ---------------------------------------------------------------------------
// 検索
// ---------------------------------------------------------------------------

/** @type {string | undefined} */
let nextStartKey
/** @type {Record<string, string>} */
let lastParams = {}

/** @param {string} v datetime-local の値 → エポックミリ秒（空なら '') */
function toEpochMs(v) {
  if (!v) return ''
  const t = new Date(v).getTime()
  return Number.isFinite(t) ? String(t) : ''
}

/** @param {Record<string, unknown>[]} items @param {boolean} append */
function renderTable(items, append) {
  const table = byId('result')
  const existing = append ? [...table.querySelectorAll('tbody tr')] : []
  if (!append && items.length === 0) {
    replaceChildren(table, [el('caption', { class: 'empty', text: 'データがありません' })])
    return
  }
  const keys = new Set(['ts'])
  for (const it of items) for (const k of Object.keys(it)) if (k !== 'no') keys.add(k)
  for (const tr of existing) for (const td of tr.querySelectorAll('td[data-key]')) keys.add(String(td.getAttribute('data-key')))
  const columns = ['ts', ...[...keys].filter((k) => k !== 'ts').sort()]

  const head = el('thead', {}, [el('tr', {}, columns.map((k) => el('th', { text: k === 'ts' ? 'ts（時刻）' : k })))])
  const rows = items.map((it) =>
    el(
      'tr',
      {},
      columns.map((k) => {
        const v = it[k]
        const text = k === 'ts' && typeof v === 'number' ? `${formatDateTime(v)} (${v})` : v === undefined ? '' : String(v)
        return el('td', { text, attrs: { 'data-key': k } })
      }),
    ),
  )
  const body = el('tbody', {}, [...existing, ...rows])
  replaceChildren(table, [head, body])
}

/** @param {boolean} append */
async function runQuery(append) {
  clearError()
  const params = append
    ? { ...lastParams, startKey: nextStartKey ?? '' }
    : {
        no: /** @type {HTMLInputElement} */ (byId('q-no')).value.trim(),
        startTime: toEpochMs(/** @type {HTMLInputElement} */ (byId('q-start')).value),
        endTime: toEpochMs(/** @type {HTMLInputElement} */ (byId('q-end')).value),
        limit: /** @type {HTMLInputElement} */ (byId('q-limit')).value,
        order: /** @type {HTMLSelectElement} */ (byId('q-order')).value,
      }
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v)
  try {
    const res = await api(`/v1/sensors?${qs.toString()}`, { headers: authHeaders() })
    renderTable(res.items, append)
    nextStartKey = res.nextStartKey
    lastParams = { no: params.no, startTime: params.startTime, endTime: params.endTime, limit: params.limit, order: params.order }
    const total = byId('result').querySelectorAll('tbody tr').length
    byId('result-meta').textContent = `${total} 件表示${nextStartKey ? '（続きあり）' : ''}`
    byId('next-page').hidden = !nextStartKey
  } catch (err) {
    showError(err)
  }
}

byId('query-form').addEventListener('submit', (e) => {
  e.preventDefault()
  void runQuery(false)
})
byId('next-page').addEventListener('click', () => void runQuery(true))

// ---------------------------------------------------------------------------
// テスト送信
// ---------------------------------------------------------------------------

byId('upload-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  clearError()
  const out = byId('upload-result')
  const text = /** @type {HTMLTextAreaElement} */ (byId('upload-body')).value
  let body
  try {
    body = JSON.parse(text)
  } catch {
    showError('JSON として読めません')
    return
  }
  try {
    const res = await api('/v1/sensors', { body, headers: authHeaders() })
    out.textContent = JSON.stringify(res, null, 2)
    out.hidden = false
  } catch (err) {
    showError(err)
  }
})

void loadHealth()
