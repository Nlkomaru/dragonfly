// D1 のスキーマ定義。ここが唯一の正で、migrations/ の SQL は drizzle-kit がここから生成する。
//
// テーブルは大きく 3 系統に分かれる。
//   1. better-auth が管理するテーブル (user / session / account / verification / apikey)
//   2. dragonfly のドメインテーブル (photos / worlds / vrc_users / tags ...)
//   3. サインインを許可する Discord ユーザーの許可リスト (allowed_discord_users)
//
// better-auth 系のテーブルは「JS のプロパティ名」で better-auth のアダプタから引かれる。
// better-auth 側のフィールド名は camelCase なので、プロパティ名は必ず camelCase にすること
// （SQL のカラム名は snake_case で構わない）。フィールド名の定義は
// better-auth の `getSchema()` が返す内容が正であり、この定義はそれに合わせてある。

import { relations } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// ---------------------------------------------------------------------------
// better-auth のテーブル
// ---------------------------------------------------------------------------

/**
 * ログインユーザー。Discord OAuth でのみ作られる。
 * dragonfly のすべての所有権 (photos.owner_id など) はこの id を指す。
 */
export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  // better-auth は boolean として読み書きするため、SQLite では integer 0/1 に落とす。
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  // 日付は Date として往復させたいので timestamp_ms（unix ミリ秒）で保存する。
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/** ブラウザのセッション。Cookie に載るのは token 側で、この行はサーバー側の実体。 */
export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("idx_session_user").on(table.userId)],
);

/** OAuth プロバイダとの結び付き。Discord の場合 account_id が Discord のユーザー ID になる。 */
export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("idx_account_user").on(table.userId),
    // 同じプロバイダの同じアカウントが二重に紐づかないようにする。
    uniqueIndex("idx_account_provider").on(table.providerId, table.accountId),
  ],
);

/** better-auth が使う短命トークン置き場（OAuth の state など）。 */
export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("idx_verification_identifier").on(table.identifier)],
);

/**
 * API キー。better-auth の apiKey プラグインが管理する。
 * `key` にはハッシュ済みの値しか入らず、生の鍵は発行時のレスポンスにしか現れない。
 * `reference_id` は「鍵の持ち主」で、このアプリでは常に user.id を指す
 * （プラグインの `references` 設定を既定の "user" のまま使っているため）。
 */
export const apikey = sqliteTable(
  "apikey",
  {
    id: text("id").primaryKey(),
    configId: text("config_id").notNull(),
    name: text("name"),
    /** 先頭数文字。一覧でどの鍵か見分けるための非機密値。 */
    start: text("start"),
    referenceId: text("reference_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    prefix: text("prefix"),
    key: text("key").notNull(),
    refillInterval: integer("refill_interval"),
    refillAmount: integer("refill_amount"),
    lastRefillAt: integer("last_refill_at", { mode: "timestamp_ms" }),
    enabled: integer("enabled", { mode: "boolean" }).default(true),
    rateLimitEnabled: integer("rate_limit_enabled", { mode: "boolean" }).default(true),
    rateLimitTimeWindow: integer("rate_limit_time_window"),
    rateLimitMax: integer("rate_limit_max"),
    requestCount: integer("request_count"),
    remaining: integer("remaining"),
    lastRequest: integer("last_request", { mode: "timestamp_ms" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    permissions: text("permissions"),
    metadata: text("metadata"),
  },
  (table) => [
    index("idx_apikey_reference").on(table.referenceId),
    // 提示された鍵はハッシュして key で引かれる。ここに索引が無いと毎回全走査になる。
    index("idx_apikey_key").on(table.key),
  ],
);

// ---------------------------------------------------------------------------
// サインイン許可リスト
// ---------------------------------------------------------------------------

/**
 * サインインを許可する Discord ユーザー。
 * ここに載っていない Discord アカウントは、OAuth のコールバック時点で弾かれる
 * （user 行を作る前に落とすので、拒否されたアカウントの痕跡は残らない）。
 *
 * 再デプロイ無しで増減できるように、コードではなくデータとして持つ。
 * 行がまだ 1 件も無い初回だけは、Worker 変数 ALLOWED_DISCORD_USER_IDS が抜け道になる。
 */
export const allowedDiscordUsers = sqliteTable("allowed_discord_users", {
  /** Discord のユーザー ID（snowflake, 10 進の文字列）。 */
  discordUserId: text("discord_user_id").primaryKey(),
  /** 誰の ID なのかを後から分かるようにするためのメモ。表示にも監査にも使う。 */
  note: text("note").notNull().default(""),
  createdAt: integer("created_at").notNull(),
});

// ---------------------------------------------------------------------------
// dragonfly のドメインテーブル
// ---------------------------------------------------------------------------

/**
 * 写真 1 枚のメタデータ。実体 (AVIF) は R2 にあり、ここにはキーだけを持つ。
 * world_name は一覧を 1 クエリで描くための非正規化。
 * 生成する主キーは UUIDv7 で、先頭が unix ミリ秒なので辞書順が生成順にほぼ一致する。
 */
export const photos = sqliteTable(
  "photos",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** 変換前 PNG の SHA-256。ユーザー内での一意キー。 */
    sourceSha256: text("source_sha256").notNull(),
    r2Key: text("r2_key").notNull(),
    thumbKey: text("thumb_key"),
    /** 撮影日時（unix ミリ秒）。ドメインの値なので Date ではなく数値のまま持つ。 */
    takenAt: integer("taken_at").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    /** 保存した AVIF のバイト数。 */
    byteSize: integer("byte_size").notNull(),
    worldId: text("world_id"),
    worldName: text("world_name"),
    instanceId: text("instance_id"),
    /** 撮影した VRChat ユーザー usr_... */
    authorId: text("author_id"),
    /**
     * 一覧の画像が読み込まれるまでのプレースホルダに使う BlurHash（28 文字）。
     * アップロード時にデスクトップが計算して載せてくるが、それより前に
     * アップロードされた行や計算前の行は null。後から Web 側が埋める。
     */
    blurhash: text("blurhash"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    // ハッシュはユーザーごとにスコープする。他人の写真の存在が漏れないための要。
    uniqueIndex("idx_photos_owner_hash").on(table.ownerId, table.sourceSha256),
    // 一覧は (taken_at DESC, id DESC) で辿るので、その順序で索引を張る。
    index("idx_photos_owner_taken").on(table.ownerId, table.takenAt),
    index("idx_photos_world").on(table.worldId),
  ],
);

/** フィルタ用に最新のワールド名を保持する。 */
export const worlds = sqliteTable("worlds", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** VRChat のユーザー。撮影者と同席者の両方をここに載せる。 */
export const vrcUsers = sqliteTable("vrc_users", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** 同席していたプレイヤー。多対多。 */
export const photoPlayers = sqliteTable(
  "photo_players",
  {
    photoId: text("photo_id")
      .notNull()
      .references(() => photos.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => vrcUsers.id),
  },
  (table) => [
    primaryKey({ columns: [table.photoId, table.userId] }),
    index("idx_photo_players_user").on(table.userId),
  ],
);

/** タグはユーザーごとの名前空間を持つ。 */
export const tags = sqliteTable(
  "tags",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
  },
  (table) => [uniqueIndex("idx_tags_owner_name").on(table.ownerId, table.name)],
);

export const photoTags = sqliteTable(
  "photo_tags",
  {
    photoId: text("photo_id")
      .notNull()
      .references(() => photos.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.photoId, table.tagId] }),
    index("idx_photo_tags_tag").on(table.tagId),
  ],
);

/**
 * 写真 1 枚から抽出したカラーパレット（代表色 5 色）。
 *
 * 抽出はサムネイル (AVIF) をデコードできるブラウザ側で行い、サーバーは受け取った値を持つだけ。
 * 1 枚につき 1 行なので photo_id をそのまま主キーにする。
 *
 * owner_id は photos から辿れるが、あえて非正規化して持つ。
 * 「そのユーザーの全パレット」を join 無しの 1 クエリで引けるようにするため
 * （/groups は全件をまとめて読み込んで距離行列を作る）。
 *
 * swatches は PaletteSwatch[] の JSON。列に展開しないのは、
 * 検索対象ではなく「まとめて読んでクライアントで計算する」値でしかないため。
 */
export const photoPalettes = sqliteTable(
  "photo_palettes",
  {
    photoId: text("photo_id")
      .primaryKey()
      .references(() => photos.id, { onDelete: "cascade" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** 抽出アルゴリズムの版。古ければクライアントが抽出し直して上書きする。 */
    version: integer("version").notNull(),
    /** PaletteSwatch[] を JSON.stringify したもの。 */
    swatches: text("swatches").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    // 一覧は owner_id だけで全件を舐めるので、ここに索引が無いと毎回全走査になる。
    index("idx_photo_palettes_owner").on(table.ownerId),
  ],
);

// リレーションは join を書くときの補助。クエリ自体は明示的な join で書いている。
export const photosRelations = relations(photos, ({ one, many }) => ({
  owner: one(user, { fields: [photos.ownerId], references: [user.id] }),
  players: many(photoPlayers),
  tags: many(photoTags),
}));
