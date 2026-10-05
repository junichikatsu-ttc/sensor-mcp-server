import type { AppConfig } from './config'
import { sensorQueryInputSchema, sensorReadingInputSchema } from './schemas'
import type { SensorQuery, SensorReading } from './schemas'

/**
 * センサー API の業務ロジック。データストアに触らない純関数だけを置く。
 * ルート（routes/*）と MCP ツール（mcp/server.ts）はここを呼んでリポジトリに渡すだけにする。
 */

/**
 * 投入ボディ → 保存するアイテム。
 * `ts` が無ければサーバ時刻を入れる（元フローは payload をそのまま put していたので、ts 無しは失敗していた）。
 */
export function toReading(body: unknown, now: () => number = Date.now): SensorReading {
  const input = sensorReadingInputSchema.parse(body)
  const { no, ts, ...rest } = input
  return { ...rest, no, ts: ts ?? now() }
}

/**
 * クエリ文字列 → リポジトリに渡す条件。
 *   - 空文字のパラメータは「指定なし」として捨てる（フォームから空のまま送られてくる）
 *   - limit は省略時に既定値、上限を超えたらクランプ（エラーにしない）
 */
export function toQuery(raw: Record<string, string | undefined>, cfg: AppConfig): SensorQuery {
  const cleaned: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined && v.trim() !== '') cleaned[k] = v
  }
  const input = sensorQueryInputSchema.parse(cleaned)
  const q: SensorQuery = {
    no: input.no,
    limit: Math.min(input.limit ?? cfg.sensorQueryLimit, cfg.sensorQueryMaxLimit),
    order: input.order,
  }
  if (input.startTime !== undefined) q.startTime = input.startTime
  if (input.endTime !== undefined) q.endTime = input.endTime
  if (input.startKey !== undefined) q.startKey = input.startKey
  return q
}

/**
 * LLM 向けの時刻入力 → エポックミリ秒。
 *   - 数値、または数字だけの文字列: そのままミリ秒として扱う
 *   - それ以外の文字列: ISO 8601 として解釈（例 "2026-10-01T00:00:00+09:00"）
 * 解釈できなければ undefined を返す（呼び出し側がエラーにする）。
 */
export function parseTimeInput(v: string | number | undefined): number | undefined {
  if (v === undefined) return undefined
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : undefined
  const s = v.trim()
  if (s === '') return undefined
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s)
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : undefined
}

export function toIso(ms: number): string {
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? String(ms) : d.toISOString()
}

/** 数値属性ごとの要約。LLM に生データを全部渡さずに済ませるためのもの */
export interface FieldSummary {
  count: number
  min: number
  max: number
  avg: number
  first: number
  last: number
}

export function summarizeReadings(items: SensorReading[]): Record<string, FieldSummary> {
  const acc = new Map<string, { count: number; sum: number; min: number; max: number; first: number; last: number }>()
  for (const it of items) {
    for (const [k, v] of Object.entries(it)) {
      if (k === 'no' || k === 'ts') continue
      const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN
      if (!Number.isFinite(n)) continue
      const cur = acc.get(k)
      if (!cur) acc.set(k, { count: 1, sum: n, min: n, max: n, first: n, last: n })
      else {
        cur.count++
        cur.sum += n
        cur.min = Math.min(cur.min, n)
        cur.max = Math.max(cur.max, n)
        cur.last = n
      }
    }
  }
  const out: Record<string, FieldSummary> = {}
  for (const [k, a] of acc) out[k] = { count: a.count, min: a.min, max: a.max, avg: a.sum / a.count, first: a.first, last: a.last }
  return out
}
