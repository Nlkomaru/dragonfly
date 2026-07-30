// 一覧の画像が読み込まれるまでに出すプレースホルダ（BlurHash）を扱う、
// プラットフォーム非依存のロジック。
//
// npm の blurhash をそのまま各所から呼ばず、この薄いラッパを挟むのは 2 つの理由から。
//   1. 成分数（COMPONENTS_X / Y）を 1 か所に固定するため。エンコードとデコードで
//      成分数がずれることは無いが、「どの値で焼いたか」がハッシュ文字列の長さに出るので、
//      アプリ全体で同じ値を使っていることを型と定数で担保しておきたい。
//   2. isBlurhashValid の戻り値がオブジェクトで、そのまま if に入れると
//      不正な文字列でも必ず truthy になる。この取り違えをここ 1 か所で潰す。
//
// なお、実際にサムネイルをデコードして RGBA を得る処理は環境依存（Web は canvas、
// デスクトップは Rust）なので、ここには持ち込まない。palette.ts と同じ方針。

import { decode, encode, isBlurhashValid } from "blurhash";

/**
 * BlurHash の成分数（横 / 縦）。数が多いほど元画像に近づくが、その分文字列が伸びる。
 *
 * VRChat のスクリーンショットは 16:9 などの横長が主なので、横を縦より多く取る。
 * 4x3 だとハッシュは 28 文字（6 + 2 * (4 * 3 - 1)）で、D1 の 1 列に持つのに十分短い。
 *
 * **この 2 つの値は Rust 側のエンコーダ（apps/desktop/src-tauri）にも同じ値で
 * 直書きされている。TypeScript の定数を Rust から読むことはできないので、
 * 変えるときは必ず両方を揃えて変えること。** ずれても例外にはならず、
 * 復元した画像の縦横比だけが静かに狂う。
 */
export const BLURHASH_COMPONENTS_X = 4;
export const BLURHASH_COMPONENTS_Y = 3;

/**
 * RGBA のピクセル列から BlurHash を作る。
 *
 * RGBA（4 バイト / 画素）を要求するのは、canvas の `getImageData().data` も
 * Rust の image クレートの `to_rgba8()` も、そのまま渡せる形がこれだから。
 * 詰め替えのコードを呼び出し側に書かせないためにこの形で受ける。
 *
 * @param rgba   4 バイトずつ RGBA が並んだ配列。長さは必ず width * height * 4。
 * @param width  rgba が表す画像の幅。実サイズではなく縮小後のサイズで構わない
 *               （BlurHash はぼかした低周波成分しか持たないため）。
 * @param height 同じく高さ。
 * @throws 長さが width * height * 4 と合わない場合（blurhash の ValidationError）。
 */
export function encodeBlurhash(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): string {
  return encode(rgba, width, height, BLURHASH_COMPONENTS_X, BLURHASH_COMPONENTS_Y);
}

/**
 * BlurHash を RGBA のピクセル列に戻す。
 *
 * 復元先は 32px 程度の小さいサイズを想定している。BlurHash が持っているのは
 * 数個の低周波成分だけなので、大きく展開してもぼけた絵が引き伸びるだけで情報は増えず、
 * デコードのコスト（width * height * 成分数）だけが増える。
 * 実際の表示サイズへは CSS 側で拡大させること。
 *
 * @returns 4 バイトずつ RGBA が並んだ、長さ width * height * 4 の配列。alpha は常に 255。
 */
export function decodeBlurhashToRgba(
  hash: string,
  width: number,
  height: number,
): Uint8ClampedArray {
  return decode(hash, width, height);
}

/**
 * BlurHash として妥当な文字列かを判定する。
 *
 * DB の古い行や、他の実装が書いた値をそのまま decode に渡すと例外で描画が落ちる。
 * 表示前にこれで弾いて、単なる無地のプレースホルダに落とすために使う。
 *
 * 本家の isBlurhashValid は理由付きのオブジェクト `{ result, errorReason }` を返す。
 * それを直接条件式に置くと不正な文字列でも常に真になってしまうので、
 * ここで result だけを取り出して真偽値にして返す。
 */
export function isValidBlurhash(hash: string): boolean {
  return isBlurhashValid(hash).result;
}
