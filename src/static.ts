import type { Context } from 'hono'
import { AppError } from './errors'

/**
 * 静的ファイルの同一オリジン配信。
 * - ビルド時に esbuild の define で __STATIC_ASSETS__ に埋め込まれる（.js の text ローダは使わない）
 * - ローカルは setStaticAssetLoader でディスク読み込みを差し込む（node:fs はここに持ち込まない）
 * - 前段キャッシュが .css/.js を max-age=14400 に上書きするため、URL に版を付ける（pitfalls 1）
 */

export interface StaticAsset {
  contentType: string
  encoding: 'utf8' | 'base64'
  body: string
}

export const ASSET_VERSION_PLACEHOLDER = '__ASSET_VERSION__'

/**
 * ZIP に同梱する静的ファイル。1 つでも欠けたらビルドを失敗させる。
 * ★ 画面を増やしたら、ここと build.mjs の STATIC_ASSETS と routes/static-routes.ts の 3 箇所に足す。
 */
export const STATIC_ASSET_NAMES = ['index.html', 'styles.css', 'app.js'] as const

export const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

type Loader = (name: string) => StaticAsset | undefined
let loader: Loader | undefined

export function setStaticAssetLoader(fn: Loader | undefined): void {
  loader = fn
}

export function getAsset(name: string): StaticAsset | undefined {
  if (loader) return loader(name)
  return typeof __STATIC_ASSETS__ === 'undefined' ? undefined : __STATIC_ASSETS__[name]
}

export function buildInfo(): { version: string; commit: string; builtAt: string } {
  return typeof __BUILD_INFO__ === 'undefined' ? { version: '0.0.0-dev', commit: 'dev', builtAt: '' } : __BUILD_INFO__
}

// ローカルは起動時刻ベースにして毎回変える
const LOCAL_VERSION = Date.now().toString(36)

export function assetVersion(): string {
  const commit = buildInfo().commit
  if (commit && commit !== 'dev' && commit !== 'unknown') return commit.slice(0, 12)
  return `dev-${LOCAL_VERSION}`
}

export function applyAssetVersion(text: string): string {
  return text.split(ASSET_VERSION_PLACEHOLDER).join(assetVersion())
}

export function sendAsset(c: Context, name: string): Response {
  const asset = getAsset(name)
  // 白画面にせず 500 を JSON で返す。ビルド漏れがその場で分かる
  if (!asset) throw new AppError('INTERNAL', 500, 'ASSET_NOT_BUILT', { asset: name })
  const headers = { 'content-type': asset.contentType, 'cache-control': 'no-cache' }
  if (asset.encoding === 'base64') {
    return c.body(Uint8Array.from(Buffer.from(asset.body, 'base64')), 200, headers)
  }
  return c.body(applyAssetVersion(asset.body), 200, headers)
}
