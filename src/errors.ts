import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { ZodError } from 'zod'
import { DataStoreConfigError, DataStoreError } from './datastore'
import { log } from './log'

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFIG_MISSING'
  | 'DATASTORE'
  | 'INTERNAL'

export interface ErrorResponse {
  error: { code: ErrorCode; message: string; details?: unknown }
}

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly status: ContentfulStatusCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError('BAD_REQUEST', 400, message, details)
export const unauthorized = (message = 'Unauthorized') => new AppError('UNAUTHORIZED', 401, message)
export const forbidden = (message = 'Forbidden') => new AppError('FORBIDDEN', 403, message)
export const notFound = (what: string) => new AppError('NOT_FOUND', 404, `${what} not found`)

function body(code: ErrorCode, message: string, details?: unknown): ErrorResponse {
  const e: ErrorResponse['error'] = { code, message }
  if (details !== undefined) e.details = details
  return { error: e }
}

/**
 * すべてのエラーをここ 1 箇所で同じ形に揃える。
 * データストア SDK の生メッセージ（DataStoreError.reason）はログにだけ出し、
 * レスポンスには出さない（送信したアイテムの中身が含まれうる。pitfalls 10）。
 */
export function toErrorResponse(err: unknown, c: Context): Response {
  if (err instanceof AppError) {
    return c.json(body(err.code, err.message, err.details), err.status)
  }
  if (err instanceof ZodError) {
    return c.json(
      body(
        'VALIDATION',
        'Validation failed',
        err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      ),
      400,
    )
  }
  if (err instanceof SyntaxError) {
    return c.json(body('BAD_REQUEST', 'Malformed JSON body'), 400)
  }
  if (err instanceof DataStoreConfigError) {
    log.error('datastore table not configured', { table: err.tableName })
    return c.json(body('CONFIG_MISSING', 'Datastore table is not configured', { table: err.tableName }), 500)
  }
  if (err instanceof DataStoreError) {
    log.error('datastore error', {
      operation: err.operation,
      kind: err.kind,
      errorName: err.errorName,
      reason: err.reason,
    })
    return c.json(
      body('DATASTORE', 'Datastore operation failed', {
        operation: err.operation,
        kind: err.kind,
        ...(err.errorName ? { errorName: err.errorName } : {}),
      }),
      503,
    )
  }
  if (err instanceof HTTPException) {
    return c.json(body(err.status === 401 ? 'UNAUTHORIZED' : 'BAD_REQUEST', err.message), err.status)
  }
  log.error('unhandled error', {
    name: err instanceof Error ? err.name : typeof err,
    message: err instanceof Error ? err.message : String(err),
  })
  return c.json(body('INTERNAL', 'Internal error'), 500)
}
