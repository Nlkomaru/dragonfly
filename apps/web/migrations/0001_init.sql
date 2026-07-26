-- dragonfly の初期スキーマ。
-- 生成する主キー (users / api_keys / photos / tags) は UUIDv7 を TEXT のハイフン付き正規形で保存する。
-- UUIDv7 は先頭が unix ミリ秒なので、辞書順が生成順とほぼ一致し、カーソル分割の tie-break にも使える。
-- VRChat 由来の ID (wrld_... / usr_...) は外部の識別子をそのまま主キーにする。

-- dragonfly のアカウント。API キーはこのユーザーに紐づく。
CREATE TABLE users (
  id           TEXT PRIMARY KEY,          -- UUIDv7
  display_name TEXT NOT NULL,
  created_at   INTEGER NOT NULL           -- unix ms
);

-- API キー。生の鍵は保存せず、SHA-256 のみを持つ。
CREATE TABLE api_keys (
  id           TEXT PRIMARY KEY,          -- UUIDv7
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,             -- 利用者が付けるラベル。例: "desktop"
  key_hash     TEXT NOT NULL UNIQUE,      -- 生の鍵の SHA-256 (16 進小文字)
  prefix       TEXT NOT NULL,             -- 先頭 8 文字。一覧表示専用の非機密値
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER                    -- 失効時刻。NULL の間だけ有効
);
CREATE INDEX idx_api_keys_user ON api_keys(user_id);

-- 写真本体のメタデータ。world_name は一覧を 1 クエリで描くための非正規化。
CREATE TABLE photos (
  id             TEXT PRIMARY KEY,        -- UUIDv7
  owner_id       TEXT NOT NULL REFERENCES users(id),
  source_sha256  TEXT NOT NULL,           -- 変換前 PNG の SHA-256
  r2_key         TEXT NOT NULL,
  thumb_key      TEXT,
  taken_at       INTEGER NOT NULL,        -- unix ms
  width          INTEGER NOT NULL,
  height         INTEGER NOT NULL,
  byte_size      INTEGER NOT NULL,        -- 保存した AVIF のサイズ
  world_id       TEXT,                    -- wrld_...
  world_name     TEXT,
  instance_id    TEXT,
  author_id      TEXT,                    -- 撮影した VRChat ユーザー usr_...
  created_at     INTEGER NOT NULL
);
-- ハッシュはユーザーごとにスコープする。他人の写真の存在が漏れないための要。
CREATE UNIQUE INDEX idx_photos_owner_hash ON photos(owner_id, source_sha256);
CREATE INDEX idx_photos_owner_taken ON photos(owner_id, taken_at DESC);
CREATE INDEX idx_photos_world ON photos(world_id);

-- フィルタ用に最新のワールド名を保持する。
CREATE TABLE worlds (
  id         TEXT PRIMARY KEY,            -- wrld_...
  name       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE vrc_users (
  id           TEXT PRIMARY KEY,          -- usr_...
  display_name TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- 同席していたプレイヤー。多対多。
CREATE TABLE photo_players (
  photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL REFERENCES vrc_users(id),
  PRIMARY KEY (photo_id, user_id)
);
CREATE INDEX idx_photo_players_user ON photo_players(user_id);

-- タグはユーザーごとの名前空間を持つ。
CREATE TABLE tags (
  id       TEXT PRIMARY KEY,              -- UUIDv7
  owner_id TEXT NOT NULL,
  name     TEXT NOT NULL,
  UNIQUE (owner_id, name)
);
CREATE TABLE photo_tags (
  photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  tag_id   TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (photo_id, tag_id)
);
CREATE INDEX idx_photo_tags_tag ON photo_tags(tag_id);
