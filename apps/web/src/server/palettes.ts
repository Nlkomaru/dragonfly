// カラーパレットの D1 アクセス。server/photos.ts と同じく、所有者 (ownerId) を必ず引数で受ける。
//
// パレットの抽出そのものはブラウザ側の仕事（AVIF をデコードできるのがそこだけ）で、
// ここは受け取った値を保管して返すだけ。中身の妥当性は api/schemas.ts の zod が見る。

import type { ApiPhotoPalette, PaletteSwatch } from "@dragonfly/core";
import { and, eq, inArray } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DrizzleDb } from "../db/client";
import { photoPalettes, photos } from "../db/schema";

/**
 * そのユーザーの全パレットを返す。
 * /groups は距離行列を作るために全件を必要とするので、ページングは設けていない。
 *
 * swatches は JSON 文字列で入っている。書き込み時に zod を通した値しか入らないので
 * 壊れている想定は無いが、1 行でも parse に失敗すると一覧全体が 500 になり、
 * その写真を再抽出する経路（この API の応答に含まれないものを抽出する）にすら
 * 辿り着けなくなる。壊れた行は落として返し、クライアントの再抽出で直させる。
 */
export async function listPalettes(
  db: DrizzleDb,
  ownerId: string,
): Promise<ApiPhotoPalette[]> {
  const rows = await db
    .select({
      photoId: photoPalettes.photoId,
      version: photoPalettes.version,
      swatches: photoPalettes.swatches,
    })
    .from(photoPalettes)
    .where(eq(photoPalettes.ownerId, ownerId));

  const palettes: ApiPhotoPalette[] = [];
  for (const row of rows) {
    try {
      palettes.push({
        photoId: row.photoId,
        version: row.version,
        swatches: JSON.parse(row.swatches) as PaletteSwatch[],
      });
    } catch {
      // 返さなければクライアントは「未抽出」として扱い、抽出し直して上書きしてくれる。
      console.error("skipped a broken palette row", row.photoId);
    }
  }
  return palettes;
}

/**
 * パレットをまとめて upsert し、実際に保存できた件数を返す。
 *
 * photo_id は写真の実在と所有を必ず先に確かめる。ここを飛ばすと
 * (1) 存在しない写真 ID で外部キー制約に当たって batch ごと落ちる
 * (2) 他人の写真 ID に対する成否が「保存できた件数」から漏れる
 * の 2 つが起きる。通らなかったものは黙って捨てる（404 も返さない）。
 *
 * 書き込む owner_id は解決済みの ownerId のみ。ボディの値は使わない。
 */
export async function upsertPalettes(
  db: DrizzleDb,
  ownerId: string,
  palettes: ApiPhotoPalette[],
): Promise<number> {
  if (palettes.length === 0) return 0;

  // 同じ photo_id が二度来ても行は 1 つなので、入口で後勝ちに畳んでおく。
  // 畳まないと同じ行を二重に数えて saved が実態より多くなる。
  const unique = new Map<string, ApiPhotoPalette>();
  for (const palette of palettes) unique.set(palette.photoId, palette);

  // 所有している写真だけを残す。findUploadedHashes と同じく、
  // 所有者条件込みの 1 クエリで引くので他人の写真は決して当たらない。
  const owned = await db
    .select({ id: photos.id })
    .from(photos)
    .where(and(eq(photos.ownerId, ownerId), inArray(photos.id, [...unique.keys()])));
  const ownedIds = new Set(owned.map((row) => row.id));

  const now = Date.now();
  const statements: BatchItem<"sqlite">[] = [];
  for (const palette of unique.values()) {
    if (!ownedIds.has(palette.photoId)) continue;
    const swatches = JSON.stringify(palette.swatches);
    statements.push(
      db
        .insert(photoPalettes)
        .values({
          photoId: palette.photoId,
          ownerId,
          version: palette.version,
          swatches,
          updatedAt: now,
        })
        // 抽出をやり直した結果で上書きする。owner_id は変わらないので触らない。
        .onConflictDoUpdate({
          target: photoPalettes.photoId,
          set: { version: palette.version, swatches, updatedAt: now },
        }),
    );
  }

  // batch() は 1 文以上を要求するので、1 件も通らなかったときは呼ばない。
  if (statements.length === 0) return 0;
  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  return statements.length;
}
