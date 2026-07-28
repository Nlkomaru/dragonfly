import { describe, expect, it } from "vitest";
import { buildStoredZip, crc32 } from "./zip";

const encoder = new TextEncoder();

describe("crc32", () => {
  it("matches the known value for a check string", () => {
    // "123456789" の CRC-32 は 0xcbf43926（規格の検査値）。
    expect(crc32(encoder.encode("123456789"))).toBe(0xcbf43926);
  });
});

describe("buildStoredZip", () => {
  it("writes the signatures and entry count", () => {
    const zip = buildStoredZip([
      { name: "a.txt", data: encoder.encode("hello") },
      { name: "b.txt", data: encoder.encode("world!") },
    ]);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);

    // 先頭はローカルファイルヘッダ。
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    // 末尾 22 バイトが EOCD で、件数が 2 件。
    const eocd = zip.length - 22;
    expect(view.getUint32(eocd, true)).toBe(0x06054b50);
    expect(view.getUint16(eocd + 10, true)).toBe(2);

    // EOCD が指すセントラルディレクトリの位置に、正しい署名があること。
    const centralOffset = view.getUint32(eocd + 16, true);
    expect(view.getUint32(centralOffset, true)).toBe(0x02014b50);
    // セントラルディレクトリの大きさが EOCD の直前までと一致すること。
    expect(view.getUint32(eocd + 12, true)).toBe(eocd - centralOffset);
  });

  it("rejects an archive that needs zip64", () => {
    expect(() => buildStoredZip(Array.from({ length: 70000 }, () => ({
      name: "x",
      data: new Uint8Array(0),
    })))).toThrow();
  });
});
