// 写真の代表色（カラーパレット）を扱う、プラットフォーム非依存のロジック。
// サムネイルのデコードは環境依存（Web は canvas）なので、ここには一切持ち込まず
// 「RGBA のピクセル列を受け取る」ところから先だけを担当する。
//
// 色空間は OKLab を使う。sRGB のまま距離を測ると人の感じる差と大きくずれるが、
// OKLab は知覚的にほぼ等間隔なので、単純なユークリッド距離が「色の似ている度合い」として使える。

/**
 * パレットの形式バージョン。抽出アルゴリズムを変えたら上げる。
 * 保存済みのパレットがこの値より古ければ、クライアントが再抽出して上書きする。
 *
 * 「アルゴリズム」にはこのファイルの外の前処理も含む。特に呼び出し側が画像を縮小する
 * サイズ（apps/web の SAMPLE_MAX_EDGE、現在は長辺 64px）を変えると代表色がずれ、古いパレットとは
 * 距離を比べられなくなる。同じ version のパレット同士は必ず同じ条件で抽出されている、
 * という前提で buildDistanceMatrix が使われるため、そこを崩すなら必ずこの値を上げること。
 */
export const PALETTE_VERSION = 2;

/**
 * 1枚の写真から取り出す代表色の数。保存される swatches の長さでもある。
 * k-means の k はこれより 1 大きい（CLUSTER_COUNT）。暗部のクラスタを捨てるためで、
 * 最終的に残る色数がこの値になる。
 */
export const PALETTE_SIZE = 5;

/** 代表色 1 色分。hex は表示用、l/a/b は距離計算用で、同じ色を 2 通りに持っているだけ。 */
export interface PaletteSwatch {
  /** `#rrggbb` 形式。表示専用で、距離計算には使わない。 */
  hex: string;
  /** この色が画像に占める割合。パレット全体の合計は 1。 */
  ratio: number;
  l: number;
  a: number;
  b: number;
}

/** 写真 1 枚分のパレット。API と D1 の両方でこの形のまま扱う。 */
export interface PhotoPalette {
  photoId: string;
  version: number;
  swatches: PaletteSwatch[];
}

// ---------------------------------------------------------------------------
// 色空間変換
// ---------------------------------------------------------------------------

/** sRGB のガンマを外して線形 RGB にする。引数・戻り値ともに 0–1。 */
function srgbChannelToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** 線形 RGB に sRGB のガンマを掛け戻す。引数・戻り値ともに 0–1。 */
function linearChannelToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

/**
 * sRGB (各チャンネル 0–255) を OKLab に変換する。
 * 線形化 → LMS 行列 → 立方根 → OKLab 行列、という Björn Ottosson の定義そのまま。
 */
export function srgbToOklab(
  r: number,
  g: number,
  b: number,
): { l: number; a: number; b: number } {
  const lr = srgbChannelToLinear(r / 255);
  const lg = srgbChannelToLinear(g / 255);
  const lb = srgbChannelToLinear(b / 255);

  // 線形 RGB → LMS（錐体応答）
  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;

  // 立方根で圧縮してから OKLab へ。負値も扱えるよう Math.cbrt を使う。
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return {
    l: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  };
}

/** 0–255 に丸めて 2 桁の 16 進にする。 */
function toHexByte(value: number): string {
  const clamped = Math.min(255, Math.max(0, Math.round(value)));
  return clamped.toString(16).padStart(2, "0");
}

/**
 * OKLab を `#rrggbb` に戻す。
 * k-means の重心は sRGB の色域外に出ることがあるため、最後に 0–255 でクランプする。
 */
export function oklabToHex(l: number, a: number, b: number): string {
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;

  const lc = l_ * l_ * l_;
  const mc = m_ * m_ * m_;
  const sc = s_ * s_ * s_;

  const r = 4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc;
  const g = -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc;
  const bl = -0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc;

  return `#${toHexByte(linearChannelToSrgb(r) * 255)}${toHexByte(
    linearChannelToSrgb(g) * 255,
  )}${toHexByte(linearChannelToSrgb(bl) * 255)}`;
}

// ---------------------------------------------------------------------------
// 決定的な乱数
// ---------------------------------------------------------------------------

/** 文字列を 32bit のハッシュにする (FNV-1a)。PRNG の種として使う。 */
function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // 0 を種にすると mulberry32 が退化するので避ける。
  return h >>> 0 || 0x9e3779b9;
}

/** mulberry32。種が同じなら必ず同じ列を返すので、再抽出しても結果が揺れない。 */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// パレット抽出 (k-means)
// ---------------------------------------------------------------------------

/** 抽出中だけ使う OKLab の点。PaletteSwatch より軽くしておく。 */
interface LabPoint {
  l: number;
  a: number;
  b: number;
}

/** OKLab 空間の距離の 2 乗。比較にしか使わないので平方根は取らない。 */
function squaredDistance(p: LabPoint, q: LabPoint): number {
  const dl = p.l - q.l;
  const da = p.a - q.a;
  const db = p.b - q.b;
  return dl * dl + da * da + db * db;
}

/** これ未満の alpha は「透明」とみなして代表色の対象から外す。 */
const MIN_ALPHA = 128;

/** k-means の反復上限。サムネイル程度の点数なら十分収束する。 */
const MAX_ITERATIONS = 20;

/**
 * 実際にクラスタ化する数。欲しい色数より 1 つ多く取る（いわゆる k+1）。
 *
 * VRChat のスクリーンショットは夜のワールドや影が広く、暗部だけで画面のかなりを占める。
 * k=5 のまま回すと 5 色のうち 1〜2 色が「ほぼ黒」に潰れ、写真の特徴が出なくなる。
 * 6 クラスタ作って暗い 1 つを捨てることで、残る 5 色を実際の色味に使い切る。
 */
const CLUSTER_COUNT = PALETTE_SIZE + 1;

/**
 * 「黒」とみなす OKLab の明度 L の上限。
 *
 * OKLab の L は 0（黒）〜1（白）。sRGB のグレー 20% 程度がおよそ 0.30 なので、
 * それより暗いものを暗部として扱う。この値を変えると代表色が変わるため、
 * 変更時は PALETTE_VERSION を上げること。
 */
const BLACK_L_MAX = 0.3;

/**
 * 捨てるクラスタの番号を選ぶ。
 *
 * 第一候補は「BLACK_L_MAX より暗いクラスタのうち最も暗いもの」。
 * ただし全画素が暗い写真（真っ暗なスクリーンショット）でそれを捨てると
 * 残りが 0 画素になり、比率が全部 0 の無意味なパレットになってしまう。
 * その場合は暗部こそがその写真の色なので捨てず、代わりに最も小さいクラスタを落とす。
 */
function pickDroppedCluster(centers: LabPoint[], counts: number[], total: number): number {
  let darkest = -1;
  for (let c = 0; c < centers.length; c += 1) {
    if (centers[c].l >= BLACK_L_MAX) continue;
    // 同じ明度なら若い番号を優先し、結果を決定的にする。
    if (darkest < 0 || centers[c].l < centers[darkest].l) darkest = c;
  }
  if (darkest >= 0 && total - counts[darkest] > 0) return darkest;

  // 暗いクラスタが無い（または捨てると何も残らない）ときは、最も小さいものを落とす。
  let smallest = 0;
  for (let c = 1; c < centers.length; c += 1) {
    if (counts[c] < counts[smallest]) smallest = c;
  }
  return smallest;
}

/**
 * k-means++ で初期中心を選ぶ。
 * 通常の乱択より初期配置が散らばるので、少ない反復でも安定した結果になる。
 */
function pickInitialCenters(
  samples: LabPoint[],
  k: number,
  rand: () => number,
): LabPoint[] {
  const centers: LabPoint[] = [];
  const first = Math.min(samples.length - 1, Math.floor(rand() * samples.length));
  centers.push({ ...samples[first] });

  while (centers.length < k) {
    // 既存の中心から遠い点ほど選ばれやすくする（D^2 重み付け）。
    let total = 0;
    const weights = samples.map((sample) => {
      let nearest = Number.POSITIVE_INFINITY;
      for (const center of centers) {
        const d = squaredDistance(sample, center);
        if (d < nearest) nearest = d;
      }
      total += nearest;
      return nearest;
    });

    if (total <= 0) {
      // 全ての点が既存の中心と一致している（単色画像など）。
      // 乱択の余地が無いので、決定的に既存の中心を複製して埋める。
      centers.push({ ...centers[0] });
      continue;
    }

    const target = rand() * total;
    let acc = 0;
    let picked = samples.length - 1;
    for (let i = 0; i < samples.length; i += 1) {
      acc += weights[i];
      if (acc >= target) {
        picked = i;
        break;
      }
    }
    centers.push({ ...samples[picked] });
  }

  return centers;
}

/**
 * RGBA のピクセル列から代表色を取り出す。
 *
 * @param pixels `getImageData().data` と同じ RGBA が 4 バイトずつ並んだ配列。
 * @param seed   初期中心を決める種。写真 ID など、写真ごとに固定の文字列を渡すこと。
 * @returns ratio の降順に並んだ、常に長さ PALETTE_SIZE の配列。
 *          代表色が足りない場合（単色画像など）は余りが ratio 0 で埋まる。
 */
export function extractPalette(
  pixels: Uint8ClampedArray,
  seed: string,
): PaletteSwatch[] {
  // 透明なピクセルは色として意味を持たないので捨てる。
  const samples: LabPoint[] = [];
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3] < MIN_ALPHA) continue;
    samples.push(srgbToOklab(pixels[i], pixels[i + 1], pixels[i + 2]));
  }

  if (samples.length === 0) {
    // 有効な画素が無い。呼び出し側が特別扱いしなくて済むよう、空ではなく黒 0% で返す。
    return Array.from({ length: PALETTE_SIZE }, () => ({
      hex: "#000000",
      ratio: 0,
      l: 0,
      a: 0,
      b: 0,
    }));
  }

  const rand = mulberry32(hashSeed(seed));
  // 欲しい色数より 1 つ多くクラスタを作る。捨てる 1 つは収束後に決める。
  const centers = pickInitialCenters(samples, CLUSTER_COUNT, rand);
  const assignments = new Array<number>(samples.length).fill(-1);
  const counts = new Array<number>(CLUSTER_COUNT).fill(0);

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
    // --- 割り当て。距離が同じなら必ず若い中心を選び、結果を決定的にする。
    let changed = false;
    counts.fill(0);
    for (let i = 0; i < samples.length; i += 1) {
      let best = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let c = 0; c < centers.length; c += 1) {
        const d = squaredDistance(samples[i], centers[c]);
        if (d < bestDistance) {
          bestDistance = d;
          best = c;
        }
      }
      if (assignments[i] !== best) {
        assignments[i] = best;
        changed = true;
      }
      counts[best] += 1;
    }
    // 割り当てが動かなくなったら収束。
    if (!changed) break;

    // --- 更新。各クラスタの重心を新しい中心にする。
    const sums = Array.from({ length: CLUSTER_COUNT }, () => ({ l: 0, a: 0, b: 0 }));
    for (let i = 0; i < samples.length; i += 1) {
      const sum = sums[assignments[i]];
      sum.l += samples[i].l;
      sum.a += samples[i].a;
      sum.b += samples[i].b;
    }
    for (let c = 0; c < CLUSTER_COUNT; c += 1) {
      if (counts[c] === 0) continue;
      centers[c] = {
        l: sums[c].l / counts[c],
        a: sums[c].a / counts[c],
        b: sums[c].b / counts[c],
      };
    }

    // --- 空クラスタの埋め直し。最も浮いている点を新しい中心にして遊ばせない。
    for (let c = 0; c < CLUSTER_COUNT; c += 1) {
      if (counts[c] > 0) continue;
      let farthest = -1;
      let farthestDistance = 0;
      for (let i = 0; i < samples.length; i += 1) {
        const d = squaredDistance(samples[i], centers[assignments[i]]);
        if (d > farthestDistance) {
          farthestDistance = d;
          farthest = i;
        }
      }
      // 距離 0 しか無い（単色画像など）なら、埋め直しても中心が重複して
      // 割り当てが振動するだけなので、空のまま残す。
      if (farthest < 0) continue;
      centers[c] = { ...samples[farthest] };
    }
  }

  // --- 最終的な占有率を数え直してから swatch に落とす。
  counts.fill(0);
  for (let i = 0; i < samples.length; i += 1) {
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let c = 0; c < centers.length; c += 1) {
      const d = squaredDistance(samples[i], centers[c]);
      if (d < bestDistance) {
        bestDistance = d;
        best = c;
      }
    }
    counts[best] += 1;
  }

  // --- k+1 のうち 1 つ（多くの場合は暗部）を捨てて、欲しい PALETTE_SIZE 色にする。
  const dropped = pickDroppedCluster(centers, counts, samples.length);
  // 比率は「捨てた後に残った画素」に対する割合にする。こうしないと合計が 1 に満たず、
  // 暗い写真ほど全部の色が薄く見える、という比較しにくいパレットになる。
  let remaining = 0;
  for (let c = 0; c < CLUSTER_COUNT; c += 1) {
    if (c !== dropped) remaining += counts[c];
  }

  const swatches: PaletteSwatch[] = [];
  for (let c = 0; c < CLUSTER_COUNT; c += 1) {
    if (c === dropped) continue;
    const center = centers[c];
    swatches.push({
      hex: oklabToHex(center.l, center.a, center.b),
      // remaining が 0 になるのは全画素が 1 クラスタに入っていて、かつそれを捨てられなかった
      // 場合だけ（pickDroppedCluster が防いでいる）。念のため 0 除算にはしない。
      ratio: remaining > 0 ? counts[c] / remaining : 0,
      l: center.l,
      a: center.a,
      b: center.b,
    });
  }

  // ratio 降順。同率のときは OKLab の値で並べて、順序まで決定的にする。
  swatches.sort(
    (x, y) => y.ratio - x.ratio || x.l - y.l || x.a - y.a || x.b - y.b,
  );
  return swatches;
}

// ---------------------------------------------------------------------------
// パレット同士の距離
// ---------------------------------------------------------------------------

/**
 * 並び順に依存しない比較キー。
 * distance(a, b) と distance(b, a) で必ず同じ手順を踏ませるために使う。
 */
function paletteKey(swatches: PaletteSwatch[]): string {
  return swatches
    .map(
      (s) =>
        `${s.l.toFixed(6)},${s.a.toFixed(6)},${s.b.toFixed(6)},${s.ratio.toFixed(6)}`,
    )
    .join("|");
}

/**
 * パレット同士の距離。0 以上の有限値で、小さいほど色味が似ている。
 *
 * 5 色 × 5 色の対応付け問題として解く。全ペアの OKLab 距離を求め、
 * 小さいものから貪欲に確定させ、min(ratio_a, ratio_b) を重みに加重平均する。
 * 「よく使われている色同士が近い」ほど距離が小さくなる、という直感に合う。
 *
 * 引数を入れ替えても必ず同じ値になる（先に決定的な順序へ正規化しているため）。
 */
export function paletteDistance(a: PaletteSwatch[], b: PaletteSwatch[]): number {
  if (a.length === 0 || b.length === 0) return 0;

  // 貪欲法は同点ペアの選び方で結果が変わりうる。引数の順序で揺れないよう、
  // 比較キーの辞書順で「どちらを左に置くか」を先に固定してしまう。
  return paletteKey(a) <= paletteKey(b)
    ? orderedPaletteDistance(a, b)
    : orderedPaletteDistance(b, a);
}

/**
 * 左右の順序が既に決まっているパレット同士の距離。paletteDistance の本体。
 *
 * 正規化（どちらを左に置くか）は呼び出し側の責任。buildDistanceMatrix は
 * 比較キーを写真ごとに 1 回だけ作って使い回したいので、ここを直接呼ぶ。
 */
function orderedPaletteDistance(left: PaletteSwatch[], right: PaletteSwatch[]): number {
  // 全ペアの距離を並べ、小さい順に確定していく。
  const pairs: Array<{ i: number; j: number; distance: number; weight: number }> =
    [];
  for (let i = 0; i < left.length; i += 1) {
    for (let j = 0; j < right.length; j += 1) {
      pairs.push({
        i,
        j,
        distance: Math.sqrt(squaredDistance(left[i], right[j])),
        weight: Math.min(left[i].ratio, right[j].ratio),
      });
    }
  }
  pairs.sort((x, y) => x.distance - y.distance || x.i - y.i || x.j - y.j);

  const usedLeft = new Array<boolean>(left.length).fill(false);
  const usedRight = new Array<boolean>(right.length).fill(false);
  let weighted = 0;
  let weightSum = 0;
  let plain = 0;
  let matched = 0;

  for (const pair of pairs) {
    if (usedLeft[pair.i] || usedRight[pair.j]) continue;
    usedLeft[pair.i] = true;
    usedRight[pair.j] = true;
    weighted += pair.distance * pair.weight;
    weightSum += pair.weight;
    plain += pair.distance;
    matched += 1;
  }

  // 重みが全て 0（ratio が全部 0 のパレット）のときは単純平均に落とす。
  if (weightSum <= 0) return matched === 0 ? 0 : plain / matched;
  return weighted / weightSum;
}

/**
 * 距離行列として受け付ける形。
 *
 * `number[][]`（buildDistanceMatrix の戻り値）と `Float64Array[]`
 * （reshapeDistanceMatrix が flat 表現から作るビュー）の両方を同じ添字で読めるように、
 * 「添字で数値が引ける行の配列」まで型を緩めてある。
 */
export type DistanceMatrix = readonly ArrayLike<number>[];

/**
 * 全ペアの距離を 1 本の Float64Array（row-major, n×n）に詰めて返す。
 *
 * Web Worker で計算してメインスレッドへ渡す用。TypedArray は transfer できるので、
 * n が大きくても構造化クローンのコピーが発生しない。
 * 添字の規約は buildDistanceMatrix と同じで、`flat[i * n + j]` が i 番と j 番の距離。
 */
export function buildDistanceMatrixFlat(palettes: PhotoPalette[]): Float64Array {
  const n = palettes.length;
  const flat = new Float64Array(n * n);
  // 比較キーは距離の値には効かず「どちらを左に置くか」を決めるだけなので、
  // n^2 回のペアごとに作り直さず写真ごとに 1 回だけ作る（枚数が増えるとここが支配的になる）。
  const keys = palettes.map((p) => paletteKey(p.swatches));
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const a = palettes[i].swatches;
      const b = palettes[j].swatches;
      const d =
        a.length === 0 || b.length === 0
          ? 0
          : keys[i] <= keys[j]
            ? orderedPaletteDistance(a, b)
            : orderedPaletteDistance(b, a);
      flat[i * n + j] = d;
      flat[j * n + i] = d;
    }
  }
  return flat;
}

/**
 * flat 表現を行ごとのビューに開き直す。
 *
 * subarray はコピーではなく同じバッファを見るビューなので、n が大きくても実質ゼロコストで、
 * `matrix[i][j]` の形で読めるようになる。
 */
export function reshapeDistanceMatrix(flat: Float64Array, n: number): Float64Array[] {
  return Array.from({ length: n }, (_, i) => flat.subarray(i * n, (i + 1) * n));
}

/**
 * 全ペアの距離行列。対称で、対角は 0。
 *
 * 添字は引数 `palettes` の並び順そのもの。groupByThreshold / nearestPhotos には
 * 必ず同じ配列を同じ順序で渡すこと。
 *
 * Worker を使えない環境向けの同期版。枚数が多い場合はメインスレッドを止めるので、
 * ブラウザからは buildDistanceMatrixFlat を Worker 側で呼ぶ方を優先すること。
 */
export function buildDistanceMatrix(palettes: PhotoPalette[]): number[][] {
  const n = palettes.length;
  const flat = buildDistanceMatrixFlat(palettes);
  return Array.from({ length: n }, (_, i) => Array.from(flat.subarray(i * n, (i + 1) * n)));
}

// ---------------------------------------------------------------------------
// グループ化
// ---------------------------------------------------------------------------

/**
 * しきい値以下のペアを繋いでグループを作る (union-find)。
 *
 * 「A と B が近く、B と C が近ければ同じグループ」という連結成分としての分け方なので、
 * しきい値を上げるほどグループは大きく・少なくなる。
 *
 * @returns photoId の配列の配列。グループは大きい順、同数なら先頭 photoId の辞書順。
 *          グループ内の photoId も辞書順に並ぶ。どの写真も必ずどれか 1 つに属する。
 */
export function groupByThreshold(
  palettes: PhotoPalette[],
  matrix: DistanceMatrix,
  threshold: number,
): string[][] {
  const n = palettes.length;
  const parent = Array.from({ length: n }, (_, i) => i);

  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    // 経路圧縮。次回以降の find を平らにする。
    let cursor = x;
    while (parent[cursor] !== root) {
      const next = parent[cursor];
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };

  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (matrix[i][j] > threshold) continue;
      const ri = find(i);
      const rj = find(j);
      if (ri !== rj) parent[Math.max(ri, rj)] = Math.min(ri, rj);
    }
  }

  const buckets = new Map<number, string[]>();
  for (let i = 0; i < n; i += 1) {
    const root = find(i);
    const bucket = buckets.get(root);
    if (bucket) bucket.push(palettes[i].photoId);
    else buckets.set(root, [palettes[i].photoId]);
  }

  const groups = [...buckets.values()];
  // localeCompare はロケール依存なので使わず、素の比較で安定させる。
  for (const group of groups) group.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  groups.sort((x, y) => {
    if (x.length !== y.length) return y.length - x.length;
    return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0;
  });
  return groups;
}

/** k-medoids の反復上限。medoid の移動は数回で止まるので、これで十分収束する。 */
const MEDOID_MAX_ITERATIONS = 20;

/**
 * 写真をちょうど count 個のグループに分ける (k-medoids)。
 *
 * groupByThreshold は「近いペアを繋ぐ」ため、A〜B と B〜C が近いだけで
 * A と C まで同じグループになる（連鎖）。こちらは代表写真 (medoid) からの
 * 距離で割り当てるので連鎖せず、グループ数も指定した数に固定される。
 *
 * 乱数は使わない。最初の medoid は「全写真への距離の合計が最小の写真」、
 * 以降は「既存の medoid から最も遠い写真」を順に選ぶ (farthest-first)。
 * 同点は常に若い添字を採るので、同じ入力からは必ず同じ結果になる。
 *
 * @param count 望むグループ数。写真の枚数と 1 でクランプされる。また、距離 0 の
 *              写真しか残っていない場合はそれ以上増やしても意味が無いので、
 *              指定より少ないグループ数で返ることがある。
 * @returns groupByThreshold と同じ形式・同じ並び順の photoId の配列の配列。
 */
export function groupByCount(
  palettes: PhotoPalette[],
  matrix: DistanceMatrix,
  count: number,
): string[][] {
  const n = palettes.length;
  if (n === 0) return [];
  const k = Math.max(1, Math.min(Math.trunc(count), n));

  // --- 初期 medoid の選択 (farthest-first)。
  // 1 つ目は最も「中心的」な写真。以降は最寄りの medoid から最も遠い写真を足していく。
  const medoids: number[] = [];
  {
    let central = 0;
    let centralSum = Number.POSITIVE_INFINITY;
    for (let i = 0; i < n; i += 1) {
      let sum = 0;
      for (let j = 0; j < n; j += 1) sum += matrix[i][j];
      if (sum < centralSum) {
        centralSum = sum;
        central = i;
      }
    }
    medoids.push(central);
  }
  // 各写真から最寄りの medoid までの距離。medoid を足すたびに縮めて使い回す。
  const nearestToMedoid = new Float64Array(n);
  for (let i = 0; i < n; i += 1) nearestToMedoid[i] = matrix[medoids[0]][i];
  while (medoids.length < k) {
    let farthest = 0;
    let farthestDistance = -1;
    for (let i = 0; i < n; i += 1) {
      if (nearestToMedoid[i] > farthestDistance) {
        farthestDistance = nearestToMedoid[i];
        farthest = i;
      }
    }
    // 全写真が既存の medoid と距離 0（全部同じパレットなど）。これ以上足しても
    // 空グループができるだけなので、少ないグループ数のまま打ち切る。
    if (farthestDistance <= 0) break;
    medoids.push(farthest);
    for (let i = 0; i < n; i += 1) {
      const d = matrix[farthest][i];
      if (d < nearestToMedoid[i]) nearestToMedoid[i] = d;
    }
  }

  // --- 割り当てと medoid の更新を、動かなくなるまで繰り返す (Voronoi 反復)。
  const assignments = new Array<number>(n).fill(0);
  for (let iteration = 0; iteration < MEDOID_MAX_ITERATIONS; iteration += 1) {
    // 割り当て。距離が同じなら若い medoid を選び、結果を決定的にする。
    for (let i = 0; i < n; i += 1) {
      let best = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let m = 0; m < medoids.length; m += 1) {
        const d = matrix[i][medoids[m]];
        if (d < bestDistance) {
          bestDistance = d;
          best = m;
        }
      }
      assignments[i] = best;
    }

    // 更新。各グループ内で「他のメンバーへの距離の合計が最小の写真」を新しい medoid にする。
    const members: number[][] = Array.from({ length: medoids.length }, () => []);
    for (let i = 0; i < n; i += 1) members[assignments[i]].push(i);
    let moved = false;
    for (let m = 0; m < medoids.length; m += 1) {
      if (members[m].length === 0) continue;
      let best = medoids[m];
      let bestSum = Number.POSITIVE_INFINITY;
      for (const i of members[m]) {
        let sum = 0;
        for (const j of members[m]) sum += matrix[i][j];
        if (sum < bestSum) {
          bestSum = sum;
          best = i;
        }
      }
      if (best !== medoids[m]) {
        medoids[m] = best;
        moved = true;
      }
    }
    // medoid が動かなければ、直前の割り当ても最新の medoid に対するものなので終わり。
    if (!moved) break;
  }

  // --- groupByThreshold と同じ形へ整える。
  const buckets: string[][] = Array.from({ length: medoids.length }, () => []);
  for (let i = 0; i < n; i += 1) buckets[assignments[i]].push(palettes[i].photoId);
  const groups = buckets.filter((bucket) => bucket.length > 0);
  for (const group of groups) group.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  groups.sort((x, y) => {
    if (x.length !== y.length) return y.length - x.length;
    return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0;
  });
  return groups;
}

/**
 * 指定した写真に色味が近い写真を、近い順に返す。自分自身は含まない。
 *
 * @param matrix buildDistanceMatrix が返した行列（`palettes` と同じ並びであること）。
 */
export function nearestPhotos(
  palettes: PhotoPalette[],
  matrix: DistanceMatrix,
  photoId: string,
  limit: number,
): Array<{ photoId: string; distance: number }> {
  const index = palettes.findIndex((p) => p.photoId === photoId);
  if (index < 0 || limit <= 0) return [];

  const candidates = palettes
    .map((p, i) => ({ photoId: p.photoId, distance: matrix[index][i] }))
    .filter((_, i) => i !== index);
  // 距離が同じときは photoId 順にして、表示順が毎回変わらないようにする。
  candidates.sort(
    (x, y) =>
      x.distance - y.distance ||
      (x.photoId < y.photoId ? -1 : x.photoId > y.photoId ? 1 : 0),
  );
  return candidates.slice(0, limit);
}
