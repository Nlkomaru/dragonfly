"""「粒の揃ったクラスタリング」の候補手法。

現行の推奨は `methods.RECOMMENDED`（accent / L=0.5 / EMD / average）で、まとめ方は
「距離行列を average linkage で count 個に切る」だけだった。これは色のまとまりは良いが、
ありふれた色の写真が 1 つの大きな塊（200 枚中 50 枚）になり、粒が揃わない。

ここでは距離の作り方は推奨のまま固定し、**まとめ方（切り方・割り当て方）だけ**を
差し替える候補を 4 つ並べる。狙いは「大きすぎる組を作らずに、似た写真は同じ組に残す」。

- `cut_balanced_labels` … 樹形図を「k 個に切る」のをやめ、根から下って部分木のサイズが
  上限以下になったところを 1 組にする。まとめ方は変えず切り方だけ変えるので、
  average linkage の良さを壊さずに最大グループだけ抑えられる。
- `constrained_lp_labels` … 各組に下限・上限を課した最小費用流（輸送 LP）で割り当てる
  k-medoids 風の反復。重心が作れないので「所属点への平均距離」を重心の代わりにする。
- `threshold_blocking_labels` … 「各組は必ず k 枚以上」を保証する 4 近似。
  組内の最大距離（min-max）を小さくする方向に効く。
- `soft_balance_labels` … 上限だけを緩く効かせる貪欲割り当て + 交換改善（ELKI の
  same-size k-means 系）。硬い制約は精度を壊すという観察を受けた折衷案。

いずれも `bench` を受け取り、写真ごとのグループ番号 (n,) を返す。採点は
`bakeoff.score_labels(bench, labels, key)` に渡すだけ。
"""

from __future__ import annotations

import math
import os
import tempfile
import time
from pathlib import Path

import numpy as np
import scipy.sparse as sp
from scipy.cluster.hierarchy import linkage
from scipy.optimize import linprog
from scipy.spatial.distance import squareform

from dragonfly_lab.bakeoff import Bench
from dragonfly_lab.methods import RECOMMENDED, Method, build_distance_matrix, cluster_labels

#: 距離行列のキャッシュ置き場。EMD を 19900 ペア分解くので毎回作ると遅い。
#: リポジトリを汚さないよう一時ディレクトリに置く（環境変数で差し替え可）。
#: 距離の設定をファイル名に含める。別の設定で作った同じ大きさの行列を取り違えないため。
_CACHE_PATH = Path(
    os.environ.get(
        "CAND_CLUSTER_CACHE",
        Path(tempfile.gettempdir())
        / f"cand_cluster_{RECOMMENDED.distance_key.replace('|', '_')}.npy",
    )
)


def recommended_matrix(bench: Bench, cache: bool = True) -> np.ndarray:
    """推奨設定 (accent / L=0.5 / EMD) の距離行列 (n, n)。

    キャッシュは枚数が一致するときだけ使う。写真の並び順は `bench.palettes` に
    紐づくので、枚数が違うキャッシュを流用すると黙って別物の行列になってしまう。
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


def _normalize(labels: np.ndarray, n: int) -> np.ndarray:
    """ラベルを 0..K-1 の連番に詰め直し、未割り当てが残っていないか確かめる。

    `_to_groups` は -1 も普通のグループ番号として扱ってしまうため、未割り当てが
    紛れ込むと「大きな 1 組」が黙って出来上がる。ここで必ず弾く。
    """
    labels = np.asarray(labels).astype(int)
    assert labels.shape == (n,), f"ラベルの長さが写真数と違う: {labels.shape} != {(n,)}"
    assert labels.min() >= 0, "未割り当て (-1) が残っている"
    _, packed = np.unique(labels, return_inverse=True)
    return packed.astype(int)


# ---------------------------------------------------------------------------
# 候補 1: サイズ上限つきデンドログラム切断 (cut_balanced)
# ---------------------------------------------------------------------------


def _linkage_tree(matrix: np.ndarray, method: Method = "average") -> np.ndarray:
    """既存の階層的クラスタリングと同じ樹形図 Z。"""
    return linkage(squareform(matrix, checks=False), method=method)


def _leaves(tree: np.ndarray, n: int, node: int) -> list[int]:
    """ノード配下の葉（写真の添字）を集める。"""
    out: list[int] = []
    stack = [node]
    while stack:
        v = stack.pop()
        if v < n:
            out.append(v)
        else:
            stack += [int(tree[v - n, 0]), int(tree[v - n, 1])]
    return out


def cut_balanced_labels(
    bench: Bench,
    matrix: np.ndarray | None = None,
    max_size: int = 20,
    method: Method = "average",
    min_size: int = 0,
) -> np.ndarray:
    """樹形図を「サイズ上限」で切る。

    根から下りていき、部分木の葉数が `max_size` 以下になったらそこを 1 組として確定する。
    大きすぎる部分木だけを割るので、正しくまとまっている小さい塊は壊れない。

    `min_size` を 1 以上にすると、小さすぎる組を「平均距離が最も近い組」へ吸収する
    後処理を入れる（単独組を消したいとき用）。
    """
    if matrix is None:
        matrix = recommended_matrix(bench)
    n = len(matrix)
    tree = _linkage_tree(matrix, method)

    def size(v: int) -> int:
        return 1 if v < n else int(tree[v - n, 3])

    chosen: list[int] = []
    stack = [2 * n - 2]  # 2n-2 が根
    while stack:
        v = stack.pop()
        if size(v) <= max_size:
            chosen.append(v)
        else:
            stack += [int(tree[v - n, 0]), int(tree[v - n, 1])]

    labels = np.empty(n, dtype=int)
    for index, node in enumerate(chosen):
        labels[_leaves(tree, n, node)] = index

    if min_size > 1:
        labels = _absorb_small(matrix, labels, min_size, max_size)
    return _normalize(labels, n)


def _absorb_small(
    matrix: np.ndarray, labels: np.ndarray, min_size: int, max_size: int
) -> np.ndarray:
    """小さすぎる組を、average linkage 距離が最も近い組へ丸ごと移す。

    上限を壊さないよう、移した先が `max_size` を超える場合は次の候補を見る。
    """
    labels = labels.copy()
    while True:
        sizes = {label: int((labels == label).sum()) for label in np.unique(labels)}
        small = [label for label, s in sizes.items() if s < min_size]
        if not small or len(sizes) <= 1:
            return labels
        target = min(small, key=lambda label: sizes[label])
        members = np.flatnonzero(labels == target)
        others = [label for label in sizes if label != target]
        # 組同士の距離は「メンバー間の平均距離」（average linkage と同じ見方）。
        ranked = sorted(
            others, key=lambda label: float(matrix[np.ix_(members, np.flatnonzero(labels == label))].mean())
        )
        moved = False
        for label in ranked:
            if sizes[label] + len(members) <= max_size:
                labels[members] = label
                moved = True
                break
        if not moved:
            return labels  # どこにも入らない（全部が上限近い）


# ---------------------------------------------------------------------------
# 候補 2: 下限・上限つき割り当て (Bradley-Bennett-Demiriz の輸送 LP)
# ---------------------------------------------------------------------------


def _cost_to_clusters(matrix: np.ndarray, labels: np.ndarray, count: int) -> np.ndarray:
    """点 i から組 j への費用 (n, count)。

    重心が作れない（EMD は非ユークリッド）ので、「その組の全メンバーへの平均距離」を
    重心の代わりに使う。medoid（代表 1 枚からの距離）は代表に引きずられて明確に劣る。
    """
    n = len(matrix)
    cost = np.empty((n, count), dtype=np.float64)
    far = float(matrix.max()) * 2.0
    for j in range(count):
        members = np.flatnonzero(labels == j)
        cost[:, j] = matrix[:, members].mean(axis=1) if members.size else far
    return cost


def _lp_assign(cost: np.ndarray, size_min: int, size_max: int) -> np.ndarray:
    """各組のサイズを [size_min, size_max] に収める最小費用の割り当て。

    輸送多面体は全単模なので、LP の頂点解はそのまま整数になる（MILP は不要）。
    """
    n, count = cost.shape
    a_eq = sp.kron(sp.eye(n), np.ones((1, count)))  # 各点はちょうど 1 組
    a_ub = sp.vstack(
        [
            sp.kron(np.ones((1, n)), sp.eye(count)),  # 各組 <= size_max
            -sp.kron(np.ones((1, n)), sp.eye(count)),  # 各組 >= size_min
        ]
    )
    b_ub = np.r_[np.full(count, size_max), np.full(count, -size_min)]
    result = linprog(
        cost.ravel(),
        A_ub=a_ub,
        b_ub=b_ub,
        A_eq=a_eq,
        b_eq=np.ones(n),
        bounds=(0, 1),
        method="highs",
    )
    if not result.success:
        raise RuntimeError(f"割り当てが解けなかった: {result.message}")
    return result.x.reshape(n, count).argmax(axis=1)


def constrained_lp_labels(
    bench: Bench,
    matrix: np.ndarray | None = None,
    size_min: int = 3,
    size_max: int = 12,
    max_iter: int = 50,
    method: Method = "average",
) -> np.ndarray:
    """サイズの下限・上限を課した k-medoids 風の反復（割り当てを LP で解く）。

    初期化は average linkage。ランダム初期化より明確に良い。
    """
    if matrix is None:
        matrix = recommended_matrix(bench)
    n = len(matrix)
    count = bench.count
    if size_min * count > n or size_max * count < n:
        raise ValueError(f"サイズ制約が成立しない: {size_min}*{count} <= {n} <= {size_max}*{count}")

    labels = cluster_labels(matrix, count, method)
    for _ in range(max_iter):
        updated = _lp_assign(_cost_to_clusters(matrix, labels, count), size_min, size_max)
        if np.array_equal(updated, labels):
            break
        labels = updated
    return _normalize(labels, n)


# ---------------------------------------------------------------------------
# 候補 3: サイズ下限を保証する threshold blocking (Higgins-Sävje-Sekhon)
# ---------------------------------------------------------------------------


def threshold_blocking_labels(
    bench: Bench,
    matrix: np.ndarray | None = None,
    k: int = 5,
    split: bool = True,
) -> np.ndarray:
    """「各組は必ず k 枚以上」を保証する 4 近似（組内の最大距離を最適値の 4 倍以内に抑える）。

    1. (k-1) 最近傍グラフを作る
    2. その 2 乗グラフの極大独立集合を種にする（種同士は必ず離れる）
    3. 種の閉近傍を 1 組にする
    4. 余った点を、隣接する組のうち最も近いものへ入れる

    上限は保証しないので、原論文の refinement（2k 以上の組は割る）を `split` で併用する。
    """
    if matrix is None:
        matrix = recommended_matrix(bench)
    n = len(matrix)
    k = max(2, min(k, n - 1))

    neighbors = np.argsort(matrix, axis=1)[:, 1:k]  # 自分自身を除いた (k-1) 近傍
    adjacency = np.zeros((n, n), dtype=bool)
    adjacency[np.repeat(np.arange(n), k - 1), neighbors.ravel()] = True
    adjacency |= adjacency.T

    squared = adjacency | (adjacency @ adjacency)  # 2 乗グラフ
    np.fill_diagonal(squared, False)

    seeds: list[int] = []
    blocked = np.zeros(n, dtype=bool)
    # 密なところ（k-1 近傍までが近い点）から種を取る。
    for i in np.argsort(matrix[np.arange(n), neighbors[:, -1]]):
        if not blocked[i]:
            seeds.append(int(i))
            blocked[i] = True
            blocked |= squared[i]

    labels = np.full(n, -1, dtype=int)
    for index, seed in enumerate(seeds):
        labels[seed] = index
        labels[np.flatnonzero(adjacency[seed])] = index
    for i in np.flatnonzero(labels < 0):
        near = np.flatnonzero(adjacency[i] & (labels >= 0))
        if near.size:
            labels[i] = labels[near[np.argmin(matrix[i, near])]]
        else:
            labels[i] = labels[seeds[int(np.argmin(matrix[i, seeds]))]]

    if split:
        labels = _split_large_blocks(matrix, labels, k)
    return _normalize(labels, n)


def _split_large_blocks(matrix: np.ndarray, labels: np.ndarray, k: int) -> np.ndarray:
    """2k 枚以上の組を、最も遠い 2 点を種にして割る（両側が k 枚以上になるときだけ）。"""
    labels = labels.copy()
    next_label = int(labels.max()) + 1
    while True:
        targets = [label for label in np.unique(labels) if int((labels == label).sum()) >= 2 * k]
        if not targets:
            return labels
        progressed = False
        for label in targets:
            members = np.flatnonzero(labels == label)
            sub = matrix[np.ix_(members, members)]
            a, b = np.unravel_index(int(np.argmax(sub)), sub.shape)
            side = sub[b] < sub[a]  # b 側に近い点を分ける
            if int(side.sum()) < k or int((~side).sum()) < k:
                continue
            labels[members[side]] = next_label
            next_label += 1
            progressed = True
        if not progressed:
            return labels


# ---------------------------------------------------------------------------
# 候補 4: 上限だけを緩く効かせる貪欲割り当て + 交換改善 (ELKI same-size k-means 系)
# ---------------------------------------------------------------------------


def soft_balance_labels(
    bench: Bench,
    matrix: np.ndarray | None = None,
    alpha: float = 2.0,
    max_iter: int = 30,
    method: Method = "average",
) -> np.ndarray:
    """上限 `cap = ceil(alpha * n / count)` だけを課した割り当てを、交換で改善する。

    1. 「最良の組と最悪の組の差」が大きい点から順に、希望する組へ入れる（満杯なら次善へ）
    2. 別の組の 2 点を入れ替えて双方の費用が下がるなら交換する
    """
    if matrix is None:
        matrix = recommended_matrix(bench)
    n = len(matrix)
    count = bench.count
    cap = max(1, math.ceil(alpha * n / count))

    reference = cluster_labels(matrix, count, method)
    cost = _cost_to_clusters(matrix, reference, count)

    # --- 貪欲割り当て：損得の差が大きい点を優先する（差が小さい点は後回しでも傷が浅い）
    labels = np.full(n, -1, dtype=int)
    filled = np.zeros(count, dtype=int)
    priority = np.argsort(cost.min(axis=1) - cost.max(axis=1))
    for i in priority:
        available = np.flatnonzero(filled < cap)
        j = int(available[np.argmin(cost[i, available])])
        labels[i] = j
        filled[j] += 1

    # --- 交換改善：両方の点にとって得になる入れ替えだけを行う（サイズは変わらない）
    # 注意: 費用は 1 巡ごとにまとめて計算しているので、同じ巡の後半の交換は少し古い費用を見る。
    # 交換のたびに全再計算しても n=200 なら回るが、その分は詰めていない（成績への影響は未測定）。
    for _ in range(max_iter):
        cost = _cost_to_clusters(matrix, labels, count)
        current = cost[np.arange(n), labels]
        gain = current - cost.min(axis=1)  # 出たがっている度合い
        order = np.argsort(-gain)
        swapped = False
        for i in order[: n // 2]:
            if gain[i] <= 0:
                break
            wish = int(np.argmin(cost[i]))
            partners = np.flatnonzero(labels == wish)
            if partners.size == 0:
                continue
            # 相手にとっても i の組の方が良くなる相手を選ぶ
            delta = (cost[i, wish] - cost[i, labels[i]]) + (
                cost[partners, labels[i]] - cost[partners, wish]
            )
            best = int(partners[np.argmin(delta)])
            if delta.min() < 0:
                labels[i], labels[best] = labels[best], labels[i]
                swapped = True
        if not swapped:
            break

    return _normalize(labels, n)


# ---------------------------------------------------------------------------
# 採点
# ---------------------------------------------------------------------------


def main() -> None:
    import warnings

    warnings.filterwarnings("ignore")

    from dragonfly_lab.bakeoff import format_row, load_bench, score_labels, score_matrix

    bench = load_bench()
    matrix = recommended_matrix(bench)
    print(f"# 写真 {len(bench.palettes)} 枚 / 目標 {bench.count} 組 / 正解 {len(bench.cases)} ケース")

    # --- 基準（この 2 行を上回れるかを見る）
    print(format_row(score_matrix(bench, matrix, "average", "基準 average/emd/accent/L=0.5")))
    print(format_row(score_matrix(bench, matrix, "average", "基準 +再分割", split=True)))
    print()

    def run(key: str, fn, **params) -> None:
        started = time.perf_counter()
        labels = fn(bench, matrix=matrix, **params)
        elapsed = time.perf_counter() - started
        print(f"{format_row(score_labels(bench, labels, key))}  {elapsed:5.2f}s")

    # --- 候補 1: cut_balanced。上限を細かく振る（樹形図は使い回せるので安い）
    for max_size in (10, 12, 14, 16, 18, 20, 22, 25, 30):
        run(f"cut_balanced average max={max_size}", cut_balanced_labels, max_size=max_size)
    for linkage_method in ("weighted", "complete", "ward"):
        run(
            f"cut_balanced {linkage_method} max=20",
            cut_balanced_labels,
            max_size=20,
            method=linkage_method,
        )
    # 単独組を消す後処理（純度が落ちる可能性があるので必ず測ってから使う）
    for min_size in (2, 3):
        run(
            f"cut_balanced average max=20 min={min_size}",
            cut_balanced_labels,
            max_size=20,
            min_size=min_size,
        )
    print()

    # --- 候補 2: 下限・上限つき LP。制約の強さを 3 段階
    for size_min, size_max in ((2, 20), (3, 12), (5, 9)):
        run(f"constrained_lp [{size_min},{size_max}]", constrained_lp_labels,
            size_min=size_min, size_max=size_max)
    print()

    # --- 候補 3: threshold blocking
    for k in (4, 5):
        for split in (False, True):
            run(
                f"threshold_blocking k={k}{' +split' if split else ''}",
                threshold_blocking_labels,
                k=k,
                split=split,
            )
    print()

    # --- 候補 4: 緩い上限 + 交換改善
    for alpha in (1.3, 2.0, 2.9, 4.0):
        run(f"soft_balance alpha={alpha}", soft_balance_labels, alpha=alpha)


if __name__ == "__main__":
    main()
