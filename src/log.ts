/**
 * 最小の構造化ロガー。LOG_LEVEL（ERROR / WARN / INFO / DEBUG）で出し分ける。
 * DEBUG 以上では入力内容がログに出うるので、本番は INFO 以下にする。
 */
const LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 } as const
type Level = keyof typeof LEVELS

function currentLevel(): number {
  const raw = (process.env['LOG_LEVEL'] ?? 'INFO').toUpperCase() as Level
  return LEVELS[raw] ?? LEVELS.INFO
}

function emit(level: Level, msg: string, data?: Record<string, unknown>): void {
  if (LEVELS[level] > currentLevel()) return
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...data })
  if (level === 'ERROR') console.error(line)
  else if (level === 'WARN') console.warn(line)
  else console.log(line)
}

export const log = {
  error: (msg: string, data?: Record<string, unknown>) => emit('ERROR', msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => emit('WARN', msg, data),
  info: (msg: string, data?: Record<string, unknown>) => emit('INFO', msg, data),
  debug: (msg: string, data?: Record<string, unknown>) => emit('DEBUG', msg, data),
}
