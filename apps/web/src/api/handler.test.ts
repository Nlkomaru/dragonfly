// API の入口まわり。境界の分岐だけを押さえる（DB を伴う挙動はここでは見ない）。
//
// 特に `:id` の解決は権限そのものなので、`me` と他人の ID の扱いは必ず確認する。

import { beforeEach, describe, expect, it, vi } from "vitest";

// Workers 固有のモジュールはテスト環境に無いので差し替える。
vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: () => {} }));

// 認証は better-auth が持つので、ここでは「セッションが解決できたかどうか」だけを模す。
const currentSession = vi.hoisted(() => ({
  value: null as { user: { id: string; name: string } } | null,
}));
vi.mock("../server/context", () => ({
  getAuth: () => ({ api: { getSession: async () => currentSession.value } }),
}));

const { default: handler } = await import("./handler");

/** バインディングは触らせないので、空のスタブで足りる。 */
const bindings = { DB: {}, PHOTOS: {} } as unknown as Env;

beforeEach(() => {
  currentSession.value = null;
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
      "/api/v1/users/{id}/photos/{photoId}/thumb",
    ]);
  });

  it("serves the scalar reference", async () => {
    expect((await handler.request("/api/scalar")).status).toBe(200);
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
