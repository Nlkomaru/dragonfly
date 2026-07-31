"""現行アルゴリズム (packages/core/src/palette.ts) の Python 移植。

改良版と比べるための「現状」がここ。移植なので、TypeScript と同じ結果が出ることを
`tests/test_parity.py` で確かめてある（代表色の hex と距離が一致する）。

移植で気をつけたところ:

- k-means++ の初期中心は `mulberry32` + FNV-1a という決定的な乱数列に依存する。
  写真 ID を種にしているので、同じ写真からは必ず同じパレットが出る。ここを崩すと
  結果が揺れて比較にならないため、32bit 演算をそのまま再現している。
- 同点のときは必ず若い添字を選ぶ（`np.argmin` の挙動と同じ）。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

# --- 本番と同じ定数 -------------------------------------------------------
PALETTE_VERSION = 3
PALETTE_SIZE = 5
MIN_ALPHA = 128
MAX_ITERATIONS = 20
BLACK_L_MAX = 0.3
ACCENT_CHROMA_FLOOR = 0.02


@dataclass(frozen=True)
class Swatch:
    """代表色 1 色分。TS の PaletteSwatch と同じ形。"""

    hex: str
    ratio: float
    l: float  # noqa: E741 — OKLab の L。TS 側のフィールド名に合わせる。
    a: float
    b: float

    @property
    def chroma(self) -> float:
        return float(np.hypot(self.a, self.b))


@dataclass(frozen=True)
class Palette:
    """写真 1 枚分のパレット。"""

    photo_id: str
    version: int
    swatches: list[Swatch]

    @property
    def lab(self) -> np.ndarray:
        """(k, 3) の OKLab 配列。距離計算で使う。"""
        return np.array([[s.l, s.a, s.b] for s in self.swatches], dtype=np.float64)

    @property
    def ratios(self) -> np.ndarray:
        return np.array([s.ratio for s in self.swatches], dtype=np.float64)


# ---------------------------------------------------------------------------
# 色空間
# ---------------------------------------------------------------------------


def srgb_to_oklab(rgb: np.ndarray) -> np.ndarray:
    """(N, 3) の sRGB (0-255) を (N, 3) の OKLab にする。"""
    c = rgb.astype(np.float64) / 255.0
    linear = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    r, g, b = linear[:, 0], linear[:, 1], linear[:, 2]

    l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b  # noqa: E741
    m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
    s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b

    l_, m_, s_ = np.cbrt(l), np.cbrt(m), np.cbrt(s)
    return np.stack(
        [
            0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
            1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
            0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
        ],
        axis=1,
    )


def oklab_to_hex(lab: np.ndarray) -> str:
    """OKLab 1 点を `#rrggbb` にする。色域外はクランプする。"""
    l, a, b = float(lab[0]), float(lab[1]), float(lab[2])  # noqa: E741
    l_ = l + 0.3963377774 * a + 0.2158037573 * b
    m_ = l - 0.1055613458 * a - 0.0638541728 * b
    s_ = l - 0.0894841775 * a - 1.2914855480 * b
    lc, mc, sc = l_**3, m_**3, s_**3

    linear = np.array(
        [
            4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc,
            -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc,
            -0.0041960863 * lc - 0.7034186147 * mc + 1.7076147010 * sc,
        ]
    )
    srgb = np.where(linear <= 0.0031308, linear * 12.92, 1.055 * np.abs(linear) ** (1 / 2.4) - 0.055)
    values = np.clip(np.round(srgb * 255), 0, 255).astype(int)
    return "#" + "".join(f"{v:02x}" for v in values)


# ---------------------------------------------------------------------------
# 決定的な乱数（TS と同じ列を出す）
# ---------------------------------------------------------------------------


def _hash_seed(seed: str) -> int:
    """FNV-1a。TS の hashSeed と同じ値を返す。"""
    h = 0x811C9DC5
    for char in seed:
        h ^= ord(char)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h or 0x9E3779B9


class _Mulberry32:
    """TS の mulberry32 と同じ乱数列。32bit 演算をそのまま再現する。"""

    def __init__(self, seed: int) -> None:
        self.t = seed & 0xFFFFFFFF

    def __call__(self) -> float:
        self.t = (self.t + 0x6D2B79F5) & 0xFFFFFFFF
        x = self.t
        x = (x ^ (x >> 15)) * (x | 1) & 0xFFFFFFFF
        x ^= (x + ((x ^ (x >> 7)) * (x | 61) & 0xFFFFFFFF)) & 0xFFFFFFFF
        x &= 0xFFFFFFFF
        return ((x ^ (x >> 14)) & 0xFFFFFFFF) / 4294967296


# ---------------------------------------------------------------------------
# 代表色の抽出 (k-means)
# ---------------------------------------------------------------------------


def _squared_distances(samples: np.ndarray, centers: np.ndarray) -> np.ndarray:
    """(N, k) の距離の 2 乗。差分の 3 次元配列を作らずに済ませるため展開して計算する。"""
    return (
        np.einsum("ij,ij->i", samples, samples)[:, None]
        - 2.0 * samples @ centers.T
        + np.einsum("ij,ij->i", centers, centers)[None, :]
    )


def _pick_initial_centers(samples: np.ndarray, k: int, rand: _Mulberry32) -> np.ndarray:
    """k-means++。TS と同じ順で乱数を消費する。"""
    first = min(len(samples) - 1, int(rand() * len(samples)))
    centers = [samples[first].copy()]

    while len(centers) < k:
        nearest = np.maximum(_squared_distances(samples, np.array(centers)).min(axis=1), 0.0)
        total = float(nearest.sum())
        if total <= 0:
            # 全点が既存の中心と一致（単色画像など）。決定的に複製して埋める。
            centers.append(centers[0].copy())
            continue
        target = rand() * total
        acc = np.cumsum(nearest)
        picked = int(np.searchsorted(acc, target))
        picked = min(picked, len(samples) - 1)
        centers.append(samples[picked].copy())
    return np.array(centers)


def _pick_dropped_cluster(centers: np.ndarray, counts: np.ndarray, total: int) -> int:
    """捨てるクラスタ。暗いものを優先し、それで全部消えるなら最小のものにする。"""
    dark = np.flatnonzero(centers[:, 0] < BLACK_L_MAX)
    if dark.size:
        darkest = int(dark[np.argmin(centers[dark, 0])])
        if total - counts[darkest] > 0:
            return darkest
    return int(np.argmin(counts))


def extract_palette(rgba: np.ndarray, seed: str, palette_size: int = PALETTE_SIZE) -> list[Swatch]:
    """RGBA 画像 1 枚から代表色を取り出す。k+1 クラスタ作って暗い 1 つを捨てる。"""
    flat = rgba.reshape(-1, 4)
    samples_rgb = flat[flat[:, 3] >= MIN_ALPHA][:, :3]
    if len(samples_rgb) == 0:
        return [Swatch("#000000", 0.0, 0.0, 0.0, 0.0) for _ in range(palette_size)]

    samples = srgb_to_oklab(samples_rgb)
    cluster_count = palette_size + 1
    rand = _Mulberry32(_hash_seed(seed))
    centers = _pick_initial_centers(samples, cluster_count, rand)

    assignments = np.full(len(samples), -1)
    for _ in range(MAX_ITERATIONS):
        new_assignments = np.argmin(_squared_distances(samples, centers), axis=1)
        if np.array_equal(new_assignments, assignments):
            break
        assignments = new_assignments

        counts = np.bincount(assignments, minlength=cluster_count)
        # 各クラスタの重心。合計を bincount で一度に出す。
        sums = np.stack(
            [np.bincount(assignments, weights=samples[:, axis], minlength=cluster_count)
             for axis in range(3)],
            axis=1,
        )
        filled = counts > 0
        centers[filled] = sums[filled] / counts[filled][:, None]

        # 空のクラスタは、いま最も浮いている点で埋め直す。
        for c in np.flatnonzero(~filled):
            residual = np.sum((samples - centers[assignments]) ** 2, axis=1)
            farthest = int(np.argmax(residual))
            if residual[farthest] <= 0:
                continue
            centers[c] = samples[farthest].copy()

    final = np.argmin(_squared_distances(samples, centers), axis=1)
    counts = np.bincount(final, minlength=cluster_count)

    dropped = _pick_dropped_cluster(centers, counts, len(samples))
    keep = [c for c in range(cluster_count) if c != dropped]
    remaining = int(counts[keep].sum())

    swatches = [
        Swatch(
            hex=oklab_to_hex(centers[c]),
            ratio=float(counts[c] / remaining) if remaining > 0 else 0.0,
            l=float(centers[c][0]),
            a=float(centers[c][1]),
            b=float(centers[c][2]),
        )
        for c in keep
    ]
    # ratio 降順、同率なら OKLab の値で並べて決定的にする。
    swatches.sort(key=lambda s: (-s.ratio, s.l, s.a, s.b))
    return swatches


def extract_palettes(
    images: list[tuple[str, np.ndarray]], palette_size: int = PALETTE_SIZE
) -> list[Palette]:
    """複数枚ぶんの代表色。photo_id が k-means の種になる（本番と同じ）。"""
    return [
        Palette(photo_id, PALETTE_VERSION, extract_palette(rgba, photo_id, palette_size))
        for photo_id, rgba in images
    ]


# ---------------------------------------------------------------------------
# パレット同士の距離（現行方式）
# ---------------------------------------------------------------------------


def swatch_weights(palette: Palette, weighting: str = "area") -> np.ndarray:
    """swatch ごとの重み。area は面積、accent は sqrt(面積)×彩度。"""
    if weighting == "area":
        return palette.ratios
    lab = palette.lab
    chroma = np.hypot(lab[:, 1], lab[:, 2])
    return np.sqrt(palette.ratios) * (ACCENT_CHROMA_FLOOR + chroma)


def _palette_key(palette: Palette) -> str:
    """左右どちらを先に置くかを決めるための、並び順に依存しないキー（TS と同じ）。"""
    return "|".join(
        f"{s.l:.6f},{s.a:.6f},{s.b:.6f},{s.ratio:.6f}" for s in palette.swatches
    )


def greedy_distance(cost: np.ndarray, weight: np.ndarray) -> float:
    """距離の小さいペアから 1 対 1 に確定させ、min(重み) で加重平均する（現行方式）。"""
    order = np.argsort(cost, axis=None, kind="stable")
    used_rows: set[int] = set()
    used_cols: set[int] = set()
    weighted = weight_sum = plain = 0.0
    matched = 0
    for flat_index in order:
        i, j = divmod(int(flat_index), cost.shape[1])
        if i in used_rows or j in used_cols:
            continue
        used_rows.add(i)
        used_cols.add(j)
        weighted += cost[i, j] * weight[i, j]
        weight_sum += weight[i, j]
        plain += cost[i, j]
        matched += 1
    if weight_sum <= 0:
        return plain / matched if matched else 0.0
    return weighted / weight_sum


def palette_distance(a: Palette, b: Palette, weighting: str = "area") -> float:
    """現行の paletteDistance。引数の順序で結果が変わらないよう先に正規化する。"""
    if not a.swatches or not b.swatches:
        return 0.0
    left, right = (a, b) if _palette_key(a) <= _palette_key(b) else (b, a)
    cost = np.linalg.norm(left.lab[:, None, :] - right.lab[None, :, :], axis=2)
    weight = np.minimum(
        swatch_weights(left, weighting)[:, None], swatch_weights(right, weighting)[None, :]
    )
    return greedy_distance(cost, weight)


def distance_matrix(palettes: list[Palette], weighting: str = "area") -> np.ndarray:
    """現行方式の距離行列 (n, n)。"""
    n = len(palettes)
    matrix = np.zeros((n, n), dtype=np.float64)
    for i in range(n):
        for j in range(i + 1, n):
            d = palette_distance(palettes[i], palettes[j], weighting)
            matrix[i, j] = matrix[j, i] = d
    return matrix


# ---------------------------------------------------------------------------
# グループ化（現行方式）
# ---------------------------------------------------------------------------


def _to_groups(palettes: list[Palette], labels: np.ndarray) -> list[list[str]]:
    """ラベルの並びを photo_id の配列の配列にする。大きい順、同数なら先頭 ID の辞書順。"""
    buckets: dict[int, list[str]] = {}
    for palette, label in zip(palettes, labels, strict=True):
        buckets.setdefault(int(label), []).append(palette.photo_id)
    groups = [sorted(group) for group in buckets.values()]
    groups.sort(key=lambda group: (-len(group), group[0]))
    return groups


def group_by_threshold(
    palettes: list[Palette], matrix: np.ndarray, threshold: float
) -> list[list[str]]:
    """しきい値以下のペアを繋いだ連結成分 (union-find)。"""
    n = len(palettes)
    parent = list(range(n))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for i in range(n):
        for j in range(i + 1, n):
            if matrix[i, j] > threshold:
                continue
            ri, rj = find(i), find(j)
            if ri != rj:
                parent[max(ri, rj)] = min(ri, rj)

    return _to_groups(palettes, np.array([find(i) for i in range(n)]))


def kmedoids_labels(matrix: np.ndarray, count: int) -> np.ndarray:
    """現行の groupByCount と同じ k-medoids。乱数は使わない。"""
    n = len(matrix)
    if n == 0:
        return np.zeros(0, dtype=int)
    k = max(1, min(int(count), n))

    # 1 つ目は最も中心的な写真、以降は最寄りの medoid から最も遠い写真 (farthest-first)。
    medoids = [int(np.argmin(matrix.sum(axis=1)))]
    nearest = matrix[medoids[0]].copy()
    while len(medoids) < k:
        farthest = int(np.argmax(nearest))
        if nearest[farthest] <= 0:
            break
        medoids.append(farthest)
        nearest = np.minimum(nearest, matrix[farthest])

    labels = np.zeros(n, dtype=int)
    for _ in range(MAX_ITERATIONS):
        labels = np.argmin(matrix[:, medoids], axis=1)
        moved = False
        for m in range(len(medoids)):
            members = np.flatnonzero(labels == m)
            if members.size == 0:
                continue
            best = int(members[np.argmin(matrix[np.ix_(members, members)].sum(axis=1))])
            if best != medoids[m]:
                medoids[m] = best
                moved = True
        if not moved:
            break
    return labels


def group_by_count(palettes: list[Palette], matrix: np.ndarray, count: int) -> list[list[str]]:
    """ちょうど count 個に分ける（現行の k-medoids）。"""
    return _to_groups(palettes, kmedoids_labels(matrix, count))


def nearest_photos(
    palettes: list[Palette], matrix: np.ndarray, photo_id: str, limit: int = 5
) -> list[tuple[str, float]]:
    """色味が近い順。自分自身は含まない。同距離なら photo_id 順。"""
    ids = [p.photo_id for p in palettes]
    if photo_id not in ids or limit <= 0:
        return []
    index = ids.index(photo_id)
    candidates = [
        (other, float(matrix[index, i])) for i, other in enumerate(ids) if i != index
    ]
    candidates.sort(key=lambda pair: (pair[1], pair[0]))
    return candidates[:limit]
