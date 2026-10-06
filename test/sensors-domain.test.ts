import { describe, expect, it } from 'vitest'
import { readConfig } from '../src/config'
import { buildSensorExpression } from '../src/datastore'
import { sensorNoSchema } from '../src/schemas'
import { parseTimeInput, summarizeReadings, toQuery, toReading } from '../src/sensors'

/** データストアに触らない純関数のテスト */

const no = sensorNoSchema.parse('dev-1')

describe('buildSensorExpression（元フローの ds-easy-query-item 相当）', () => {
  // ★ プロキシは values のキーがキー属性名（no / ts）のものしか `#名前` / `:名前` に変換しない（pitfalls 13）。
  //   :startTime のような任意名を使うと本番で ValidationException になる。この形は変えない。
  it('両方指定で BETWEEN。値は ts の配列で渡し :ts1 / :ts2 に展開させる', () => {
    expect(buildSensorExpression({ no, startTime: 1, endTime: 2 })).toEqual({
      expression: '#no = :no AND #ts BETWEEN :ts1 AND :ts2',
      values: { no: 'dev-1', ts: [1, 2] },
    })
  })
  it('片方だけなら >= / <= で値名は ts、無指定なら no のみ', () => {
    expect(buildSensorExpression({ no, startTime: 1 })).toEqual({
      expression: '#no = :no AND #ts >= :ts',
      values: { no: 'dev-1', ts: 1 },
    })
    expect(buildSensorExpression({ no, endTime: 2 })).toEqual({
      expression: '#no = :no AND #ts <= :ts',
      values: { no: 'dev-1', ts: 2 },
    })
    expect(buildSensorExpression({ no })).toEqual({ expression: '#no = :no', values: { no: 'dev-1' } })
  })
  it('values に no / ts 以外のキーは使わない（プロキシが捨てるため）', () => {
    for (const q of [{ no }, { no, startTime: 1 }, { no, endTime: 2 }, { no, startTime: 1, endTime: 2 }]) {
      expect(Object.keys(buildSensorExpression(q)).length).toBe(2)
      expect(Object.keys(buildSensorExpression(q).values).every((k) => k === 'no' || k === 'ts')).toBe(true)
    }
  })
})

describe('toReading', () => {
  it('ts 省略時は now()、他の属性はそのまま残す', () => {
    const r = toReading({ no: ' dev-1 ', temperature: 1, label: 'x' }, () => 123)
    expect(r).toEqual({ no: 'dev-1', ts: 123, temperature: 1, label: 'x' })
  })
  it('no 不正は throw（ZodError）', () => {
    expect(() => toReading({ no: '' })).toThrow()
    expect(() => toReading({ no: 'a'.repeat(65) })).toThrow()
  })
})

describe('toQuery', () => {
  const cfg = readConfig()
  it('空文字は無視、limit 省略は既定値', () => {
    const q = toQuery({ no: 'dev-1', startTime: '', endTime: undefined }, cfg)
    expect(q).toEqual({ no: 'dev-1', limit: cfg.sensorQueryLimit, order: 'asc' })
  })
  it('limit は上限でクランプ', () => {
    expect(toQuery({ no: 'dev-1', limit: String(cfg.sensorQueryMaxLimit * 10) }, cfg).limit).toBe(cfg.sensorQueryMaxLimit)
  })
  it('startTime > endTime は throw', () => {
    expect(() => toQuery({ no: 'dev-1', startTime: '2', endTime: '1' }, cfg)).toThrow()
  })
})

describe('parseTimeInput（LLM 向け）', () => {
  it('数値・数字文字列はミリ秒、ISO 8601 は Date.parse、それ以外は undefined', () => {
    expect(parseTimeInput(1700000000000)).toBe(1700000000000)
    expect(parseTimeInput('1700000000000')).toBe(1700000000000)
    expect(parseTimeInput('2026-10-01T09:00:00+09:00')).toBe(Date.parse('2026-10-01T00:00:00Z'))
    expect(parseTimeInput('yesterday')).toBeUndefined()
    expect(parseTimeInput('')).toBeUndefined()
    expect(parseTimeInput(-1)).toBeUndefined()
  })
})

describe('summarizeReadings', () => {
  it('数値属性だけを集計し、no / ts / 非数値は除く', () => {
    const s = summarizeReadings([
      { no, ts: 1, temperature: 10, label: 'a', hum: '50' },
      { no, ts: 2, temperature: 20, label: 'b', hum: '70' },
    ])
    expect(Object.keys(s).sort()).toEqual(['hum', 'temperature'])
    expect(s['temperature']).toEqual({ count: 2, min: 10, max: 20, avg: 15, first: 10, last: 20 })
    expect(s['hum']).toEqual({ count: 2, min: 50, max: 70, avg: 60, first: 50, last: 70 })
  })
})
