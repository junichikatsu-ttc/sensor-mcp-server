# 実測で踏んだ落とし穴

いずれも「エラーが出ない」「原因の表示が無い」形で壊れるもの。実装前に読み、症状が出たらここへ戻る。

---

## 1. 前段キャッシュ — `no-cache` は CSS と JS に効かない（最大のハマりどころ）

実行環境の前段（Cloudflare）が**拡張子で判断してヘッダを上書きする**。実測:

| パス | 返る `Cache-Control` |
| :--- | :--- |
| `/`（HTML） | `no-cache`（こちらの指定が残る） |
| `/styles.css` | **`max-age=14400`**（上書きされる） |
| `/app.js` | **`max-age=14400`**（上書きされる） |

結果、**サーバは新しいファイルを返しているのに、ブラウザは 4 時間前の CSS と JS を使い続ける。**
症状は「デプロイしたのに画面が変わらない」。**デプロイ失敗より気づきにくい。**

ヘッダを通せない以上、**URL を変えるしかない**。`index.html` は素通しで届くので、そこに版を差し込む。

```html
<link rel="stylesheet" href="styles.css?v=__ASSET_VERSION__" />
<script src="app.js?v=__ASSET_VERSION__"></script>
```

- `__ASSET_VERSION__` は**配信時に**コミットハッシュ（先頭 12 桁）へ置換する
- ローカルは起動時刻ベースの値にして毎回変える
- `app.js` の中で組み立てる `<img>` などにも同じ置換を効かせる
- **この仕組みはテストで固定する**（`?v=` を外すと問題がそのまま戻る）

参照実装: [`templates/minimal/src/static.ts`](../templates/minimal/src/static.ts) の `assetVersion()` / `applyAssetVersion()`。
固定しているテストは [`templates/minimal/test/app.test.ts`](../templates/minimal/test/app.test.ts)。

## 2. HTTP トリガーはトリガーのパスを含めてハンドラを呼ぶ

トリガーが `/myapp` なら、Hono が受け取るのは `/myapp/v1/health` であって `/v1/health` ではない。

同じルート定義を **3 通りにマウント**して吸収する。

```ts
app.route('/',       createRoutes())  // /v1/health        ローカル・テスト
app.route('/:base',  createRoutes())  // /myapp/v1/health  トリガー経由
app.route('/:base/', createRoutes())  // /myapp/           トリガーのルート URL
```

> **トリガーのパスを環境変数で持たないこと。** `HTTP_TRIGGER_PATH` のような設定を置くと、実設定と
> ずれた瞬間に**全リクエストが 404** になり、「関数は動いているのに何も応答しない」という最も
> 切り分けにくい壊れ方をする。`:base` で受ければ設定自体が存在しなくなる。

404 では**受け取ったパスとメソッドを返す**。イベント形式の想定違いをログ無しで切り分けられる。

```ts
app.notFound((c) => c.json({
  error: { code: 'NOT_FOUND', message: 'Not Found', path: c.req.path, method: c.req.method },
}, 404))
```

## 3. トリガーのルート URL は末尾スラッシュへリダイレクトする

```ts
routes.get('/', (c) => {
  const path = c.req.path
  if (!path.endsWith('/')) return c.redirect(`${path}/`, 302)   // /myapp → /myapp/
  return sendAsset(c, 'index.html')
})
```

`/myapp` のままだと HTML の `href="styles.css"` が `/styles.css`（トリガーの外）に解決され、
**CSS も JS も 404 になる。**

## 4. 静的ファイルの埋め込みに `.js` の text ローダを使わない

ビルド時に **esbuild の `define` で文字列として埋め込む**。
`loader: { '.js': 'text' }` は使わない — `app.js` のために `.js` を text ローダにすると、
**バンドル対象の依存パッケージまで文字列になる。**

- テキストは utf8、画像などバイナリは **base64 文字列**で埋め込み、配信直前にバイトへ戻す
  （`define` は JSON なので文字列しか持てない。`hono/aws-lambda` は content-type がバイナリなら
  `isBase64Encoded` で返す）
- ローカル起動時は `local.ts` から**ディスク読み込み関数を差し込む**（`setStaticAssetLoader`）。
  リクエストごとに読み直すので、HTML/CSS を編集したらリロードだけで反映される。
  **`node:fs` を `index.ts` 側に持ち込まない**（Lambda のバンドルに入れない）
- 静的ファイルが 1 つでも欠けたら**ビルドを失敗させる**。画面が白いままデプロイされる方が損失が大きい
- 配信時に見つからない場合は白画面ではなく `500 ASSET_NOT_BUILT` を JSON で返す

## 5. データストア SDK の失敗の伝え方は 2 通りある

**両方を 1 箇所で揃えること。** 各リポジトリで try/catch を書くと必ず抜ける。

| 投げられ方 | 意味 | 分類 |
| :--- | :--- | :--- |
| **文字列を throw** | データストア操作がエラーを返した（テーブル不在・キー不正・Not found） | `failed` |
| `Error` を throw | プロキシ Lambda に到達できない（接続不可・`connectDataStore` 無効） | `threw` |

> SDK は `throw result.error` で**文字列のまま**投げる。`cause.message` だけを見ていると
> 原因の記述をまるごと捨てることになる。本番の 503 が切り分けられなかった原因がこれ。

## 6. `getItem` の "Not found" は正常系

**`getItem` はアイテムが無いとき `"Not found"` エラーを返す。** 「無い」は多くの場合正常系
（初回サインアップ、未生成のレポート）なので、`getItem` 専用の `runGet` を用意して `undefined` に落とす。
**これを 503 にするとサインアップが原理的に成立しない。**

ただし `putItem` / `query` / `deleteItem` の "not found" は設定ミスの可能性があるので**吸収しない**。

```ts
export async function runOp<T>(operation: DataStoreOperation, fn: () => Promise<T>): Promise<T> {
  try { return await fn() } catch (err) { throw classifyDataStoreError(operation, err) }
}

export async function runGet<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try { return await fn() } catch (err) {
    if (isNotFoundError(err)) return undefined
    throw classifyDataStoreError('getItem', err)
  }
}
```

参照実装: [`templates/minimal/src/datastore/run.ts`](../templates/minimal/src/datastore/run.ts) / [`errors.ts`](../templates/minimal/src/datastore/errors.ts)。

## 7. データストアのクライアント生成は初回アクセスまで遅らせる

```ts
export function getDataStoreClient(): DataStoreClient {
  if (injected) return injected           // テスト用の差し替え
  if (cached) return cached
  // 生成は初回アクセス時まで遅らせる。コンストラクタは実行環境が注入する
  // ENEBULAR_DS_JWT / ENEBULAR_DS_PROXY_ARN が無いと throw するため、
  // モジュール読み込み時に作ると /v1/health すら返らなくなる
  cached = new CloudDataStoreClient() as DataStoreClient
  return cached
}
```

`CloudDataStoreClient` を直接持ち回らず、**使う操作だけのインターフェース**
（`getItem` / `putItem` / `query` / `deleteItem`）に絞ってテストから差し替え可能にする。

## 8. 設定不足で起動を止めない

設定 1 個の欠けで全リクエストが 500 になると `/v1/health` すら返らず、
「関数は動いているのに何も応答しない」という最も切り分けにくい状態になる。
`configOk: false` を返せる状態で立ち上がる方が診断できる。**`config.ts` で throw しない。**

## 9. ビルド成果物の検証で文字列 grep をしない

`build/index.js` を `require()` して `typeof m.handler === 'function'` を確認する。
esbuild の CJS 出力に **`"exports.handler"` という字面は現れない**（`__toCommonJS` 経由で
`module.exports` を組み立てるため）。grep は必ず失敗する。

## 10. 秘匿情報の露出

- エラーの詳細（`operation` / `kind` / `errorName`）はレスポンスに出してよいが、
  **SDK の生メッセージは絶対にどこにも出さない**（送信したアイテムの中身が含まれうる）
- `/v1/health` に**不足キー名を出さない**（認証不要のため）。件数だけ
- `LOG_LEVEL` が `DEBUG` 以上だと入力内容がログに出うる

## 11. フロントに `innerHTML` を使わない

React のような自動エスケープが無い。ユーザー入力や外部由来の文字列は必ず `textContent` で入れる。
**フロントのソース（`web/src/**`、モノレポなら `apps/web/src/**`）に対して eslint で `innerHTML` を
禁止する**（`no-restricted-properties` など）。雛形は `dom.js` の `el()` / `textContent` で書く前提。

## 12. データストアの連続書き込みはスロットリングされる

**間隔を空けずに `putItem` を並べると、途中で失敗する。** 実測では 370 件の投入で
**約 280 件目で失敗**した（1件あたり間隔なし＝およそ 30 件/秒）。
**間隔 100ms（10 件/秒）でも約 198 件目で失敗した。** 単発の速さではなく、
一定時間内の累計で効いてくる。

失敗は文字列 throw で届くため分類は `failed` になり、**テーブル不在・キー不正と区別が付かない。**
理由の文字列を捨てていると切り分け不能になる（落とし穴 5 と同じ根）。

**対処:**

- **既定の間隔を 0 にしない。** 運用者が毎回オプションを思い出す前提にすると忘れる
- 詰まったら**間隔を置いて数回だけ再試行**し、以降は**間隔を自動で広げる**。
  同じ速さで続けても再び詰まる
- **再試行回数は絞る**（3回程度）。再試行もアクセス数（E4）を消費する。
  設定の誤りなら何度やっても失敗するので、回数の上限が区別の代わりになる
- 投入は**範囲指定（offset / count）で少しずつ**。1リクエストで全件書く形にしない。
  タイムアウトに当たるうえ、やり直しのたびに件数ぶんアクセス数を消費する
- **1件目から失敗したら例外を上へ返す。** 0 件のまま 200 を返すと気づけない。
  ただし**再開の呼び出し（offset > 0）では例外にしない。** 前回まで入っているなら
  設定は正しく、スロットリングが続いているだけである。ここを区別しないと、
  呼び出し側が「設定ミス」と受け取って諦める
- **諦める前に間隔を広げて返す。** 「再試行3回・間隔100ms」のまま返すと、
  呼び出し側が同じ速さで再開してまた詰まる
- 呼び出し側（スクリプト）は**冷却してから緩めて続ける**。詰まった直後に再開すると即失敗する。
  実測に基づく待ち時間は 5 → 15 → 30 → 60 秒

**切り分けは 1 件だけ投入するのが早い。** 1 件でも失敗するなら設定の誤りで、
件数を減らしても直らない。1 件は通るのに途中で止まるなら速度側である。

> 初期データの投入は「1回やれば終わり」の作業に見えるが、**取り込む範囲を変えるたびに
> やり直す。** 上限のある資源を消費するので、最初から少しずつ入れる形にしておく。

## 13. `query` の `values` はメインキー名 / サブキー名しか効かない

**`values` のキーがテーブルのメインキー名かサブキー名と一致するものだけが `#名前` / `:名前` に変換される。
それ以外のキーは名前も値も黙って捨てられる。** `#ts BETWEEN :startTime AND :endTime` のような
任意の値名を使うと、`#ts` が未定義のまま DynamoDB に渡り、
`ValidationException: Invalid KeyConditionExpression: An expression attribute name used in the document path
is not defined; attribute name: #ts` で失敗する（503 `DATASTORE` / `kind: failed`。本番で実際に起きた）。

メインキーだけの式（`#no = :no`）は通るので、**範囲条件を付けた瞬間に初めて壊れる。** テストのインメモリ実装が
任意名を受け付けていると、本番まで気づけない。

**書き方（公式ノード ds-easy-query-item と同じ）:**

| 条件 | expression | values |
| :--- | :--- | :--- |
| 等価 / 比較 | `#no = :no AND #ts >= :ts` | `{ no, ts: 境界値 }` |
| BETWEEN | `#no = :no AND #ts BETWEEN :ts1 AND :ts2` | `{ no, ts: [start, end] }`（配列が `:ts1`, `:ts2` に展開される） |
| IN | `#ts IN (:ts1, :ts2)` | `{ no, ts: [a, b] }` |

- サブキーの値はテーブル定義が数値型なら `Number()` に変換される
- インメモリ実装も同じ規則にして、任意名を throw させる（雛形の `memory.ts`）

出典: `enebular-aws-sam-templates` の `features/datastore/ds-common/index.ts`（`convertUserConditionToSysCondition`）、
`enebular-official-nodes` の `enebular-privatenode-contrib-ee-connect/v2/src/common/ProxyClient.ts`（`easyQueryRequest`）。

## 14. `query` の `order` は SDK 1.0.1 で `true` = 昇順

constraints.md の古い記述（`true` = 降順）は誤り。**`@uhuru/enebular-sdk` 1.0.1 では `true` = 昇順 / `false` = 降順**。
SDK の `ProxyClient` が `Order: !order` に反転してプロキシへ渡し、プロキシが `ScanIndexForward: !Order` にするため。
JSDoc（false = ascending）と README（true = 昇順）が食い違っていて、JSDoc の方が間違っている。

症状は「`order=asc` で新しい順が返る」「最新 1 件を取ったつもりが最古の 1 件」。
**写像は 1 箇所（`query.ts` の `toSdkOrder`）に閉じ込め、本番の `/v1/sensors?order=asc` と `desc` で向きを実測して固定する。**
