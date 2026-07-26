// サインイン許可リストが「実際の better-auth 設定を通して」効くことの確認。
//
// allowlist.ts 単体のテストとは別に、createAuth() が組み立てた Discord プロバイダの
// mapProfileToUser が本当に許可リストを見ているかを見る。ここが繋がっていないと、
// 判定ロジックが正しくても誰でもログインできてしまう。

import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: () => {} }));

const { createAuth } = await import("./auth");

/**
 * allowed_discord_users の SELECT だけを模した D1 のダブル。
 * bind された値で実際に絞り込む。素通しにすると「WHERE が効いていない」バグを
 * テストが見逃してしまうため、そこだけは本物と同じ振る舞いにしておく。
 */
function fakeEnv(allowedRows: string[], allowedIdsVar?: string): Env {
  const makeStatement = (bound: unknown[] = []) => {
    const matched = allowedRows.filter((id) => bound.includes(id));
    const statement = {
      bind: (...args: unknown[]) => makeStatement(args),
      all: async () => ({ results: matched.map((id) => ({ id })), success: true, meta: {} }),
      first: async () => (matched[0] ? { id: matched[0] } : null),
      run: async () => ({ results: [], success: true, meta: {} }),
      raw: async () => matched.map((id) => [id]),
    };
    return statement;
  };
  return {
    DB: { prepare: () => makeStatement(), batch: async () => [], exec: async () => ({}) },
    PHOTOS: {},
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_CLIENT_SECRET: "client-secret",
    BETTER_AUTH_SECRET: "test-secret",
    BETTER_AUTH_URL: "http://localhost:1421",
    ALLOWED_DISCORD_USER_IDS: allowedIdsVar,
  } as unknown as Env;
}

/** createAuth() が実際に組み立てた Discord の mapProfileToUser を取り出す。 */
function discordGate(env: Env) {
  const provider = createAuth(env).options.socialProviders?.discord;
  const map = provider?.mapProfileToUser;
  expect(map).toBeTypeOf("function");
  return (discordUserId: string) =>
    // biome-ignore lint: プロフィールは id しか見ないので、必要な分だけ渡す。
    (map as (p: { id: string }) => Promise<unknown>)({ id: discordUserId });
}

describe("discord sign-in allowlist", () => {
  it("lets through an id listed in the bootstrap env var", async () => {
    await expect(discordGate(fakeEnv([], "111"))("111")).resolves.toBeDefined();
  });

  it("lets through an id present in allowed_discord_users", async () => {
    await expect(discordGate(fakeEnv(["222"]))("222")).resolves.toBeDefined();
  });

  it("rejects an id in neither source, before any user row is written", async () => {
    // 拒否は例外で表される。better-auth はこれを 403 の応答に変える。
    // getUserInfo の途中なので、この時点では user も account もまだ書かれていない。
    await expect(discordGate(fakeEnv(["222"], "111"))("999")).rejects.toThrow(
      /not allowed to sign in/,
    );
  });
});
