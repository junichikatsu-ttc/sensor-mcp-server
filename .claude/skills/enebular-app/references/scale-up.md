# モノレポへ昇格する

雛形は単一 `package.json`。**手狭になってから**切り出す。先回りして切ると、
ビルドの通し確認が遅くなるぶんだけ損をする。

## 切り出す目安

- 画面が 3 つ以上あり、それぞれ独立したバンドルとビルド設定を持つ
- ドメインロジックがデータストアと無関係に育ち、単体でテストしたい塊になった
- 同じ型・スキーマを使う関数が 2 つ以上のデプロイ単位に分かれる

**どれにも当たっていないなら切らない。** ファイル数が増えただけなら `src/` の中でフォルダを分ければ足りる。

## 切り出した後の形

```
<repo>/
├── package.json            # pnpm workspace ルート（packageManager, engines.node >= 22）
├── pnpm-workspace.yaml     # packages: apps/*, packages/*  /  allowBuilds: esbuild: true
├── turbo.json
├── tsconfig.base.json      # 雛形の tsconfig.json の compilerOptions をそのまま移す
├── .env.example
├── .env.deploy.example
├── scripts/deploy.mjs      # 雛形の deploy.mjs（パスだけ直す）
│
├── apps/
│   ├── web/                # 雛形の web/ をそのまま
│   └── function/           # 雛形の src/ と build.mjs と zip-package.json
│
└── packages/
    ├── shared/             # 型と Zod スキーマ（雛形の src/schemas.ts）
    ├── core/               # ドメインロジック（純関数・外部依存なし）
    └── datastore/          # 雛形の src/datastore/
```

依存の向き — **`core` がどのパッケージにも依存しないことが重要。**
データストアも LLM もなしでテストできる:

```
apps/web       ──▶ packages/shared, core（マスキング等の共有純関数）
apps/function  ──▶ packages/shared, core, datastore
packages/core  ──▶ packages/shared のみ
```

## 手順

1. `pnpm-workspace.yaml` と `turbo.json` を足し、ルート `package.json` を workspace ルートにする
2. `tsconfig.json` の `compilerOptions` を `tsconfig.base.json` へ移し、各パッケージから `extends` する
3. ファイルを移動する。**中身は変えない。import のパスだけ直す**
   - `src/schemas.ts` → `packages/shared/src/index.ts`
   - `src/datastore/` → `packages/datastore/src/`
   - `src/` の残り → `apps/function/src/`
   - `web/` → `apps/web/`
4. **`apps/function/package.json` は `"type": "module"` のままでよい。**
   ZIP に入れる `package.json` は `zip-package.json` として別ファイルで持ち続ける
   （設定に引きずられて壊れないようにする。E3）
5. `build.mjs` と `deploy.mjs` の相対パスを直す
   （`webDir` / `functionDir` / `zipPath` / `root`）
6. **`npm test` → `pnpm build:zip` まで通してから次に進む。**
   ZIP のレイアウトが崩れていないかは `deploy.mjs` の `verifyZip` が見る

## 変えてはいけないもの

移動しても、次は**そのまま**残す。ここを作り直すと落とし穴が戻る。

- `app.ts` の 3 通りマウント
- `static.ts` の `?v=__ASSET_VERSION__` 置換と、それを固定するテスト
- `build.mjs` の処理順（web ビルド → `zip-package.json` 検証 → esbuild → `require` 検証 → ZIP → サイズ）
- データストアのエラー正規化（文字列 throw / Error throw）と `runGet`
- `config.ts` が throw しないこと
