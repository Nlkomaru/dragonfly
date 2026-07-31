"""「画素から作る大域的な色特徴」の候補手法。

現行の推奨 (`methods.RECOMMENDED`) は、k-means で作った代表色 5 色を EMD で比べている。
ここでは **代表色を一切使わず、全画素の色分布そのもの**から距離を作る候補を並べる。
5 色に潰す時点で捨てている情報（色の広がり・階調・少数派の色）が効くかどうかを見る。

- `histogram_matrix` … OKLab の 3 次元格子に画素を投票した結合ヒストグラム。
  ハード割当と、ガウス核で近傍 bin にも配るソフト割当（van Gemert の codeword uncertainty）
  の両方を持つ。距離は Hellinger（L1 正規化 → 平方根 → ユークリッド）か chi2。
- `histogram_emd_matrix` … 同じヒストグラムの上で厳密な輸送距離を解く。
  bin 中心どうしの OKLab 距離を地上コストにする。推奨手法の EMD を画素側に持ち上げた版。
- `msswd_matrix` … MS-SWD (ECCV 2024) のスライス Wasserstein。パッチをランダム方向に
  射影して 1 次元 Wasserstein を取る。分位点ベクトルに落とすと距離行列が cdist 1 回で済む。
- `moments_matrix` … 色モーメント（平均・標準偏差・歪度）だけの最安ベースライン。
  上の 3 つが「複雑さに見合う効果を出しているか」を測る物差しとして置く。
- `fused_matrix` … 上のどれかと、現行の推奨（パレット EMD）を中央値正規化して混ぜる。

いずれも `bench` を受け取り (n, n) の距離行列を返す。採点は
`bakeoff.score_matrix(bench, matrix, "average", key)` に渡すだけ。

**この設定での注意**

- キャッシュ 200 枚のうち 21 枚は縦向き (192x108) で、残りは横向き (108x192)。
  そのため「セルの位置」を前提にする空間記述子 (MPEG-7 CLD) は前提が崩れるので入れていない。
  ここに並べた候補はすべて画素の順序に依存しない（分布だけを見る）ので影響を受けない。
- 画素の重み（アクセント重みの画素版）は、既存の `swatch_weights` と同じく
  `ACCENT_CHROMA_FLOOR + chroma` を使う。彩度そのものを掛けると、無彩色に近い写真で
  重みの合計が 0 に潰れてヒストグラムが数画素で決まってしまう。
"""

from __future__ import annotations

import os
import tempfile
import time
from pathlib import Path

import numpy as np
import ot
from numpy.lib.stride_tricks import sliding_window_view
from scipy.ndimage import gaussian_filter
from scipy.spatial.distance import cdist, squareform
from scipy.stats import rankdata, spearmanr
from sklearn.metrics.pairwise import additive_chi2_kernel

from dragonfly_lab.bakeoff import Bench, format_row, load_bench, score_matrix
from dragonfly_lab.methods import RECOMMENDED, build_distance_matrix
from dragonfly_lab.palette import ACCENT_CHROMA_FLOOR, MIN_ALPHA, srgb_to_oklab

#: パレット EMD の距離行列のキャッシュ置き場。19900 ペア分解くので毎回作ると遅い。
#: 他の候補モジュールと同時に走っても衝突しないよう、このモジュール専用の名前にする。
_CACHE_PATH = Path(
    os.environ.get(
        "CAND_DESCRIPTOR_CACHE",
        Path(tempfile.gettempdir())
        / f"cand_descriptor_{RECOMMENDED.distance_key.replace('|', '_')}.npy",
    )
)

#: OKLab の a, b がだいたい収まる範囲。sRGB 全域でも ±0.3 程度なので、
#: 実写では ±0.25 でほぼ全画素を覆える（外れる画素は端の bin に寄せる）。
_AB_RANGE = 0.25


# ---------------------------------------------------------------------------
# 共通の下ごしらえ
# ---------------------------------------------------------------------------


def oklab_pixels(bench: Bench) -> list[np.ndarray]:
    """写真ごとの OKLab 画素 (npix, 3)。透明な画素は捨てる（パレット抽出と同じ条件）。"""
    result: list[np.ndarray] = []
    for _, rgba in bench.images:
        flat = rgba.reshape(-1, 4)
        opaque = flat[flat[:, 3] >= MIN_ALPHA]
        if len(opaque) == 0:  # 全部透明なら元の画素をそのまま使う（実データでは起きない）
            opaque = flat
        result.append(srgb_to_oklab(opaque[:, :3]))
    return result


def oklab_images(bench: Bench) -> list[np.ndarray]:
    """写真ごとの OKLab 画像 (H, W, 3)。画素の並びを保つ手法（MS-SWD）用。"""
    return [
        srgb_to_oklab(rgba[:, :, :3].reshape(-1, 3)).reshape(rgba.shape[0], rgba.shape[1], 3)
        for _, rgba in bench.images
    ]


def pixel_weights(lab: np.ndarray, gamma: float) -> np.ndarray:
    """画素ごとの重み。gamma=0 で面積（全部 1）、1 でアクセント重み相当。

    彩度をそのまま掛けず `ACCENT_CHROMA_FLOOR + chroma` にするのは `swatch_weights` と同じ。
    無彩色ばかりの写真で重みの合計が 0 になるのを防ぐ。
    """
    if gamma == 0:
        return np.ones(len(lab), dtype=np.float64)
    chroma = np.hypot(lab[:, 1], lab[:, 2])
    return (ACCENT_CHROMA_FLOOR + chroma) ** gamma


def _symmetrize(matrix: np.ndarray) -> np.ndarray:
    """対称・対角 0・非負に整える。

    `cluster_labels` は `squareform(..., checks=False)` で片側の三角しか読まないので、
    浮動小数の誤差で非対称になっていてもエラーにならず、黙って結果が偏る。
    """
    matrix = np.asarray(matrix, dtype=np.float64)
    matrix = (matrix + matrix.T) / 2.0
    np.fill_diagonal(matrix, 0.0)
    return np.maximum(matrix, 0.0)


# ---------------------------------------------------------------------------
# 候補 A: OKLab 3 次元ヒストグラム（ハード割当 / ソフト割当）
# ---------------------------------------------------------------------------


def _bin_centers(bins: tuple[int, int, int]) -> np.ndarray:
    """bin 中心 (K, 3)。L は [0, 1]、a と b は [-0.25, 0.25] を等分する。"""
    bl, ba, bb = bins
    axis_l = (np.arange(bl) + 0.5) / bl
    axis_a = -_AB_RANGE + (np.arange(ba) + 0.5) * (2 * _AB_RANGE / ba)
    axis_b = -_AB_RANGE + (np.arange(bb) + 0.5) * (2 * _AB_RANGE / bb)
    grid = np.stack(np.meshgrid(axis_l, axis_a, axis_b, indexing="ij"), axis=-1)
    return grid.reshape(-1, 3)


def _hard_histogram(lab: np.ndarray, weight: np.ndarray, bins: tuple[int, int, int]) -> np.ndarray:
    """ハード割当のヒストグラム (K,)。各画素は最も近い 1 つの bin にだけ投票する。"""
    bl, ba, bb = bins
    idx_l = np.clip((lab[:, 0] * bl).astype(np.int64), 0, bl - 1)
    idx_a = np.clip(((lab[:, 1] + _AB_RANGE) / (2 * _AB_RANGE) * ba).astype(np.int64), 0, ba - 1)
    idx_b = np.clip(((lab[:, 2] + _AB_RANGE) / (2 * _AB_RANGE) * bb).astype(np.int64), 0, bb - 1)
    flat = (idx_l * ba + idx_a) * bb + idx_b
    return np.bincount(flat, weights=weight, minlength=bl * ba * bb).astype(np.float64)


def _soft_histogram(
    lab: np.ndarray,
    weight: np.ndarray,
    centers: np.ndarray,
    sigma: float,
    scale: np.ndarray,
    chunk: int = 4096,
) -> np.ndarray:
    """ソフト割当（codeword uncertainty）のヒストグラム (K,)。

    各画素の質量 1 をガウス核で近傍 bin に配る。**画素ごとに合計 1 に正規化する**のが肝で、
    正規化しないと codeword plausibility になり、van Gemert の比較では最悪の割当になる。
    """
    scaled_centers = centers * scale
    result = np.zeros(len(centers), dtype=np.float64)
    for start in range(0, len(lab), chunk):
        block = lab[start : start + chunk] * scale
        d2 = ((block[:, None, :] - scaled_centers[None, :, :]) ** 2).sum(-1)
        # 最小距離を引いてから exp する。素の exp はアンダーフローして全 0 になりうる。
        d2 -= d2.min(axis=1, keepdims=True)
        w = np.exp(-d2 / (2.0 * sigma * sigma))
        w /= w.sum(axis=1, keepdims=True)
        result += (w * weight[start : start + chunk, None]).sum(axis=0)
    return result


def build_histograms(
    bench: Bench,
    bins: tuple[int, int, int] = (4, 8, 8),
    gamma: float = 1.0,
    sigma: float = 0.0,
    lightness_weight: float = 0.5,
    pixels: list[np.ndarray] | None = None,
) -> np.ndarray:
    """全写真のヒストグラム (n, K)。各行の合計は 1。

    sigma=0 はハード割当。sigma>0 はソフト割当で、そのときだけ `lightness_weight` が効く
    （bin の切り方自体は素の OKLab 空間で固定し、重みは「近さの測り方」にだけ掛ける）。
    """
    pixels = pixels if pixels is not None else oklab_pixels(bench)
    centers = _bin_centers(bins)
    scale = np.array([lightness_weight, 1.0, 1.0])
    rows = []
    for lab in pixels:
        weight = pixel_weights(lab, gamma)
        h = (
            _hard_histogram(lab, weight, bins)
            if sigma <= 0
            else _soft_histogram(lab, weight, centers, sigma, scale)
        )
        total = h.sum()
        rows.append(h / total if total > 0 else np.full(len(h), 1.0 / len(h)))
    return np.asarray(rows, dtype=np.float64)


def histogram_matrix(
    bench: Bench,
    bins: tuple[int, int, int] = (4, 8, 8),
    gamma: float = 1.0,
    sigma: float = 0.0,
    lightness_weight: float = 0.5,
    distance: str = "hellinger",
    histograms: np.ndarray | None = None,
) -> np.ndarray:
    """ヒストグラム同士の距離行列 (n, n)。

    - `hellinger` … L1 正規化 → 要素ごとの平方根 → ユークリッド。追加コストなしで
      「近い bin に落ちた質量」の効き方が穏やかになる。
    - `chi2` … Σ (x-y)^2 / (x+y)。Rubner の比較で色の分類・検索に良かった測度。
    """
    h = histograms if histograms is not None else build_histograms(
        bench, bins, gamma, sigma, lightness_weight
    )
    if distance == "chi2":
        return _symmetrize(-additive_chi2_kernel(h))
    # Hellinger は「L1 正規化（合計 1）→ 要素ごとの平方根 → ユークリッド」で得られる。
    root = np.sqrt(h)
    return _symmetrize(cdist(root, root, "euclidean"))


def histogram_emd_matrix(
    bench: Bench,
    bins: tuple[int, int, int] = (4, 8, 8),
    gamma: float = 1.0,
    lightness_weight: float = 0.5,
    saturating: bool = False,
    histograms: np.ndarray | None = None,
) -> np.ndarray:
    """ヒストグラム上の厳密な輸送距離 (n, n)。

    地上コストは bin 中心どうしの OKLab 距離（L には `lightness_weight` を掛ける）。
    `saturating=True` にすると Rubner の飽和型コスト 1 - exp(-alpha d) を使い、
    遠い色どうしの差が結果を支配するのを抑える。
    """
    h = histograms if histograms is not None else build_histograms(
        bench, bins, gamma, 0.0, lightness_weight
    )
    centers = _bin_centers(bins) * np.array([lightness_weight, 1.0, 1.0])
    cost = ot.dist(centers, centers, metric="euclidean")
    if saturating:
        # alpha は「全 bin 中心間距離の標準偏差の半分」の逆数（Rubner の指定）。
        alpha = 1.0 / (0.5 * float(np.std(cost[np.triu_indices(len(cost), 1)])))
        cost = 1.0 - np.exp(-alpha * cost)
    cost = np.ascontiguousarray(cost / cost.max())

    n = len(h)
    matrix = np.zeros((n, n), dtype=np.float64)
    for i in range(n):
        for j in range(i + 1, n):
            matrix[i, j] = matrix[j, i] = float(ot.emd2(h[i], h[j], cost))
    return _symmetrize(matrix)


# ---------------------------------------------------------------------------
# 候補 B: MS-SWD（多スケール・スライス Wasserstein）の分位点埋め込み
# ---------------------------------------------------------------------------


def msswd_embeddings(
    bench: Bench,
    scales: int = 3,
    patch: int = 5,
    projections: int = 32,
    quantiles: int = 64,
    lightness_weight: float = 0.5,
    center: bool = False,
    seed: int = 0,
    images: list[np.ndarray] | None = None,
) -> np.ndarray:
    """MS-SWD の埋め込み (n, scales*projections*quantiles)。

    ガウシアンピラミッドの各段でパッチを取り、共有のランダム方向に射影して分位点を取る。
    分位点ベクトルの L1 距離は 1 次元 Wasserstein 距離に一致するので、ペアごとに
    sort し直す代わりに 1 枚 1 本のベクトルで済む（キャッシュの写真は縦横が混ざっているが、
    分位点は標本数に依らない ECDF の要約なのでそのまま比べられる）。

    `center=True` は各射影ごとに中央値を引く。「同じ場所だが露出・時刻が違う」写真の
    平行移動ぶんを消す狙いだが、暖色／寒色の違いまで消える危険もある。
    """
    images = images if images is not None else oklab_images(bench)
    rng = np.random.default_rng(seed)
    dim = patch * patch * 3
    directions = rng.standard_normal((dim, projections))
    directions /= np.linalg.norm(directions, axis=0, keepdims=True)
    qs = (np.arange(quantiles) + 0.5) / quantiles
    scale = np.array([lightness_weight, 1.0, 1.0])

    rows = []
    for lab in images:
        current = lab * scale
        parts = []
        for k in range(scales):
            if k > 0:
                # 空間方向だけぼかしてから 1/2 に間引く（色チャネルは混ぜない）。
                current = gaussian_filter(current, sigma=(1.0, 1.0, 0.0), mode="reflect")[::2, ::2]
            if current.shape[0] < patch or current.shape[1] < patch:
                parts.append(np.zeros(projections * quantiles))  # これ以上小さくできない段
                continue
            windows = sliding_window_view(current, (patch, patch, 3))
            flat = windows.reshape(-1, dim)
            proj = flat @ directions
            parts.append(np.quantile(proj, qs, axis=0))
        embedding = np.concatenate([p.reshape(quantiles, -1) if p.ndim == 1 else p for p in parts])
        if center:
            embedding = embedding - np.median(embedding, axis=0, keepdims=True)
        rows.append(embedding.ravel())
    return np.asarray(rows, dtype=np.float64)


def msswd_matrix(
    bench: Bench,
    scales: int = 3,
    patch: int = 5,
    projections: int = 32,
    quantiles: int = 64,
    lightness_weight: float = 0.5,
    center: bool = False,
    embeddings: np.ndarray | None = None,
) -> np.ndarray:
    """MS-SWD の距離行列 (n, n)。埋め込みの L1 距離をそのまま使う。"""
    e = embeddings if embeddings is not None else msswd_embeddings(
        bench, scales, patch, projections, quantiles, lightness_weight, center
    )
    return _symmetrize(cdist(e, e, "cityblock") / e.shape[1])


# ---------------------------------------------------------------------------
# 候補 C: 色モーメント（最安のベースライン）
# ---------------------------------------------------------------------------


def moments_matrix(
    bench: Bench,
    grid: int = 1,
    gamma: float = 1.0,
    lightness_weight: float = 0.5,
    skew_weight: float = 1.0,
    metric: str = "cityblock",
) -> np.ndarray:
    """色モーメント（平均・標準偏差・歪度）の距離行列 (n, n)。

    grid>1 のときは画像を grid x grid のセルに割って各セルで同じものを計算し連結する。
    セルの位置に意味を持たせるので、縦向きの写真が混ざるこのデータでは grid=1 が本命。
    """
    weights = np.array([lightness_weight, 1.0, 1.0])
    features = []
    for _, rgba in bench.images:
        cells = []
        rows = np.array_split(np.arange(rgba.shape[0]), grid)
        cols = np.array_split(np.arange(rgba.shape[1]), grid)
        for r in rows:
            for c in cols:
                block = rgba[np.ix_(r, c)].reshape(-1, 4)
                opaque = block[block[:, 3] >= MIN_ALPHA]
                if len(opaque) == 0:
                    cells.append(np.zeros(9))
                    continue
                lab = srgb_to_oklab(opaque[:, :3])
                w = pixel_weights(lab, gamma)
                w = w / w.sum()
                mean = (w[:, None] * lab).sum(0)
                diff = lab - mean
                var = (w[:, None] * diff * diff).sum(0)
                skew = np.cbrt((w[:, None] * diff**3).sum(0))  # 符号を保つため cbrt を使う
                cells.append(
                    np.concatenate(
                        [mean * weights, np.sqrt(var) * weights, skew * weights * skew_weight]
                    )
                )
        features.append(np.concatenate(cells))
    return _symmetrize(cdist(np.asarray(features), np.asarray(features), metric))


# ---------------------------------------------------------------------------
# 候補 D: 現行の推奨（パレット EMD）との融合
# ---------------------------------------------------------------------------


def palette_matrix(bench: Bench, cache: bool = True) -> np.ndarray:
    """現行の推奨設定 (accent / L=0.5 / EMD) の距離行列 (n, n)。

    キャッシュは枚数が一致するときだけ使う。並び順は `bench.palettes` に紐づくので、
    枚数が違うキャッシュを流用すると黙って別物の行列になる。
    """
    n = len(bench.palettes)
    if cache and _CACHE_PATH.exists():
        cached = np.load(_CACHE_PATH)
        if cached.shape == (n, n):
            return cached
    matrix = build_distance_matrix(bench.palettes, RECOMMENDED)
    if cache:
        np.save(_CACHE_PATH, matrix)
    return matrix


def _median_normalized(matrix: np.ndarray) -> np.ndarray:
    """上三角の中央値で割って尺度を揃える。片方が数値的に支配するのを防ぐ。"""
    upper = matrix[np.triu_indices(len(matrix), 1)]
    median = float(np.median(upper))
    return matrix / (median if median > 0 else 1.0)


def _rank_normalized(matrix: np.ndarray) -> np.ndarray:
    """上三角を順位に潰す。分布の形の違いまで消したいとき用。"""
    index = np.triu_indices(len(matrix), 1)
    ranks = rankdata(matrix[index]) / len(index[0])
    return _symmetrize(squareform(ranks))


def fused_matrix(
    bench: Bench,
    pixel: np.ndarray,
    alpha: float = 0.3,
    normalize: str = "median",
    base: np.ndarray | None = None,
) -> np.ndarray:
    """パレット EMD と画素特徴の線形結合 (n, n)。alpha=0 が現行、1 が画素特徴単独。"""
    base = base if base is not None else palette_matrix(bench)
    norm = _rank_normalized if normalize == "rank" else _median_normalized
    return _symmetrize((1.0 - alpha) * norm(base) + alpha * norm(pixel))


# ---------------------------------------------------------------------------
# 採点
# ---------------------------------------------------------------------------


def main() -> None:  # noqa: C901
    bench = load_bench()
    print(f"写真 {len(bench.palettes)} 枚 / 目標 {bench.target_size} 枚ずつ / {bench.count} 組")
    print(f"正解 {len(bench.cases)} ケース / 自動 {len(bench.auto_pairs)} ペア\n")

    pixels = oklab_pixels(bench)
    images = oklab_images(bench)
    results: list[tuple[str, object, float]] = []
    #: 最後に「再分割つき」でも見たいものを取っておく。粒を揃えたときに強さが残るかの確認用。
    keep: dict[str, np.ndarray] = {}

    def run(key: str, matrix: np.ndarray, elapsed: float, split: bool = False) -> np.ndarray:
        """距離行列を採点して 1 行表示する。split=True の行も欲しいときは追加で呼ぶ。"""
        evaluation = score_matrix(bench, matrix, "average", key, split=split)
        print(format_row(evaluation), f"{elapsed:5.1f}s")
        results.append((key, evaluation, elapsed))
        return matrix

    # --- 基準: 現行の推奨（パレット EMD）
    start = time.perf_counter()
    base = palette_matrix(bench)
    base_time = time.perf_counter() - start
    run("[基準] palette-emd accent L=0.5", base, base_time)
    run("[基準] palette-emd +再分割", base, base_time, split=True)
    print()

    # --- 候補 C: 色モーメント（最安のベースライン。4 通り）
    print("--- 色モーメント（ベースライン）")
    for grid, gamma, metric in ((1, 1.0, "cityblock"), (1, 0.0, "cityblock"),
                                (2, 1.0, "cityblock"), (4, 1.0, "cityblock")):
        start = time.perf_counter()
        m = moments_matrix(bench, grid=grid, gamma=gamma, metric=metric)
        key = f"moments G={grid} gamma={gamma:g} {metric}"
        run(key, m, time.perf_counter() - start)
        if grid == 4:
            keep[key] = m
    print()

    # --- 候補 A: 3D ヒストグラム（10 通り）
    print("--- OKLab 3D ヒストグラム")
    hist_specs = [
        # (bins, gamma, sigma, distance)
        ((4, 8, 8), 0.0, 0.0, "hellinger"),
        ((4, 8, 8), 1.0, 0.0, "hellinger"),
        ((4, 8, 8), 1.0, 0.0, "chi2"),
        ((3, 6, 6), 1.0, 0.0, "hellinger"),
        ((6, 10, 10), 1.0, 0.0, "hellinger"),
        ((4, 8, 8), 0.0, 0.04, "hellinger"),
        ((4, 8, 8), 1.0, 0.04, "hellinger"),
        ((4, 8, 8), 1.0, 0.04, "chi2"),
        ((4, 8, 8), 2.0, 0.04, "hellinger"),
        ((3, 6, 6), 1.0, 0.05, "hellinger"),
    ]
    hist_cache: dict[tuple, tuple[np.ndarray, float]] = {}
    best_hist: tuple[float, str, np.ndarray] | None = None
    for bins, gamma, sigma, distance in hist_specs:
        cache_key = (bins, gamma, sigma)
        if cache_key not in hist_cache:
            start = time.perf_counter()
            hist_cache[cache_key] = (
                build_histograms(bench, bins, gamma, sigma, 0.5, pixels),
                time.perf_counter() - start,
            )
        h, build_time = hist_cache[cache_key]
        start = time.perf_counter()
        m = histogram_matrix(bench, distance=distance, histograms=h)
        key = f"hist {bins[0]}x{bins[1]}x{bins[2]} g={gamma:g} s={sigma:g} {distance}"
        run(key, m, build_time + time.perf_counter() - start)
        score = results[-1][1].handmade.exact_cases
        if best_hist is None or score > best_hist[0]:
            best_hist = (score, key, m)
        if sigma <= 0 and gamma == 1.0 and distance == "hellinger" and bins != (3, 6, 6):
            keep[key] = m  # 探索なしの素のヒストグラム（本命の対照）
    print()

    # --- 候補 A': ヒストグラム上の厳密 EMD（2 通り）
    print("--- ヒストグラム上の厳密 EMD")
    for gamma, saturating in ((1.0, False), (1.0, True)):
        h, build_time = hist_cache[((4, 8, 8), gamma, 0.0)]
        start = time.perf_counter()
        m = histogram_emd_matrix(bench, gamma=gamma, saturating=saturating, histograms=h)
        run(
            f"hist-emd 4x8x8 g={gamma:g}{' 飽和型' if saturating else ''}",
            m,
            build_time + time.perf_counter() - start,
        )
    print()

    # --- 候補 B: MS-SWD（8 通り）
    print("--- MS-SWD（スライス Wasserstein）")
    best_swd: tuple[float, str, np.ndarray] | None = None
    swd_specs = [
        # (patch, scales, lightness_weight, center)
        (1, 1, 0.25, False),
        (1, 1, 0.5, False),
        (1, 1, 1.0, False),
        (5, 3, 0.25, False),
        (5, 3, 0.5, False),
        (5, 3, 1.0, False),
        (1, 1, 0.5, True),
        (5, 3, 0.5, True),
    ]
    for patch, scales, wl, center in swd_specs:
        start = time.perf_counter()
        e = msswd_embeddings(
            bench,
            scales=scales,
            patch=patch,
            lightness_weight=wl,
            center=center,
            images=images,
        )
        m = msswd_matrix(bench, embeddings=e)
        key = f"msswd S={patch} K={scales} L={wl:g}{' 中央値引き' if center else ''}"
        run(key, m, time.perf_counter() - start)
        score = results[-1][1].handmade.exact_cases
        if best_swd is None or score > best_swd[0]:
            best_swd = (score, key, m)
    print()

    # --- 候補 D: 融合（6 通り）
    print("--- パレット EMD との融合")
    assert best_hist is not None and best_swd is not None
    top = max([best_hist, best_swd], key=lambda item: item[0])
    second = min([best_hist, best_swd], key=lambda item: item[0])
    upper = np.triu_indices(len(base), 1)
    for label, (_, key, m) in (("最良", top), ("次点", second)):
        rho = spearmanr(base[upper], m[upper]).statistic
        print(f"  {label} {key}: パレット EMD との spearman 相関 {rho:.3f}")
    for alpha in (0.1, 0.2, 0.3, 0.5, 0.7):
        start = time.perf_counter()
        m = fused_matrix(bench, top[2], alpha=alpha)
        run(f"融合 {top[1]} a={alpha:g}", m, time.perf_counter() - start)
    start = time.perf_counter()
    m = fused_matrix(bench, second[2], alpha=0.3)
    run(f"融合 {second[1]} a=0.3", m, time.perf_counter() - start)
    print()

    # --- 上位のものだけ再分割つきでも見る（まとめすぎの抑えが効くか）
    # 「まとめすぎ」を抑えたときにも強さが残るかを、粒を揃えた条件で比べる。
    # 純度と最大グループはグループの粒度に強く依存するので、基準の「+再分割」行と
    # 同じ最大グループのところで比べないと意味がない。
    print("--- 上位の再分割つき（基準の +再分割 行と同じ土俵で比べる）")
    keep[top[1]] = top[2]
    keep[f"融合 {top[1]} a=0.3"] = fused_matrix(bench, top[2], alpha=0.3)
    for label, matrix in keep.items():
        run(f"{label} +再分割", matrix, 0.0, split=True)


if __name__ == "__main__":
    main()
