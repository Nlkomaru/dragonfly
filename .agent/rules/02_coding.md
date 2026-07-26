# コーディングプラクティス

## 実装手順

1. **型設計**
   - まず型(interface / type)を定義

2. **純粋関数から実装**
   - 外部依存のない関数を先に実装

## プラクティス

- 小さく始めて段階的に拡張
- 過度な抽象化を避ける
- コードよりも型を重視
- 複雑さに応じてアプローチを調整

## コードスタイル（共通）

- 常に既存コードの設計や記法を参考にしてください。
- 書籍「リーダブルコード」のようなベストプラクティスを常に適用してください。
- コードの意図・背景などのコメントを各行に日本語で積極的に入れてください。
- コードを書いた後は、ビルドが通ることを確認してください。

## フロントエンド共通 (TypeScript / React)

- 関数コンポーネントと Hooks を使用してください（クラスコンポーネントは使用しない）。
- 状態管理には Jotai（`atom` / `useAtom`）を活用してください。グローバルな props バケツリレーは避けてください。
- UI コンポーネントは `packages/ui/src/components/ui/` 配下の shadcn コンポーネントをベースに構築してください。
  アプリ固有でないものは必ず `packages/ui` 側に置き、`apps/desktop` と `apps/web` の両方から使えるようにしてください。
- スタイリングは Tailwind CSS v4 のユーティリティクラスを使用してください。
- アイコンは `lucide-react` を使用してください。
- 1コンポーネントにつき1ファイルとし、コンポーネント名とファイル名を一致させてください。
- ルーティングは TanStack Router のファイルベースルーティングを使用し、`src/routes/` にルートを追加してください。
  `routeTree.gen.ts` は自動生成物なので手で編集しないでください。

## 環境差の扱い

- Tauri の `invoke` や `@tauri-apps/api` を画面コードから直接呼ばないでください。
  必ず `@dragonfly/api-client` の `call()` を経由し、環境分岐はこのパッケージ内に閉じ込めます。
- `apps/desktop` は SPA、`apps/web` は SSR です。`window` / `document` に触れるコードは
  Web 側では `useEffect` 内など、クライアントでのみ実行される場所に置いてください。

## バックエンド (`apps/desktop/src-tauri/src/`, Rust)

- Tauri 2 のコマンド（`#[tauri::command]`）とイベント（`emit` / `listen`）でフロントエンドと連携してください。
- 非同期処理は `tokio` を使用し、`tokio::sync::watch` などで状態を共有してください。
- 適切にモジュール（`mod`）を分けてファイルを整理してください。
- 公開する関数にはドキュメンテーションコメント（`///`）を付けてください。
- 新しいプラグインや権限を使う場合は `capabilities/default.json` の `permissions` を更新してください。
  権限漏れはビルドではなく実行時に失敗します。

## ビルド・確認コマンド

- 依存関係のインストール: `pnpm install`
- デスクトップアプリの開発起動: `pnpm dev` (Tauri デバッグビルド)
- Web アプリの開発起動: `pnpm dev:web` (http://localhost:1421)
- デスクトップのフロントエンドのみビルド: `pnpm build:desktop`
- Web アプリのビルド: `pnpm build:web`
- Storybook の起動: `pnpm storybook`
- Storybook のビルド: `pnpm build-storybook`
- Rust の検査: `cargo fmt --check` / `cargo clippy --all-targets -- -D warnings`（`apps/desktop/src-tauri` で実行）
