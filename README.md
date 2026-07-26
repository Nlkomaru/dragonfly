# dragonfly

Tauri 2 デスクトップアプリと TanStack Start の Web アプリを共存させた pnpm ワークスペース。

| パッケージ | 役割 |
|---|---|
| `apps/desktop` | Tauri 2 + Vite + TanStack Router (SPA) のデスクトップアプリ |
| `apps/web` | TanStack Start (SSR) の Web アプリ（Cloudflare Workers 想定） |
| `packages/ui` | 共有 UI コンポーネント（shadcn / Tailwind v4）と Storybook |
| `packages/core` | ドメインロジック・型定義 |
| `packages/api-client` | Tauri `invoke` と HTTP を同一インターフェースで抽象化する層 |

## 開発

```bash
pnpm install
pnpm dev          # デスクトップ (Tauri)
pnpm dev:web      # Web (TanStack Start)
pnpm storybook    # UI カタログ
```

## リリース

`.github/workflows/release.yml` を `workflow_dispatch` で実行すると、release-drafter が
バージョンを採番 → Tauri バイナリをビルド → アセット添付後にリリースを公開する。
詳細は [docs/releasing.md](docs/releasing.md) を参照。
