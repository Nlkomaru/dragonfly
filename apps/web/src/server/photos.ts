// 写真まわりの D1 アクセス。Drizzle 経由でのみ触り、ルート側にはクエリを書かない。
//
// すべての関数は「所有者 (ownerId) を必ず引数で受け取る」形にしてある。
// 認証済みユーザー以外のデータに触れる経路を型の上で作らないための約束事。

import type {
  ApiPhoto,
  ApiPhotoBlurhash,
  ListFacetsResponse,
  ListPhotosResponse,
  UploadPhotoMetadata,
} from "@dragonfly/core";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DrizzleDb } from "../db/client";
import {
  photoPalettes,
  photoPlayers,
  photoTags,
  photos,
  tags,
  vrcUsers,
  worlds,
} from "../db/schema";
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
  authorId: photos.authorId,
  blurhash: photos.blurhash,
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
  authorId: string | null;
  blurhash: string | null;
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
  author: ApiPhoto["author"],
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
    author,
    players,
    tags: tagNames,
    // 未計算なら null。クライアントはそれを見て「後から埋める対象」だと判断する。
    blurhash: row.blurhash,
  };
}

/**
 * 1 クエリに入れる IN の要素数の上限。
 *
 * D1 は 1 クエリあたりのバインド変数を 100 個までしか受け付けず、超えると
 * クエリ自体が失敗する。owner_id のぶんを空けて余裕を持たせた値にしてある。
 * CHECK_HASH_LIMIT (500) はこの上限とは無関係に決まっているので、
 * ここで必ず分割すること。
 */
const D1_IN_CHUNK = 90;

/** IN に並べる値を D1 のバインド変数の上限に収まる長さへ割る。 */
function chunkForIn(values: string[]): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < values.length; i += D1_IN_CHUNK) {
    chunks.push(values.slice(i, i + D1_IN_CHUNK));
  }
  return chunks;
}

/** 送信済みハッシュの一括判定。所有者で絞るので他人の写真は決して当たらない。 */
export async function findUploadedHashes(
  db: DrizzleDb,
  ownerId: string,
  hashes: string[],
): Promise<string[]> {
  if (hashes.length === 0) return [];

  // D1 のバインド変数の上限に収まるように割ってから引く。
  const chunks = chunkForIn(hashes);

  const results = await Promise.all(
    chunks.map((chunk) =>
      db
        .select({ sourceSha256: photos.sourceSha256 })
        .from(photos)
        .where(and(eq(photos.ownerId, ownerId), inArray(photos.sourceSha256, chunk))),
    ),
  );
  return results.flat().map((row) => row.sourceSha256);
}

/**
 * 渡した写真 ID のうち、そのユーザーが実際に持っているものだけを返す。
 * 一括書き込みの前に「他人の写真 ID」と「存在しない ID」をまとめて落とすのに使う。
 *
 * findUploadedHashes と同じく必ず分割して引く。ID の件数 + owner_id が
 * D1 のバインド変数の上限を超えると、クエリ自体が失敗するため。
 */
async function findOwnedPhotoIds(
  db: DrizzleDb,
  ownerId: string,
  photoIds: string[],
): Promise<Set<string>> {
  if (photoIds.length === 0) return new Set();

  const results = await Promise.all(
    chunkForIn(photoIds).map((chunk) =>
      db
        .select({ id: photos.id })
        .from(photos)
        .where(and(eq(photos.ownerId, ownerId), inArray(photos.id, chunk))),
    ),
  );
  return new Set(results.flat().map((row) => row.id));
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
 * 再送で既存行に当たったときに、まだ空の blurhash だけを埋める。
 *
 * WHERE に IS NULL を付けるのが要。blurhash を計算できない古いデスクトップからの再送でも
 * 既に入っている値を消さないため、上書きではなく「空のときだけ書く」にしてある。
 * 送られてこなかった場合 (undefined) は何もしない。
 */
async function fillMissingBlurhash(
  db: DrizzleDb,
  photoId: string,
  blurhash: string | undefined,
): Promise<void> {
  if (!blurhash) return;
  await db
    .update(photos)
    .set({ blurhash })
    .where(and(eq(photos.id, photoId), isNull(photos.blurhash)));
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
  if (duplicate) {
    // 行は増やさないが、blurhash を持たない時代に入った写真はこの再送で埋まる。
    await fillMissingBlurhash(db, duplicate, metadata.blurhash);
    return { id: duplicate, deduplicated: true };
  }

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
      // 計算できたときだけ載ってくる。無ければ null のままで、後から Web 側が埋める。
      blurhash: metadata.blurhash ?? null,
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
    if (existing) {
      // 競り勝った側が blurhash を入れているとは限らないので、こちらでも埋めておく。
      await fillMissingBlurhash(db, existing, metadata.blurhash);
      return { id: existing, deduplicated: true };
    }
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
    // 撮影者は photo_players に入らず photos.author_id にだけ載る。
    // 「その人が写っている写真」を探すとき、自分で撮った分が落ちるのは直感に反するので
    // 同席者と撮影者のどちらかに一致すれば拾う。
    const byPlayer = or(
      sql`EXISTS (SELECT 1 FROM photo_players pp WHERE pp.photo_id = ${photos.id} AND pp.user_id = ${filters.playerId})`,
      eq(photos.authorId, filters.playerId),
    );
    if (byPlayer) conditions.push(byPlayer);
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
          relations.authors.get(row.id) ?? null,
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
): Promise<{
  players: Map<string, ApiPhoto["players"]>;
  authors: Map<string, NonNullable<ApiPhoto["author"]>>;
  tags: Map<string, string[]>;
}> {
  const players = new Map<string, ApiPhoto["players"]>();
  const authors = new Map<string, NonNullable<ApiPhoto["author"]>>();
  const tagNames = new Map<string, string[]>();
  if (photoIds.length === 0) return { players, authors, tags: tagNames };
  const [playerRows, authorRows, tagRows] = await db.batch([
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
      .select({
        photoId: photos.id,
        id: vrcUsers.id,
        displayName: vrcUsers.displayName,
      })
      .from(photos)
      .innerJoin(vrcUsers, eq(vrcUsers.id, photos.authorId))
      .where(inArray(photos.id, photoIds)),
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
  for (const row of authorRows) {
    authors.set(row.photoId, { id: row.id, displayName: row.displayName });
  }
  for (const row of tagRows) {
    const list = tagNames.get(row.photoId) ?? [];
    list.push(row.name);
    tagNames.set(row.photoId, list);
  }
  return { players, authors, tags: tagNames };
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
    relations.authors.get(row.id) ?? null,
    relations.tags.get(row.id) ?? [],
    signingSecret,
  );
}

/**
 * 写真 1 枚のタグを、渡された配列でまるごと置き換える。
 * 差分を取らず全消し・全入れにしているのは、タグが数個しかない前提で、
 * 差分計算を持ち込むより「送った通りになる」ほうが扱いを間違えにくいため。
 *
 * 戻り値は反映後のタグ。写真が存在しない（他人のものを含む）なら null。
 */
export async function setPhotoTags(
  db: DrizzleDb,
  ownerId: string,
  photoId: string,
  tagNames: string[],
): Promise<string[] | null> {
  // 所有者の写真であることを先に確かめる。ここを飛ばすと、
  // 認証さえ通れば他人の写真 ID にタグを付けられてしまう。
  const owned = await db
    .select({ id: photos.id })
    .from(photos)
    .where(and(eq(photos.id, photoId), eq(photos.ownerId, ownerId)))
    .limit(1);
  if (!owned[0]) return null;

  const statements: BatchItem<"sqlite">[] = [
    db.delete(photoTags).where(eq(photoTags.photoId, photoId)),
  ];

  for (const tag of tagNames) {
    // insertPhoto と同じ書き方。batch の中では insert の結果を読み戻せないので、
    // 「入れる」→「名前で引いて紐づける」の 2 文に分ける。
    statements.push(
      db.insert(tags).values({ id: uuidv7(), ownerId, name: tag }).onConflictDoNothing(),
      db
        .insert(photoTags)
        .values({
          photoId,
          tagId: sql`(SELECT id FROM tags WHERE owner_id = ${ownerId} AND name = ${tag})`,
        })
        .onConflictDoNothing(),
    );
  }

  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  return tagNames;
}

/**
 * そのユーザーが使ったことのあるタグ名を全部返す。入力補完に使う。
 * 写真から外れて誰にも使われていないタグも残るが、
 * それはユーザー自身の語彙なので候補として出したままにする。
 */
export async function listTags(db: DrizzleDb, ownerId: string): Promise<string[]> {
  const rows = await db
    .select({ name: tags.name })
    .from(tags)
    .where(eq(tags.ownerId, ownerId))
    .orderBy(tags.name);
  return rows.map((row) => row.name);
}

/**
 * 絞り込みの選択肢に出す上限。写真の多いものから順に返し、あふれた分は捨てる。
 * 個人のライブラリならこの数で足りる想定なので、サーバー側の検索は用意していない。
 */
const FACET_LIMIT = 300;

/**
 * ワールドと VRChat ユーザーの一覧を、そのユーザーの写真から作る。
 * ID を覚えていなくても名前で絞り込めるようにするための選択肢。
 *
 * worlds / vrc_users は所有者を持たない共有テーブルなので、必ず photos 側で
 * owner_id を効かせる。直接引くと他人の写真に出てくる名前まで漏れる。
 */
export async function listFacets(
  db: DrizzleDb,
  ownerId: string,
): Promise<ListFacetsResponse> {
  // ワールド名は photos に非正規化されているので、worlds への join は要らない。
  const worldRows = await db
    .select({
      id: photos.worldId,
      // 名前が変わっていても 1 つに寄せる。
      name: sql<string | null>`MAX(${photos.worldName})`,
      count: sql<number>`COUNT(*)`,
    })
    .from(photos)
    .where(and(eq(photos.ownerId, ownerId), isNotNull(photos.worldId)))
    .groupBy(photos.worldId)
    .orderBy(sql`COUNT(*) DESC`)
    .limit(FACET_LIMIT);

  // 同席者と撮影者を 1 つの集合にまとめる。listPhotos の player 絞り込みが
  // 両方を見るので、選択肢もそれに揃える（片方だけだと 0 件になる候補が出る）。
  const playerRows = await db.all<{ id: string; displayName: string; count: number }>(sql`
    SELECT u.id AS id, u.display_name AS displayName, COUNT(*) AS count
    FROM (
      SELECT pp.user_id AS user_id, pp.photo_id AS photo_id
      FROM photo_players pp
      JOIN photos p ON p.id = pp.photo_id
      WHERE p.owner_id = ${ownerId}
      UNION
      SELECT p.author_id AS user_id, p.id AS photo_id
      FROM photos p
      WHERE p.owner_id = ${ownerId} AND p.author_id IS NOT NULL
    ) AS pairs
    JOIN vrc_users u ON u.id = pairs.user_id
    GROUP BY u.id
    ORDER BY count DESC
    LIMIT ${FACET_LIMIT}
  `);

  return {
    worlds: worldRows.flatMap((row) =>
      // isNotNull で除いてあるが、型の上では null が残るのでここでも落とす。
      row.id ? [{ id: row.id, name: row.name ?? "", count: Number(row.count) }] : [],
    ),
    players: playerRows.map((row) => ({
      id: row.id,
      displayName: row.displayName,
      count: Number(row.count),
    })),
  };
}

/** R2 のキーと現在の解像度を引く。所有者条件込みなので、権限チェックを兼ねる。 */
export async function findPhotoKeys(
  db: DrizzleDb,
  ownerId: string,
  photoId: string,
): Promise<{ r2Key: string; thumbKey: string | null; width: number; height: number } | null> {
  const rows = await db
    .select({
      r2Key: photos.r2Key,
      thumbKey: photos.thumbKey,
      width: photos.width,
      height: photos.height,
    })
    .from(photos)
    .where(and(eq(photos.id, photoId), eq(photos.ownerId, ownerId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * R2 上の実体を回転した後の行の更新。
 *
 * 90 / 270 度では width と height が入れ替わり、再エンコードで byteSize も変わる。
 * blurhash は空間情報なので回転で無効になる。null に戻せば、ギャラリーを開いたときに
 * ブラウザ側のバックフィルが新しいサムネイルから計算し直す（upsertBlurhashes 参照）。
 * パレット / ヒストグラムは色分布で回転不変なので触らない。
 */
export async function applyPhotoRotation(
  db: DrizzleDb,
  ownerId: string,
  photoId: string,
  update: { width: number; height: number; byteSize: number },
): Promise<void> {
  await db
    .update(photos)
    .set({ ...update, blurhash: null })
    .where(and(eq(photos.id, photoId), eq(photos.ownerId, ownerId)));
}

/**
 * 写真を削除する。photo_players / photo_tags / photo_palettes は ON DELETE CASCADE で
 * 消えるが、D1 は既定で外部キーが有効でない場合があるため、明示的に同じ batch で消しておく。
 * 特にパレットは owner_id だけで一覧されるので、残ると /groups が実体の無い写真を掴む。
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
    db.delete(photoPalettes).where(eq(photoPalettes.photoId, photoId)),
    db.delete(photos).where(and(eq(photos.id, photoId), eq(photos.ownerId, ownerId))),
  ]);
  return keys;
}

/**
 * source_sha256 から引いて削除する。消すものも戻り値も id 版とまったく同じで、
 * 行の特定の仕方だけが違う。
 *
 * デスクトップはサーバー側の写真 ID を持たない（アップロード後に覚えていない）ので、
 * 手元で計算できる変換前 PNG のハッシュから消せる経路を用意している。
 * (owner_id, source_sha256) は一意索引なので、当たる行は高々 1 つ。
 */
export async function deletePhotoBySourceHash(
  db: DrizzleDb,
  ownerId: string,
  sourceSha256: string,
): Promise<{ r2Key: string; thumbKey: string | null } | null> {
  const photoId = await findPhotoIdByHash(db, ownerId, sourceSha256);
  // 他人の写真のハッシュを指された場合もここに来る。存在の有無は漏らさない。
  if (!photoId) return null;
  // 削除そのものは id 版に任せる。消し忘れるテーブルが片方だけ出るのを防ぐため。
  return deletePhoto(db, ownerId, photoId);
}

/**
 * BlurHash をまとめて書き込み、実際に保存できた件数を返す。
 *
 * blurhash は写真の側テーブルではなく photos の 1 列なので、パレットと違って
 * ここ（server/photos.ts）に置いている。ルータだけは api/blurhashes.ts に分けてある。
 *
 * 計算はサムネイル (AVIF) をデコードできるブラウザ側の仕事で、サーバーは置くだけ。
 * 自分が所有していない写真 ID は黙って捨てる（他人の写真の存在を漏らさないため、
 * 404 にはせず saved の件数だけが減る）。
 */
export async function upsertBlurhashes(
  db: DrizzleDb,
  ownerId: string,
  blurhashes: ApiPhotoBlurhash[],
): Promise<number> {
  if (blurhashes.length === 0) return 0;

  // 同じ photo_id が二度来ても列は 1 つなので、入口で後勝ちに畳んでおく。
  // 畳まないと同じ行を二重に数えて saved が実態より多くなる。
  const unique = new Map<string, string>();
  for (const entry of blurhashes) unique.set(entry.photoId, entry.blurhash);

  const ownedIds = await findOwnedPhotoIds(db, ownerId, [...unique.keys()]);

  const statements: BatchItem<"sqlite">[] = [];
  for (const [photoId, blurhash] of unique) {
    if (!ownedIds.has(photoId)) continue;
    // insertPhoto の fillMissingBlurhash と違い、ここは IS NULL で絞らない。
    // 呼び出し元は「今のアルゴリズムで計算し直した値」を送ってくるので、上書きが正しい。
    statements.push(
      db
        .update(photos)
        .set({ blurhash })
        .where(and(eq(photos.id, photoId), eq(photos.ownerId, ownerId))),
    );
  }

  // batch() は 1 文以上を要求するので、1 件も通らなかったときは呼ばない。
  if (statements.length === 0) return 0;
  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  return statements.length;
}
