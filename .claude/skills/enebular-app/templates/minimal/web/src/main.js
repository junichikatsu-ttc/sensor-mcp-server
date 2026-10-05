// @ts-check
/**
 * 画面の配線。サンプルとして「自分のメモ一覧」を作る。ここは丸ごと書き換える前提。
 */
import { api, ApiError } from './api.js'
import { byId, el, formatTime, replaceChildren } from './dom.js'

// 所有者 ID。デモなのでブラウザ側で作って localStorage に保存し、ヘッダで送る。
// 本物の認証に差し替えるときは references/recipes.md の「セッション認証」を見る。
const OWNER_KEY = '__APP_NAME__:ownerId'

function ownerId() {
  let v = localStorage.getItem(OWNER_KEY)
  if (!v) {
    v = `u${Math.random().toString(36).slice(2, 10)}`
    localStorage.setItem(OWNER_KEY, v)
  }
  return v
}

const headers = () => ({ 'x-owner-id': ownerId() })

/** @param {string} message */
function showError(message) {
  const box = byId('error')
  box.textContent = message
  box.hidden = false
}

function clearError() {
  byId('error').hidden = true
}

/** @param {{ownerId: string, createdAt: number, text: string}[]} items */
function renderItems(items) {
  const list = byId('list')
  if (items.length === 0) {
    replaceChildren(list, [el('li', { class: 'empty', text: 'まだ何もありません' })])
    return
  }
  replaceChildren(
    list,
    items.map((it) =>
      el('li', { class: 'item' }, [
        el('div', { class: 'item-text', text: it.text }),
        el('div', { class: 'item-meta', text: formatTime(it.createdAt) }),
        el('button', {
          class: 'link',
          text: '削除',
          on: { click: () => void remove(it.createdAt) },
        }),
      ]),
    ),
  )
}

async function load() {
  clearError()
  try {
    const res = await api('/v1/items', { headers: headers() })
    renderItems(res.items)
  } catch (err) {
    showError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err))
  }
}

/** @param {number} createdAt */
async function remove(createdAt) {
  clearError()
  try {
    await api(`/v1/items/${createdAt}`, { method: 'DELETE', headers: headers() })
    await load()
  } catch (err) {
    showError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err))
  }
}

async function submit() {
  const input = /** @type {HTMLInputElement} */ (byId('text'))
  const text = input.value.trim()
  if (!text) return
  clearError()
  try {
    await api('/v1/items', { body: { text }, headers: headers() })
    input.value = ''
    await load()
  } catch (err) {
    showError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err))
  }
}

byId('form').addEventListener('submit', (e) => {
  e.preventDefault()
  void submit()
})

byId('owner').textContent = ownerId()
void load()
