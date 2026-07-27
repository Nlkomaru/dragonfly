// 署名付き写真 URL の単体テスト。
// 受け入れる条件と、改ざん・期限切れ・欠落・不正な exp を落とすことだけを押さえる。

import { describe, expect, it } from "vitest";
import {
  PHOTO_URL_TTL_SECONDS,
  buildSignedPhotoUrl,
  photoUrlExpiry,
  photoUrlPayload,
  signPhotoPayload,
  verifySignedPhotoUrl,
} from "./signedUrl";

const SECRET = "test-better-auth-secret";
const OWNER = "user-abc";
const PHOTO = "019abcde-0000-7000-8000-000000000001";

describe("photoUrlExpiry", () => {
  it("adds the default TTL to now", () => {
    expect(photoUrlExpiry(1_700_000_000)).toBe(1_700_000_000 + PHOTO_URL_TTL_SECONDS);
  });
});

describe("photoUrlPayload", () => {
  it("builds the v1 colon-separated payload", () => {
    expect(photoUrlPayload(OWNER, PHOTO, "image", 123)).toBe(
      `v1:${OWNER}:${PHOTO}:image:123`,
    );
  });
});

describe("verifySignedPhotoUrl", () => {
  it("accepts a fresh signature", async () => {
    const now = 1_700_000_000;
    const exp = photoUrlExpiry(now);
    const sig = await signPhotoPayload(
      SECRET,
      photoUrlPayload(OWNER, PHOTO, "thumb", exp),
    );

    await expect(
      verifySignedPhotoUrl({
        secret: SECRET,
        ownerId: OWNER,
        photoId: PHOTO,
        variant: "thumb",
        exp: String(exp),
        sig,
        nowSeconds: now,
      }),
    ).resolves.toEqual({ ok: true, exp });
  });

  it("rejects a tampered signature", async () => {
    const now = 1_700_000_000;
    const exp = photoUrlExpiry(now);
    const sig = await signPhotoPayload(
      SECRET,
      photoUrlPayload(OWNER, PHOTO, "image", exp),
    );
    // 末尾を 1 文字いじる（base64url 文字の範囲内で）。
    const tampered = `${sig.slice(0, -1)}${sig.endsWith("a") ? "b" : "a"}`;

    await expect(
      verifySignedPhotoUrl({
        secret: SECRET,
        ownerId: OWNER,
        photoId: PHOTO,
        variant: "image",
        exp: String(exp),
        sig: tampered,
        nowSeconds: now,
      }),
    ).resolves.toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects when path fields do not match the signed payload", async () => {
    const now = 1_700_000_000;
    const exp = photoUrlExpiry(now);
    const sig = await signPhotoPayload(
      SECRET,
      photoUrlPayload(OWNER, PHOTO, "image", exp),
    );

    await expect(
      verifySignedPhotoUrl({
        secret: SECRET,
        ownerId: OWNER,
        photoId: PHOTO,
        // variant をすり替える
        variant: "thumb",
        exp: String(exp),
        sig,
        nowSeconds: now,
      }),
    ).resolves.toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects an expired signature", async () => {
    const exp = 1_700_000_000;
    const sig = await signPhotoPayload(
      SECRET,
      photoUrlPayload(OWNER, PHOTO, "image", exp),
    );

    await expect(
      verifySignedPhotoUrl({
        secret: SECRET,
        ownerId: OWNER,
        photoId: PHOTO,
        variant: "image",
        exp: String(exp),
        sig,
        // exp の 1 秒後
        nowSeconds: exp + 1,
      }),
    ).resolves.toEqual({ ok: false, reason: "expired" });
  });

  it("rejects missing exp or sig", async () => {
    await expect(
      verifySignedPhotoUrl({
        secret: SECRET,
        ownerId: OWNER,
        photoId: PHOTO,
        variant: "image",
        exp: null,
        sig: "abc",
      }),
    ).resolves.toEqual({ ok: false, reason: "missing" });

    await expect(
      verifySignedPhotoUrl({
        secret: SECRET,
        ownerId: OWNER,
        photoId: PHOTO,
        variant: "image",
        exp: "123",
        sig: undefined,
      }),
    ).resolves.toEqual({ ok: false, reason: "missing" });
  });

  it("rejects a malformed exp", async () => {
    await expect(
      verifySignedPhotoUrl({
        secret: SECRET,
        ownerId: OWNER,
        photoId: PHOTO,
        variant: "image",
        exp: "12.5",
        sig: "abc",
      }),
    ).resolves.toEqual({ ok: false, reason: "malformed" });

    await expect(
      verifySignedPhotoUrl({
        secret: SECRET,
        ownerId: OWNER,
        photoId: PHOTO,
        variant: "image",
        exp: "-1",
        sig: "abc",
      }),
    ).resolves.toEqual({ ok: false, reason: "malformed" });

    await expect(
      verifySignedPhotoUrl({
        secret: SECRET,
        ownerId: OWNER,
        photoId: PHOTO,
        variant: "image",
        exp: "not-a-number",
        sig: "abc",
      }),
    ).resolves.toEqual({ ok: false, reason: "malformed" });
  });
});

describe("buildSignedPhotoUrl", () => {
  it("returns a relative path with exp and sig query params", async () => {
    const exp = 1_800_000_000;
    const url = await buildSignedPhotoUrl(SECRET, OWNER, PHOTO, "image", exp);
    const parsed = new URL(url, "https://example.test");

    expect(parsed.pathname).toBe(`/api/v1/users/${OWNER}/photos/${PHOTO}/image`);
    expect(parsed.searchParams.get("exp")).toBe(String(exp));
    const sig = parsed.searchParams.get("sig");
    expect(sig).toBeTruthy();

    await expect(
      verifySignedPhotoUrl({
        secret: SECRET,
        ownerId: OWNER,
        photoId: PHOTO,
        variant: "image",
        exp: String(exp),
        sig,
        nowSeconds: exp - 10,
      }),
    ).resolves.toEqual({ ok: true, exp });
  });
});
