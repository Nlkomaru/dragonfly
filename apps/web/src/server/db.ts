// D1 への SQL アクセスを閉じ込める層。ルート側には生の SQL を書かない。
// すべての関数は「所有者 (ownerId / userId) を必ず引数で受け取る」形にしてある。
// 認証済みユーザー以外のデータに触れる経路を型の上で作らないための約束事。

import type {
  ApiKeySummary,
  ApiPhoto,
  CreateApiKeyResponse,
  ListPhotosResponse,
  UploadPhotoMetadata,
} from "@dragonfly/core";
import { generateRawApiKey, sha256Hex, uuidv7 } from "./ids";

/** 一覧の 1 ページあたりの件数。 */
const PAGE_SIZE = 60;

/** photos テーブルの行。camelCase 変換は toApiPhoto に集約する。 */
interface PhotoRow {
  id: string;
  source_sha256: string;
  thumb_key: string | null;
  taken_at: number;
  width: number;
  height: number;
  byte_size: number;
  world_id: string | null;
  world_name: string | null;
  instance_id: string | null;
}

interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

/** R2 のオブジェクトキー。内容アドレスなので上書きしても同じ中身になる。 */
export function photoKeys(ownerId: string, sha256: string): { r2Key: string; thumbKey: string } {
  return {
    r2Key: `photos/${ownerId}/${sha256}.avif`,
    thumbKey: `thumbs/${ownerId}/${sha256}.avif`,
  };
}

function toApiPhoto(row: PhotoRow, players: ApiPhoto["players"], tags: string[]): ApiPhoto {
  return {
    id: row.id,
    sourceSha256: row.source_sha256,
    // 画像は Bearer 認証付きの API 経由でしか取れない。R2 のキーは外に出さない。
    url: `/api/photos/${row.id}/image`,
    thumbUrl: `/api/photos/${row.id}/thumb`,
    takenAt: row.taken_at,
    width: row.width,
    height: row.height,
    byteSize: row.byte_size,
    world: row.world_id
      ? { id: row.world_id, name: row.world_name ?? "", instanceId: row.instance_id ?? "" }
      : null,
    players,
    tags,
  };
}

function toApiKeySummary(row: ApiKeyRow): ApiKeySummary {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

// ---------------------------------------------------------------------------
// ユーザー / API キー
// ---------------------------------------------------------------------------

export async function findUser(
  db: D1Database,
  userId: string,
): Promise<{ id: string; displayName: string } | null> {
  const row = await db
    .prepare("SELECT id, display_name FROM users WHERE id = ?")
    .bind(userId)
    .first<{ id: string; display_name: string }>();
  return row ? { id: row.id, displayName: row.display_name } : null;
}

/** 提示された鍵のハッシュから有効な鍵を引く。失効済み (revoked_at) は対象外。 */
export async function findActiveApiKey(
  db: D1Database,
  keyHash: string,
): Promise<{ id: string; userId: string } | null> {
  const row = await db
    .prepare("SELECT id, user_id FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL")
    .bind(keyHash)
    .first<{ id: string; user_id: string }>();
  return row ? { id: row.id, userId: row.user_id } : null;
}

/** 最終利用時刻の更新。応答をブロックしない前提で呼ばれる。 */
export function touchApiKey(db: D1Database, keyId: string, now: number): Promise<unknown> {
  return db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(now, keyId).run();
}

export async function listApiKeys(db: D1Database, userId: string): Promise<ApiKeySummary[]> {
  const result = await db
    .prepare(
      `SELECT id, name, prefix, created_at, last_used_at, revoked_at
       FROM api_keys WHERE user_id = ? ORDER BY created_at DESC`,
    )
    .bind(userId)
    .all<ApiKeyRow>();
  return result.results.map(toApiKeySummary);
}

/** 鍵を発行する。生の鍵を返すのはこの瞬間だけで、DB には SHA-256 しか残さない。 */
export async function createApiKey(
  db: D1Database,
  userId: string,
  name: string,
): Promise<CreateApiKeyResponse> {
  const rawKey = generateRawApiKey();
  const keyHash = await sha256Hex(rawKey);
  const row: ApiKeyRow = {
    id: uuidv7(),
    name,
    prefix: rawKey.slice(0, 8),
    created_at: Date.now(),
    last_used_at: null,
    revoked_at: null,
  };
  await db
    .prepare(
      `INSERT INTO api_keys (id, user_id, name, key_hash, prefix, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(row.id, userId, row.name, keyHash, row.prefix, row.created_at)
    .run();
  return { key: toApiKeySummary(row), rawKey };
}

/** 失効させる。監査のため行は消さず revoked_at を立てるだけ。 */
export async function revokeApiKey(
  db: D1Database,
  userId: string,
  keyId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
    )
    .bind(Date.now(), keyId, userId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// 写真
// ---------------------------------------------------------------------------

/** 送信済みハッシュの一括判定。所有者で絞るので他人の写真は決して当たらない。 */
export async function findUploadedHashes(
  db: D1Database,
  ownerId: string,
  hashes: string[],
): Promise<string[]> {
  if (hashes.length === 0) return [];
  const placeholders = hashes.map(() => "?").join(",");
  const result = await db
    .prepare(
      `SELECT source_sha256 FROM photos WHERE owner_id = ? AND source_sha256 IN (${placeholders})`,
    )
    .bind(ownerId, ...hashes)
    .all<{ source_sha256: string }>();
  return result.results.map((row) => row.source_sha256);
}

/**
 * 写真 1 枚分の行をまとめて書き込む。
 * 複数テーブルにまたがるので batch() で 1 トランザクションにし、
 * 途中で失敗しても孤児行が残らないようにする。
 * 既に同じ (owner_id, source_sha256) があれば何も増えず、既存 ID を返す（冪等）。
 */
export async function insertPhoto(
  db: D1Database,
  ownerId: string,
  metadata: UploadPhotoMetadata,
  byteSize: number,
): Promise<{ id: string; deduplicated: boolean }> {
  // 既に同じ写真があるなら何も書かずに既存 ID を返す。
  // 先に確かめておかないと、batch の後続文が「存在しない photo_id」の関連行を作ってしまう。
  const duplicate = await findPhotoIdByHash(db, ownerId, metadata.sourceSha256);
  if (duplicate) return { id: duplicate, deduplicated: true };

  const now = Date.now();
  const photoId = uuidv7();
  const { r2Key, thumbKey } = photoKeys(ownerId, metadata.sourceSha256);
  const { world, players, author } = metadata.vrcx;

  const statements: D1PreparedStatement[] = [
    // 重複は UNIQUE 制約で必ず弾く。同時実行で競り負けたときは batch ごと失敗させ、
    // 中途半端な関連行が残らないようにする（下の catch で重複として扱い直す）。
    db
      .prepare(
        `INSERT INTO photos
           (id, owner_id, source_sha256, r2_key, thumb_key, taken_at, width, height,
            byte_size, world_id, world_name, instance_id, author_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        photoId,
        ownerId,
        metadata.sourceSha256,
        r2Key,
        thumbKey,
        metadata.takenAt,
        metadata.width,
        metadata.height,
        byteSize,
        world.id,
        world.name,
        world.instanceId,
        author.id,
        now,
      ),
    db
      .prepare(
        `INSERT INTO worlds (id, name, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
      )
      .bind(world.id, world.name, now),
  ];

  // 撮影者も同席者も vrc_users に載せる。表示名は最新のもので上書きする。
  const vrcUsers = [author, ...players];
  for (const player of vrcUsers) {
    statements.push(
      db
        .prepare(
          `INSERT INTO vrc_users (id, display_name, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at`,
        )
        .bind(player.id, player.displayName, now),
    );
  }
  for (const player of players) {
    statements.push(
      db
        .prepare("INSERT OR IGNORE INTO photo_players (photo_id, user_id) VALUES (?, ?)")
        .bind(photoId, player.id),
    );
  }

  for (const tag of metadata.tags ?? []) {
    // タグは (owner_id, name) が一意。batch 内では読めないので
    // INSERT OR IGNORE → SELECT で ID を引く 2 文に分ける。
    statements.push(
      db
        .prepare("INSERT OR IGNORE INTO tags (id, owner_id, name) VALUES (?, ?, ?)")
        .bind(uuidv7(), ownerId, tag),
      db
        .prepare(
          `INSERT OR IGNORE INTO photo_tags (photo_id, tag_id)
           SELECT ?, id FROM tags WHERE owner_id = ? AND name = ?`,
        )
        .bind(photoId, ownerId, tag),
    );
  }

  try {
    await db.batch(statements);
    return { id: photoId, deduplicated: false };
  } catch (error) {
    // 同じ写真が並行して入った場合だけ重複として扱う。R2 は内容アドレスなので実体は同一。
    const existing = await findPhotoIdByHash(db, ownerId, metadata.sourceSha256);
    if (existing) return { id: existing, deduplicated: true };
    throw error;
  }
}

/** (owner_id, source_sha256) から既存の写真 ID を引く。冪等判定に使う。 */
async function findPhotoIdByHash(
  db: D1Database,
  ownerId: string,
  sha256: string,
): Promise<string | null> {
  const row = await db
    .prepare("SELECT id FROM photos WHERE owner_id = ? AND source_sha256 = ?")
    .bind(ownerId, sha256)
    .first<{ id: string }>();
  return row?.id ?? null;
}

export interface ListPhotosFilters {
  worldId?: string;
  playerId?: string;
  tag?: string;
  from?: number;
  to?: number;
  cursor?: string;
}

/** カーソルは `takenAt:id` を base64 にしただけの不透明な文字列。 */
function encodeCursor(takenAt: number, id: string): string {
  return btoa(`${takenAt}:${id}`);
}

function decodeCursor(cursor: string): { takenAt: number; id: string } | null {
  try {
    const [takenAt, id] = atob(cursor).split(":");
    if (!takenAt || !id) return null;
    return { takenAt: Number(takenAt), id };
  } catch {
    return null;
  }
}

export async function listPhotos(
  db: D1Database,
  ownerId: string,
  filters: ListPhotosFilters,
): Promise<ListPhotosResponse> {
  const conditions = ["p.owner_id = ?"];
  const bindings: unknown[] = [ownerId];

  if (filters.worldId) {
    conditions.push("p.world_id = ?");
    bindings.push(filters.worldId);
  }
  if (filters.playerId) {
    conditions.push("EXISTS (SELECT 1 FROM photo_players pp WHERE pp.photo_id = p.id AND pp.user_id = ?)");
    bindings.push(filters.playerId);
  }
  if (filters.tag) {
    // タグ名はユーザーごとの名前空間なので owner_id でも絞る。
    conditions.push(
      `EXISTS (SELECT 1 FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id
               WHERE pt.photo_id = p.id AND t.owner_id = ? AND t.name = ?)`,
    );
    bindings.push(ownerId, filters.tag);
  }
  if (filters.from !== undefined) {
    conditions.push("p.taken_at >= ?");
    bindings.push(filters.from);
  }
  if (filters.to !== undefined) {
    conditions.push("p.taken_at <= ?");
    bindings.push(filters.to);
  }

  const cursor = filters.cursor ? decodeCursor(filters.cursor) : null;
  if (cursor) {
    // taken_at が同値でも順序が決まるよう、id も比較に含める。
    conditions.push("(p.taken_at < ? OR (p.taken_at = ? AND p.id < ?))");
    bindings.push(cursor.takenAt, cursor.takenAt, cursor.id);
  }

  // 次ページの有無を知るために 1 件多く取る。
  const result = await db
    .prepare(
      `SELECT p.id, p.source_sha256, p.thumb_key, p.taken_at, p.width, p.height,
              p.byte_size, p.world_id, p.world_name, p.instance_id
       FROM photos p
       WHERE ${conditions.join(" AND ")}
       ORDER BY p.taken_at DESC, p.id DESC
       LIMIT ?`,
    )
    .bind(...bindings, PAGE_SIZE + 1)
    .all<PhotoRow>();

  const rows = result.results.slice(0, PAGE_SIZE);
  const hasMore = result.results.length > PAGE_SIZE;
  const relations = await loadRelations(db, ownerId, rows.map((row) => row.id));
  const photos = rows.map((row) =>
    toApiPhoto(row, relations.players.get(row.id) ?? [], relations.tags.get(row.id) ?? []),
  );
  const last = rows[rows.length - 1];
  return {
    photos,
    nextCursor: hasMore && last ? encodeCursor(last.taken_at, last.id) : null,
  };
}

/** 一覧・詳細で使う同席者とタグをまとめて引く（N+1 を避ける）。 */
async function loadRelations(
  db: D1Database,
  ownerId: string,
  photoIds: string[],
): Promise<{ players: Map<string, ApiPhoto["players"]>; tags: Map<string, string[]> }> {
  const players = new Map<string, ApiPhoto["players"]>();
  const tags = new Map<string, string[]>();
  if (photoIds.length === 0) return { players, tags };

  const placeholders = photoIds.map(() => "?").join(",");
  const [playerResult, tagResult] = await db.batch<Record<string, string>>([
    db
      .prepare(
        `SELECT pp.photo_id, u.id, u.display_name
         FROM photo_players pp JOIN vrc_users u ON u.id = pp.user_id
         WHERE pp.photo_id IN (${placeholders})`,
      )
      .bind(...photoIds),
    db
      .prepare(
        `SELECT pt.photo_id, t.name
         FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id
         WHERE pt.photo_id IN (${placeholders}) AND t.owner_id = ?`,
      )
      .bind(...photoIds, ownerId),
  ]);

  for (const row of playerResult.results) {
    const list = players.get(row.photo_id) ?? [];
    list.push({ id: row.id, displayName: row.display_name });
    players.set(row.photo_id, list);
  }
  for (const row of tagResult.results) {
    const list = tags.get(row.photo_id) ?? [];
    list.push(row.name);
    tags.set(row.photo_id, list);
  }
  return { players, tags };
}

export async function getPhoto(
  db: D1Database,
  ownerId: string,
  photoId: string,
): Promise<ApiPhoto | null> {
  const row = await db
    .prepare(
      `SELECT id, source_sha256, thumb_key, taken_at, width, height,
              byte_size, world_id, world_name, instance_id
       FROM photos WHERE id = ? AND owner_id = ?`,
    )
    .bind(photoId, ownerId)
    .first<PhotoRow>();
  if (!row) return null;
  const relations = await loadRelations(db, ownerId, [row.id]);
  return toApiPhoto(row, relations.players.get(row.id) ?? [], relations.tags.get(row.id) ?? []);
}

/** R2 のキーだけを引く。画像配信で所有者チェックを兼ねる。 */
export async function findPhotoKeys(
  db: D1Database,
  ownerId: string,
  photoId: string,
): Promise<{ r2Key: string; thumbKey: string | null } | null> {
  const row = await db
    .prepare("SELECT r2_key, thumb_key FROM photos WHERE id = ? AND owner_id = ?")
    .bind(photoId, ownerId)
    .first<{ r2_key: string; thumb_key: string | null }>();
  return row ? { r2Key: row.r2_key, thumbKey: row.thumb_key } : null;
}

/**
 * 写真を削除する。photo_players / photo_tags は ON DELETE CASCADE で消えるが、
 * D1 は既定で外部キーが有効でない場合があるため、明示的に同じ batch で消しておく。
 */
export async function deletePhoto(
  db: D1Database,
  ownerId: string,
  photoId: string,
): Promise<{ r2Key: string; thumbKey: string | null } | null> {
  const keys = await findPhotoKeys(db, ownerId, photoId);
  if (!keys) return null;
  await db.batch([
    db.prepare("DELETE FROM photo_players WHERE photo_id = ?").bind(photoId),
    db.prepare("DELETE FROM photo_tags WHERE photo_id = ?").bind(photoId),
    db.prepare("DELETE FROM photos WHERE id = ? AND owner_id = ?").bind(photoId, ownerId),
  ]);
  return keys;
}
