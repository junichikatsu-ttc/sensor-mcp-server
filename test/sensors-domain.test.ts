import { describe, expect, it } from 'vitest'
import { readConfig } from '../src/config'
import { buildSensorExpression } from '../src/datastore'
import { sensorNoSchema } from '../src/schemas'
import { parseTimeInput, summarizeReadings, toQuery, toReading } from '../src/sensors'

/** データストアに触らない純関数のテスト */

const no = sensorNoSchema.parse('dev-1')

describe('buildSensorExpression（元フローの ds-easy-query-item 相当）', () => {
  it('両方指定で BETWEEN', () => {
    expect(buildSensorExpression({ no, startTime: 1, endTime: 2 })).toEqual({
      expression: '#no = :no AND #ts BETWEEN :startTime AND :endTime',
      values: { no: 'dev-1', startTime: 1, endTime: 2 },
    })
  })
  it('片方だけなら >= / <=、無指定なら no のみ', () => {
    expect(buildSensorExpression({ no, startTime: 1 }).expression).toBe('#no = :no AND #ts >= :startTime')
    expect(buildSensorExpression({ no, endTime: 2 }).expression).toBe('#no = :no AND #ts <= :endTime')
    expect(buildSensorExpression({ no }).expression).toBe('#no = :no')
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
