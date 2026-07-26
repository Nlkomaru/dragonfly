# リリース手順

## 全体の流れ

1. PR にラベル（`breaking` / `feature` / `fix` など）を付ける。
   `release-drafter.yml` が PR 上で次のバージョンを見せるので、採番の結果を事前に確認できる。
2. main にマージすると **Release** ワークフローが自動で走り、そのままリリースが公開される。
3. ワークフロー内で以下が順に走る。
   - `draft` — PR ラベルからバージョンを採番し、ドラフトを用意する（まだ非公開）
   - `build` — Windows / macOS(aarch64) / Linux のバンドルと `latest.json` をドラフトに添付する
   - `publish` — 全アセットが揃ってからドラフトを解除して公開する

ドラフトは公開までの足場でしかなく、人手で触る必要はない。
Actions から `Run workflow` で手動実行することもでき、`dry_run` を有効にすると
ビルドまでで止まってドラフトのまま結果を確認できる。

リリースしたくない変更には PR に `skip-release` ラベルを付ける。
また、デスクトップアプリの成果物に影響しない変更（`apps/web/` やドキュメントのみ）では
`paths-ignore` により Release ワークフロー自体が走らない。

## なぜ「公開してからビルド」ではないのか

- GITHUB_TOKEN が公開したリリースは `on: release: [published]` を発火させない。
  そのため「release-drafter が公開 → 別ワークフローがビルド」という構成は動かない。
- 先に公開するとアセットが揃うまでの間、updater が参照する `latest.json` が無い状態になる。

この2点を避けるため、採番・ビルド・公開を `release.yml` 1本の `needs` チェーンにまとめている。

## バージョンの正

バージョンの正は **リリースタグ**（release-drafter が採番）。
`apps/desktop/src-tauri/tauri.conf.json` の `version` はリポジトリ上では更新せず、
CI の "Sync app version from release tag" ステップがタグの値を書き込む。
手動で上げると二重管理になるので触らないこと。

## 自動更新（Tauri Updater）

- 設定は `apps/desktop/src-tauri/tauri.conf.json` の `plugins.updater`。
  - `endpoints`: `https://github.com/Nlkomaru/dragonfly/releases/latest/download/latest.json`
  - `pubkey`: 署名鍵の公開鍵
- `bundle.createUpdaterArtifacts: true` により、ビルド時に更新用アーカイブと `.sig` が生成される。
- アプリ側は `apps/desktop/src/components/UpdateNotifier.tsx` が起動時にチェックし、
  更新があればダウンロード・インストールして再起動する。
- 権限は `apps/desktop/src-tauri/capabilities/default.json` の `updater:default` /
  `process:allow-restart` で付与している。

`latest.json` は3プラットフォームが同じ名前のアセットを更新するため、
ビルドジョブは `max-parallel: 1` で直列実行している（並列だと片方の書き込みが失われる）。

## 署名鍵のセットアップ（初回のみ・手元で実行）

updater の署名鍵はリポジトリでは生成できないので、手元で作って Secrets に登録する。

```bash
pnpm --dir apps/desktop exec tauri signer generate -w ~/.tauri/dragonfly.key
```

- 出力された **公開鍵** を `tauri.conf.json` の `plugins.updater.pubkey` に貼る
  （初期値は `REPLACE_WITH_TAURI_UPDATER_PUBLIC_KEY` というプレースホルダー）。
- **秘密鍵**（`~/.tauri/dragonfly.key` の中身）とパスワードを GitHub Secrets に登録する。

| Secret | 内容 |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | 秘密鍵ファイルの中身そのもの |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 生成時に設定したパスワード（未設定なら空文字） |

秘密鍵を失うと、既存ユーザーへ更新を配信できなくなる（新しい鍵で署名しても
インストール済みアプリが検証に失敗する）。バックアップを取っておくこと。

## この構成に含まれない署名

ここで扱っているのは **Tauri updater の署名** のみで、OS のコード署名とは別物。
未署名のため、Windows では SmartScreen の警告、macOS では Gatekeeper のブロックが出る。
必要になったら別途以下が要る。

- **Windows**: Authenticode 証明書（`.pfx` または Azure Trusted Signing）と
  `tauri.conf.json` の `bundle.windows.certificateThumbprint` などの設定
- **macOS**: Apple Developer Program の Developer ID 証明書と notarization
  （`APPLE_CERTIFICATE` / `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` などの Secrets）

## 必要な Secrets 一覧

| Secret | 用途 |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | updater 署名 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | updater 署名 |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | Storybook デプロイ、Web アプリのデプロイと D1 マイグレーション |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` / `S3_URL` / `BUCKET_NAME` | PR プレビュー (R2) |

## Web アプリのデプロイ

このドキュメントはデスクトップアプリのリリースだけを扱う。
Web アプリ (`apps/web`) は別系統で、`web-deploy.yml` と `db-migrate.yml` が担当する。
手順とリソース (R2 / D1) の準備は [web-deploy.md](./web-deploy.md) を参照。
