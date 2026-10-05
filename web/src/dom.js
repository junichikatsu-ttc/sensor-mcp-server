// @ts-check
/**
 * 描画ユーティリティ。
 *
 * ★ innerHTML は使わない。React のような自動エスケープが無いので、
 *   ユーザー入力や外部由来の文字列は必ず textContent で入れる。
 */

/** @param {string} id @returns {HTMLElement} */
export function byId(id) {
  const el = document.getElementById(id)
  if (!el) throw new Error(`要素がありません: #${id}`)
  return el
}

/**
 * @param {string} tag
 * @param {{ class?: string, text?: string, attrs?: Record<string,string>, on?: Record<string, (e: Event) => void> }} [opts]
 * @param {Node[]} [children]
 * @returns {HTMLElement}
 */
export function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag)
  if (opts.class) node.className = opts.class
  if (opts.text !== undefined) node.textContent = opts.text
  for (const [k, v] of Object.entries(opts.attrs ?? {})) node.setAttribute(k, v)
  for (const [k, v] of Object.entries(opts.on ?? {})) node.addEventListener(k, v)
  for (const c of children) node.appendChild(c)
  return node
}

/** @param {HTMLElement} parent @param {Node[]} children */
export function replaceChildren(parent, children) {
  parent.replaceChildren(...children)
}

/** @param {number} ms @returns {string} 秒まで。ローカル時刻 */
export function formatDateTime(ms) {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return String(ms)
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
