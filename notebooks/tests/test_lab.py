"""ラボの実装が壊れていないことの最低限の確認。

写真もネットワークも要らないよう、合成画像だけで完結させてある。
`uv run pytest` で実行する。
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from dragonfly_lab import (
    CURRENT,
    RECOMMENDED,
    GroupingConfig,
    build_distance_matrix,
    extract_palettes,
    filter_cases,
    group_by_target_size,
    group_photos,
    score_groups,
    synthetic_images,
)
from dragonfly_lab.cases import load_cases


@pytest.fixture(scope="module")
def palettes():
    return extract_palettes(synthetic_images(max_edge=96))


def test_palette_shape_is_deterministic(palettes):
    """Palettes have k swatches, ratios sum to 1, and repeat identically."""
    assert all(len(p.swatches) == 5 for p in palettes)
    assert all(
        abs(sum(s.ratio for s in p.swatches) - 1.0) < 1e-9
        or all(s.ratio == 0 for s in p.swatches)
        for p in palettes
    )
    again = extract_palettes(synthetic_images(max_edge=96))
    assert [[s.hex for s in p.swatches] for p in palettes] == [
        [s.hex for s in p.swatches] for p in again
    ]


@pytest.mark.parametrize("matching", ["greedy", "hungarian", "emd"])
def test_distance_matrix_is_a_valid_metric_shape(palettes, matching):
    """Every matching produces a symmetric, non-negative matrix with a zero diagonal."""
    matrix = build_distance_matrix(palettes, GroupingConfig(matching=matching))
    assert np.allclose(matrix, matrix.T)
    assert np.allclose(np.diag(matrix), 0.0)
    assert np.all(matrix >= 0) and np.all(np.isfinite(matrix))


def test_accent_separates_dark_photos_with_different_highlights(palettes):
    """Accent weighting pulls apart near-black photos that differ only in a small vivid patch."""
    ids = [p.photo_id for p in palettes]
    red, cyan = ids.index("night-red-accent"), ids.index("night-cyan-accent")
    area = build_distance_matrix(palettes, GroupingConfig(weighting="area"))
    accent = build_distance_matrix(palettes, GroupingConfig(weighting="accent"))
    assert accent[red, cyan] > area[red, cyan] * 2


def test_lower_lightness_weight_brings_same_hue_closer(palettes):
    """Down-weighting L makes two photos that differ mainly in brightness closer."""
    ids = [p.photo_id for p in palettes]
    dark, white = ids.index("all-dark"), ids.index("mono-gradient")
    full = build_distance_matrix(palettes, GroupingConfig(lightness_weight=1.0))
    half = build_distance_matrix(palettes, GroupingConfig(lightness_weight=0.25))
    assert half[dark, white] < full[dark, white]


def test_grouping_covers_every_photo_exactly_once(palettes):
    """Each photo lands in exactly one group, for both the current and recommended methods."""
    for config in (CURRENT, RECOMMENDED):
        matrix = build_distance_matrix(palettes, config)
        groups = group_photos(palettes, 3, config, matrix)
        flat = [pid for group in groups for pid in group]
        assert sorted(flat) == sorted(p.photo_id for p in palettes)
        assert len(flat) == len(set(flat))


def test_target_size_split_caps_group_size(palettes):
    """Splitting oversized groups keeps every group within twice the target size."""
    matrix = build_distance_matrix(palettes, RECOMMENDED)
    groups = group_by_target_size(palettes, matrix, target_size=2, config=RECOMMENDED)
    assert max(len(g) for g in groups) <= 4
    assert sum(len(g) for g in groups) == len(palettes)


def test_histogram_distance_matrix_is_well_formed():
    """The colour-histogram distance is symmetric, zero on the diagonal and bounded."""
    from dragonfly_lab import build_histograms, histogram_distance_matrix

    images = synthetic_images(max_edge=96)
    matrix = histogram_distance_matrix(images)
    assert np.allclose(matrix, matrix.T)
    assert np.allclose(np.diag(matrix), 0.0)
    # Hellinger 距離は 0〜sqrt(2) の範囲に収まる。
    assert np.all(matrix >= 0) and np.all(matrix <= np.sqrt(2) + 1e-9)
    # 合計 1 のヒストグラムになっている。
    histograms = build_histograms(images)
    assert np.allclose(histograms.sum(axis=1), 1.0)


def test_histogram_separates_photos_that_palettes_confuse():
    """The histogram keeps near-identical scenes closer than clearly different ones."""
    from dragonfly_lab import histogram_distance_matrix

    images = synthetic_images(max_edge=96)
    ids = [photo_id for photo_id, _ in images]
    matrix = histogram_distance_matrix(images)
    sunset, shifted = ids.index("sunset"), ids.index("sunset-shifted")
    forest = ids.index("forest")
    assert matrix[sunset, shifted] < matrix[sunset, forest]


def test_case_scoring_counts_pairs_and_exact_matches():
    """Scoring reports exact cases only when every photo of a case shares one group."""
    groups = [["a", "b", "c"], ["d", "e"]]
    score = score_groups([["a", "b"], ["a", "d"]], groups)
    assert score.exact_cases == 1
    assert (score.matched_pairs, score.total_pairs) == (1, 2)


def test_case_file_is_readable_even_with_trailing_commas(tmp_path):
    """Hand-edited case files with trailing commas still load."""
    path = tmp_path / "case.json"
    path.write_text('[\n  ["a", "b",],\n]', encoding="utf-8")
    assert load_cases(path) == [["a", "b"]]
    assert filter_cases(load_cases(path), {"a"}) == []  # 1 枚しか残らないケースは落ちる


def test_palettes_match_the_golden_fixture(palettes):
    """Palettes still match the values recorded when palette.py was ported from palette.ts.

    移植した時点で TypeScript 実装と完全一致していた出力を固定してある。ここが崩れると
    「現行アルゴリズム」を名乗れなくなり、比較の基準として使えなくなる。
    """
    golden_path = Path(__file__).with_name("golden_palettes.json")
    golden = json.loads(golden_path.read_text(encoding="utf-8"))

    actual = {
        p.photo_id: [
            [s.hex, round(s.ratio, 9), round(s.l, 9), round(s.a, 9), round(s.b, 9)]
            for s in p.swatches
        ]
        for p in palettes
    }
    assert actual == golden


def test_case_file_in_repository_is_valid():
    """tests/case.json parses and contains only string ids."""
    cases = load_cases()
    assert isinstance(cases, list)
    for case in cases:
        assert all(isinstance(pid, str) for pid in case), json.dumps(case)
