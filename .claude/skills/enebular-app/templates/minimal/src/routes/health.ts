import type { Context } from 'hono'
import { basicAuthEnabled, effectiveLimits, missingConfigKeys, readConfig } from '../config'
import { dataStoreKind } from '../datastore'
import type { Health } from '../schemas'
import { buildInfo } from '../static'

/**
 * 認証不要の唯一のエンドポイント。運用の目はここに集約する。
 *   - commit: デプロイしたコミットが実際に動いているかを機械的に確認する（deploy.mjs が照合する）
 *   - mockMode: 本番で true のまま公開していないかの目視確認
 *   - configMissing: 件数だけ。キー名は出さない（認証不要のため。起動時ログにのみ出る）
 */
export function healthHandler(c: Context): Response {
  const missing = missingConfigKeys()
  const info = buildInfo()
  const body: Health = {
    status: 'ok',
    version: info.version,
    commit: info.commit,
    builtAt: info.builtAt,
    mockMode: readConfig().mockMode,
    basicAuth: basicAuthEnabled(),
    datastore: dataStoreKind(),
    configOk: missing.length === 0,
    configMissing: missing.length,
    limits: effectiveLimits(),
  }
  return c.json(body)
}
