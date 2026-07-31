"""画素の色分布そのものを見る距離（現時点で最良の手法）。

代表色 5 色に潰さず、写真の全画素を OKLab 空間の 3 次元ヒストグラムにして比べる。
`tests/case*.json` の正解での成績は `methods.RECOMMENDED`（パレットの EMD）より明確に良い。
詳しい比較は README を参照。

なぜ効くのか:

- **情報量** … 5 色に潰すと「同じ場所の似た写真」でもクラスタの切れ目が変わって
  代表色が入れ替わることがある。ヒストグラムは分布をそのまま持つので、その揺れが出ない。
- **Hellinger 距離** … ヒストグラムを L1 正規化して要素ごとに平方根を取り、ユークリッド距離を測る。
  比率の差をそのまま測る L2 より、小さな山（＝面積の小さい差し色）の違いが効くようになる。
  平方根を取るだけなので追加コストはゼロ。
- **彩度の重み** … 画素ごとに `(0.02 + 彩度)^gamma` の重みを掛けて投票する。
  `swatch_weights` の accent 重みと同じ考え方で、暗い画面の中の鮮やかな一点を拾う。

bin の切り方は L を 6 分割、a と b を 10 分割（合計 600 bin）。L 方向を粗くしてあるのは、
露出や時刻の違いで明るさだけがずれた写真を離さないため。
"""

from __future__ import annotations

import numpy as np
from scipy.spatial.distance import cdist

from dragonfly_lab.palette import ACCENT_CHROMA_FLOOR, MIN_ALPHA, srgb_to_oklab

#: 既定の bin 数 (L, a, b)。総当たりで最も成績が良かった組み合わせ。
DEFAULT_BINS = (6, 10, 10)

#: 彩度の重みの指数。0 で面積そのまま、1 で accent 重み相当。
DEFAULT_GAMMA = 1.0

# a と b の範囲。sRGB を OKLab にすると、おおむね ±0.25 に収まる。
_AB_RANGE = 0.25


def _oklab_pixels(rgba: np.ndarray) -> np.ndarray:
    """不透明な画素だけを OKLab にする (npix, 3)。条件はパレット抽出と同じ。"""
    flat = rgba.reshape(-1, 4)
    opaque = flat[flat[:, 3] >= MIN_ALPHA]
    if len(opaque) == 0:
        opaque = flat  # 全部透明。実データでは起きないが、空の配列を返さないようにする。
    return srgb_to_oklab(opaque[:, :3])


def _pixel_weights(lab: np.ndarray, gamma: float) -> np.ndarray:
    """画素ごとの投票の重み。彩度が高いほど強くする。"""
    if gamma == 0:
        return np.ones(len(lab), dtype=np.float64)
    chroma = np.hypot(lab[:, 1], lab[:, 2])
    return (ACCENT_CHROMA_FLOOR + chroma) ** gamma


def build_histogram(
    rgba: np.ndarray, bins: tuple[int, int, int] = DEFAULT_BINS, gamma: float = DEFAULT_GAMMA
) -> np.ndarray:
    """写真 1 枚を長さ bl*ba*bb のヒストグラムにする。合計は 1。

    各画素はいちばん近い 1 つの bin にだけ投票する（ハード割当）。ガウス核で近傍の bin にも
    配るソフト割当も試したが、この設定では成績が変わらず、計算だけ重くなった。
    """
    lab = _oklab_pixels(rgba)
    weight = _pixel_weights(lab, gamma)

    bl, ba, bb = bins
    index_l = np.clip((lab[:, 0] * bl).astype(np.int64), 0, bl - 1)
    index_a = np.clip(((lab[:, 1] + _AB_RANGE) / (2 * _AB_RANGE) * ba).astype(np.int64), 0, ba - 1)
    index_b = np.clip(((lab[:, 2] + _AB_RANGE) / (2 * _AB_RANGE) * bb).astype(np.int64), 0, bb - 1)
    flat_index = (index_l * ba + index_a) * bb + index_b

    histogram = np.bincount(flat_index, weights=weight, minlength=bl * ba * bb).astype(np.float64)
    total = histogram.sum()
    # 合計 1 に正規化する。写真の大きさや彩度の絶対値ではなく、色の配分だけを比べたいため。
    return histogram / total if total > 0 else np.full(len(histogram), 1.0 / len(histogram))


def build_histograms(
    images: list[tuple[str, np.ndarray]],
    bins: tuple[int, int, int] = DEFAULT_BINS,
    gamma: float = DEFAULT_GAMMA,
) -> np.ndarray:
    """写真ごとのヒストグラム (n, K)。"""
    return np.asarray([build_histogram(rgba, bins, gamma) for _, rgba in images], dtype=np.float64)


def histogram_distance_matrix(
    images: list[tuple[str, np.ndarray]],
    bins: tuple[int, int, int] = DEFAULT_BINS,
    gamma: float = DEFAULT_GAMMA,
    histograms: np.ndarray | None = None,
) -> np.ndarray:
    """全ペアの Hellinger 距離 (n, n)。対称で対角は 0、値は 0〜sqrt(2)。

    ヒストグラムを渡せば作り直さない（bin を変えずに何度も測るとき用）。
    """
    h = histograms if histograms is not None else build_histograms(images, bins, gamma)
    # Hellinger 距離 = 「要素ごとに平方根を取ってからのユークリッド距離」。
    root = np.sqrt(h)
    matrix = cdist(root, root, "euclidean")
    # 浮動小数の誤差で非対称・対角が微小な非 0 になることがある。ここで整えておく。
    matrix = (matrix + matrix.T) / 2.0
    np.fill_diagonal(matrix, 0.0)
    return np.maximum(matrix, 0.0)
