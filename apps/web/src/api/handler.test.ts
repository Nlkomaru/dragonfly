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

/** バインディングは触らせないので、空のスタブで足りる。署名検証に secret だけ必要。 */
const bindings = {
  DB: {},
  PHOTOS: {},
  BETTER_AUTH_SECRET: SECRET,
} as unknown as Env;

beforeEach(() => {
  currentSession.value = null;
  sessionError.value = null;
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
      "/api/v1/users/{id}/photos",
      "/api/v1/users/{id}/photos/check",
      "/api/v1/users/{id}/photos/{photoId}",
      "/api/v1/users/{id}/photos/{photoId}/image",
      "/api/v1/users/{id}/photos/{photoId}/tags",
      "/api/v1/users/{id}/photos/{photoId}/thumb",
      "/api/v1/users/{id}/tags",
    ]);
  });

  it("serves the scalar reference", async () => {
    expect((await handler.request("/api/scalar")).status).toBe(200);
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
