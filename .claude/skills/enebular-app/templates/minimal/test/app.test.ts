import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { STATIC_ASSET_NAMES, setStaticAssetLoader } from '../src/static'

/**
 * enebular 固有の挙動を固定するテスト。ここを外すと落とし穴がそのまま戻る。
 * 機能を足してもこのファイルは残す。
 */

const app = createApp()

afterEach(() => {
  setStaticAssetLoader(undefined)
})

describe('3 通りマウント（pitfalls 2）', () => {
  // HTTP トリガーはトリガーのパスを含めてハンドラを呼ぶ。
  // どちらか一方しか通らない状態になると、本番だけ全リクエスト 404 になる。
  it('ルート直下でもトリガーのパス配下でも /v1/health が 200', async () => {
    for (const path of ['/v1/health', '/myapp/v1/health', '/anything/v1/health']) {
      const res = await app.request(path)
      expect(res.status, path).toBe(200)
      const body = (await res.json()) as { status: string }
      expect(body.status).toBe('ok')
    }
  })

  it('404 は受け取ったパスとメソッドを返す', async () => {
    const res = await app.request('/myapp/v1/nope', { method: 'POST' })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { path: string; method: string } }
    expect(body.error.path).toBe('/myapp/v1/nope')
    expect(body.error.method).toBe('POST')
  })
})

describe('静的配信（pitfalls 1 / 3）', () => {
  it('トリガーのルート URL は末尾スラッシュへリダイレクトする', async () => {
    // これが無いと href="styles.css" が /styles.css（トリガーの外）に解決され CSS も JS も 404 になる
    const res = await app.request('/myapp')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/myapp/')
  })

  it('?v=__ASSET_VERSION__ が実際の版に置換される', async () => {
    // 外すと前段キャッシュ（max-age=14400）で「デプロイしたのに画面が変わらない」が戻る
    setStaticAssetLoader((name) =>
      name === 'index.html'
        ? {
            contentType: 'text/html; charset=utf-8',
            encoding: 'utf8',
            body: '<script src="app.js?v=__ASSET_VERSION__"></script>',
          }
        : undefined,
    )
    const res = await app.request('/myapp/')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).not.toContain('__ASSET_VERSION__')
    expect(html).toMatch(/app\.js\?v=[\w-]+/)
  })

  it('ビルドされていない静的ファイルは白画面ではなく 500 を返す', async () => {
    const res = await app.request('/myapp/app.js')
    expect(res.status).toBe(500)
  })
})

describe('静的ファイル一覧', () => {
  it('index.html / styles.css / app.js が登録されている', () => {
    // src/static.ts・build.mjs・routes/static-routes.ts の 3 箇所がそろっているかの目印
    expect([...STATIC_ASSET_NAMES]).toEqual(expect.arrayContaining(['index.html', 'styles.css', 'app.js']))
  })
})
