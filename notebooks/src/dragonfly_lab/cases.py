"""「この写真たちは同じグループになってほしい」という手書きの正解を扱う。

`notebooks/tests/case.json` に、同じ組に入ってほしい写真 ID の配列を並べておく。
手で書くファイルなので、末尾のカンマは許して読む。

    [
      ["019fa429-...", "019fa42a-...", "019fa42a-..."],
      ["019fa42d-...", "019fa162-..."]
    ]

評価の指標は 2 つ。

- **ペア一致率** … ケース内の全ペアのうち、同じグループに入った割合。
  1 枚だけ外れたときに 0 点にならないので、手法の良し悪しの差が見える。
- **完全一致数** … ケース全体が 1 つのグループに収まった数。最終的に目指すのはこちら。
"""

from __future__ import annotations

import itertools
import json
import re
from dataclasses import dataclass
from pathlib import Path

from dragonfly_lab.paths import NOTEBOOKS_DIR

DEFAULT_CASES_PATH = NOTEBOOKS_DIR / "tests" / "case.json"


@dataclass(frozen=True)
class CaseScore:
    """1 つの評価結果。"""

    pair_ratio: float
    matched_pairs: int
    total_pairs: int
    exact_cases: int
    total_cases: int
    #  ケースごとに、所属したグループ番号の並び（どこで割れたかを見る用）。
    group_indices: list[list[int]]

    @property
    def summary(self) -> str:
        return (
            f"ペア {self.matched_pairs}/{self.total_pairs} "
            f"({self.pair_ratio:.0%}) / 完全一致 {self.exact_cases}/{self.total_cases}"
        )


def available_case_files() -> list[Path]:
    """`tests/case*.json` を名前順に返す。正解を何通りか置いて比べられるようにするため。"""
    return sorted(DEFAULT_CASES_PATH.parent.glob("case*.json"))


def load_case_files(paths: list[Path]) -> list[list[str]]:
    """複数の正解ファイルをまとめて読む。"""
    cases: list[list[str]] = []
    for path in paths:
        cases.extend(load_cases(path))
    return cases


def load_cases(path: Path = DEFAULT_CASES_PATH) -> list[list[str]]:
    """正解ファイルを読む。手書きしやすいよう、末尾カンマは取り除いてから解釈する。"""
    if not path.is_file():
        return []
    raw = path.read_text(encoding="utf-8")
    # `[1, 2, ]` のような末尾カンマは JSON では不正だが、手で足しがちなので許す。
    return json.loads(re.sub(r",(\s*[\]\}])", r"\1", raw))


def filter_cases(cases: list[list[str]], available: set[str]) -> list[list[str]]:
    """手元に無い写真を落とし、2 枚以上残ったケースだけにする。"""
    filtered = [[pid for pid in case if pid in available] for case in cases]
    return [case for case in filtered if len(case) >= 2]


def score_groups(cases: list[list[str]], groups: list[list[str]]) -> CaseScore:
    """グループ分けの結果を正解と突き合わせる。"""
    where = {pid: index for index, group in enumerate(groups) for pid in group}

    matched = 0
    total = 0
    exact = 0
    indices: list[list[int]] = []
    for case in cases:
        case_indices = [where.get(pid, -1) for pid in case]
        indices.append(case_indices)
        pairs = list(itertools.combinations(case_indices, 2))
        matched += sum(1 for x, y in pairs if x == y and x >= 0)
        total += len(pairs)
        if len(set(case_indices)) == 1 and case_indices[0] >= 0:
            exact += 1

    return CaseScore(
        pair_ratio=matched / total if total else 0.0,
        matched_pairs=matched,
        total_pairs=total,
        exact_cases=exact,
        total_cases=len(cases),
        group_indices=indices,
    )
