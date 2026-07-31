"""「輸送距離とその発展形」の候補手法。

現行の推奨 (`methods.RECOMMENDED` = accent / L=0.5 / EMD / average) は、色 1 組ごとの
ユークリッド距離を地上コストにした素の EMD (`ot.emd2`) である。ここでは **距離の中身だけ**
を差し替える候補を並べる。まとめ方 (average linkage) と重み (accent) は推奨のまま固定する。

推奨の弱点は再現率ではなく **純度 8.2% と最大グループ 50** の 2 つなので、判別質問は
「背景色 1 つが共通しているだけの写真同士を、近いと宣言するのをやめられるか」になる。

- `saturating_emd` … Rubner らの飽和地上コスト `1 - exp(-alpha d)` (IJCV 2000, Eq.5)。
  遠い色対のコストを頭打ちにして、「1 色だけ大きく違う」ことが距離を支配するのを防ぐ。
- `thresholded_emd` … Pele-Werman の閾値コスト `min(d, t)` (ICCV 2009)。同じ狙いの粗い版。
- `partial_emd` … 質量の一部 (frac) だけを運ぶ partial OT (Chapel et al. 2020)。
  「一番合わない色」を捨てられる。
- `sinkhorn_divergence` … 自己項を引いた Sinkhorn divergence (Feydy et al. 2019)。
  eps→0 で EMD、eps→∞ で energy distance に連続的につながる 1 本の軸。
- `quadratic_form` … 輸送計画を解かない二次形式距離 (SQFD / energy distance)。
  Sinkhorn 軸の eps→∞ 側の端点にあたる。つまみ 0 個の energy が既定。
- `unbalanced_emd` … 周辺制約を KL で緩める unbalanced OT。accent 重みの
  **総量差**（このデータでは 0.041〜0.402 と 10 倍の開きがある）を潰さずに使う。

いずれも `bench` を受け取り距離行列 (n, n) を返す。採点は
`bakeoff.score_matrix(bench, matrix, "average", key)` に渡すだけ。

スケール依存のつまみ (alpha, t, eps, reg_m) は、必ず **ソルバに渡す最終的なコスト行列** の
中央値から決める。地上コストを差し替えると中央値そのものが動くため、絶対値で指定しない。
"""

from __future__ import annotations

import time
from typing import Literal

import numpy as np
import ot
from scipy.spatial.distance import cdist

from dragonfly_lab.bakeoff import Bench, format_row, load_bench, score_matrix
from dragonfly_lab.palette import Palette, swatch_weights

Ground = Literal["euclid", "saturating", "thresholded"]

#: 推奨設定と同じ既定値。ここを変えると比較の土俵がずれる。
LIGHTNESS_WEIGHT = 0.5
WEIGHTING = "accent"


# ---------------------------------------------------------------------------
# 共通の下ごしらえ
# ---------------------------------------------------------------------------


def scaled_coords(palettes: list[Palette], lightness_weight: float = LIGHTNESS_WEIGHT) -> list[np.ndarray]:
    """明度の重みを座標に畳み込んだ OKLab 座標 (k, 3) の一覧。

    現行の `_swatch_cost` は sqrt(sum(diff^2 * [w,1,1])) を計算しているが、これは
    sqrt([w,1,1]) でスケールした座標の素のユークリッド距離と厳密に同じ。こう置いておくと
    点集合を受け取る POT の API もそのまま使えて、地上コストの差し替えも 1 か所で済む。
    """
    scale = np.sqrt(np.array([lightness_weight, 1.0, 1.0]))
    return [p.lab * scale for p in palettes]


def masses(palettes: list[Palette], weighting: str = WEIGHTING) -> list[np.ndarray]:
    """swatch ごとの質量。ペアごとに合計 1 に正規化する（現行と同じ扱い）。"""
    out = []
    for p in palettes:
        w = swatch_weights(p, weighting).astype(np.float64)
        total = w.sum()
        out.append(w / total if total > 0 else np.full(len(w), 1.0 / len(w)))
    return out


def relative_masses(palettes: list[Palette], weighting: str = WEIGHTING) -> list[np.ndarray]:
    """データセット全体の平均で割った質量。ペア間の質量「比」だけを残す（C3 用）。

    ペアごとに合計 1 にすると総量差の情報が消えて unbalanced OT にする意味がなくなる。
    かといって正規化しないと、線形項も KL ペナルティも総質量に比例してスケールするため、
    「彩やかさの総量」でクラスタが割れてしまう。全体で 1 つの定数で割るのが折衷案。
    """
    raw = [swatch_weights(p, weighting).astype(np.float64) for p in palettes]
    scale = float(np.mean([w.sum() for w in raw])) or 1.0
    return [w / scale for w in raw]


def ground_cost(
    zi: np.ndarray, zj: np.ndarray, ground: Ground = "euclid", param: float = 0.0
) -> np.ndarray:
    """色 1 組ごとの地上コスト (k, k)。非負・自己対角 0 は保たれる。"""
    d = cdist(zi, zj)
    if ground == "saturating":
        # Rubner et al. IJCV 2000 Eq.(5)。値域が [0,1) に有界になり、遠い色対の影響が頭打ちになる。
        d = 1.0 - np.exp(-param * d)
    elif ground == "thresholded":
        # Pele & Werman ICCV 2009。上位の色対を t で打ち切る。
        d = np.minimum(d, param)
    return np.ascontiguousarray(d)


def cost_median(coords: list[np.ndarray], ground: Ground = "euclid", param: float = 0.0) -> float:
    """コスト行列の中央値。つまみを「中央値の何倍」で指定するための基準。

    全ペア (19900) を作ると無駄なので、等間隔に間引いたペアで推定する。
    """
    samples = []
    n = len(coords)
    for i in range(0, n, 7):
        for j in range(i + 1, n, 11):
            samples.append(ground_cost(coords[i], coords[j], ground, param).ravel())
    return float(np.median(np.concatenate(samples)))


def rubner_alpha(coords: list[np.ndarray]) -> float:
    """Rubner らの処方 alpha = 1 / ||[sigma_1 ... sigma_dim]||。

    sigma は全写真・全 swatch の座標の各軸標準偏差。無調整で決まるのが利点。
    """
    stacked = np.vstack(coords)
    return float(1.0 / np.linalg.norm(stacked.std(axis=0)))


def _pairwise(coords: list[np.ndarray], fn) -> np.ndarray:
    """全ペアに fn(i, j) を適用して対称な距離行列にする。"""
    n = len(coords)
    matrix = np.zeros((n, n), dtype=np.float64)
    for i in range(n):
        for j in range(i + 1, n):
            matrix[i, j] = matrix[j, i] = fn(i, j)
    return matrix


# ---------------------------------------------------------------------------
# C5: ロバスト地上コスト（飽和 / 閾値）+ 素の EMD
# ---------------------------------------------------------------------------


def saturating_emd(
    bench: Bench,
    alpha_ratio: float | None = None,
    lightness_weight: float = LIGHTNESS_WEIGHT,
    weighting: str = WEIGHTING,
) -> np.ndarray:
    """飽和地上コスト `1 - exp(-alpha d)` を使った EMD。

    alpha_ratio を渡すと alpha = alpha_ratio / median(d)、None なら Rubner の
    alpha = 1/||sigma||（このデータでは alpha * median(d) が 1 前後になる）。
    """
    coords = scaled_coords(bench.palettes, lightness_weight)
    weights = masses(bench.palettes, weighting)
    if alpha_ratio is None:
        alpha = rubner_alpha(coords)
    else:
        alpha = alpha_ratio / cost_median(coords)
    return _pairwise(
        coords,
        lambda i, j: float(
            ot.emd2(weights[i], weights[j], ground_cost(coords[i], coords[j], "saturating", alpha))
        ),
    )


def thresholded_emd(
    bench: Bench,
    q: float = 2.0,
    lightness_weight: float = LIGHTNESS_WEIGHT,
    weighting: str = WEIGHTING,
) -> np.ndarray:
    """閾値地上コスト `min(d, t)` を使った EMD。t = q * median(d)。"""
    coords = scaled_coords(bench.palettes, lightness_weight)
    weights = masses(bench.palettes, weighting)
    t = q * cost_median(coords)
    return _pairwise(
        coords,
        lambda i, j: float(
            ot.emd2(weights[i], weights[j], ground_cost(coords[i], coords[j], "thresholded", t))
        ),
    )


# ---------------------------------------------------------------------------
# C2: partial OT（質量の一部だけ運ぶ）
# ---------------------------------------------------------------------------


def partial_emd(
    bench: Bench,
    frac: float = 0.85,
    ground: Ground = "euclid",
    ground_ratio: float = 1.0,
    lightness_weight: float = LIGHTNESS_WEIGHT,
    weighting: str = WEIGHTING,
) -> np.ndarray:
    """質量の frac だけを運ぶ partial Wasserstein。

    frac を下げるほど「一番合わない色」を捨てられる。運んだ質量 m で割って
    「1 単位あたりのコスト」にしないとペア間で尺度が揃わない点に注意。
    frac=1.0 は浮動小数点誤差 (a.sum() = 0.999...) で infeasible になるので 0.99 で頭打ち。
    """
    coords = scaled_coords(bench.palettes, lightness_weight)
    weights = masses(bench.palettes, weighting)
    param = 0.0
    if ground == "saturating":
        param = ground_ratio / cost_median(coords)
    elif ground == "thresholded":
        param = ground_ratio * cost_median(coords)
    m = float(min(frac, 0.99))

    def distance(i: int, j: int) -> float:
        cost = ground_cost(coords[i], coords[j], ground, param)
        v = ot.partial.partial_wasserstein2(weights[i], weights[j], cost, m=m)
        return float(max(v, 0.0) / m)

    return _pairwise(coords, distance)


# ---------------------------------------------------------------------------
# C1: debiased Sinkhorn divergence
# ---------------------------------------------------------------------------


def _sinkhorn(a: np.ndarray, b: np.ndarray, cost: np.ndarray, eps: float) -> float:
    """log 領域の Sinkhorn。小さい eps でも NaN にならない。"""
    return float(
        ot.sinkhorn2(a, b, cost, eps, method="sinkhorn_log", numItermax=2000, stopThr=1e-10)
    )


def sinkhorn_divergence(
    bench: Bench,
    r: float = 0.8,
    ground: Ground = "euclid",
    ground_ratio: float = 1.0,
    lightness_weight: float = LIGHTNESS_WEIGHT,
    weighting: str = WEIGHTING,
) -> np.ndarray:
    """S_eps(a,b) = OT_eps(a,b) - 0.5 OT_eps(a,a) - 0.5 OT_eps(b,b)。eps = r * median(cost)。

    生の `ot.sinkhorn2` は自己距離が 0 にならず squareform → linkage を壊すので、
    必ず 3 項で debias する。自己項は写真ごとに 1 回だけ解けばよいので先に計算しておく
    （200 回で済み、ペアごとに 2 回解く 39800 回を避けられる）。
    有限反復では理論に反して負が出るため 0 で clip する。
    """
    coords = scaled_coords(bench.palettes, lightness_weight)
    weights = masses(bench.palettes, weighting)
    param = 0.0
    if ground == "saturating":
        param = ground_ratio / cost_median(coords)
    elif ground == "thresholded":
        param = ground_ratio * cost_median(coords)
    eps = r * cost_median(coords, ground, param)

    self_terms = [
        _sinkhorn(w, w, ground_cost(z, z, ground, param), eps) for z, w in zip(coords, weights)
    ]

    def distance(i: int, j: int) -> float:
        cross = _sinkhorn(
            weights[i], weights[j], ground_cost(coords[i], coords[j], ground, param), eps
        )
        return float(max(cross - 0.5 * self_terms[i] - 0.5 * self_terms[j], 0.0))

    return _pairwise(coords, distance)


# ---------------------------------------------------------------------------
# C4: 対応付けを使わない二次形式距離（SQFD / energy distance）
# ---------------------------------------------------------------------------


def quadratic_form(
    bench: Bench,
    kernel: Literal["energy", "gauss", "laplace"] = "energy",
    h_ratio: float = 1.0,
    lightness_weight: float = LIGHTNESS_WEIGHT,
    weighting: str = WEIGHTING,
) -> np.ndarray:
    """符号付き重みベクトル w = [a, -b] に対する sqrt(w^T K w)。

    輸送計画を一切解かないので純 numpy で全ペア同時に計算できる。全写真の swatch を
    1 本に積んだ (n*k, n*k) のカーネルを 1 回作れば、あとはブロックの切り出しで済む。

    - `energy` … K = -D。つまみ 0 個。Sinkhorn 軸の eps→∞ 側の端点。
    - `gauss` … K = exp(-alpha D^2)、alpha = 1/(4h^2)、h = h_ratio * median(D)。
      等方共分散 GMM の L2 divergence (Grogan & Dahyot) と厳密に対応し、h はバンド幅。
    - `laplace` … K = exp(-alpha D)。gauss より早く天井に飽和する。
    """
    coords = scaled_coords(bench.palettes, lightness_weight)
    weights = masses(bench.palettes, weighting)
    n, k = len(coords), coords[0].shape[0]
    points = np.vstack(coords)  # (n*k, 3)
    d = cdist(points, points)

    if kernel == "energy":
        kmat = -d
    else:
        h = h_ratio * cost_median(coords)
        alpha = 1.0 / (4.0 * h * h) if kernel == "gauss" else 1.0 / h
        kmat = np.exp(-alpha * (d * d if kernel == "gauss" else d))

    w = np.vstack(weights)  # (n, k)
    # G[i, j] = a_i^T K_ij b_j。ブロックごとの二次形式をまとめて計算する。
    blocks = kmat.reshape(n, k, n, k)
    gram = np.einsum("ip,ipjq,jq->ij", w, blocks, w)
    diag = np.diag(gram)
    # ||a - b||^2_K = a^T K a - 2 a^T K b + b^T K b
    squared = diag[:, None] + diag[None, :] - 2.0 * gram
    matrix = np.sqrt(np.maximum(squared, 0.0))
    np.fill_diagonal(matrix, 0.0)
    return (matrix + matrix.T) / 2.0


# ---------------------------------------------------------------------------
# C3: unbalanced OT（accent 質量の総量差を潰さない）
# ---------------------------------------------------------------------------


def unbalanced_emd(
    bench: Bench,
    reg_ratio: float = 0.5,
    div: str = "kl",
    lightness_weight: float = LIGHTNESS_WEIGHT,
    weighting: str = WEIGHTING,
) -> np.ndarray:
    """周辺制約を KL で緩めた unbalanced OT。reg_m = reg_ratio * median(cost)。

    質量はデータセット全体の平均で割るだけにして、ペア間の質量比を残す。
    `returnCost='total'`（線形項 + 両側の KL ペナルティ）を必ず指定すること。既定の
    'linear' は reg_m を下げると「何も運ばない」が最適になり、距離が 0 に潰れる。

    **実測では失敗した（負の結果として残す）。** reg_m を 0.25/0.5/1.0 * median と振っても
    最大グループが 115〜136 枚、純度は 2.5〜2.8%（無作為の 1.6% とほぼ同じ）にしかならない。
    距離と |accent 質量の差| の相関が 0.56 あり、136 枚の塊の平均 accent 質量は 0.109 と
    全体平均 0.139 より低い（小さい組は逆にどれも 0.157 以上）。つまり色相ではなく
    「写真全体の彩やかさ」でクラスタが割れている。accent 重みの総量はこのデータでは
    0.041〜0.402 と 10 倍の開きがあり、その差が色の違いを覆い隠してしまう。
    """
    coords = scaled_coords(bench.palettes, lightness_weight)
    weights = relative_masses(bench.palettes, weighting)
    reg_m = reg_ratio * cost_median(coords)

    def distance(i: int, j: int) -> float:
        cost = ground_cost(coords[i], coords[j])
        v = ot.unbalanced.mm_unbalanced2(
            weights[i],
            weights[j],
            cost,
            reg_m=reg_m,
            div=div,
            returnCost="total",
            numItermax=1000,
            stopThr=1e-10,  # 既定の 1e-15 まで回すのは 5x5 では過剰。打ち切って速くする
        )
        return float(max(v, 0.0))

    return _pairwise(coords, distance)


# ---------------------------------------------------------------------------
# 採点
# ---------------------------------------------------------------------------


def main(section: str | None = None) -> None:
    """全候補を実データで採点して 1 行ずつ表示する。

    section に "C5" のような接頭辞を渡すと、その候補だけを走らせる（コマンドライン第 1 引数）。
    """
    bench = load_bench()
    coords = scaled_coords(bench.palettes)
    median = cost_median(coords)
    print(f"n={len(bench.palettes)} 目標グループ数={bench.count} median(cost)={median:.4f}")
    print(f"Rubner alpha = 1/||sigma|| = {rubner_alpha(coords):.3f} "
          f"(alpha * median = {rubner_alpha(coords) * median:.3f})")
    print()

    def run(key: str, fn, **params) -> None:
        if section and not key.startswith(section):
            return
        started = time.perf_counter()
        matrix = fn(bench, **params)
        elapsed = time.perf_counter() - started
        # 「+再分割」は同じ行列を切り直すだけなので追加費用はほぼゼロ。純度は必ず
        # 再分割ありの基準（純度 20.5% / 最大 14）と見比べること。再分割なしの 8.2% と
        # 比べると「再分割で済む改善」を新手法の手柄にしてしまう。
        print(f"{format_row(score_matrix(bench, matrix, 'average', key))}  {elapsed:5.1f}s")
        print(format_row(score_matrix(bench, matrix, "average", key + " +再分割", split=True)))

    # --- 基準（現行の推奨）。地上コストを素のユークリッドにした EMD と一致する。
    from dragonfly_lab.methods import RECOMMENDED, build_distance_matrix

    base = build_distance_matrix(bench.palettes, RECOMMENDED)
    print(format_row(score_matrix(bench, base, "average", "[基準] emd/accent/L=0.5")))
    print(format_row(score_matrix(bench, base, "average", "[基準] +再分割", split=True)))
    print()

    # --- C5: 飽和地上コスト（Rubner）。alpha は無調整版と 3 段階のスイープ
    run("C5 saturating alpha=1/||sigma||", saturating_emd)
    for ratio in (0.5, 2.0, 3.0):
        run(f"C5 saturating alpha*med={ratio:g}", saturating_emd, alpha_ratio=ratio)
    print()

    # --- C5: 閾値地上コスト（Pele-Werman）
    for q in (1.5, 2.0, 3.0):
        run(f"C5 thresholded t={q:g}*med", thresholded_emd, q=q)
    print()

    # --- C2: partial OT
    for frac in (0.70, 0.80, 0.85, 0.90, 0.95):
        run(f"C2 partial frac={frac:g}", partial_emd, frac=frac)
    print()

    # --- C4: 二次形式距離。energy はつまみ 0 個
    run("C4 energy", quadratic_form)
    for h in (0.5, 1.0, 2.0):
        run(f"C4 gauss h={h:g}*med", quadratic_form, kernel="gauss", h_ratio=h)
    print()

    # --- C1: Sinkhorn divergence。r <= 0.2 は EMD と同じなので大きめだけ見る
    for r in (0.4, 0.8, 2.0):
        run(f"C1 sinkhorn eps={r:g}*med", sinkhorn_divergence, r=r)
    print()

    # --- C3: unbalanced OT。accent の総量差を残す
    for ratio in (0.25, 0.5, 1.0):
        run(f"C3 unbalanced reg_m={ratio:g}*med", unbalanced_emd, reg_ratio=ratio)
    print()

    # --- 詰め: 上のスイープで良かった点の周りをもう少しだけ見る（合計 30 通りに収める）
    for ratio in (4.0, 5.0):
        run(f"詰め saturating alpha*med={ratio:g}", saturating_emd, alpha_ratio=ratio)
    for q in (1.0, 1.2):
        run(f"詰め thresholded t={q:g}*med", thresholded_emd, q=q)
    for frac in (0.75, 0.82):
        run(f"詰め partial frac={frac:g}", partial_emd, frac=frac)
    # 地上コストの差し替えは距離の定義と直交するので合成できる。
    run(
        "詰め partial frac=0.8 x saturating a*med=3",
        partial_emd,
        frac=0.80,
        ground="saturating",
        ground_ratio=3.0,
    )
    run(
        "詰め sinkhorn eps=2*med x saturating a*med=3",
        sinkhorn_divergence,
        r=2.0,
        ground="saturating",
        ground_ratio=3.0,
    )


if __name__ == "__main__":
    import sys

    main(sys.argv[1] if len(sys.argv) > 1 else None)
