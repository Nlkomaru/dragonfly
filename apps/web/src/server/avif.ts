// Worker 上での AVIF のデコード / 回転 / 再エンコード。
//
// Workers には画像処理のネイティブ API が無く、Cloudflare Images も AVIF 入力は
// Enterprise 限定なので、libavif の wasm ビルド (@jsquash/avif) を同梱して使う。
//
// wasm は実行時にバイト列からコンパイルできない（Workers の制限）ため、
// 必ず import した WebAssembly.Module を init() に渡す。この import は
// Vite では external に残し、wrangler の既定ルール (CompiledWasm) が解決する。
//
// このモジュールは wasm import を含むので、Node で走る vitest から photos ルータを
// 読んでも壊れないよう、ルート側からは動的 import で遅延読み込みすること。

import decode, { init as initAvifDecode } from "@jsquash/avif/decode";
import encode, { init as initAvifEncode } from "@jsquash/avif/encode";
import AVIF_DEC_WASM from "@jsquash/avif/codec/dec/avif_dec.wasm";
import AVIF_ENC_WASM from "@jsquash/avif/codec/enc/avif_enc.wasm";
import { rotateRgba, type RotationDegrees } from "@dragonfly/core";

/**
 * 再エンコードの品質。デスクトップ側の既定 (settings.rs の avif_quality = 70) に合わせる。
 * 回転のたびに世代劣化するので、元より下げない。
 */
const ENCODE_QUALITY = 70;

/**
 * エンコード速度 (0-10)。大きいほど速いが圧縮率は落ちる。
 * wasm はネイティブより数倍遅く、Workers には CPU 時間の上限があるので速度側に倒す。
 */
const ENCODE_SPEED = 8;

/**
 * 両コーデックの初期化。isolate ごとに一度だけでよいのでメモ化する。
 *
 * encode 側の init は内部に await を挟んでから module を確定するため、
 * 待たずに encode() を呼ぶと「module 無しの二重初期化」（＝wasm の fetch）に落ちる。
 * 必ずこの Promise を await してから使うこと。
 */
let codecReady: Promise<unknown> | null = null;

function ensureCodec(): Promise<unknown> {
  if (!codecReady) {
    codecReady = Promise.all([initAvifDecode(AVIF_DEC_WASM), initAvifEncode(AVIF_ENC_WASM)]);
  }
  return codecReady;
}

export interface RotatedAvif {
  bytes: ArrayBuffer;
  width: number;
  height: number;
}

/**
 * AVIF のバイト列を時計回りに回転し、AVIF で再エンコードして返す。
 *
 * AVIF は JPEG と違い無損失回転ができないため、デコード → 再エンコードになる。
 * 品質は固定（ENCODE_QUALITY）で、元のエンコード品質は復元できない点に注意。
 */
export async function rotateAvif(
  source: ArrayBuffer,
  degrees: RotationDegrees,
): Promise<RotatedAvif> {
  await ensureCodec();

  const decoded = await decode(source);
  // 型の上では null がありうる（実装は throw する）。壊れた実体は明示的に落とす。
  if (!decoded) throw new Error("failed to decode AVIF");
  const rotated = rotateRgba(
    {
      // bitDepth 既定 (8) でデコードするので Uint8ClampedArray になる。
      data: decoded.data as Uint8ClampedArray,
      width: decoded.width,
      height: decoded.height,
    },
    degrees,
  );

  const bytes = await encode(
    // encode は ImageData 互換の { data, width, height } を受け取る。
    { data: rotated.data, width: rotated.width, height: rotated.height } as ImageData,
    { quality: ENCODE_QUALITY, speed: ENCODE_SPEED },
  );
  return { bytes, width: rotated.width, height: rotated.height };
}
