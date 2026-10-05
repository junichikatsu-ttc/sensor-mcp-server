---
name: enebular-app
description: enebular のクラウド実行環境（ZIP / Node.js 22.x / Lambda ベース）で Web アプリを作るときに使う。バックエンド API とフロントエンドを同一オリジンで 1 つの ZIP に載せる雛形と、実測で踏んだ落とし穴が入っている。新規に enebular アプリを立ち上げる、既存の enebular ZIP 関数を直す、enebular データストアのキー設計をする、enebular へデプロイする（CLI / GitHub Actions）といった作業のすべてで読むこと。「デプロイしたのに画面が変わらない」「関数は動いているのに 404」「データストアが 503」などの症状の切り分けにも使う。
---

# enebular に Web アプリを載せる

enebular クラウド実行環境（ZIP）で動くバックエンド API と、**同じ ZIP から同一オリジンで配信される
フロントエンド**を作るための手順書と雛形。

ここに書かれているのは推測ではなく、本番デプロイまで到達した構成の**確定仕様**として扱う。
[`templates/minimal/`](templates/minimal/) は typecheck・テスト・ZIP ビルド・ローカル疎通を通した動く雛形。

## 0. まず雛形を出す

新規なら、設計の相談より先にこれを実行する。**動く状態から始めた方が速いし、外しどころが減る。**

```bash
node .claude/skills/enebular-app/scripts/init.mjs ./myapp --name myapp --title "My App"
cd myapp && npm install && cp .env.example .env
npm run dev:web    # 別ターミナル
npm run dev        # http://localhost:8787
```

雛形に最初から入っているもの — **どれも後から入れると高くつくものばかり**:

| | |
| :--- | :--- |
| 3 通りマウント | トリガーのパスを含むリクエストを吸収する（落とし穴 2） |
| `?v=__ASSET_VERSION__` | 前段キャッシュ対策。テストで固定済み（落とし穴 1） |
| `/v1/health` | `commit` / `configOk` / `mockMode` / `limits` |
| データストアのラッパ | 文字列 throw と Error throw の正規化、`getItem` の "Not found" 吸収 |
| インメモリ実装 | ローカル起動と統合テストで実物の代わりに使う |
| `build.mjs` | web → 関数 → ZIP。`require` して handler を検証してから固める |
| `deploy.mjs` | `check` / `init` / `config` / `deploy` / `smoke`。デプロイ後に commit を照合する |
| テスト 10 本 | enebular 固有の挙動（上の 1・2・6）を固定する |

雛形を出したら、**サンプルの `items`（メモ一覧）を作るものに置き換えていく。**
どこを触るかは生成された `README.md` の「増やすときの手順」と
[references/recipes.md](references/recipes.md) にある。

既存アプリの修正なら 0 は飛ばし、[§4 外してはいけない 5 点](#4-特に外してはいけない-5-点)と
[references/pitfalls.md](references/pitfalls.md) から入る。

### 最初にユーザーに聞くこと

雛形を出したうえで、次だけ確認する。それ以外はこの手順書どおりに進めてよい。

1. アプリ名（`--name`。ZIP 名と HTTP トリガーのパスの既定値になる）
2. 必要なデータストアのテーブルとアクセスパターン（[キー設計の原則](references/constraints.md#キー設計の原則)を踏まえて一緒に設計する）
3. 認証が要るか（デモ公開だけなら雛形の BASIC 認証で足りる）
4. 外部サービス（LLM など）を使うか。使うなら経由するゲートウェイとモデルの出し分け

## 1. 動かせない前提

| # | 制約 | 帰結 |
| :--- | :--- | :--- |
| E1 | ハンドラは `{ statusCode, headers, body }` を return し、レスポンスはバッファされる | **SSE / ストリーミングは原理的に使えない** |
| E2 | データストアはメインキー + サブキーの JSON アイテムストア。JOIN・二次インデックス・集計なし | アクセスパターン起点のキー設計。集計は書き込み時に事前計算 |
| E3 | ZIP はルート直下に `index.js` と `package.json`。`"type": "module"` 不可（**CommonJS 必須**）。250MB 以下 | esbuild で単一 CJS にバンドル |
| E4 | データストアのアクセス数に月次上限（フリー 10,000 / エンタープライズ 3,000,000）。1 アイテム約 350KB | **1 論理単位 = 少数アイテム**に集約 |

詳細と出典は [references/constraints.md](references/constraints.md)。

## 2. 採る構成（この通りにする）

| レイヤ | 採用 |
| :--- | :--- |
| バックエンド | TypeScript + **Hono**（`hono/aws-lambda`） |
| バンドル | **esbuild**（`--bundle --platform=node --target=node22 --format=cjs`） |
| フロントエンド | **フレームワークなし。HTML + CSS + 素の JavaScript + esbuild のみ** |
| 配信 | **バックエンドの関数が静的ファイルを返す（同一オリジン）** |
| データストア | enebular データストア（`@uhuru/enebular-sdk`） |
| バリデーション | Zod（サーバ側の入力検証。FE と契約を共有） |
| パッケージ | **単一 package.json**（画面数が増えたらモノレポへ昇格） |
| テスト | Vitest |
| デプロイ | `deploy.mjs`（enebular CLI）。必要なら GitHub Actions |

**フロントエンドを別ホスティング（Vercel / Pages 等）に置かないこと。** ZIP に同梱し、関数が
`/`・`/app.js`・`/styles.css` を返す。CORS・Cookie の SameSite・デプロイ 2 系統・API ベース URL の
環境変数がまとめて消える。構成上いちばん効く判断。

フロントにフレームワークを入れるのは、画面数と状態遷移がフレームワークの解く問題に達したときだけ。
入れる場合はユーザーに理由を説明して合意を取る。**関数側・ビルド・静的配信の構成は
フレームワーク有無に関わらず同じ**なので、雛形のその部分はそのまま使える。

### モノレポへ昇格する目安

雛形は単一パッケージ。次のどれかに当たったら [references/scale-up.md](references/scale-up.md) の手順で
pnpm workspaces + Turborepo に切り出す。**当たっていないうちに切り出さない。**

- 画面が 3 つ以上あり、それぞれ独立したバンドルとビルド設定を持つ
- ドメインロジックがデータストアと無関係に育ち、単体でテストしたい塊になった
- 同じ型・スキーマを使う関数が 2 つ以上のデプロイ単位に分かれる

## 3. 実装の進め方

雛形から始めるなら 1〜3 は済んでいる。ゼロから書く場合も**順序は変えない**
（ZIP が作れない構成に後から気づくと高くつく）。

1. 骨格 — `package.json` / `tsconfig.json` / `.gitignore` / `.env.example`
2. 関数の最小構成 — `index.ts` / `app.ts`（**3 通りマウント**）/ `local.ts` / `config.ts` / `GET /v1/health`
3. `build.mjs` と `zip-package.json` — **この時点で ZIP を作り、`require` して handler を検証できる状態にする**
4. データストア層（クライアントラッパ + テーブル解決 + リポジトリ 1 本 + インメモリ実装）
5. フロントの骨格と `static.ts` による同一オリジン配信 — **`?v=__ASSET_VERSION__` をこの段階で入れる**
6. 業務ロジック（データストアなしでテストできる純関数に寄せる）
7. `deploy.mjs` でデプロイ（必要なら GitHub Actions を追加）
8. `docs/` に構成・ADR・デプロイ手順・データモデル・API 仕様を書く

各段階でテストを書きながら進める。コードの骨子は [references/scaffold.md](references/scaffold.md)。

## 4. 特に外してはいけない 5 点

実装中に何度も戻ってくる点。詳細と再現条件は [references/pitfalls.md](references/pitfalls.md)。

1. **前段キャッシュは `no-cache` を無視する。** 実行環境の前段（Cloudflare）が拡張子で判断し、
   `.css` と `.js` を `max-age=14400` に上書きする。**URL を変えるしかない** →
   `index.html` に `href="styles.css?v=__ASSET_VERSION__"` を書き、配信時にコミットハッシュへ置換。
   **この仕組みはテストで固定する。** 症状は「デプロイしたのに画面が変わらない」。デプロイ失敗より気づきにくい。
2. **HTTP トリガーはトリガーのパスを含めてハンドラを呼ぶ。** 同じルート定義を `/`・`/:base`・`/:base/` の
   3 通りにマウントして吸収する。**トリガーのパスを環境変数で持たない**（ずれた瞬間に全リクエスト 404）。
3. **`getItem` の "Not found" は正常系。** `getItem` 専用の `runGet` で `undefined` に落とす。
   503 にするとサインアップが原理的に成立しない。`putItem` / `query` / `deleteItem` の "not found" は吸収しない。
4. **データストア SDK は文字列を throw することがある。** 文字列 = 操作エラー（`failed`）、
   `Error` = プロキシに到達不可（`threw`）。両方を 1 箇所で正規化する。`cause.message` だけ見ると原因が消える。
5. **設定不足で起動を止めない。** `configOk: false` を返せる状態で立ち上がる。throw すると `/v1/health` すら
   返らず、最も切り分けにくい状態になる。

## 5. 運用のための仕込み

**`GET /v1/health`（認証不要の唯一のエンドポイント）** は次を返す:

```jsonc
{
  "status": "ok",
  "version": "0.1.0",
  "commit": "<git sha>",   // デプロイしたコミットが実際に動いているかを機械的に確認する
  "builtAt": "...",
  "mockMode": false,       // 本番で true のまま公開していないかの目視確認用
  "configOk": true,
  "configMissing": 0,      // 件数だけ。キー名は出さない（認証不要のため）
  "limits": { }            // 実際に効いている上限値
}
```

**環境変数の設定漏れ検出（`config.ts`）**:

- 動作モードに応じて必須項目が変わるので、手作業のチェックリストではなく**コードで持つ**
- `.env.example` の雛形値（`00000000-0000-0000-0000-000000000000` / `change-me`）は**未設定と同じ扱い**
- **不足キー名は `/v1/health` に出さない。起動時ログにだけ出す。値はどこにも出さない**
- 環境変数の読み取りは**呼び出しのたびに行う**（モジュール読み込み時に固めない）

**ローカル開発**:

- ローカルは Lambda を介さず**同じ `app` を `@hono/node-server` で起動**する
- **データストアだけはローカルで代替できない**（実行環境が接続情報を注入するため）。
  雛形は `DATASTORE_MODE=memory` でインメモリ実装に切り替わる。**永続化されない事実を README に正直に書く**
- 通しの導線確認は**同じインターフェースの fake に差し替えた統合テスト**で行う
- 外部依存（LLM 等）を使うなら `MOCK_MODE` を**最初に**実装する。後から入れると分岐の差し込み箇所が
  散って高くつく。分岐は各関数の**入口 1 箇所**に置く

## 6. 完了報告の前に

[references/checklist.md](references/checklist.md) の項目をレビューする。

**「動いた」と報告する前に、実際にコマンドを実行して結果を確認すること。未実施のことを実施済みと書かない。**

## 参照ファイル

作業に入る段階で該当するものだけを読む。

| ファイル | 読むタイミング |
| :--- | :--- |
| [references/constraints.md](references/constraints.md) | 常に。プラットフォーム制約 E1〜E4 と、キー設計の原則 |
| [references/pitfalls.md](references/pitfalls.md) | 実装前と、症状の切り分け時。前段キャッシュ・トリガーパス・データストア SDK の落とし穴 |
| [references/recipes.md](references/recipes.md) | 雛形に機能を足すとき。API・画面・テーブル・認証・長い処理・LLM |
| [references/scaffold.md](references/scaffold.md) | ゼロから書くとき、または雛形の各ファイルの役割を確認するとき |
| [references/deploy.md](references/deploy.md) | enebular 側セットアップと CI/CD を組むとき |
| [references/scale-up.md](references/scale-up.md) | 単一パッケージが手狭になり、モノレポへ切り出すとき |
| [references/checklist.md](references/checklist.md) | 実装完了を報告する前に必ず |
