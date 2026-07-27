# Web アプリのデプロイ

`apps/web` は TanStack Start を Cloudflare Workers 向けにビルドし、`dragonfly.vrc.nikomaru.dev` で公開する。
画像の実体は R2、検索用のメタデータは D1 に置く。

## リソース

| 種別 | 名前 | 用途 |
| --- | --- | --- |
| Workers | `dragonfly-web` | SSR とバックエンド API |
| R2 バケット | `dragonfly-photos` | AVIF 本体とサムネイル |
| D1 | `dragonfly` | 写真・ワールド・同席者・タグ・API キー |

R2 バケットと D1 はどちらも作成済みで、`wrangler.jsonc` に ID を記載してある。

作り直すときは以下。API トークンには **D1:Edit** の権限が必要で、
権限が足りないと `Authentication error [code: 10000]` で失敗する。

```sh
pnpm --dir apps/web exec wrangler d1 create dragonfly
# 出力された database_id を apps/web/wrangler.jsonc に書き込む
```

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

## 認証と環境変数

ログインは **Discord OAuth のみ**で、認証基盤には [better-auth](https://better-auth.com) を使う。
デスクトップアプリは better-auth の apiKey プラグインが発行した API キーを
`Authorization: Bearer dfly_…` で送る。ブラウザのセッション Cookie と API キーは
どちらも `auth.api.getSession()` が同じ形に解決するため、API 側は両者を区別しない。

### Discord アプリの用意

1. [Discord Developer Portal](https://discord.com/developers/applications) でアプリを作る。
2. OAuth2 のリダイレクト URI に `https://dragonfly.vrc.nikomaru.dev/api/auth/callback/discord` を登録する。
   ローカルで試すときは `http://localhost:1421/api/auth/callback/discord` も追加する。
3. スコープは `identify` と `email`（better-auth が既定で要求する）。

### 必要な設定値

| 名前 | 用途 |
| --- | --- |
| `BETTER_AUTH_URL` | better-auth が絶対 URL を組み立てるための公開 URL |
| `DISCORD_CLIENT_ID` | Discord アプリのクライアント ID |
| `DISCORD_CLIENT_SECRET` | Discord アプリのクライアントシークレット |
| `BETTER_AUTH_SECRET` | セッション Cookie の署名鍵。十分な長さのランダム値にする |
| `ALLOWED_DISCORD_USER_IDS` | サインインを許可する Discord ユーザー ID のカンマ区切り（任意） |

いずれも Worker の **secret** として入る。GitHub Secrets に登録しておけば
`web-deploy.yml` の Push secrets ステップが `wrangler secret bulk` で流し込む
（上の「GitHub Actions」の節を参照）。手元から入れ直したいときは:

```sh
pnpm --dir apps/web exec wrangler secret put BETTER_AUTH_SECRET
```

`wrangler.jsonc` の `vars` には書かないこと。同名の var と secret が両方あると二重定義になる。

ローカルで動かすときは `apps/web/.dev.vars` に同じ名前で置く（このファイルは
必ず `.gitignore` に入れること。秘密の値がそのまま入る）。
`BETTER_AUTH_URL` は本番の URL ではなく `http://localhost:1421` にすること。
ここが公開 URL のままだと、Discord から戻る先が本番になってしまう。

### サインインできる人を絞る

Discord アカウントさえあれば誰でも入れる、という状態にはしていない。
許可された Discord ユーザー ID は次の 2 つの **和集合**で決まる。

1. D1 の `allowed_discord_users` テーブル（通常の運用経路）
2. Worker 変数 `ALLOWED_DISCORD_USER_IDS`（カンマ区切り）

判定は OAuth のコールバックの中、`user` 行を作る**前**に行う。
そのため許可されていないアカウントは DB に痕跡を残さず、
「このアカウントはサインインを許可されていません」という趣旨のエラーになる。

初期マイグレーションは `allowed_discord_users` に `REPLACE_ME` というプレースホルダ行を 1 件入れる。
これは Discord のユーザー ID（数字のみの snowflake）として成立しないので、置き換えを忘れても
誰かが入れてしまうことはない。運用開始時は次のどちらかを行う。

```sh
# a) 先に ALLOWED_DISCORD_USER_IDS で 1 人目を通し、ログイン後に行を整える
#    → GitHub Secrets の ALLOWED_DISCORD_USER_IDS に自分の Discord ユーザー ID を入れてデプロイ

# b) 直接 D1 に入れる
pnpm --dir apps/web exec wrangler d1 execute dragonfly --remote --command \
  "UPDATE allowed_discord_users SET discord_user_id = '<Discord のユーザー ID>', note = '<誰のものか>' WHERE discord_user_id = 'REPLACE_ME'"

# 2 人目以降を追加する
pnpm --dir apps/web exec wrangler d1 execute dragonfly --remote --command \
  "INSERT INTO allowed_discord_users (discord_user_id, note, created_at) VALUES ('<ID>', '<メモ>', 0)"
```

ブートストラップが済んだら `ALLOWED_DISCORD_USER_IDS` は外しておくのが望ましい。
許可リストの管理場所が 2 か所に分かれたままになるのを避けるため。

## スキーマとマイグレーション

スキーマの正は `apps/web/src/db/schema.ts`（Drizzle）で、`apps/web/migrations/` の SQL は
そこから生成する。テーブルを変えたら必ず生成し直してコミットすること。

```sh
pnpm --dir apps/web db:generate
```

生成先を `migrations/` にしているのは、`db-migrate.yml` が
`wrangler d1 migrations apply dragonfly --remote` でこのディレクトリを読むため。
drizzle-kit は同じ場所に `meta/` も作るが、wrangler は `*.sql` しか見ないので共存する。

better-auth のテーブル（`user` / `session` / `account` / `verification` / `apikey`）も
同じスキーマファイルに入っている。列名やモードを勝手に変えると、ビルドも型検査も通ったまま
実行時にだけ壊れるので注意すること。

## API ドキュメント

Hono が `/api` 配下をすべて持ち、OpenAPI の仕様と閲覧 UI も同じ Worker が配信する。

| パス | 内容 |
| --- | --- |
| `/api/openapi` | OpenAPI 3.1 の仕様（JSON） |
| `/api/scalar` | Scalar による閲覧 UI |
| `/api/auth/*` | better-auth（ログイン、セッション、API キーの発行 / 失効） |
| `/api/v1/*` | dragonfly の API |

`/api/*` は TanStack Start のキャッチオールルート `apps/web/src/routes/api/$.ts` が
まるごと Hono に委譲している。API のルート定義は `apps/web/src/api/` 側だけを見ればよい。

### 画像 URL は HMAC 署名付き (issue #10)

`/image` と `/thumb` は、次のどちらかで認可する。

- **署名付き URL**: クエリ `exp`（unix seconds）と `sig`（HMAC-SHA256 の base64url）。
  署名対象は `v1:{ownerId}:{photoId}:{variant}:{exp}`。鍵は `BETTER_AUTH_SECRET` を流用する。
  一覧 / 詳細が返す `url` / `thumbUrl` がこの形なので、ブラウザの `<img src>` から
  Authorization 無しで表示できる。既定 TTL は 6 時間。
- **セッション Cookie / API キー**: デスクトップ向けの従来パス。署名は不要。

署名経由の応答は `Cache-Control: public, max-age=<残秒>, immutable`、
資格情報経由は `private, max-age=31536000, immutable`。
