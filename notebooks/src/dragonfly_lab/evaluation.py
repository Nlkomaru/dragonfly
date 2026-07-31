"""グループ分けの良し悪しを数字にする。

指標は 3 つ。手書きの正解だけだと数が少なく、手法をそれに合わせ込んでしまう
（過学習）ので、メタデータから自動で作る大きめの正解と、
「まとめすぎ」を見張る指標を合わせて見る。

- **手書き** (`tests/case.json`) … 同じ組に入ってほしい写真。少数だが本命。
- **自動** … 同じワールドで短い間に撮った写真同士。ほぼ同じシーンのはずなので、
  同じ組に入るのが自然。数が多いので過学習しにくい。
- **純度** … 同じ組に入ったペアのうち、ワールドまで一致している割合。
  全部を 1 つの組にすれば手書きも自動も満点になってしまうため、その抑えとして見る。
"""

from __future__ import annotations

import itertools
from dataclasses import dataclass

from dragonfly_lab.cases import CaseScore, score_groups

# 「同じシーン」と見なす撮影間隔。VRChat で連写する間隔として現実的な幅。
SAME_SCENE_WINDOW_MS = 5 * 60 * 1000


@dataclass(frozen=True)
class Evaluation:
    """1 つの手法の成績。"""

    key: str
    handmade: CaseScore
    auto_recall: float
    auto_pairs: int
    purity: float
    group_sizes: list[int]

    @property
    def largest(self) -> int:
        return self.group_sizes[0] if self.group_sizes else 0

    def as_row(self) -> dict[str, object]:
        """表に並べる用。"""
        return {
            "手法": self.key,
            "手書き完全一致": f"{self.handmade.exact_cases}/{self.handmade.total_cases}",
            "手書きペア": self.handmade.pair_ratio,
            "自動ペア再現": self.auto_recall,
            "純度": self.purity,
            "最大グループ": self.largest,
            "グループ数": len(self.group_sizes),
        }


def build_auto_pairs(
    photo_ids: list[str], metadata: dict[str, dict], window_ms: int = SAME_SCENE_WINDOW_MS
) -> list[tuple[str, str]]:
    """同じワールドで window_ms 以内に撮られた写真のペアを集める。"""
    by_world: dict[str, list[tuple[int, str]]] = {}
    for photo_id in photo_ids:
        entry = metadata.get(photo_id, {})
        world = entry.get("world")
        if not world:
            continue
        by_world.setdefault(world, []).append((entry.get("takenAt") or 0, photo_id))

    pairs: list[tuple[str, str]] = []
    for items in by_world.values():
        items.sort()
        for (t1, a), (t2, b) in itertools.combinations(items, 2):
            if abs(t1 - t2) <= window_ms:
                pairs.append((a, b))
    return pairs


def evaluate(
    key: str,
    groups: list[list[str]],
    cases: list[list[str]],
    auto_pairs: list[tuple[str, str]],
    metadata: dict[str, dict],
) -> Evaluation:
    """1 つのグループ分けを 3 つの指標で採点する。"""
    where = {pid: index for index, group in enumerate(groups) for pid in group}

    hits = sum(1 for a, b in auto_pairs if where.get(a, -1) == where.get(b, -2))
    auto_recall = hits / len(auto_pairs) if auto_pairs else 0.0

    same_world = 0
    total_in_group = 0
    for group in groups:
        for a, b in itertools.combinations(group, 2):
            total_in_group += 1
            if (metadata.get(a, {}).get("world") or "?") == (metadata.get(b, {}).get("world") or "!"):
                same_world += 1
    purity = same_world / total_in_group if total_in_group else 0.0

    return Evaluation(
        key=key,
        handmade=score_groups(cases, groups),
        auto_recall=auto_recall,
        auto_pairs=len(auto_pairs),
        purity=purity,
        group_sizes=sorted((len(g) for g in groups), reverse=True),
    )
