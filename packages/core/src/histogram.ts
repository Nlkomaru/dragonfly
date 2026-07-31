// 写真の色分布を表すヒストグラムと、それを使ったグループ分け。
//
// 代表色パレット (palette.ts) は「見せる」ための 5 色で、こちらは「比べる」ための表現。
// 5 色に潰すと、同じ場所で撮った似た写真でも k-means の切れ目が変わって代表色が入れ替わり、
// 距離が不安定になる。分布をそのまま持てばその揺れが出ない。
//
// notebooks/ で手書きの正解（同じ組に入ってほしい写真）に対して測った結果、
// 1 グループ 7 枚を目標にしたとき 17/29 → 24/29、同じワールドで連写した写真の再現率が
// 65% → 80% に上がった。計算も約 4 倍速い。
//
// 色空間は palette.ts と同じ OKLab。距離の測り方だけがこちらで完結している。

import { srgbToOklab } from "./palette";

/**
 * ヒストグラムの形式バージョン。bin の切り方・重みの付け方を変えたら上げる。
 * 保存済みのものがこの値より古ければ、クライアントが作り直して上書きする。
 */
export const HISTOGRAM_VERSION = 1;

/**
 * bin の分割数 (L, a, b)。合計 6 × 10 × 10 = 600 bin。
 *
 * L 方向を粗くしてあるのは、露出や時刻の違いで明るさだけがずれた写真を離さないため。
 * 4×8×8 (256 bin) でもほぼ同じ成績が出たので、この付近なら鋭敏ではない。
 */
export const HISTOGRAM_BINS = { l: 6, a: 10, b: 10 } as const;

/** ヒストグラムの長さ。 */
export const HISTOGRAM_SIZE = HISTOGRAM_BINS.l * HISTOGRAM_BINS.a * HISTOGRAM_BINS.b;

/**
 * a と b の範囲。sRGB を OKLab に変換すると概ね ±0.25 に収まるので、この幅を等分する。
 * これを外れる値は端の bin に丸める。
 */
const AB_RANGE = 0.25;

/** これ未満の alpha は「透明」とみなして数えない。palette.ts の MIN_ALPHA と同じ値。 */
const MIN_ALPHA = 128;

/**
 * 彩度の下駄。palette.ts の ACCENT_CHROMA_FLOOR と同じ考え方で、
 * 無彩色ばかりの写真でも重みの合計が 0 にならないようにする。
 */
const CHROMA_FLOOR = 0.02;

/**
 * 保存時に切り捨てる下限。これ以下の bin は 0 とみなす。
 *
 * 実写 200 枚で測ると、600 bin のうち値が入るのは中央値 44 個で、この閾値を掛けても
 * 捨てられる質量は平均 0.3% しかない。グループ分けの結果は変わらないまま、
 * 保存量が 1 枚あたり 130 バイト程度に収まる。
 */
const ENCODE_MIN_WEIGHT = 5e-4;

/** 写真 1 枚分のヒストグラム。API と D1 では bins を base64 にして持ち回る。 */
export interface PhotoHistogram {
  photoId: string;
  version: number;
  /** 長さ HISTOGRAM_SIZE、合計 1 の配列。 */
  bins: Float64Array;
}

/** グループ分けの対象。パレットでもヒストグラムでも、写真 ID さえ引ければよい。 */
export interface PhotoRef {
  photoId: string;
}

// ---------------------------------------------------------------------------
// 抽出
// ---------------------------------------------------------------------------

/**
 * RGBA のピクセル列から色ヒストグラムを作る。
 *
 * 画素ごとに「彩度 + 下駄」を重みとして、いちばん近い 1 つの bin に投票する。
 * 鮮やかな色ほど強く効くので、暗い画面の中の差し色が拾える。
 * 最後に合計 1 へ正規化するため、画像の大きさには依存しない。
 *
 * @param pixels `getImageData().data` と同じ RGBA が 4 バイトずつ並んだ配列。
 */
export function buildHistogram(pixels: Uint8ClampedArray): Float64Array {
  const bins = new Float64Array(HISTOGRAM_SIZE);
  const { l: binsL, a: binsA, b: binsB } = HISTOGRAM_BINS;
  let total = 0;

  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3] < MIN_ALPHA) continue;
    const lab = srgbToOklab(pixels[i], pixels[i + 1], pixels[i + 2]);

    // 各軸を [0, bins) に写してから切り捨てる。範囲外は端に丸める。
    const indexL = clampIndex(Math.floor(lab.l * binsL), binsL);
    const indexA = clampIndex(
      Math.floor(((lab.a + AB_RANGE) / (2 * AB_RANGE)) * binsA),
      binsA,
    );
    const indexB = clampIndex(
      Math.floor(((lab.b + AB_RANGE) / (2 * AB_RANGE)) * binsB),
      binsB,
    );

    const weight = CHROMA_FLOOR + Math.hypot(lab.a, lab.b);
    bins[(indexL * binsA + indexA) * binsB + indexB] += weight;
    total += weight;
  }

  if (total > 0) {
    for (let i = 0; i < bins.length; i += 1) bins[i] /= total;
  } else {
    // 有効な画素が 1 つも無い（全部透明など）。距離が NaN にならないよう一様分布にする。
    bins.fill(1 / HISTOGRAM_SIZE);
  }
  return bins;
}

/** 0 以上 size 未満に丸める。 */
function clampIndex(value: number, size: number): number {
  if (value < 0) return 0;
  if (value >= size) return size - 1;
  return value;
}

// ---------------------------------------------------------------------------
// 保存形式
// ---------------------------------------------------------------------------
// 600 個の double をそのまま JSON に載せると 1 枚 5KB を超える。値が入る bin は
// 数十個しかないので、「bin 番号 (2 バイト) + 値 (1 バイト)」の並びにして base64 にする。
// 値は最大値を 255 とする相対値で持ち、読み出し時に合計 1 へ正規化し直す。

/** ヒストグラムを base64 文字列にする。 */
export function encodeHistogram(bins: Float64Array): string {
  let max = 0;
  for (const value of bins) if (value > max) max = value;
  if (max <= 0) return "";

  const entries: number[] = [];
  for (let i = 0; i < bins.length; i += 1) {
    if (bins[i] <= ENCODE_MIN_WEIGHT) continue;
    // 1 未満に丸められると bin ごと消えるので、残すと決めたものは最低 1 にする。
    const quantized = Math.max(1, Math.min(255, Math.round((bins[i] / max) * 255)));
    entries.push(i, quantized);
  }

  const bytes = new Uint8Array((entries.length / 2) * 3);
  for (let e = 0, o = 0; e < entries.length; e += 2, o += 3) {
    const index = entries[e];
    bytes[o] = index & 0xff;
    bytes[o + 1] = (index >> 8) & 0xff;
    bytes[o + 2] = entries[e + 1];
  }
  return bytesToBase64(bytes);
}

/**
 * base64 文字列からヒストグラムに戻す。合計は 1 に正規化される。
 * 壊れた文字列（長さが 3 の倍数でない、bin 番号が範囲外）では null を返す。
 */
export function decodeHistogram(encoded: string): Float64Array | null {
  if (encoded.length === 0) return null;
  const bytes = base64ToBytes(encoded);
  if (bytes === null || bytes.length === 0 || bytes.length % 3 !== 0) return null;

  const bins = new Float64Array(HISTOGRAM_SIZE);
  let total = 0;
  for (let o = 0; o < bytes.length; o += 3) {
    const index = bytes[o] | (bytes[o + 1] << 8);
    if (index >= HISTOGRAM_SIZE) return null;
    bins[index] = bytes[o + 2];
    total += bytes[o + 2];
  }
  if (total <= 0) return null;
  for (let i = 0; i < bins.length; i += 1) bins[i] /= total;
  return bins;
}

/** バイト列を base64 に。btoa は環境によって無い（Node の一部）ので自前で持つ。 */
const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += BASE64_CHARS[b0 >> 2];
    out += BASE64_CHARS[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? BASE64_CHARS[((b1 & 0x0f) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < bytes.length ? BASE64_CHARS[b2 & 0x3f] : "=";
  }
  return out;
}

function base64ToBytes(text: string): Uint8Array | null {
  const clean = text.replace(/=+$/, "");
  const bits: number[] = [];
  for (const char of clean) {
    const value = BASE64_CHARS.indexOf(char);
    if (value < 0) return null;
    bits.push(value);
  }
  const bytes = new Uint8Array(Math.floor((bits.length * 6) / 8));
  let out = 0;
  for (let i = 0; i + 1 < bits.length; i += 4) {
    bytes[out++] = (bits[i] << 2) | (bits[i + 1] >> 4);
    if (i + 2 < bits.length) bytes[out++] = ((bits[i + 1] & 0x0f) << 4) | (bits[i + 2] >> 2);
    if (i + 3 < bits.length) bytes[out++] = ((bits[i + 2] & 0x03) << 6) | bits[i + 3];
  }
  return bytes.subarray(0, out);
}

// ---------------------------------------------------------------------------
// 距離
// ---------------------------------------------------------------------------

/**
 * ヒストグラム同士の Hellinger 距離。0 以上 √2 以下で、小さいほど色味が似ている。
 *
 * 「要素ごとに平方根を取ってからユークリッド距離」を測る。比率をそのまま引き算する
 * ユークリッド距離と違い、面積の小さい山（＝差し色）の違いもきちんと効く。
 */
export function histogramDistance(a: Float64Array, b: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = Math.sqrt(a[i]) - Math.sqrt(b[i]);
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/**
 * 全ペアの距離を 1 本の Float64Array（row-major, n×n）に詰めて返す。
 * 添字の規約は palette.ts の buildDistanceMatrixFlat と同じで、`flat[i * n + j]` が i 番と j 番の距離。
 *
 * 平方根は写真ごとに 1 回だけ取る。ペアごとに取り直すと n^2 回になり、ここが支配的になる。
 */
export function buildHistogramMatrixFlat(histograms: readonly PhotoHistogram[]): Float64Array {
  const n = histograms.length;
  const roots = histograms.map((histogram) => {
    const root = new Float64Array(histogram.bins.length);
    for (let i = 0; i < root.length; i += 1) root[i] = Math.sqrt(histogram.bins[i]);
    return root;
  });

  const flat = new Float64Array(n * n);
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const left = roots[i];
      const right = roots[j];
      let sum = 0;
      for (let k = 0; k < left.length; k += 1) {
        const d = left[k] - right[k];
        sum += d * d;
      }
      const distance = Math.sqrt(sum);
      flat[i * n + j] = distance;
      flat[j * n + i] = distance;
    }
  }
  return flat;
}

// ---------------------------------------------------------------------------
// グループ分け（平均連結法）
// ---------------------------------------------------------------------------

/**
 * 平均連結法（average linkage）で count 個のグループに分ける。
 *
 * 近い 2 つを繋いでいき、繋いだ後の距離は「両者のメンバー数で重み付けした平均」にする。
 * groupByCount の k-medoids は代表 1 枚からの距離で決めるため、代表がずれるとグループごと
 * 崩れるが、こちらは少しずつ変化していく写真の並びにも強い。
 *
 * 同点は必ず若い添字を選ぶので、同じ入力からは必ず同じ結果になる。
 *
 * @returns 各写真の所属グループ番号。番号は 0 から連番。
 */
export function averageLinkageLabels(matrix: ArrayLike<ArrayLike<number>>, count: number, size: number): Int32Array {
  const n = size;
  const k = Math.max(1, Math.min(Math.trunc(count), n));
  const labels = new Int32Array(n);
  if (n === 0) return labels;

  // 併合のたびに書き換える作業用の距離。上三角だけ使う。
  const distance: Float64Array[] = [];
  for (let i = 0; i < n; i += 1) {
    const row = new Float64Array(n);
    for (let j = 0; j < n; j += 1) row[j] = matrix[i][j];
    distance.push(row);
  }

  const alive = new Uint8Array(n).fill(1);
  const clusterSize = new Int32Array(n).fill(1);
  // 各クラスタが抱える写真の添字。併合のたびに片方へ寄せる。
  const members: number[][] = Array.from({ length: n }, (_, i) => [i]);

  let clusters = n;
  while (clusters > k) {
    let bestI = -1;
    let bestJ = -1;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < n; i += 1) {
      if (!alive[i]) continue;
      for (let j = i + 1; j < n; j += 1) {
        if (!alive[j]) continue;
        if (distance[i][j] < best) {
          best = distance[i][j];
          bestI = i;
          bestJ = j;
        }
      }
    }
    if (bestI < 0) break;

    // Lance-Williams の平均連結：併合後の距離はメンバー数で重み付けした平均。
    const sizeI = clusterSize[bestI];
    const sizeJ = clusterSize[bestJ];
    for (let m = 0; m < n; m += 1) {
      if (!alive[m] || m === bestI || m === bestJ) continue;
      const merged = (sizeI * distance[bestI][m] + sizeJ * distance[bestJ][m]) / (sizeI + sizeJ);
      distance[bestI][m] = merged;
      distance[m][bestI] = merged;
    }

    alive[bestJ] = 0;
    clusterSize[bestI] = sizeI + sizeJ;
    members[bestI] = members[bestI].concat(members[bestJ]);
    clusters -= 1;
  }

  let label = 0;
  for (let i = 0; i < n; i += 1) {
    if (!alive[i]) continue;
    for (const member of members[i]) labels[member] = label;
    label += 1;
  }
  return labels;
}

/**
 * 大きすぎるグループを、同じ手順で中だけ分け直す。
 *
 * 平均連結法は「似たものがまとまる」代わりに、ありふれた色の写真が 1 つの大きな塊に
 * なりやすい。1 グループおよそ N 枚という粒度が欲しいときは、目標の maxRatio 倍を
 * 超えた組だけを再帰的に割る。正しくまとまっている小さい組は触らない。
 */
export function splitOversizedLabels(
  matrix: ArrayLike<ArrayLike<number>>,
  labels: Int32Array,
  targetSize: number,
  maxRatio = 2,
): Int32Array {
  const limit = Math.max(2, Math.round(targetSize * maxRatio));
  const result = Int32Array.from(labels);
  let nextLabel = 0;
  for (const label of result) if (label >= nextLabel) nextLabel = label + 1;

  // 1 回では収まらない（割った先がまだ大きい）ことがあるので、収まるまで繰り返す。
  for (;;) {
    const sizes = new Map<number, number[]>();
    for (let i = 0; i < result.length; i += 1) {
      const bucket = sizes.get(result[i]);
      if (bucket) bucket.push(i);
      else sizes.set(result[i], [i]);
    }

    const oversized = [...sizes.entries()].filter(([, members]) => members.length > limit);
    if (oversized.length === 0) return result;

    let progressed = false;
    for (const [, members] of oversized) {
      const subCount = Math.max(2, Math.round(members.length / targetSize));
      // 部分行列を作って同じ手順を掛ける。
      const sub: number[][] = members.map((i) => members.map((j) => matrix[i][j]));
      const subLabels = averageLinkageLabels(sub, subCount, members.length);

      let distinct = 0;
      for (const value of subLabels) if (value + 1 > distinct) distinct = value + 1;
      if (distinct < 2) continue; // これ以上割れない（全部同じ距離など）

      // 0 番はそのまま残し、1 番以降を新しい番号に振り直す。
      const mapping = new Map<number, number>();
      for (let s = 1; s < distinct; s += 1) mapping.set(s, nextLabel++);
      for (let m = 0; m < members.length; m += 1) {
        const sub = subLabels[m];
        if (sub === 0) continue;
        result[members[m]] = mapping.get(sub) as number;
      }
      progressed = true;
    }
    if (!progressed) return result;
  }
}

/**
 * 1 グループがおよそ targetSize 枚になるように分ける。
 *
 * 平均連結法で `写真数 / targetSize` 個に分けたあと、目標の 2 倍を超えた組だけ割り直す。
 * 割り直しでグループ数は指定より増えるが、そのぶん粒が揃う。
 *
 * @returns photoId の配列の配列。groupByThreshold と同じく、大きい順・同数なら先頭 ID の辞書順。
 */
export function groupByTargetSize(
  items: readonly PhotoRef[],
  matrix: ArrayLike<ArrayLike<number>>,
  targetSize: number,
  maxRatio = 2,
): string[][] {
  const n = items.length;
  if (n === 0) return [];
  const size = Math.max(1, Math.trunc(targetSize));
  const count = Math.max(1, Math.round(n / size));

  const labels = splitOversizedLabels(
    matrix,
    averageLinkageLabels(matrix, count, n),
    size,
    maxRatio,
  );

  const buckets = new Map<number, string[]>();
  for (let i = 0; i < n; i += 1) {
    const bucket = buckets.get(labels[i]);
    if (bucket) bucket.push(items[i].photoId);
    else buckets.set(labels[i], [items[i].photoId]);
  }

  const groups = [...buckets.values()];
  for (const group of groups) group.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  groups.sort((x, y) => {
    if (x.length !== y.length) return y.length - x.length;
    return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0;
  });
  return groups;
}
