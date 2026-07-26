// 許可リストの判定。ここを間違えると誰でもログインできてしまうので、分岐だけは押さえておく。

import { describe, expect, it } from "vitest";
import { isDiscordUserAllowed, parseAllowedIds } from "./allowlist";
import type { DrizzleDb } from "../db/client";

/** allowed_discord_users の SELECT だけを模した最小のダブル。 */
function fakeDb(rows: string[]): DrizzleDb {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows.map((id) => ({ id }))),
  };
  return { select: () => chain } as unknown as DrizzleDb;
}

describe("parseAllowedIds", () => {
  it("splits on commas and drops blanks and padding", () => {
    expect([...parseAllowedIds(" 1, 2 ,,3 ")]).toEqual(["1", "2", "3"]);
  });

  it("treats missing or empty values as nobody allowed", () => {
    expect(parseAllowedIds(undefined).size).toBe(0);
    expect(parseAllowedIds("").size).toBe(0);
  });
});

describe("isDiscordUserAllowed", () => {
  it("allows an id listed in the bootstrap env var without touching the table", async () => {
    await expect(isDiscordUserAllowed(fakeDb([]), "123,456", "456")).resolves.toBe(true);
  });

  it("allows an id present in the table", async () => {
    await expect(isDiscordUserAllowed(fakeDb(["789"]), undefined, "789")).resolves.toBe(true);
  });

  it("rejects an id that is in neither source", async () => {
    await expect(isDiscordUserAllowed(fakeDb([]), "123", "999")).resolves.toBe(false);
  });
});
