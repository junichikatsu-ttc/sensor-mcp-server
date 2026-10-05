# __APP_TITLE__

enebular クラウド実行環境（ZIP / Node.js 22.x）で動くバックエンド API と、
**同じ ZIP から同一オリジンで配信されるフロントエンド**。

```
__APP_NAME__/
├── build.mjs          ZIP ビルド（web → 関数 → ZIP。処理順を変えない）
├── deploy.mjs         enebular CLI ラッパ（check / init / config / deploy / smoke）
├── zip-package.json   ZIP に同梱する package.json（"type": "module" を書かない）
├── src/               関数側（Hono）
│   ├── app.ts           3 通りマウント。ここは触らない
│   ├── static.ts        静的配信と ?v= 置換
│   ├── config.ts        環境変数の設定漏れ検出（throw しない）
│   ├── routes/          ルート定義
│   ├── middleware/
│   └── datastore/       enebular データストアのラッパとリポジトリ
├── web/               フロントエンド（フレームワークなし・esbuild のみ）
│   ├── src/             入力
│   └── public/          index.html / styles.css / app.js（app.js は生成物）
└── test/              enebular 固有の挙動を固定するテスト
```

## ローカル開発

```bash
npm install
cp .env.example .env

npm run dev:web    # 別ターミナル。web の監視ビルド
npm run dev        # http://localhost:8787
```

データストアは**ローカルで代替できない**（接続情報を実行環境が注入するため）。
`DATASTORE_MODE=memory` のときはインメモリ実装に切り替わる。永続化はされない。
通しの確認は `test/items.test.ts`（fake に差し替えた統合テスト）で行う。

```bash
npm run typecheck && npm test
npm run build       # __APP_NAME__-function.zip ができる
```

## enebular へのデプロイ

初回だけコンソールでの作業がある。

1. コンソールでプロジェクトを作る → `ENEBULAR_PROJECT_ID`
2. コンソールでデータストアのテーブルを作る（キー名と型は `src/datastore/tables.ts` と一致させる）→ テーブル ID
3. `cp .env.deploy.example .env.deploy` して 1・2 の値とアクセスキーを入れる
4. `npm run enebular:init` — ZIP を作ってファイルアセットを登録し、`ENEBULAR_FILE_ASSET_ID` を書き戻す
5. コンソールでクラウド実行環境を作る（そのアセット / ランタイム Node.js 22.x）→ `ENEBULAR_CLOUD_ID`
6. `npm run enebular:config` — HTTP トリガー・タイムアウト・`connectDataStore`・環境変数を一括設定
7. トリガー URL を `ENEBULAR_HTTP_TRIGGER_URL` に入れる

以降は `npm run enebular:deploy` だけ。ビルド → 差し替え → デプロイ → バージョン記録 →
スモークテスト（`/v1/health` の `commit` が今回のビルドと一致するか）まで通す。

```bash
npm run enebular:check              # 設定の確認（値はマスク表示）
npm run enebular:deploy --dry-run   # enebular を呼ばずに手順だけ確認
npm run enebular:smoke              # デプロイ済みの環境を確認
```

> `.env.deploy` には API キーが入るのでコミットしない。
> `FN_*` は関数の環境変数になる（`FN_` を外して送られる）。**送った内容で置き換わる**ので、
> `FN_*` を消すと実行環境からもそのキーが消える。

## 増やすときの手順

| やること | 触るファイル |
| :--- | :--- |
| API を足す | `src/routes/` に 1 本足し、`src/routes/index.ts` でマウント |
| 画面を足す | `web/public/*.html` / `web/build.mjs` の entries / `src/static.ts` の `STATIC_ASSET_NAMES` / `build.mjs` の `STATIC_ASSETS` / `src/routes/static-routes.ts` |
| テーブルを足す | `src/datastore/tables.ts` / `.env.example` / `.env.deploy.example` / `deploy.mjs` の `REQUIRED_FN`。リポジトリは `items-repo.ts` を写す |
| 環境変数を足す | `src/config.ts`（モードに応じた必須はコードで持つ） / `.env.example` / `.env.deploy.example` |

設計の理由と落とし穴は `enebular-app` スキルの `references/` にある。
`test/app.test.ts` は enebular 固有の挙動を固定しているので消さない。
