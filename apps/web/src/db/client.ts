// D1 の drizzle クライアント。生の SQL はここより先には書かない。

import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

/** リクエストごとに作る drizzle インスタンス。D1Database 自体は Workers が使い回す。 */
export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export type DrizzleDb = ReturnType<typeof createDb>;
