# Web アプリのデプロイ

`apps/web` は TanStack Start を Cloudflare Workers 向けにビルドし、`dragonfly.vrc.nikomaru.dev` で公開する。
画像の実体は R2、検索用のメタデータは D1 に置く。

## リソース

| 種別 | 名前 | 用途 |
| --- | --- | --- |
| Workers | `dragonfly-web` | SSR とバックエンド API |
| R2 バケット | `dragonfly-photos` | AVIF 本体とサムネイル |
| D1 | `dragonfly` | 写真・ワールド・同席者・タグ・API キー |

R2 バケットは作成済み。D1 は未作成で、`wrangler.jsonc` の `database_id` はプレースホルダのままになっている。

```sh
# D1 を作成し、出力された database_id を apps/web/wrangler.jsonc に書き込む
pnpm --dir apps/web exec wrangler d1 create dragonfly
```

作成に使う API トークンには **D1:Edit** の権限が必要。Storybook デプロイ用のトークンには
Workers と R2 の権限しか付いていないため、そのままでは `Authentication error [code: 10000]` で失敗する。
Cloudflare ダッシュボードの API トークン設定で D1 の編集権限を追加してから実行すること。

## GitHub Actions

| ワークフロー | 契機 | 内容 |
| --- | --- | --- |
| `web-deploy.yml` | main への push（`apps/web` / `packages/*` の変更）と手動 | ビルドして `wrangler deploy` |
| `db-migrate.yml` | 手動のみ | `apps/web/migrations` の未適用分を本番 D1 に適用 |

`db-migrate.yml` は既定が dry run で、未適用のマイグレーションを一覧するだけ。
実際に流すときは `dry_run` のチェックを外して実行する。スキーマ変更は破壊的になりうるため、
デプロイと同じワークフローには載せていない。

必要な GitHub Secrets:

| Secret | 用途 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | デプロイと D1 マイグレーション（Storybook デプロイと共用） |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | Discord ログイン |
| `BETTER_AUTH_SECRET` | セッションの暗号化 |
| `BETTER_AUTH_URL` | 公開 URL |
| `ALLOWED_DISCORD_USER_IDS` | サインインを許可する Discord ユーザーID（カンマ区切り） |

下 5 つは `web-deploy.yml` の Push secrets ステップが `wrangler secret bulk` で Worker に流し込む。
Worker が存在しないと登録できないため、必ず `wrangler deploy` の後に実行している。
secret を更新すると新しいバージョンが自動で有効になるので、再デプロイは要らない。
手元から入れ直したいときは `pnpm --dir apps/web exec wrangler secret put <NAME>`。

`ALLOWED_DISCORD_USER_IDS` は最初の1人がログインするための逃げ道で、
通常の許可リストは D1 の `allowed_discord_users` テーブルで管理する。

## カスタムドメイン

`wrangler.jsonc` の `routes` に `dragonfly.vrc.nikomaru.dev` を `custom_domain` として指定してある。
初回デプロイ時に DNS レコードとカスタムドメインが作成されるため、実行するアカウントが
`vrc.nikomaru.dev` ゾーンをホストしている必要がある。
