# 推奨される書き方

## 状態管理 (Jotai)
- グローバルな状態は `src/state/` にアトムとして定義し、`useAtom` / `useAtomValue` / `useSetAtom` で参照してください。
- ローカルな UI 状態は `useState` で十分な場合は無理にアトム化しないでください。
- 派生状態には `useAtomValue` と派生アトム（`atom((get) => ...)`）を組み合わせてください。

## ルーティング (TanStack Router)
- ルートは `src/routes/` にファイルを追加して定義し、`createFileRoute` を使ってください。
- 画面遷移は `<Link to="/path">` か `useNavigate()` を使い、`to` は型補完に従ってください。
- データ取得はルートの `loader` に寄せ、コンポーネント内の `useEffect` での取得は避けてください。

## Tauri IPC
- フロントエンドからは `@dragonfly/api-client` の `call("<command>", args)` を使用してください。
- Rust からのイベント受信は `@tauri-apps/api/event` の `listen("<event>", callback)` を使用します（デスクトップ専用コードに限る）。
- コマンド名・イベント名はスネークケースで統一し、フロントエンド側でも同じ名前を使用してください。

## 非同期 / エラーハンドリング
- Tauri コマンドは `Result<T, String>` を返し、エラーはフロントエンドで `toast` 等で表示してください。
- ネットワークやデバイス通信など失敗しやすい処理は、指数バックオフで再試行するなど耐障害性を持たせてください。

## スタイリング
- Tailwind CSS v4 のユーティリティを優先し、カラートークン（`bg-background` / `text-foreground` など）を使用してください。
- `cva`（class-variance-authority）でバリアントを管理し、shadcn の記法に合わせてください。
- クラスの結合は `@dragonfly/ui` の `cn()` を使ってください。

## 自動更新
- updater の設定（`endpoints` / `pubkey`）は `apps/desktop/src-tauri/tauri.conf.json` にあります。
- `version` の正はリリースタグです。リポジトリ上の `tauri.conf.json` の `version` は更新せず、
  CI がタグの値を書き込みます。手動で上げないでください。
- 署名鍵（`TAURI_SIGNING_PRIVATE_KEY`）は GitHub Secrets にのみ置き、リポジトリにコミットしないでください。

## Test
- テストは主要な分岐点をカバーする程度に留め、過度な網羅は避けてください。
- テストケースの説明は英語で短く記述してください。

## 正式サポート環境
- 正式サポートは Windows 11 のみです。ただし macOS / Linux 向けのビルドも配布しています。プラットフォーム固有のコードを書く際はこの点に留意してください。
