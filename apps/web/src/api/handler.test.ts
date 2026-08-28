// API の入口まわり。境界の分岐だけを押さえる（DB を伴う挙動はここでは見ない）。
//
// 特に `:id` の解決は権限そのものなので、`me` と他人の ID の扱いは必ず確認する。
// 画像配信は署名 URL でも通るので、その分岐もここで押さえる。

import { beforeEach, describe, expect, it, vi } from "vitest";

// Workers 固有のモジュールはテスト環境に無いので差し替える。
vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: () => {} }));

// 認証は better-auth が持つので、ここでは「セッションが解決できたかどうか」だけを模す。
const currentSession = vi.hoisted(() => ({
  value: null as { user: { id: string; name: string } } | null,
}));
// better-auth が投げる例外（レート制限など）の扱いも見たいので、差し込めるようにする。
const sessionError = vi.hoisted(() => ({ value: null as Error | null }));
vi.mock("../server/context", () => ({
  getAuth: () => ({
    api: {
      getSession: async () => {
        if (sessionError.value) throw sessionError.value;
        return currentSession.value;
      },
    },
  }),
}));

// 画像本体は R2 / D1 に触るので、認可を抜けたあとは固定レスポンスに差し替える。
const streamPhotoObject = vi.hoisted(() =>
  vi.fn(
    async (
      _db: unknown,
      _bucket: unknown,
      _ownerId: string,
      _photoId: string,
      _variant: "image" | "thumb",
      _cache?: { mode: "signed" | "private"; exp?: number },
    ) =>
      new Response(new Uint8Array([0, 0, 0]), {
        headers: { "Content-Type": "image/avif" },
      }),
  ),
);
vi.mock("../server/r2", () => ({
  PhotoObjectNotFound: class PhotoObjectNotFound extends Error {},
  streamPhotoObject,
}));

const { default: handler } = await import("./handler");
const { buildSignedPhotoUrl } = await import("../server/signedUrl");

const SECRET = "test-better-auth-secret";

/**
 * D1 のダブル。drizzle が呼ぶ分（prepare / bind / raw / run / batch）だけを備える。
 *
 * drizzle 自体は本物のまま動かすので、SQL の組み立ても owner_id での絞り込みも実物が走る。
 * テストが差し込むのは「SELECT が返す行」だけで、実行された SQL と束縛値は queries に残る。
 */
const d1 = vi.hoisted(() => ({
  /**
   * SELECT が返す行を実行順に積んだキュー。1 要素が 1 クエリ分で、尽きたら空を返す。
   *
   * 分割して並行に引くクエリ (findOwnedPhotoIds) も同じキューから取るので、
   * 「1 つの流れで SELECT が何本走るか」を分かった上で積むこと。
   * 途中に SELECT が増えると、失敗ではなく静かに別のクエリへずれる。
   */
  results: [] as unknown[][][],
  /** 実行された SQL と束縛値。所有者条件が効いているかを確かめるのに使う。 */
  queries: [] as { sql: string; params: unknown[] }[],
  /** batch() に渡された文。実際に書き込まれた件数の確認に使う。 */
  batched: [] as unknown[],
}));

/** バインディングは触らせないので、空のスタブで足りる。署名検証に secret だけ必要。 */
const bindings = {
  DB: {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => {
        d1.queries.push({ sql, params });
        // drizzle は列を選ぶ SELECT を values() 経由で読むので、raw() が本命。
        // 返すのは行オブジェクトではなく「値の配列」であることに注意。
        const rows = d1.results.shift() ?? [];
        return {
          raw: async () => rows,
          all: async () => ({ results: rows }),
          run: async () => ({ results: [], success: true, meta: {} }),
        };
      },
    }),
    batch: async (statements: unknown[]) => {
      d1.batched.push(...statements);
      return statements.map(() => ({ results: [], success: true, meta: {} }));
    },
  },
  // R2 は書き込み先としてしか使わないので、受け取って捨てるだけで足りる。
  PHOTOS: { put: async () => {}, delete: async () => {} },
  BETTER_AUTH_SECRET: SECRET,
} as unknown as Env;

beforeEach(() => {
  currentSession.value = null;
  sessionError.value = null;
  d1.results = [];
  d1.queries = [];
  d1.batched = [];
  streamPhotoObject.mockClear();
});

describe("error mapping", () => {
  it("keeps the status of a better-auth APIError instead of turning it into a 500", async () => {
    const { APIError } = await import("better-auth/api");
    sessionError.value = new APIError("TOO_MANY_REQUESTS", { message: "Rate limit exceeded." });

    const res = await handler.request("/api/v1/me", {}, bindings);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "Rate limit exceeded." });
  });

  it("maps by shape, so a duplicated better-auth copy is still handled", async () => {
    // 依存が重複解決されると例外のクラスが別物になる。instanceof に頼っていないことの確認。
    sessionError.value = Object.assign(new Error("nope"), { statusCode: 401 });

    const res = await handler.request("/api/v1/me", {}, bindings);
    expect(res.status).toBe(401);
  });

  it("still returns 500 for an error without a status", async () => {
    sessionError.value = new Error("boom");
    const res = await handler.request("/api/v1/me", {}, bindings);
    expect(res.status).toBe(500);
  });
});

describe("documentation", () => {
  it("serves the openapi document with every versioned route", async () => {
    const res = await handler.request("/api/openapi");
    expect(res.status).toBe(200);
    const spec = (await res.json()) as { paths: Record<string, unknown> };
    expect(Object.keys(spec.paths).sort()).toEqual([
      "/api/v1/me",
      "/api/v1/users/{id}/blurhashes",
      "/api/v1/users/{id}/facets",
      "/api/v1/users/{id}/palettes",
      "/api/v1/users/{id}/photos",
      // by-hash が `:photoId` に食われず、独立したパスとして登録されている証拠でもある。
      "/api/v1/users/{id}/photos/by-hash/{sourceSha256}",
      "/api/v1/users/{id}/photos/check",
      "/api/v1/users/{id}/photos/{photoId}",
      "/api/v1/users/{id}/photos/{photoId}/image",
      "/api/v1/users/{id}/photos/{photoId}/rotate",
      "/api/v1/users/{id}/photos/{photoId}/tags",
      "/api/v1/users/{id}/photos/{photoId}/thumb",
      "/api/v1/users/{id}/tags",
    ]);
  });

  it("serves the scalar reference", async () => {
    expect((await handler.request("/api/scalar")).status).toBe(200);
  });
});

describe("rotation", () => {
  it("rejects non-AVIF uploads before touching the photo", async () => {
    currentSession.value = { user: { id: "user-1", name: "nikomaru" } };
    const form = new FormData();
    form.set("image", new File([new Uint8Array([1])], "image.png", { type: "image/png" }));
    form.set("degrees", "90");
    form.set("width", "1080");
    form.set("height", "1920");

    const res = await handler.request(
      "/api/v1/users/me/photos/photo-1/rotate",
      { method: "POST", body: form },
      bindings,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "image must be an AVIF file" });
  });
});

describe("tags", () => {
  /** タグの検証はハンドラの手前（zod）で落ちるので、DB に触らずに確かめられる。 */
  const putTags = (body: unknown) =>
    handler.request(
      "/api/v1/users/me/photos/photo-1/tags",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      bindings,
    );

  it("rejects a blank tag, which would otherwise take a row of its own", async () => {
    currentSession.value = { user: { id: "user-1", name: "nikomaru" } };
    expect((await putTags({ tags: ["  "] })).status).toBe(400);
  });

  it("rejects more tags than a photo may carry", async () => {
    currentSession.value = { user: { id: "user-1", name: "nikomaru" } };
    const tooMany = Array.from({ length: 33 }, (_, i) => `tag-${i}`);
    expect((await putTags({ tags: tooMany })).status).toBe(400);
  });

  it("requires a session", async () => {
    expect((await putTags({ tags: ["a"] })).status).toBe(401);
  });
});

describe("palettes", () => {
  /** タグと同じく、パレットの検証も zod で落ちるので DB に触らずに確かめられる。 */
  const putPalettes = (body: unknown) =>
    handler.request(
      "/api/v1/users/me/palettes",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      bindings,
    );

  const palette = (photoId: string) => ({
    photoId,
    version: 1,
    swatches: [{ hex: "#3a5f8a", ratio: 1, l: 0.5, a: 0, b: 0 }],
  });

  it("rejects more palettes than one request may carry", async () => {
    currentSession.value = { user: { id: "user-1", name: "nikomaru" } };
    const tooMany = Array.from({ length: 51 }, (_, i) => palette(`photo-${i}`));
    expect((await putPalettes({ palettes: tooMany })).status).toBe(400);
  });

  it("rejects an uppercase hex, which would not match what the extractor emits", async () => {
    currentSession.value = { user: { id: "user-1", name: "nikomaru" } };
    const invalid = {
      ...palette("photo-1"),
      swatches: [{ hex: "#3A5F8A", ratio: 1, l: 0, a: 0, b: 0 }],
    };
    expect((await putPalettes({ palettes: [invalid] })).status).toBe(400);
  });

  it("rejects an oversized photo id, which would bloat the lookup query", async () => {
    currentSession.value = { user: { id: "user-1", name: "nikomaru" } };
    expect((await putPalettes({ palettes: [palette("x".repeat(65))] })).status).toBe(400);
  });

  it("requires a session", async () => {
    expect((await putPalettes({ palettes: [] })).status).toBe(401);
    expect((await handler.request("/api/v1/users/me/palettes", {}, bindings)).status).toBe(401);
  });
});

describe("blurhashes", () => {
  const putBlurhashes = (body: unknown) =>
    handler.request(
      "/api/v1/users/me/blurhashes",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      bindings,
    );

  it("ignores a photo id the caller does not own", async () => {
    currentSession.value = { user: { id: "user-1", name: "nikomaru" } };
    // 所有確認の SELECT が返すのは photo-1 だけ。photo-2 は他人のものとして落ちる。
    d1.results.push([["photo-1"]]);

    const res = await putBlurhashes({
      blurhashes: [
        { photoId: "photo-1", blurhash: "LTFi4E2|sYo$zOR:jujJeqf7fQf7" },
        { photoId: "photo-2", blurhash: "LTFi4E2|sYo$zOR:jujJeqf7fQf7" },
      ],
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ saved: 1 });
    // 書き込みは 1 文だけ。落とした写真の分が混ざっていないことを見る。
    expect(d1.batched).toHaveLength(1);
    // 所有確認は必ず owner_id 込みで引く。ここが抜けると他人の写真も通ってしまう。
    expect(d1.queries[0]?.params).toContain("user-1");
  });

  it("splits the ownership lookup so a full request stays under the d1 bind limit", async () => {
    currentSession.value = { user: { id: "user-1", name: "nikomaru" } };
    // 上限いっぱいの 100 件。1 クエリで引くと owner_id と合わせて 101 個の束縛値になり、
    // D1 の上限 (100) を超えてクエリごと失敗する。
    const full = Array.from({ length: 100 }, (_, i) => ({
      photoId: `photo-${i}`,
      blurhash: "LTFi4E2|sYo$zOR:jujJeqf7fQf7",
    }));

    expect((await putBlurhashes({ blurhashes: full })).status).toBe(200);
    // 90 件ずつなので 2 本。1 件ずつ引く実装に戻っていないことも同時に見る。
    expect(d1.queries).toHaveLength(2);
    // 100 は失敗する値そのものなので、それ未満であることを要求する。
    for (const query of d1.queries) expect(query.params.length).toBeLessThan(100);
  });

  it("rejects more blurhashes than one request may carry", async () => {
    currentSession.value = { user: { id: "user-1", name: "nikomaru" } };
    const tooMany = Array.from({ length: 101 }, (_, i) => ({
      photoId: `photo-${i}`,
      blurhash: "LTFi4E2|sYo$zOR:jujJeqf7fQf7",
    }));
    expect((await putBlurhashes({ blurhashes: tooMany })).status).toBe(400);
  });

  it("requires a session", async () => {
    expect((await putBlurhashes({ blurhashes: [] })).status).toBe(401);
  });
});

describe("re-uploading a photo that is already stored", () => {
  const metadata = {
    sourceSha256: "b".repeat(64),
    takenAt: 1700000000000,
    width: 1920,
    height: 1080,
    vrcx: {
      application: "VRCX",
      version: 1,
      author: { id: "usr_1", displayName: "nikomaru" },
      world: { id: "wrld_1", name: "Home", instanceId: "12345" },
      players: [],
    },
    blurhash: "LTFi4E2|sYo$zOR:jujJeqf7fQf7",
  };

  it("fills the blurhash only while it is still empty", async () => {
    currentSession.value = { user: { id: "user-1", name: "nikomaru" } };
    // 同じハッシュの行が既にある（冪等の再送）。
    d1.results.push([["photo-1"]]);

    const form = new FormData();
    form.set("image", new File([new Uint8Array([1, 2, 3])], "a.avif", { type: "image/avif" }));
    form.set("metadata", JSON.stringify(metadata));
    const res = await handler.request(
      "/api/v1/users/me/photos",
      { method: "POST", body: form },
      bindings,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ id: "photo-1", deduplicated: true });
    // IS NULL が外れると、blurhash を計算できない古いクライアントの再送で値が消える。
    const update = d1.queries.find((query) => query.sql.startsWith("update"));
    expect(update?.sql).toContain('"blurhash" is null');
  });
});

describe("deleting a photo by its source hash", () => {
  const hash = "a".repeat(64);

  const deleteByHash = (id: string, sourceSha256: string) =>
    handler.request(
      `/api/v1/users/${id}/photos/by-hash/${sourceSha256}`,
      { method: "DELETE" },
      bindings,
    );

  it("returns 404 for a hash that belongs to someone else", async () => {
    currentSession.value = { user: { id: "user-1", name: "nikomaru" } };
    // 所有者条件込みで引くので、他人の写真のハッシュでは 1 行も返らない。
    d1.results.push([]);

    expect((await deleteByHash("me", hash)).status).toBe(404);
    // 呼び出し元の ID で絞っていることを確かめる。ここが抜けると他人の写真を消せてしまう。
    // 末尾の 1 は limit(1) の束縛値。
    expect(d1.queries[0]?.params).toEqual(["user-1", hash, 1]);
  });

  it("rejects a malformed hash before touching the database", async () => {
    currentSession.value = { user: { id: "user-1", name: "nikomaru" } };
    expect((await deleteByHash("me", "not-a-hash")).status).toBe(400);
    expect(d1.queries).toHaveLength(0);
  });

  it("requires a session", async () => {
    expect((await deleteByHash("me", hash)).status).toBe(401);
  });
});

describe("authentication", () => {
  it("rejects a request without a session or api key", async () => {
    const res = await handler.request("/api/v1/users/me/photos", {}, bindings);
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "authentication required" });
  });

  it("resolves `me` to the caller", async () => {
    currentSession.value = { user: { id: "user-1", name: "nikomaru" } };
    const res = await handler.request("/api/v1/me", {}, bindings);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ userId: "user-1", displayName: "nikomaru" });
  });

  it("rejects another user's id with 403", async () => {
    currentSession.value = { user: { id: "user-1", name: "nikomaru" } };
    const res = await handler.request("/api/v1/users/user-2/photos", {}, bindings);
    expect(res.status).toBe(403);
  });
});

describe("signed photo image URLs", () => {
  const ownerId = "user-1";
  const photoId = "019abcde-0000-7000-8000-000000000001";

  it("rejects unauthenticated image access without a signature", async () => {
    const res = await handler.request(
      `/api/v1/users/${ownerId}/photos/${photoId}/image`,
      {},
      bindings,
    );
    expect(res.status).toBe(401);
    expect(streamPhotoObject).not.toHaveBeenCalled();
  });

  it("allows image access with a valid signature and no session", async () => {
    const url = await buildSignedPhotoUrl(SECRET, ownerId, photoId, "image");
    const res = await handler.request(url, {}, bindings);
    expect(res.status).toBe(200);
    expect(streamPhotoObject).toHaveBeenCalledOnce();
    expect(streamPhotoObject).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      ownerId,
      photoId,
      "image",
      expect.objectContaining({ mode: "signed" }),
    );
  });

  it("rejects image access with an invalid signature and no session", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const res = await handler.request(
      `/api/v1/users/${ownerId}/photos/${photoId}/image?exp=${exp}&sig=not-a-valid-sig`,
      {},
      bindings,
    );
    expect(res.status).toBe(401);
    expect(streamPhotoObject).not.toHaveBeenCalled();
  });

  it("allows image access with a session and no signature", async () => {
    currentSession.value = { user: { id: ownerId, name: "nikomaru" } };
    const res = await handler.request(
      `/api/v1/users/me/photos/${photoId}/thumb`,
      {},
      bindings,
    );
    expect(res.status).toBe(200);
    expect(streamPhotoObject).toHaveBeenCalledOnce();
    expect(streamPhotoObject).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      ownerId,
      photoId,
      "thumb",
      { mode: "private" },
    );
  });
});
