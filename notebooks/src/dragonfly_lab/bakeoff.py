"""候補手法を同じ土俵で採点するためのハーネス。

新しい距離やまとめ方を試すときは、距離行列（またはラベル）を作ってここに渡す。
評価の条件（写真・正解・グループの目標枚数）を固定するので、結果をそのまま並べて比べられる。

    from dragonfly_lab.bakeoff import load_bench, score_matrix

    bench = load_bench()                       # 写真・パレット・正解を読む
    matrix = my_distance(bench.palettes)       # (n, n) の距離行列
    print(score_matrix(bench, matrix, "average"))
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

from dragonfly_lab.cases import available_case_files, filter_cases, load_case_files
from dragonfly_lab.evaluation import Evaluation, build_auto_pairs, evaluate
from dragonfly_lab.methods import Method, cluster_labels, split_oversized_labels
from dragonfly_lab.palette import Palette, _to_groups, extract_palettes
from dragonfly_lab.remote import load_cache, load_cache_metadata

# 評価の条件。ノートブックの既定値と揃えてある。
PALETTE_SIZE = 5
MAX_EDGE = 192
TARGET_SIZE = 7


@dataclass(frozen=True)
class Bench:
    """採点に必要なものひと揃い。"""

    images: list[tuple[str, np.ndarray]]
    palettes: list[Palette]
    metadata: dict[str, dict]
    cases: list[list[str]]
    auto_pairs: list[tuple[str, str]]
    target_size: int

    @property
    def photo_ids(self) -> list[str]:
        return [p.photo_id for p in self.palettes]

    @property
    def count(self) -> int:
        """目標枚数から決まるグループ数。"""
        return max(1, round(len(self.palettes) / self.target_size))


def load_bench(
    max_edge: int = MAX_EDGE,
    palette_size: int = PALETTE_SIZE,
    target_size: int = TARGET_SIZE,
    case_paths: list[Path] | None = None,
) -> Bench:
    """キャッシュの写真・パレット・正解を読み込む。"""
    images = load_cache(max_edge=max_edge)
    if not images:
        raise RuntimeError("notebooks/remote/ にキャッシュがありません")
    palettes = extract_palettes(images, palette_size=palette_size)
    metadata = load_cache_metadata()
    photo_ids = [photo_id for photo_id, _ in images]
    cases = filter_cases(load_case_files(case_paths or available_case_files()), set(photo_ids))
    return Bench(
        images=images,
        palettes=palettes,
        metadata=metadata,
        cases=cases,
        auto_pairs=build_auto_pairs(photo_ids, metadata),
        target_size=target_size,
    )


def score_labels(bench: Bench, labels: np.ndarray, key: str = "candidate") -> Evaluation:
    """ラベル（各写真の所属グループ番号）を採点する。"""
    return evaluate(
        key, _to_groups(bench.palettes, labels), bench.cases, bench.auto_pairs, bench.metadata
    )


def score_matrix(
    bench: Bench,
    matrix: np.ndarray,
    method: Method = "average",
    key: str = "candidate",
    split: bool = False,
) -> Evaluation:
    """距離行列を目標枚数どおりに分けて採点する。

    split=True にすると、目標の 2 倍を超えた組だけ中で割り直す。
    """
    labels = cluster_labels(matrix, bench.count, method)
    if split:
        labels = split_oversized_labels(matrix, labels, bench.target_size, method)
    return score_labels(bench, labels, key)


def format_row(evaluation: Evaluation) -> str:
    """1 行のテキストにする。表にして並べるとき用。"""
    handmade = evaluation.handmade
    return (
        f"{evaluation.key:<44} "
        f"完全一致 {handmade.exact_cases:>2}/{handmade.total_cases:<3} "
        f"ペア {handmade.pair_ratio:>5.0%} "
        f"自動 {evaluation.auto_recall:>5.0%} "
        f"純度 {evaluation.purity:>5.1%} "
        f"組数 {len(evaluation.group_sizes):>3} 最大 {evaluation.largest:>3}"
    )
