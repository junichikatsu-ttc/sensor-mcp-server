import { Hono } from 'hono'
import { readConfig } from '../config'
import { deleteItem, getItem, listItems, putItem } from '../datastore'
import { badRequest, notFound } from '../errors'
import { createItemSchema, ownerIdSchema } from '../schemas'
import type { Item, OwnerId } from '../schemas'

/**
 * サンプルの CRUD。作るアプリに合わせて書き換える／消す前提のお手本。
 *
 * ここで見せていること:
 *   - 入力は必ず Zod で検証してからリポジトリに渡す（ブランド型 OwnerId は parse でしか作れない）
 *   - 所有者はメインキーに入るので、アプリ層で他人のデータを弾くコードが要らない
 *   - 一覧の件数は設定から取る（/v1/health の limits に出る値と同じものを使う）
 *
 * 所有者の決め方は用途で差し替える。ここではデモとしてヘッダから取っている。
 * 本物の認証が要るなら references/recipes.md の「セッション認証」に置き換える。
 */
function ownerOf(c: { req: { header: (n: string) => string | undefined } }): OwnerId {
  const raw = c.req.header('x-owner-id')
  const parsed = ownerIdSchema.safeParse(raw)
  if (!parsed.success) throw badRequest('x-owner-id ヘッダが必要です')
  return parsed.data
}

export function itemRoutes(): Hono {
  const r = new Hono()

  r.get('/', async (c) => {
    const items = await listItems(ownerOf(c), readConfig().itemListLimit)
    return c.json({ items })
  })

  r.post('/', async (c) => {
    const input = createItemSchema.parse(await c.req.json())
    const item: Item = { ownerId: ownerOf(c), createdAt: Date.now(), text: input.text }
    await putItem(item)
    return c.json({ item }, 201)
  })

  r.delete('/:createdAt', async (c) => {
    const createdAt = Number(c.req.param('createdAt'))
    if (!Number.isFinite(createdAt)) throw badRequest('createdAt は数値')
    const owner = ownerOf(c)
    if (!(await getItem(owner, createdAt))) throw notFound('item')
    await deleteItem(owner, createdAt)
    return c.body(null, 204)
  })

  return r
}
