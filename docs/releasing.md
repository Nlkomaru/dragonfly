# リリース手順

## 全体の流れ

1. PR にラベル（`breaking` / `feature` / `fix` など）を付ける。
   `release-drafter.yml` が PR 上で次のバージョンを見せるので、採番の結果を事前に確認できる。
2. main にマージすると **Release** ワークフローが自動で走り、そのままリリースが公開される。
3. ワークフロー内で以下が順に走る。
   - `draft` — PR ラベルからバージョンを採番し、ドラフトを用意する（まだ非公開）
   - `build` — Windows / macOS(aarch64) / Linux のバンドルと `.sig` をドラフトに添付する（3つ並列）
   - `updater-manifest` — 添付済みのアセットから `latest.json` を組み立てて1回だけ添付する
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

### `latest.json` の作られ方

`latest.json` は3プラットフォーム共通の同名アセットで、`tauri-action` は
「既存を読む → 自分の分をマージ → 上げ直す」という形で更新する。競合時は再試行するので
並列に走らせても多くの場合は3つ揃う（実際、姉妹リポジトリの `kodou` は
`max-parallel` 無しで3並列のまま3プラットフォーム揃った `latest.json` を出せている）。
ただし read-modify-write である以上、同時実行で更新を取りこぼす窓は残る。

そこでビルド側では生成させず（`uploadUpdaterJson: false`）、
全ビルド完了後の `updater-manifest` ジョブが
`.github/scripts/build-updater-manifest.sh` で1回だけ組み立てて添付する。
書き込みが1回きりなら競合そのものが無くなる。

**より重要なのは、欠けたときに気付けること。** プラットフォーム別に書く方式では、
どれか1つのビルドが失敗しても残りだけの `latest.json` が添付され、そのまま公開まで
進み得た（v0.1.1 のドラフトで実際に発生し、macOS 欠落のまま誰も落ちなかった）。
現在は揃っていなければ `updater-manifest` が落ち、`publish` に進まない。

ビルドジョブは **3つ並列** で走る。
以前の `max-parallel: 1` は上記の競合を「起きにくくする」だけで無くせてはおらず、
その対価として1リリースあたり約20分を余計に払っていた。

スクリプトが `latest.json` の各プラットフォームに割り当てるアセットは次の通り。
`.sig` の中身が `signature`、`.sig` を外した同名アセットが `url` になる。

| キー | 更新バンドル |
|---|---|
| `darwin-aarch64` | `*.app.tar.gz` |
| `linux-x86_64` | `*.AppImage` |
| `windows-x86_64` | `*-setup.exe`（NSIS） |

Windows は `bundle.targets: "all"` により `.msi` と `-setup.exe` の両方に `.sig` が出るが、
更新には Tauri が既定として推奨する NSIS 側を使う（`.msi` は更新時に再起動要求が絡みやすい）。

`url` はドラフトのアセットが返す `browser_download_url` をそのまま使わず、
`https://github.com/<owner>/<repo>/releases/download/<tag>/<asset>` を自前で組み立てている。
ドラフト段階の URL は `untagged-<hash>` を含むことがあり、公開後に無効になるため。

いずれかのプラットフォームの `.sig` が欠けている、署名が空、といった場合はジョブを失敗させる。
欠けた `latest.json` を公開すると更新が静かに止まり、赤いビルドより被害が大きいため。

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
