// サインインを許可する Discord ユーザーの判定。
//
// 誰でも Discord さえ持っていれば入れてしまうのを防ぐため、明示的な許可リストで絞る。
// 許可の源は 2 つあり、その和集合が「許可された ID」になる。
//   1. allowed_discord_users テーブル（通常の運用経路。再デプロイ無しで増減できる）
//   2. Worker 変数 ALLOWED_DISCORD_USER_IDS（カンマ区切り）
//      テーブルにまだ 1 行も無い最初の 1 人が入るための抜け道。
//
// 判定は OAuth コールバックの getUserInfo 内（= user 行を作る前）で行う。
// そのため拒否されたアカウントは DB に一切痕跡を残さない。

import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/client";
import { allowedDiscordUsers } from "../db/schema";

/**
 * カンマ区切りの環境変数を Discord ユーザー ID の集合にする。
 * 空要素と前後の空白は落とす。DB を触らないので単体でテストできる。
 */
export function parseAllowedIds(raw: string | undefined | null): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
}

/**
 * この Discord ユーザーがサインインしてよいかを返す。
 * 環境変数を先に見るのは、DB がまだ空 / 到達不能でもブートストラップできるようにするため。
 */
export async function isDiscordUserAllowed(
  db: DrizzleDb,
  allowedIdsFromEnv: string | undefined,
  discordUserId: string,
): Promise<boolean> {
  if (parseAllowedIds(allowedIdsFromEnv).has(discordUserId)) return true;

  const row = await db
    .select({ id: allowedDiscordUsers.discordUserId })
    .from(allowedDiscordUsers)
    .where(eq(allowedDiscordUsers.discordUserId, discordUserId))
    .limit(1);
  return row.length > 0;
}
