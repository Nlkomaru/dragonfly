# ディレクトリ配置規則

## ワークスペース構成

pnpm ワークスペースで、`apps/*`（アプリ）と `packages/*`（共有コード）から構成されます。

```
dragonfly/
├─ apps/
│  ├─ desktop/   Tauri 2 + Vite + TanStack Router (SPA)
│  └─ web/       TanStack Start (SSR / Cloudflare Workers)
├─ packages/
│  ├─ ui/          共有 UI + Storybook
│  ├─ core/        ドメインの型・ロジック
│  └─ api-client/  実行環境の差を吸収する呼び出し層
├─ docs/         運用ドキュメント (Markdown)
├─ notebooks/    marimo による検証ノートブック（uv 管理・pnpm ワークスペース外）
├─ .agent/       エージェント向けルール（AGENTS.md / CLAUDE.md の生成元）
└─ .github/
```

## `apps/desktop/` — デスクトップアプリ

- `src/` — React フロントエンドのソース
  - `routes/` — TanStack Router のファイルベースルート（`__root.tsx` が全体レイアウト）
  - `components/` — このアプリ固有のコンポーネント
  - `hooks/` — カスタムフック
  - `state/` — Jotai のアトム定義
  - `lib/` — 汎用ユーティリティ
  - `routeTree.gen.ts` — 自動生成物（コミットしない）
- `src-tauri/src/` — Rust バックエンド
  - `main.rs` — 実行バイナリのエントリ
  - `lib.rs` — Tauri アプリの組み立て・プラグイン登録・コマンド定義
- `src-tauri/capabilities/` — ウィンドウに与える権限の定義
- `src-tauri/tauri.conf.json` — バンドル設定と updater（`endpoints` / `pubkey`）の設定

## `apps/web/` — Web アプリ

- `src/routes/` — TanStack Start のルート
- `src/router.tsx` — ルーター生成
- `wrangler.jsonc` — Cloudflare Workers のデプロイ設定

## `packages/`

- `ui/src/components/ui/` — shadcn のプリミティブ
- `ui/src/components/` — 共有の複合コンポーネント（`*.stories.tsx` を併置）
- `ui/.storybook/` — Storybook の設定
- `ui/wrangler.jsonc` — Storybook のホスティング設定
- `core/src/` — プラットフォーム非依存の型とロジック
- `api-client/src/` — `isTauri()` による分岐を閉じ込めた呼び出し層

## `notebooks/` — 検証用ノートブック

uv + marimo の Python プロジェクト。pnpm ワークスペースの外にあり、アプリのビルドや CI には関与しません。

- `*.py` — marimo ノートブック（`uv run marimo edit <file>.py` で開く）
- `src/dragonfly_lab/` — ノートブックから使う実装
  - `palette.py` は `packages/core/src/palette.ts` の移植です。本番のアルゴリズムを変えたときは
    こちらも合わせてください（比較の基準として使うため、挙動が一致している必要があります）
  - `methods.py` は本番にまだ無い候補手法です。良かったものを core に入れる、という順番で使います
- `tests/case*.json` — 「同じグループに入ってほしい写真」の正解データ（採点用）
- `remote/` — API から取得したサムネイルのキャッシュ。自動生成物で gitignore 済み

## `.github/`

- `workflows/` — GitHub Actions のワークフロー
  - `release.yml` — リリース一式（採番 → ビルド → 公開）
  - `release-drafter.yml` — main への push でドラフトの変更履歴を更新
  - `tauri-build-check.yml` — PR での Tauri ビルド確認
  - `rust-lint.yml` — fmt / clippy
  - `preview.yml` — PR ごとの Storybook プレビューと Rust テスト
  - `storybook-deploy.yml` — Storybook の本番デプロイ
  - `cleanup-pr-cache.yml` — クローズした PR のキャッシュ削除
- `release-drafter.yml` — Release Drafter の設定
