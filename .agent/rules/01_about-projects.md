## このアプリケーションの概要

このプロジェクトは、VRChatで撮影されたスクリーンショットを管理するためのデスクトップアプリケーションです。
デスクトップアプリにおいて、送信するスクリーンショットの選択、タグ付けなどを行い、Webアプリに送信することができます。Webアプリでは、送信されたスクリーンショットを閲覧・検索・管理することができます。

## 主な技術スタック

### デスクトップアプリ (`apps/desktop/`)

- **Tauri 2** — Rust バックエンド + WebView フロントエンドのデスクトップアプリ基盤
- **Rust** — ネイティブ処理の実装
- **React 19 + Vite** — フロントエンド UI（SSR なしの SPA としてビルドし、Tauri が `dist/` を読む）
- **TanStack Router** — ファイルベースルーティング（`src/routes/`）
- **TypeScript** — 型安全な実装
- **Tailwind CSS v4** — スタイリング
- **Jotai** — 状態管理（アトム指向）
- **Tauri Updater** — GitHub Releases の `latest.json` を参照する自動更新（署名付き）

### Web アプリ (`apps/web/`)

- **TanStack Start** — SSR + サーバー関数（`dragonfly.vrc.nikomaru.dev` で公開予定）
- **Cloudflare Workers** — デプロイ先

### 共有パッケージ (`packages/`)

- **`@dragonfly/ui`** — shadcn / Radix UI / lucide-react ベースの共有 UI と Storybook 10
- **`@dragonfly/core`** — ドメインの型とプラットフォーム非依存のロジック
- **`@dragonfly/api-client`** — Tauri `invoke` と HTTP を同一インターフェースで扱う抽象層

### インフラ・CI

- **Cloudflare Workers (Static Assets)** — Storybook のホスティング (`dragonfly-sb.vrc.nikomaru.dev`)
- **R2 (S3 互換)** — PR ごとの Storybook プレビュー (`ci.nikomaru.dev/dragonfly`)
- **GitHub Actions** — リリースビルド (Tauri)、Storybook デプロイ、Rust lint / test、Release Drafter
- **pnpm ワークスペース** — `apps/*` と `packages/*` の構成
