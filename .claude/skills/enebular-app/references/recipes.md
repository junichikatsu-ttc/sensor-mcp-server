# 雛形に機能を足すレシピ

`templates/minimal` を出したあと、よくある追加作業の手順。
どれも「どのファイルを触るか」を先に決めてから書く。**触り忘れが 404 や白画面になる箇所**に ★ を付けた。

---

## API を 1 本足す

1. `src/schemas.ts` に Zod スキーマを足す（= API 契約。フロントの JSDoc からも参照する）
2. `src/routes/<name>.ts` を作る。`src/routes/items.ts` を写すのが早い
3. ★ `src/routes/index.ts` で `routes.route('/v1/<name>', <name>Routes())` とマウントする

**入力は必ず Zod で `parse` してからリポジトリに渡す。** `toErrorResponse` が `ZodError` を
400 `VALIDATION` に変換するので、ルート側で try/catch を書かない。

## 画面を 1 枚足す

HTML は**同じ階層**（`/admin.html` のように）に置く。ディレクトリを切ると相対パスの CSS / JS が
トリガーのパスの外に出る。

触るのは 5 箇所。**ここが 1 つでも欠けると本番で白画面か 404 になる。**

| ファイル | 何を足すか |
| :--- | :--- |
| `web/public/admin.html` | `?v=__ASSET_VERSION__` 付きで `admin.css` / `admin.js` を参照する |
| `web/src/admin/main.js` | 画面の配線 |
| ★ `web/build.mjs` | `entries` にエントリポイントと出力先を足す |
| ★ `src/static.ts` | `STATIC_ASSET_NAMES` に `admin.html` / `admin.css` / `admin.js` を足す |
| ★ `build.mjs` | `STATIC_ASSETS` に同じ名前を足す（`static.ts` と一致させる） |
| ★ `src/routes/static-routes.ts` | `r.get('/admin.html', …)` と CSS / JS のルートを足す |

拡張子なしの URL も受けたいなら、リダイレクトを足す:

```ts
r.get('/admin', (c) => c.redirect(`${c.req.path}.html`, 302))
```

## データストアのテーブルを足す

1. **アクセスパターンを先に書き出す**（「誰が」「何を」「どの順で」引くか）。
   [constraints.md のキー設計の原則](constraints.md#キー設計の原則)に戻る
2. `src/datastore/tables.ts` に 1 行足す。`mainKey` の先頭に所有者・テナントを入れる。
   時系列の `subKey` は必ず `number`
3. ★ `.env.example` と `.env.deploy.example`（`FN_` 付き）に同じ env 名を足す
4. ★ `deploy.mjs` の `REQUIRED_FN` に足す
5. `src/datastore/<name>-repo.ts` を `items-repo.ts` を写して作り、`index.ts` から export する
6. enebular コンソールでテーブルを作る。**キー属性名と型は `tables.ts` と完全に一致させる**

`query` は `limit` を必ず明示する（SDK の既定は 10 件）。集計が要るなら**書き込み時に事前計算**する。

## 認証を足す

デモ公開に URL を知られない程度のガードが欲しいだけなら、雛形の BASIC 認証で足りる
（`FN_BASIC_AUTH_USER` / `FN_BASIC_AUTH_PASSWORD` を設定するだけで有効になる）。

本物のセッション認証が要る場合:

1. `src/lib/token.ts` — HMAC-SHA256 でユーザー ID と有効期限を署名する。鍵は `SESSION_SECRET`
2. `src/middleware/auth.ts` — `authorization: Bearer <token>` を検証し、`c.set('userId', …)` する
3. ★ **認証はルートファイル側に書かず、`src/routes/index.ts` で 1 箇所にまとめて適用する**

```ts
import { except } from 'hono/combine'

// c.req.path はトリガーのパスを含むので endsWith で判定する
const PUBLIC = ['/v1/auth/login', '/v1/auth/signup']
const isPublic = (c: { req: { path: string } }) => PUBLIC.some((p) => c.req.path.endsWith(p))

routes.use('/v1/*', except(isPublic, requireAuth()))
```

各ルートに書く方式はルート追加時に**書き忘れる**。忘れられる防御は防御ではない。
`SESSION_SECRET` は `src/config.ts` の `missingConfigKeys()` に足す（設定漏れが `/v1/health` に出る）。

## 時間のかかる処理を入れる

**SSE もストリーミングも使えない**（E1）。バックグラウンド実行の手段も無い。
**別リクエストとして撃たせる**しかない。

```ts
// 起動側: すぐ返す
return c.json({ status: 'accepted', retryAfterMs: 2000 }, 202)
```

フロントの `web/src/api.js` は `202` を**エラーではなく待機**として扱い、`retryAfterMs` で
自動的に再送する。呼ぶ側のコードは変えなくてよい。

処理そのものは、状態をデータストアに置いて**リクエストごとに少しずつ進める**形にする。
1 リクエストで全部やろうとすると `timeout`（`ENEBULAR_TIMEOUT`、既定 30 秒）に当たる。

## LLM / 外部 API を呼ぶ

1. **`MOCK_MODE` を先に実装する。** 分岐は各関数の**入口 1 箇所**に置く。
   後から入れると差し込み箇所が散って高くつく
2. API キーは `src/config.ts` 経由で読み、`missingConfigKeys()` に**モードに応じた必須**として足す

```ts
if (!cfg.mockMode && !env('LLM_API_KEY')) missing.push('LLM_API_KEY')
```

3. ★ **キーは `.env.deploy` に `FN_LLM_API_KEY` として書き、リポジトリにコミットしない。**
   CI を使う場合、CI が知るシークレットは enebular のアクセスキーだけにする
4. レスポンスにも `/v1/health` にも**キー名すら出さない**。エラーは `toErrorResponse` で
   1 つの形に揃え、外部 API の生メッセージはログにだけ出す
5. `ENEBULAR_TIMEOUT` を想定レイテンシより長くする

## 初期データを投入する

**1 回やれば終わりの作業に見えて、取り込む範囲を変えるたびにやり直す。**
データストアの連続書き込みはスロットリングされる（[pitfalls 12](pitfalls.md#12-データストアの連続書き込みはスロットリングされる)）。

- 投入は**範囲指定（offset / count）で少しずつ**。1 リクエストで全件書く形にしない
- **既定の書き込み間隔を 0 にしない**
- **1 件目から失敗したら例外を上へ返す**（設定ミス）。**再開（offset > 0）では例外にしない**
  （スロットリングが続いているだけ）
- 切り分けは**1 件だけ投入するのが早い**。1 件でも失敗するなら設定の誤り

## テストを足す

`test/app.test.ts` は enebular 固有の挙動を固定している。**機能を足しても消さない。**

新しい導線は `test/items.test.ts` を写して書く。データストアだけを `MemoryDataStoreClient` に
差し替え、それ以外は本物を通す。`store.calls` で操作回数を見れば E4（アクセス数上限）の見積りになる。
