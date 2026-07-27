// 写真まわりの D1 アクセス。Drizzle 経由でのみ触り、ルート側にはクエリを書かない。
//
// すべての関数は「所有者 (ownerId) を必ず引数で受け取る」形にしてある。
// 認証済みユーザー以外のデータに触れる経路を型の上で作らないための約束事。

import type { ApiPhoto, ListPhotosResponse, UploadPhotoMetadata } from "@dragonfly/core";
import { and, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DrizzleDb } from "../db/client";
import { photoPlayers, photoTags, photos, tags, vrcUsers, worlds } from "../db/schema";
import { uuidv7 } from "./ids";
import { buildSignedPhotoUrl, photoUrlExpiry } from "./signedUrl";

/** 一覧の 1 ページあたりの件数。 */
const PAGE_SIZE = 60;

/** R2 のオブジェクトキー。内容アドレスなので上書きしても同じ中身になる。 */
export function photoKeys(ownerId: string, sha256: string): { r2Key: string; thumbKey: string } {
  return {
    r2Key: `photos/${ownerId}/${sha256}.avif`,
    thumbKey: `thumbs/${ownerId}/${sha256}.avif`,
  };
}

/** 一覧・詳細で SELECT する列。ApiPhoto を組み立てるのに必要な分だけ。 */
const photoColumns = {
  id: photos.id,
  sourceSha256: photos.sourceSha256,
  takenAt: photos.takenAt,
  width: photos.width,
  height: photos.height,
  byteSize: photos.byteSize,
  worldId: photos.worldId,
  worldName: photos.worldName,
  instanceId: photos.instanceId,
};

/** photoColumns で SELECT した 1 行。NULL 許容はテーブル定義と揃えてある。 */
interface PhotoRow {
  id: string;
  sourceSha256: string;
  takenAt: number;
  width: number;
  height: number;
  byteSize: number;
  worldId: string | null;
  worldName: string | null;
  instanceId: string | null;
}

/**
 * 行を API のレスポンス形に直す。
 *
 * url / thumbUrl は「解決済みの所有者 ID」で組み立てる。`me` は書かない。
 * エイリアスのまま返すと、URL を別の文脈（キャッシュや共有）に持ち出したときに
 * 誰の写真か分からなくなるため。
 *
 * 画像パスには HMAC 署名と短い有効期限を付ける。ブラウザの <img src> は
 * Authorization を送れないので、クエリの署名だけで配信を許可する（issue #10）。
 */
async function toApiPhoto(
  ownerId: string,
  row: PhotoRow,
  players: ApiPhoto["players"],
  tagNames: string[],
  signingSecret: string,
): Promise<ApiPhoto> {
  // 本体とサムネは同じ exp にして、一覧の有効期限を揃える。
  const exp = photoUrlExpiry();
  const [url, thumbUrl] = await Promise.all([
    buildSignedPhotoUrl(signingSecret, ownerId, row.id, "image", exp),
    buildSignedPhotoUrl(signingSecret, ownerId, row.id, "thumb", exp),
  ]);
  return {
    id: row.id,
    sourceSha256: row.sourceSha256,
    url,
    thumbUrl,
    takenAt: row.takenAt,
    width: row.width,
    height: row.height,
    byteSize: row.byteSize,
    world: row.worldId
      ? { id: row.worldId, name: row.worldName ?? "", instanceId: row.instanceId ?? "" }
      : null,
    players,
    tags: tagNames,
  };
}

/** 送信済みハッシュの一括判定。所有者で絞るので他人の写真は決して当たらない。 */
export async function findUploadedHashes(
  db: DrizzleDb,
  ownerId: string,
  hashes: string[],
): Promise<string[]> {
  if (hashes.length === 0) return [];
  const rows = await db
    .select({ sourceSha256: photos.sourceSha256 })
    .from(photos)
    .where(and(eq(photos.ownerId, ownerId), inArray(photos.sourceSha256, hashes)));
  return rows.map((row) => row.sourceSha256);
}

/** (owner_id, source_sha256) から既存の写真 ID を引く。冪等判定に使う。 */
async function findPhotoIdByHash(
  db: DrizzleDb,
  ownerId: string,
  sha256: string,
): Promise<string | null> {
  const rows = await db
    .select({ id: photos.id })
    .from(photos)
    .where(and(eq(photos.ownerId, ownerId), eq(photos.sourceSha256, sha256)))
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * 写真 1 枚分の行をまとめて書き込む。
 * 複数テーブルにまたがるので D1 の batch() で 1 まとまりにし、
 * 途中で失敗しても孤児行が残らないようにする。
 * 既に同じ (owner_id, source_sha256) があれば何も増えず、既存 ID を返す（冪等）。
 */
export async function insertPhoto(
  db: DrizzleDb,
  ownerId: string,
  metadata: UploadPhotoMetadata,
  byteSize: number,
): Promise<{ id: string; deduplicated: boolean }> {
  // 先に確かめておかないと、batch の後続文が「存在しない photo_id」の関連行を作ってしまう。
  const duplicate = await findPhotoIdByHash(db, ownerId, metadata.sourceSha256);
  if (duplicate) return { id: duplicate, deduplicated: true };

  const now = Date.now();
  const photoId = uuidv7();
  const { r2Key, thumbKey } = photoKeys(ownerId, metadata.sourceSha256);
  const { world, players, author } = metadata.vrcx;

  // batch に渡す文の配列。テーブルごとに型が違うので BatchItem で受ける。
  const statements: BatchItem<"sqlite">[] = [
    // 重複は UNIQUE 制約で必ず弾く。同時実行で競り負けたときは batch ごと失敗させ、
    // 中途半端な関連行が残らないようにする（下の catch で重複として扱い直す）。
    db.insert(photos).values({
      id: photoId,
      ownerId,
      sourceSha256: metadata.sourceSha256,
      r2Key,
      thumbKey,
      takenAt: metadata.takenAt,
      width: metadata.width,
      height: metadata.height,
      byteSize,
      worldId: world.id,
      worldName: world.name,
      instanceId: world.instanceId,
      authorId: author.id,
      createdAt: now,
    }),
    db
      .insert(worlds)
      .values({ id: world.id, name: world.name, updatedAt: now })
      .onConflictDoUpdate({
        target: worlds.id,
        set: { name: world.name, updatedAt: now },
      }),
  ];

  // 撮影者も同席者も vrc_users に載せる。表示名は最新のもので上書きする。
  for (const player of [author, ...players]) {
    statements.push(
      db
        .insert(vrcUsers)
        .values({ id: player.id, displayName: player.displayName, updatedAt: now })
        .onConflictDoUpdate({
          target: vrcUsers.id,
          set: { displayName: player.displayName, updatedAt: now },
        }),
    );
  }
  for (const player of players) {
    statements.push(
      db
        .insert(photoPlayers)
        .values({ photoId, userId: player.id })
        .onConflictDoNothing(),
    );
  }

  for (const tag of metadata.tags ?? []) {
    // タグは (owner_id, name) が一意。batch の中では読み戻せないので、
    // 「入れる」→「名前で引いて紐づける」の 2 文に分ける。
    statements.push(
      db
        .insert(tags)
        .values({ id: uuidv7(), ownerId, name: tag })
        .onConflictDoNothing(),
      db
        .insert(photoTags)
        .values({
          photoId,
          tagId: sql`(SELECT id FROM tags WHERE owner_id = ${ownerId} AND name = ${tag})`,
        })
        .onConflictDoNothing(),
    );
  }

  try {
    // batch は「1 文以上」をタプルで要求する。写真の INSERT が必ず先頭にあるので、
    // 空でないことは自明。その事実を型に伝えるためだけのキャスト。
    await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
    return { id: photoId, deduplicated: false };
  } catch (error) {
    // 同じ写真が並行して入った場合だけ重複として扱う。R2 は内容アドレスなので実体は同一。
    const existing = await findPhotoIdByHash(db, ownerId, metadata.sourceSha256);
    if (existing) return { id: existing, deduplicated: true };
    throw error;
  }
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
    const value = Number(takenAt);
    return Number.isFinite(value) ? { takenAt: value, id } : null;
  } catch {
    return null;
  }
}

export async function listPhotos(
  db: DrizzleDb,
  ownerId: string,
  filters: ListPhotosFilters,
  signingSecret: string,
): Promise<ListPhotosResponse> {
  const conditions = [eq(photos.ownerId, ownerId)];

  if (filters.worldId) conditions.push(eq(photos.worldId, filters.worldId));
  if (filters.playerId) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM photo_players pp WHERE pp.photo_id = ${photos.id} AND pp.user_id = ${filters.playerId})`,
    );
  }
  if (filters.tag) {
    // タグ名はユーザーごとの名前空間なので owner_id でも絞る。
    conditions.push(
      sql`EXISTS (SELECT 1 FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id
                  WHERE pt.photo_id = ${photos.id} AND t.owner_id = ${ownerId} AND t.name = ${filters.tag})`,
    );
  }
  if (filters.from !== undefined) conditions.push(gte(photos.takenAt, filters.from));
  if (filters.to !== undefined) conditions.push(lte(photos.takenAt, filters.to));

  const cursor = filters.cursor ? decodeCursor(filters.cursor) : null;
  if (cursor) {
    // taken_at が同値でも順序が決まるよう、id も比較に含める。
    const next = or(
      sql`${photos.takenAt} < ${cursor.takenAt}`,
      and(eq(photos.takenAt, cursor.takenAt), sql`${photos.id} < ${cursor.id}`),
    );
    if (next) conditions.push(next);
  }

  // 次ページの有無を知るために 1 件多く取る。
  const found = await db
    .select(photoColumns)
    .from(photos)
    .where(and(...conditions))
    .orderBy(desc(photos.takenAt), desc(photos.id))
    .limit(PAGE_SIZE + 1);

  const rows = found.slice(0, PAGE_SIZE);
  const hasMore = found.length > PAGE_SIZE;
  const relations = await loadRelations(db, ownerId, rows.map((row) => row.id));
  const last = rows[rows.length - 1];
  return {
    photos: await Promise.all(
      rows.map((row) =>
        toApiPhoto(
          ownerId,
          row,
          relations.players.get(row.id) ?? [],
          relations.tags.get(row.id) ?? [],
          signingSecret,
        ),
      ),
    ),
    nextCursor: hasMore && last ? encodeCursor(last.takenAt, last.id) : null,
  };
}

/** 一覧・詳細で使う同席者とタグをまとめて引く（N+1 を避ける）。 */
async function loadRelations(
  db: DrizzleDb,
  ownerId: string,
  photoIds: string[],
): Promise<{ players: Map<string, ApiPhoto["players"]>; tags: Map<string, string[]> }> {
  const players = new Map<string, ApiPhoto["players"]>();
  const tagNames = new Map<string, string[]>();
  if (photoIds.length === 0) return { players, tags: tagNames };

  const [playerRows, tagRows] = await db.batch([
    db
      .select({
        photoId: photoPlayers.photoId,
        id: vrcUsers.id,
        displayName: vrcUsers.displayName,
      })
      .from(photoPlayers)
      .innerJoin(vrcUsers, eq(vrcUsers.id, photoPlayers.userId))
      .where(inArray(photoPlayers.photoId, photoIds)),
    db
      .select({ photoId: photoTags.photoId, name: tags.name })
      .from(photoTags)
      .innerJoin(tags, eq(tags.id, photoTags.tagId))
      .where(and(inArray(photoTags.photoId, photoIds), eq(tags.ownerId, ownerId))),
  ]);

  for (const row of playerRows) {
    const list = players.get(row.photoId) ?? [];
    list.push({ id: row.id, displayName: row.displayName });
    players.set(row.photoId, list);
  }
  for (const row of tagRows) {
    const list = tagNames.get(row.photoId) ?? [];
    list.push(row.name);
    tagNames.set(row.photoId, list);
  }
  return { players, tags: tagNames };
}

export async function getPhoto(
  db: DrizzleDb,
  ownerId: string,
  photoId: string,
  signingSecret: string,
): Promise<ApiPhoto | null> {
  const rows = await db
    .select(photoColumns)
    .from(photos)
    .where(and(eq(photos.id, photoId), eq(photos.ownerId, ownerId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const relations = await loadRelations(db, ownerId, [row.id]);
  return toApiPhoto(
    ownerId,
    row,
    relations.players.get(row.id) ?? [],
    relations.tags.get(row.id) ?? [],
    signingSecret,
  );
}

/** R2 のキーだけを引く。所有者条件込みなので、画像配信の権限チェックを兼ねる。 */
export async function findPhotoKeys(
  db: DrizzleDb,
  ownerId: string,
  photoId: string,
): Promise<{ r2Key: string; thumbKey: string | null } | null> {
  const rows = await db
    .select({ r2Key: photos.r2Key, thumbKey: photos.thumbKey })
    .from(photos)
    .where(and(eq(photos.id, photoId), eq(photos.ownerId, ownerId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * 写真を削除する。photo_players / photo_tags は ON DELETE CASCADE で消えるが、
 * D1 は既定で外部キーが有効でない場合があるため、明示的に同じ batch で消しておく。
 */
export async function deletePhoto(
  db: DrizzleDb,
  ownerId: string,
  photoId: string,
): Promise<{ r2Key: string; thumbKey: string | null } | null> {
  const keys = await findPhotoKeys(db, ownerId, photoId);
  if (!keys) return null;
  await db.batch([
    db.delete(photoPlayers).where(eq(photoPlayers.photoId, photoId)),
    db.delete(photoTags).where(eq(photoTags.photoId, photoId)),
    db.delete(photos).where(and(eq(photos.id, photoId), eq(photos.ownerId, ownerId))),
  ]);
  return keys;
}
