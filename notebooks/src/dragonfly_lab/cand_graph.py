"""「近傍グラフと再ランキング」の候補手法。

推奨設定 (`methods.RECOMMENDED` = accent / L=0.5 / EMD / average) の距離行列は、
色のまとまりは良いが「ありふれた色の写真が 200 枚中 50 枚の 1 つの塊になる」という
弱点がある。average linkage はその塊を物理的に割れないので、まとめ方をいじっても直らない。

ここでは **距離行列 → 距離行列の変換**（再ランキング）を挟んで、この塊を割ることを狙う。
どれも「絶対距離ではなく、近傍集合が一致するか」を見る手法で、鎖状に繋がった巨大な塊を
分解する方向に効く。距離行列を返すだけなので `cluster_labels` 側は一切変更しない。

- `k_reciprocal_matrix` … Zhong+ CVPR2017。相互 k 近傍集合を指数重み付きベクトルに
  符号化し、その重み付き Jaccard 距離で測り直す。本命。
- `diffusion_matrix` … Iscen+ CVPR2017。相互 kNN グラフ上で (I - αS)^{-1} を解き、
  多様体上の距離にする。「間を繋ぐ写真の列がある」ペアを近づける（＝繋げる方向）。
- `snn_matrix` … Jarvis-Patrick / Ertöz+ の共有近傍類似度。k-reciprocal から重み付けと
  拡張を全部落とした最小版。検算用。
- `modularity_labels` … 相互 kNN グラフ上の CNM 貪欲モジュラリティ最大化。
  クラスタ数を指定できないので、ラベルを直接返す形にしてある。

**k の目安は「期待クラスタサイズ」** であって論文の既定値ではない。Zhong+ の k1=20 は
Market-1501（1 人あたり 19.9 枚）に合わせた値で、ここは 200/29 ≈ 6.9 枚なので k1 ≈ 7-8。

**崩壊モードに注意。** 拡散や SNN は k を小さくすると全 200 枚が 1 組に潰れ、
「完全一致 29/29・自動 100%」という満点に見える数字を出す（実体は純度 0.016 =
無作為並み）。`is_collapsed` で必ず弾くこと。

    from dragonfly_lab.bakeoff import load_bench, score_matrix, format_row
    from dragonfly_lab.cand_graph import recommended_matrix, k_reciprocal_matrix

    bench = load_bench()
    print(format_row(score_matrix(bench, k_reciprocal_matrix(bench), "average", "k-recip")))
"""

from __future__ import annotations

import os
import tempfile
import time
from pathlib import Path

import numpy as np

from dragonfly_lab.bakeoff import Bench, format_row, score_labels, score_matrix
from dragonfly_lab.evaluation import Evaluation
from dragonfly_lab.methods import RECOMMENDED, build_distance_matrix

#: 距離行列のキャッシュ置き場。EMD を 19900 ペア分解くので毎回作ると 10 秒かかる。
#: 他の候補ファイルと衝突しないよう、このモジュール専用の名前にしてある。
_CACHE_PATH = Path(
    os.environ.get("CAND_GRAPH_CACHE", Path(tempfile.gettempdir()) / "cand_graph_distance.npy")
)


def recommended_matrix(bench: Bench, cache: bool = True) -> np.ndarray:
    """推奨設定 (accent / L=0.5 / EMD) の距離行列 (n, n)。ここが全候補の入力。

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


def _sanitize(matrix: np.ndarray) -> np.ndarray:
    """距離行列の体裁（対称・対角 0・非負）を整える。

    再ランキングは行ごとに独立して計算するので、数値誤差で微妙に非対称になる。
    `squareform` は非対称だと例外を投げるため、返す前に必ず通す。
    """
    matrix = np.asarray(matrix, dtype=np.float64)
    matrix = (matrix + matrix.T) / 2.0
    np.fill_diagonal(matrix, 0.0)
    return np.maximum(matrix, 0.0)


def _order_of(matrix: np.ndarray) -> np.ndarray:
    """各行の近い順の添字 (n, n)。同点は若い添字が先（stable ソート）。"""
    return np.argsort(matrix, axis=1, kind="stable")


def _mutual_knn_mask(matrix: np.ndarray, k: int) -> np.ndarray:
    """相互 kNN のブール行列。自分自身は含めない。"""
    n = len(matrix)
    order = _order_of(matrix)
    mask = np.zeros((n, n), dtype=bool)
    for i in range(n):
        mask[i, order[i, 1 : k + 1]] = True
    return mask & mask.T  # 片思いは落とす: s_k(x,z) = min{s_k(x|z), s_k(z|x)}


# ---------------------------------------------------------------------------
# 候補 1: k-reciprocal encoding + Jaccard 再ランキング (Zhong+ CVPR2017)
# ---------------------------------------------------------------------------


def k_reciprocal_matrix(
    bench: Bench, k1: int = 8, k2: int = 2, lam: float = 0.3, matrix: np.ndarray | None = None
) -> np.ndarray:
    """相互 k 近傍集合の重み付き Jaccard 距離で測り直した距離行列 (n, n)。

    手順は論文どおり 4 段。

    1. R(p,k1) … p の上位 k1 近傍のうち、相手からも上位 k1 に入っている写真（相互近傍）
    2. R*(p,k1) … R(p,k1) の各要素 q について R(q,k1/2) を求め、R(p,k1) と 2/3 以上
       重なっていれば足し込む。1 枚だけ写り方が違って相互近傍から漏れた写真を拾う段。
    3. V_p … R* の各要素に exp(-d) の重みを置いた疎ベクトル。行の総和を 1 に正規化する。
       さらに上位 k2 近傍の V を平均する（局所クエリ拡張）。ここが効く。
    4. d* = (1-λ)·重み付き Jaccard + λ·元の距離

    「近傍の集合が一致するか」を見るので、A→B→C と鎖で繋がっただけの巨大な塊が割れる。

    k1 は期待クラスタサイズ（200/29 ≈ 7）に合わせるのが要点で、論文の既定値 k1=20 を
    そのまま使うと最初のホップで別グループが混ざり、ベースラインより悪化する。
    """
    D = recommended_matrix(bench) if matrix is None else matrix
    n = len(D)
    order = _order_of(D)
    half = int(np.around(k1 / 2))

    V = np.zeros((n, n), dtype=np.float64)
    for i in range(n):
        # --- 1. 相互 k 近傍 R(i, k1) -------------------------------------
        fwd = order[i, : k1 + 1]
        bwd = order[fwd, : k1 + 1]
        recip = fwd[np.any(bwd == i, axis=1)]

        # --- 2. 2/3 重なりルールで広げた R*(i, k1) -----------------------
        expanded = recip.copy()
        for q in recip:
            fwd_h = order[q, : half + 1]
            bwd_h = order[fwd_h, : half + 1]
            recip_h = fwd_h[np.any(bwd_h == q, axis=1)]
            if len(np.intersect1d(recip_h, recip)) > 2 / 3 * len(recip_h):
                expanded = np.append(expanded, recip_h)
        expanded = np.unique(expanded)

        # --- 3. 指数重みで符号化。行の総和を 1 にする --------------------
        w = np.exp(-D[i, expanded])
        V[i, expanded] = w / w.sum()

    # --- 3'. 局所クエリ拡張: 上位 k2 近傍の V を平均する ------------------
    # k2=1 は「自分だけ」＝拡張なし。近傍集合の揺らぎをならす役目で、外すと効果が半減する。
    if k2 != 1:
        V = np.array([V[order[i, :k2]].mean(axis=0) for i in range(n)])

    # --- 4. 重み付き Jaccard 距離 ----------------------------------------
    # 各行の総和が 1 なので Σmax = 2 - Σmin。max を作らずに済む。
    jac = np.zeros((n, n), dtype=np.float64)
    for i in range(n):
        m = np.minimum(V[i], V).sum(axis=1)
        jac[i] = 1.0 - m / (2.0 - m)

    return _sanitize((1.0 - lam) * jac + lam * D)


# ---------------------------------------------------------------------------
# 候補 2: 相互 kNN グラフ上の拡散 (Iscen+ CVPR2017 / Zhou+ 2004)
# ---------------------------------------------------------------------------


def diffusion_matrix(
    bench: Bench,
    k: int = 7,
    alpha: float = 0.99,
    gamma: float = 3.0,
    matrix: np.ndarray | None = None,
) -> np.ndarray:
    """相互 kNN グラフ上を拡散させて得た多様体距離 (n, n)。

    距離をガウスカーネルで類似度に変え（gamma 乗して鋭くする）、相互 kNN で疎化し、
    対称正規化した S に対して f* = (1-α)(I - αS)^{-1} y を解く。y に単位行列を入れると
    全点ぶんの拡散結果が一度に出る。n=200 なので共役勾配法は不要で密に解ける。

    「A と B は色が違うが、間を繋ぐ写真の列がある」ペアを近づける = 断片化を直す方向。
    逆に巨大な塊を割る力は無いので、k-reciprocal とは効き方が逆になる。

    k を小さくしすぎるとグラフが痩せて全体が 1 組に潰れるので `is_collapsed` で必ず確認する。
    """
    D = recommended_matrix(bench) if matrix is None else matrix
    n = len(D)

    # σ は距離の中央値。データの尺度に合わせるため（methods.cluster_labels の spectral と同じ流儀）
    sigma = float(np.median(D[np.triu_indices(n, 1)])) or 1.0
    S = np.exp(-((D / sigma) ** 2)) ** gamma
    np.fill_diagonal(S, 0.0)
    W = np.where(_mutual_knn_mask(D, k), S, 0.0)

    # S = D^{-1/2} W D^{-1/2}。孤立点（次数 0）で発散しないよう下限を入れる。
    deg = np.maximum(W.sum(axis=1), 1e-12)
    inv_sqrt = 1.0 / np.sqrt(deg)
    normalized = W * inv_sqrt[:, None] * inv_sqrt[None, :]

    F = np.linalg.solve(np.eye(n) - alpha * normalized, (1.0 - alpha) * np.eye(n))
    F = np.maximum((F + F.T) / 2.0, 0.0)

    # 拡散後の類似度をコサイン化してから距離に戻す（行ごとの絶対量の差を消す）
    scale = np.sqrt(np.clip(np.diag(F), 1e-12, None))
    return _sanitize(1.0 - np.clip(F / scale[:, None] / scale[None, :], 0.0, 1.0))


# ---------------------------------------------------------------------------
# 候補 3: 共有近傍 (SNN) 類似度 / Jarvis-Patrick
# ---------------------------------------------------------------------------


def snn_matrix(bench: Bench, k: int = 20, matrix: np.ndarray | None = None) -> np.ndarray:
    """共有近傍の数を類似度にした距離行列 (n, n)。

    2 点の上位 k 近傍集合の共通要素数を数え、相互 kNN でない組は 0 にする
    （Jarvis-Patrick の相互条件）。k-reciprocal から指数重み・2/3 拡張・局所クエリ拡張を
    全部落とした最小版で、実装 10 行。検算と足がかり用。

    SNN は「共有数を数える」ので分解能が要る。k-recip と違って k は大きめが安定する。
    """
    D = recommended_matrix(bench) if matrix is None else matrix
    n = len(D)
    order = _order_of(D)

    near = np.zeros((n, n), dtype=bool)
    for i in range(n):
        near[i, order[i, : k + 1]] = True  # 自分を含む上位 k 近傍
    shared = (near.astype(np.int32) @ near.T.astype(np.int32)).astype(np.float64)
    sim = np.where(near & near.T, shared, 0.0) / (k + 1)
    np.fill_diagonal(sim, 1.0)
    return _sanitize(1.0 - sim)


# ---------------------------------------------------------------------------
# 候補 4: 相互 kNN グラフ + CNM 貪欲モジュラリティ最大化
# ---------------------------------------------------------------------------


def modularity_labels(
    bench: Bench, k: int = 5, resolution: float = 1.0, matrix: np.ndarray | None = None
) -> np.ndarray:
    """相互 kNN グラフのコミュニティ検出でグループを決める (n,)。

    モジュラリティ Q = (1/2m) Σ [A_ij - γ k_i k_j / 2m] δ(c_i,c_j) が増える限り、
    一番得なコミュニティ対を貪欲に併合する（Clauset-Newman-Moore）。networkx も igraph も
    依存に無いので numpy で自前実装する。n=200 なら密行列で足りる。

    **グループ数を指定できない**のが欠点。γ を上げると細かく割れるが、`count` を渡したら
    `count` 組が返るという既存の契約は満たせない。ここでは比較用に置いてある。
    """
    D = recommended_matrix(bench) if matrix is None else matrix
    n = len(D)
    sigma = float(np.median(D[np.triu_indices(n, 1)])) or 1.0
    W = np.where(_mutual_knn_mask(D, k), np.exp(-((D / sigma) ** 2)), 0.0)
    np.fill_diagonal(W, 0.0)

    total = W.sum()
    if total <= 0:
        return np.zeros(n, dtype=int)
    e = W / total  # コミュニティ間の辺の割合
    a = W.sum(axis=1) / total  # コミュニティの次数割合
    labels = np.arange(n)
    alive = np.ones(n, dtype=bool)

    while True:
        gain = 2.0 * (e - resolution * np.outer(a, a))  # ΔQ = 2(e_ij - γ a_i a_j)
        gain[~alive] = -np.inf
        gain[:, ~alive] = -np.inf
        np.fill_diagonal(gain, -np.inf)
        gain[e <= 0] = -np.inf  # 辺が無い組は繋がない（非連結成分を跨がない）
        i, j = np.unravel_index(np.argmax(gain), gain.shape)
        if not np.isfinite(gain[i, j]) or gain[i, j] <= 0:
            break
        e[i] += e[j]
        e[:, i] += e[:, j]
        a[i] += a[j]
        alive[j] = False
        labels[labels == j] = i

    _, packed = np.unique(labels, return_inverse=True)
    return packed.astype(int)


# ---------------------------------------------------------------------------
# 崩壊モードの検出
# ---------------------------------------------------------------------------


def is_collapsed(
    bench: Bench, evaluation: Evaluation, min_purity: float = 0.05, max_share: float = 0.25
) -> bool:
    """「全部を 1 組にしただけ」の見かけ倒しかどうか。

    拡散や SNN は k を小さくすると 200 枚を 1 組にまとめ、手書き 29/29・自動 100% という
    満点を出す。純度が無作為水準 (1.6%) に近い／1 つの組が全体の max_share を超える、の
    どちらかならその状態なので、順位付けの前にここで弾く。

    調査時の案は「最大グループ ≤ 2×target_size (=14)」だったが、K=29 の average linkage は
    まともな設定でも最大 18-20 になるため、それだと良い候補まで落ちる。ここでは
    「1 組が全体の 1/4 を超えたら異常」（現在の推奨がちょうど 50 枚 = 1/4）に緩めてある。
    """
    total = sum(evaluation.group_sizes) or len(bench.palettes)
    return evaluation.purity < min_purity or evaluation.largest > max_share * total


if __name__ == "__main__":
    import warnings

    warnings.filterwarnings("ignore")

    from dragonfly_lab.bakeoff import load_bench

    bench = load_bench()
    D = recommended_matrix(bench)
    print(f"写真 {len(bench.palettes)} 枚 / 目標 {bench.count} 組 / 正解 {len(bench.cases)} ケース")
    print()

    rows: list[tuple[Evaluation, float]] = []

    def run(evaluation: Evaluation, seconds: float) -> None:
        """1 行採点して表示する。崩壊しているものには印を付ける。"""
        rows.append((evaluation, seconds))
        mark = "  ← 崩壊(見かけ倒し)" if is_collapsed(bench, evaluation) else ""
        print(format_row(evaluation) + mark)

    def run_matrix(key: str, make, split: bool = False) -> None:
        """距離行列を作る時間も測りつつ採点する。"""
        started = time.time()
        m = make()
        elapsed = time.time() - started
        run(score_matrix(bench, m, "average", key, split=split), elapsed)

    # --- 基準 --------------------------------------------------------------
    run(score_matrix(bench, D, "average", "baseline (現在の推奨)"), 0.0)
    run(score_matrix(bench, D, "average", "baseline +再分割", split=True), 0.0)
    print()

    # --- 候補 1: k-reciprocal（k1 を振る / k2 を振る / λ を振る） ----------
    for k1 in (6, 7, 8, 10, 12):
        run_matrix(f"k-recip k1={k1} k2=2 λ=0.3", lambda k1=k1: k_reciprocal_matrix(bench, k1, 2, 0.3, D))
    for k2 in (1, 3, 4):
        run_matrix(f"k-recip k1=8 k2={k2} λ=0.3", lambda k2=k2: k_reciprocal_matrix(bench, 8, k2, 0.3, D))
    for lam in (0.0, 0.5):
        run_matrix(f"k-recip k1=8 k2=2 λ={lam:g}", lambda lam=lam: k_reciprocal_matrix(bench, 8, 2, lam, D))
    run_matrix("k-recip k1=8 k2=2 λ=0.3 +再分割", lambda: k_reciprocal_matrix(bench, 8, 2, 0.3, D), split=True)
    print()

    # --- 候補 2: 拡散（k=5 は崩壊の確認用） -------------------------------
    for k in (5, 7, 10, 15):
        run_matrix(f"diffusion k={k}", lambda k=k: diffusion_matrix(bench, k, matrix=D))
    print()

    # --- 候補 3: SNN（k=5 は崩壊の確認用） --------------------------------
    for k in (5, 10, 20, 30):
        run_matrix(f"snn k={k}", lambda k=k: snn_matrix(bench, k, matrix=D))
    print()

    # --- 候補 4: モジュラリティ（組数を指定できないので参考） -------------
    for k, gamma in ((5, 1.0), (5, 4.0)):
        started = time.time()
        labels = modularity_labels(bench, k, gamma, D)
        run(score_labels(bench, labels, f"modularity k={k} γ={gamma:g}"), time.time() - started)
    print()

    # --- 組み合わせ: 拡散 → k-reciprocal ----------------------------------
    run_matrix(
        "diffusion k=7 → k-recip k1=8",
        lambda: k_reciprocal_matrix(bench, 8, 2, 0.3, diffusion_matrix(bench, 7, matrix=D)),
    )
    print()

    # --- 崩壊していないものだけを完全一致で並べる -------------------------
    print("=== 崩壊していない候補（手書き完全一致 順） ===")
    survivors = [(ev, sec) for ev, sec in rows if not is_collapsed(bench, ev)]
    for ev, sec in sorted(survivors, key=lambda r: (-r[0].handmade.exact_cases, -r[0].purity)):
        print(f"{format_row(ev)}  {sec:5.2f}s")
