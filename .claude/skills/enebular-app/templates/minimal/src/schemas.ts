import { z } from 'zod'

/**
 * API 契約。サーバの入力検証に使い、フロントの JSDoc からも参照できるよう 1 箇所にまとめる。
 * フロントを TypeScript にする場合は、ここを import して型を共有する。
 */

/** 所有者 ID。メインキーの先頭に入る（constraints.md キー設計の原則） */
export const ownerIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{4,64}$/, 'ownerId は英数字・_・- の 4〜64 文字')
  .brand<'OwnerId'>()
export type OwnerId = z.infer<typeof ownerIdSchema>

export const createItemSchema = z.object({
  text: z.string().trim().min(1, '空にできません').max(500),
})
export type CreateItemInput = z.infer<typeof createItemSchema>

export const itemSchema = z.object({
  ownerId: z.string(),
  createdAt: z.number(),
  text: z.string(),
})
export type Item = z.infer<typeof itemSchema>

export interface Health {
  status: 'ok'
  version: string
  commit: string
  builtAt: string
  mockMode: boolean
  basicAuth: boolean
  datastore: 'cloud' | 'memory'
  configOk: boolean
  configMissing: number
  limits: Record<string, number>
}
