"""グループ分けの精度を上げるための候補手法。

現行 (`palette.py`) は次の組み合わせで固定されている。

    重み = 面積 or アクセント / 明度の重み = 1.0 / 対応付け = 貪欲 / まとめ方 = k-medoids

ここでは、その 3 か所をそれぞれ差し替えられるようにして比較する。

**距離の作り方**

- `matching="greedy"` … 現行。距離の小さい色から 1 対 1 に確定させる。速いが、
  全体で見ると損な組み合わせに落ちることがある。
- `matching="hungarian"` … 総和が最小になる 1 対 1 対応を厳密に選ぶ。
- `matching="emd"` … 色を「面積という質量」と見て運ぶ輸送問題として解く
  (earth mover's distance)。1 対 1 に縛られないので、片方の 1 色が
  もう片方の 2 色に分かれている写真同士を正しく近いと判定できる。
- `lightness_weight` … OKLab の L の差に掛ける重み。1.0 が現行。下げると
  「同じ色だが露出が違う」写真が近くなる。

**まとめ方**

- `kmedoids` … 現行。代表 1 枚からの距離で決めるので、代表がずれると群ごと崩れる。
- `average` / `complete` / `ward` … 階層的クラスタリング。近いものから順に併合していく。
- `spectral` … 距離を類似度に変えてグラフとして切る。細長い塊に強い。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import numpy as np
import ot
from scipy.cluster.hierarchy import fcluster, linkage
from scipy.optimize import linear_sum_assignment
from scipy.spatial.distance import squareform
from sklearn.cluster import SpectralClustering

from dragonfly_lab.palette import (
    Palette,
    _to_groups,
    greedy_distance,
    kmedoids_labels,
    swatch_weights,
)

Weighting = Literal["area", "accent"]
Matching = Literal["greedy", "hungarian", "emd"]
Method = Literal["kmedoids", "average", "complete", "ward", "spectral"]


@dataclass(frozen=True)
class GroupingConfig:
    """試す手法 1 つぶん。既定値は現行の実装と同じ。

    総当たりで比べた結果、`RECOMMENDED` の組み合わせが最も良かった（根拠は下の定数を参照）。
    """

    weighting: Weighting = "area"
    lightness_weight: float = 1.0
    matching: Matching = "greedy"
    method: Method = "kmedoids"

    @property
    def distance_key(self) -> str:
        """距離行列を使い回すためのキー。まとめ方だけ違う設定では再計算しない。"""
        return f"{self.weighting}|{self.lightness_weight:g}|{self.matching}"

    @property
    def key(self) -> str:
        return f"{self.method}/{self.matching}/{self.weighting}/L={self.lightness_weight:g}"


#: 現行の実装と同じ設定。比較の基準。
CURRENT = GroupingConfig(weighting="area", lightness_weight=1.0, matching="greedy", method="kmedoids")

#: 総当たりで最も成績が良かった設定。
#:
#: 200 枚・1 グループ 10 枚（k=20）で測ったところ、現行 (CURRENT) と比べて
#:
#:   手書きの正解が全部そろった数  1/3 → 3/3
#:   自動生成した正解の再現率      38% → 83%（再分割を入れると 71%）
#:   同じ組のワールド一致率(純度)  6.9% → 6.8%（再分割を入れると 14.0%、無作為は 1.6%）
#:
#: 効いているのは主に 2 つ。
#:
#: - **EMD** … 1 対 1 の対応付けをやめ、色を面積ぶん運ぶ輸送問題として測る。
#:   「片方の 1 色が、もう片方では 2 色に分かれている」写真同士を近いと判定できる。
#: - **明度の重み 0.5** … OKLab の L の差を半分にする。同じ場所で露出や時刻が違うだけの
#:   写真が離れてしまう問題が減る。
#:
#: まとめ方は average（階層的クラスタリング）。k-medoids は代表 1 枚に引きずられる。
RECOMMENDED = GroupingConfig(
    weighting="accent", lightness_weight=0.5, matching="emd", method="average"
)


def _swatch_cost(left: Palette, right: Palette, lightness_weight: float) -> np.ndarray:
    """色 1 組ごとの距離 (k, k)。lightness_weight で L の効き方を変える。"""
    diff = left.lab[:, None, :] - right.lab[None, :, :]
    scale = np.array([lightness_weight, 1.0, 1.0])
    return np.sqrt(np.sum(diff * diff * scale, axis=2))


def _hungarian_distance(cost: np.ndarray, weight: np.ndarray) -> float:
    """総和が最小になる 1 対 1 対応での加重平均。"""
    rows, cols = linear_sum_assignment(cost * weight)
    weights = weight[rows, cols]
    total = weights.sum()
    if total <= 0:
        return float(cost[rows, cols].mean()) if len(rows) else 0.0
    return float((cost[rows, cols] * weights).sum() / total)


def _emd_distance(cost: np.ndarray, left_mass: np.ndarray, right_mass: np.ndarray) -> float:
    """輸送問題として解いた距離 (earth mover's distance)。"""
    left_sum, right_sum = left_mass.sum(), right_mass.sum()
    if left_sum <= 0 or right_sum <= 0:
        return float(cost.mean())
    # 質量は合計 1 に正規化する。写真ごとの重みの絶対値ではなく配分だけを見たいため。
    return float(ot.emd2(left_mass / left_sum, right_mass / right_sum, np.ascontiguousarray(cost)))


def build_distance_matrix(palettes: list[Palette], config: GroupingConfig) -> np.ndarray:
    """設定に応じた全ペアの距離行列 (n, n)。対称で対角は 0。"""
    n = len(palettes)
    weights = [swatch_weights(p, config.weighting) for p in palettes]
    matrix = np.zeros((n, n), dtype=np.float64)

    for i in range(n):
        for j in range(i + 1, n):
            cost = _swatch_cost(palettes[i], palettes[j], config.lightness_weight)
            if config.matching == "emd":
                d = _emd_distance(cost, weights[i], weights[j])
            else:
                pair_weight = np.minimum(weights[i][:, None], weights[j][None, :])
                d = (
                    greedy_distance(cost, pair_weight)
                    if config.matching == "greedy"
                    else _hungarian_distance(cost, pair_weight)
                )
            matrix[i, j] = matrix[j, i] = d
    return matrix


def cluster_labels(matrix: np.ndarray, count: int, method: Method) -> np.ndarray:
    """距離行列を count 個のグループに分けたラベル。"""
    n = len(matrix)
    k = max(1, min(int(count), n))
    if method == "kmedoids":
        return kmedoids_labels(matrix, k)
    if method == "spectral":
        # 距離を類似度に変える。σ は距離の中央値にして、データの尺度に合わせる。
        upper = matrix[np.triu_indices(n, k=1)]
        sigma = float(np.median(upper)) or 1.0
        affinity = np.exp(-((matrix / sigma) ** 2))
        model = SpectralClustering(
            n_clusters=k, affinity="precomputed", random_state=0, assign_labels="kmeans"
        )
        return model.fit_predict(affinity)

    # 階層的クラスタリング。ward は 2 乗距離を前提にしているのでそのまま渡す。
    condensed = squareform(matrix, checks=False)
    tree = linkage(condensed, method=method)
    return fcluster(tree, t=k, criterion="maxclust") - 1


def group_photos(
    palettes: list[Palette], count: int, config: GroupingConfig, matrix: np.ndarray | None = None
) -> list[list[str]]:
    """設定どおりに距離を測ってグループ分けする。距離行列を渡せば再計算しない。"""
    if matrix is None:
        matrix = build_distance_matrix(palettes, config)
    return _to_groups(palettes, cluster_labels(matrix, count, config.method))


def split_oversized_labels(
    matrix: np.ndarray, labels: np.ndarray, target_size: int, method: Method, max_ratio: float = 2.0
) -> np.ndarray:
    """大きすぎるグループを、同じ手法で中だけ分け直す。

    階層的クラスタリングは「似た写真がまとまる」代わりに、ありふれた色の写真が
    1 つの大きな塊になりやすい。「10 枚ごと」のように粒の揃った分け方が欲しいときは、
    目標の max_ratio 倍を超えた組だけを再帰的に割る。

    分けるのは大きい組の中だけなので、正しくまとまっている小さい組は壊れない。
    """
    limit = max(2, int(round(target_size * max_ratio)))
    labels = labels.copy()
    next_label = int(labels.max()) + 1 if labels.size else 0

    # 1 回で終わらない（割った先がまだ大きい）ことがあるので、収まるまで繰り返す。
    while True:
        oversized = [
            label for label in np.unique(labels) if int((labels == label).sum()) > limit
        ]
        if not oversized:
            return labels
        progressed = False
        for label in oversized:
            members = np.flatnonzero(labels == label)
            sub_count = max(2, int(round(len(members) / target_size)))
            sub_labels = cluster_labels(
                matrix[np.ix_(members, members)], sub_count, method
            )
            if len(np.unique(sub_labels)) < 2:
                continue  # これ以上割れない（全部同じ距離など）
            for sub in np.unique(sub_labels)[1:]:
                labels[members[sub_labels == sub]] = next_label
                next_label += 1
            progressed = True
        if not progressed:
            return labels


def group_by_target_size(
    palettes: list[Palette],
    matrix: np.ndarray,
    target_size: int,
    config: GroupingConfig,
    max_ratio: float = 2.0,
) -> list[list[str]]:
    """1 グループがおよそ target_size 枚になるように分ける（「10 枚ごと」用）。"""
    count = max(1, round(len(palettes) / max(1, target_size)))
    labels = cluster_labels(matrix, count, config.method)
    labels = split_oversized_labels(matrix, labels, target_size, config.method, max_ratio)
    return _to_groups(palettes, labels)


def run_configs(
    palettes: list[Palette], count: int, configs: list[GroupingConfig]
) -> dict[str, list[list[str]]]:
    """複数の設定をまとめて試す。距離行列は距離の設定ごとに 1 回だけ作る。"""
    matrices: dict[str, np.ndarray] = {}
    results: dict[str, list[list[str]]] = {}
    for config in configs:
        matrix = matrices.get(config.distance_key)
        if matrix is None:
            matrix = build_distance_matrix(palettes, config)
            matrices[config.distance_key] = matrix
        results[config.key] = group_photos(palettes, count, config, matrix)
    return results
