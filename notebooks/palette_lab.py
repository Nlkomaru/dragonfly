import marimo

__generated_with = "0.23.15"
app = marimo.App(width="medium")


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    # パレット / グルーピングの検証ラボ

    自分の写真で、色によるグループ分けの精度を測って上げるためのノートブック。
    すべて Python で完結していて、`dragonfly_lab` に実装がある。

    - `palette.py` … **現行アルゴリズム**（`packages/core/src/palette.ts` の移植）。比較の基準
    - `methods.py` … **候補手法**。距離の作り方（対応付け・明度の重み）とまとめ方を差し替えられる
    - `cases.py` / `evaluation.py` … `tests/case.json` の手書き正解と、メタデータから作る自動正解で採点

    | 節 | 見るもの |
    | --- | --- |
    | 1 | 写真の読み込み（API から取得 → `notebooks/remote/` にキャッシュ） |
    | 2 | 代表色 |
    | 3 | **目標枚数ごとのグループ分け**と、正解ケースが同じ組に入ったか |
    | 4 | 手法の総当たり比較 |
    | 5 | 近い写真 |
    | 6 | 不変条件 |
    """)
    return


@app.cell
def _():
    import warnings
    from pathlib import Path

    import marimo as mo
    import matplotlib.pyplot as plt
    import numpy as np

    # POT が読み込み時に出す警告はここでは意味が無いので黙らせる。
    warnings.filterwarnings("ignore", category=SyntaxWarning)

    from dragonfly_lab import (
        CURRENT,
        DEFAULT_BASE_URL,
        RECOMMENDED,
        REMOTE_CACHE_DIR,
        GroupingConfig,
        build_auto_pairs,
        build_distance_matrix,
        cached_photo_count,
        download_to_cache,
        evaluate,
        extract_palettes,
        available_case_files,
        filter_cases,
        format_taken_at,
        group_by_target_size,
        group_photos,
        histogram_distance_matrix,
        hue_angle,
        load_cache,
        load_cache_metadata,
        load_case_files,
        montage_html,
        nearest_photos,
        run_configs,
        swatch_bar_html,
        thumb_html,
    )

    return (
        CURRENT,
        DEFAULT_BASE_URL,
        GroupingConfig,
        Path,
        RECOMMENDED,
        REMOTE_CACHE_DIR,
        available_case_files,
        build_auto_pairs,
        build_distance_matrix,
        cached_photo_count,
        download_to_cache,
        evaluate,
        extract_palettes,
        filter_cases,
        format_taken_at,
        group_by_target_size,
        group_photos,
        histogram_distance_matrix,
        hue_angle,
        load_cache,
        load_cache_metadata,
        load_case_files,
        mo,
        montage_html,
        nearest_photos,
        np,
        plt,
        run_configs,
        swatch_bar_html,
        thumb_html,
    )


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    ## 1. 写真を読み込む

    本番 API から取ってきた自分の写真を使う。取得したサムネイルは `notebooks/remote/` に保存され、
    **次からはそこを読む**（API は叩かない）。取り直したいときは、もう一度「リモートから取得」を押すか、
    `notebooks/remote/` を消す。
    """)
    return


@app.cell
def _(DEFAULT_BASE_URL, REMOTE_CACHE_DIR, cached_photo_count, mo):
    # フォームにしておくと、キーを打っている途中で API を叩いてしまうことがない。
    remote_form = (
        mo.md("""
        {api_key}

        {base_url}

        {limit}
        """)
        .batch(
            api_key=mo.ui.text(
                label="API キー", kind="password", placeholder="dfly_...", full_width=True
            ),
            base_url=mo.ui.text(label="ベース URL", value=DEFAULT_BASE_URL, full_width=True),
            limit=mo.ui.slider(
                start=4, stop=400, step=4, value=200, label="取得枚数", show_value=True
            ),
        )
        .form(submit_button_label="リモートから取得", bordered=True)
    )

    cached_count = cached_photo_count()
    cache_note = (
        f"キャッシュ: `{REMOTE_CACHE_DIR}` に **{cached_count} 枚**"
        if cached_count
        else "キャッシュはまだ空。API キーを入れて取得してほしい。"
    )
    mo.vstack([mo.md(cache_note), remote_form])
    return (remote_form,)


@app.cell
def _(mo):
    palette_size_slider = mo.ui.slider(
        start=2, stop=10, step=1, value=5, label="代表色の数 k", show_value=True
    )
    max_edge_slider = mo.ui.slider(
        start=32, stop=512, step=32, value=192, label="縮小後の長辺 (px)", show_value=True
    )
    target_size_slider = mo.ui.slider(
        start=2, stop=40, step=1, value=7, label="1 グループの目標枚数", show_value=True
    )
    mo.vstack([palette_size_slider, max_edge_slider, target_size_slider])
    return max_edge_slider, palette_size_slider, target_size_slider


@app.cell
def _(download_to_cache, remote_form):
    # フォームが提出されたときだけ API を叩き、キャッシュを置き換える。
    downloaded_count = (
        download_to_cache(
            remote_form.value["api_key"].strip(),
            limit=int(remote_form.value["limit"]),
            base_url=remote_form.value["base_url"].strip(),
        )
        if remote_form.value and remote_form.value["api_key"].strip()
        else 0
    )
    return (downloaded_count,)


@app.cell
def _(downloaded_count, load_cache, load_cache_metadata, max_edge_slider, mo):
    # downloaded_count は「取得が終わったこと」を伝えるためだけの依存。読むのは常にキャッシュ。
    _ = downloaded_count
    images = load_cache(max_edge=max_edge_slider.value)
    image_ids = [photo_id for photo_id, _rgba in images]
    rgba_by_id = dict(images)
    photo_meta = load_cache_metadata()

    mo.stop(
        not images,
        mo.md("**キャッシュが空。** 上のフォームに API キーを入れて「リモートから取得」を押してほしい。"),
    )
    return image_ids, images, photo_meta, rgba_by_id


@app.cell
def _(format_taken_at, images, mo, photo_meta, thumb_html):
    photos_table = mo.ui.table(
        [
            {
                "写真": mo.Html(thumb_html(rgba, title=photo_id)),
                "ワールド": photo_meta.get(photo_id, {}).get("world") or "—",
                "撮影": format_taken_at(photo_meta.get(photo_id, {}).get("takenAt")),
                "photoId": photo_id,
            }
            for photo_id, rgba in images
        ],
        label=f"{len(images)} 枚（行を選ぶと「5. 近い写真」がその写真になる）",
        page_size=5,
        selection="multi",
        initial_selection=[0],
        hidden_columns=["photoId"],
        show_column_summaries=False,
        column_widths={"写真": 70, "ワールド": 380, "撮影": 150},
    )
    photos_table
    return (photos_table,)


@app.cell
def _(image_ids, photos_table):
    selected_ids = [row["photoId"] for row in photos_table.value] or image_ids[:1]
    return (selected_ids,)


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    ## 2. 代表色

    k+1 クラスタ作ってから暗い 1 つを捨て、k 色を返す。帯の幅がその色の占有率。
    """)
    return


@app.cell
def _(extract_palettes, images, palette_size_slider):
    palettes = extract_palettes(images, palette_size=palette_size_slider.value)
    palette_by_id = {p.photo_id: p for p in palettes}
    return palette_by_id, palettes


@app.cell
def _(mo, palettes, photo_meta, rgba_by_id, swatch_bar_html, thumb_html):
    palette_table = mo.ui.table(
        [
            {
                "写真": mo.Html(thumb_html(rgba_by_id[p.photo_id], title=p.photo_id)),
                "パレット": mo.Html(swatch_bar_html(p.swatches)),
                "主要色": p.swatches[0].hex,
                "最大彩度": max(s.chroma for s in p.swatches),
                "平均明度": sum(s.l * s.ratio for s in p.swatches),
                "ワールド": photo_meta.get(p.photo_id, {}).get("world") or "—",
            }
            for p in palettes
        ],
        label="代表色（列見出しで並べ替えできる）",
        page_size=5,
        selection=None,
        format_mapping={"最大彩度": "{:.3f}".format, "平均明度": "{:.3f}".format},
        column_widths={
            "写真": 70,
            "パレット": 170,
            "主要色": 100,
            "最大彩度": 100,
            "平均明度": 100,
            "ワールド": 300,
        },
    )
    palette_table
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    ## 3. グループ分けと、正解ケースの判定

    `tests/case.json` に「同じ組に入ってほしい写真」を書いておくと、ここで判定される。
    手で書くファイルなので、末尾のカンマは許して読む。

    ```json
    [
      ["019fa429-...", "019fa42a-...", "019fa42a-..."],
      ["019fa42d-...", "019fa162-..."]
    ]
    ```

    採点は 3 つ。**手書き**（本命だが数が少ない）、**自動**（同じワールドで 5 分以内に撮った写真同士。
    数が多く過学習しにくい）、**純度**（同じ組のペアのうちワールドまで一致した割合。まとめすぎの抑え。
    無作為だとおよそ 2%）。
    """)
    return


@app.cell
def _(CURRENT, RECOMMENDED, available_case_files, mo):
    method_radio = mo.ui.radio(
        options={
            "色ヒストグラム (OKLab 600bin + Hellinger)": "histogram",
            f"パレット距離 ({RECOMMENDED.key})": "recommended",
            f"現状 ({CURRENT.key})": "current",
        },
        value="色ヒストグラム (OKLab 600bin + Hellinger)",
        label="手法",
    )
    split_switch = mo.ui.switch(value=True, label="大きすぎる組を再分割する（目標の 2 倍まで）")

    # tests/case*.json を全部選べるようにする。手法を選ぶときに使ったファイルと、
    # 使っていないファイルを切り替えて、過学習していないかを見るため。
    case_paths = {path.name: str(path) for path in available_case_files()}
    case_select = mo.ui.multiselect(
        options=case_paths,
        value=list(case_paths),
        label="採点に使う正解ファイル",
    )
    mo.vstack([method_radio, split_switch, case_select])
    return case_select, method_radio, split_switch


@app.cell
def _(
    CURRENT,
    RECOMMENDED,
    build_distance_matrix,
    histogram_distance_matrix,
    images,
    method_radio,
    palettes,
):
    # ヒストグラムはパレットを介さず画素から直に作るので、距離の作り方だけ分岐する。
    # まとめ方（average linkage + 再分割）はどの手法でも共通。
    active_config = CURRENT if method_radio.value == "current" else RECOMMENDED
    active_matrix = (
        histogram_distance_matrix(images)
        if method_radio.value == "histogram"
        else build_distance_matrix(palettes, active_config)
    )
    active_label = (
        "色ヒストグラム (OKLab 600bin + Hellinger)"
        if method_radio.value == "histogram"
        else active_config.key
    )
    return active_config, active_label, active_matrix


@app.cell
def _(
    active_config,
    active_matrix,
    group_by_target_size,
    group_photos,
    palettes,
    split_switch,
    target_size_slider,
):
    target_size = target_size_slider.value
    group_count = max(1, round(len(palettes) / target_size))
    groups = (
        group_by_target_size(palettes, active_matrix, target_size, active_config)
        if split_switch.value
        else group_photos(palettes, group_count, active_config, active_matrix)
    )
    return group_count, groups, target_size


@app.cell
def _(
    Path,
    build_auto_pairs,
    case_select,
    evaluate,
    filter_cases,
    groups,
    image_ids,
    load_case_files,
    photo_meta,
):
    written_cases = load_case_files([Path(value) for value in case_select.value])
    cases = filter_cases(written_cases, set(image_ids))
    # キャッシュに無い写真を含むケースは採点できない。黙って減ると「全部 ✅」に見えてしまうので数えておく。
    dropped_cases = len(written_cases) - len(cases)
    auto_pairs = build_auto_pairs(image_ids, photo_meta)
    score = evaluate("いま選んでいる手法", groups, cases, auto_pairs, photo_meta)
    return auto_pairs, cases, dropped_cases, score


@app.cell
def _(dropped_cases, group_count, mo, score, target_size):
    mo.hstack(
        [
            mo.stat(
                value=f"{score.handmade.exact_cases}/{score.handmade.total_cases}",
                label="手書きケース（全部同じ組）",
                caption=(
                    f"ペアでは {score.handmade.pair_ratio:.0%}"
                    + (
                        f" / キャッシュに無い写真のため {dropped_cases} 件は採点対象外"
                        if dropped_cases
                        else ""
                    )
                ),
            ),
            mo.stat(
                value=f"{score.auto_recall:.0%}",
                label="自動ケースの再現",
                caption=f"{score.auto_pairs} 組",
            ),
            mo.stat(
                value=f"{score.purity:.1%}",
                label="純度",
                caption="無作為だと約 2%",
            ),
            mo.stat(
                value=f"{len(score.group_sizes)}",
                label="グループ数",
                caption=f"目標 {target_size} 枚 → {group_count} 組 / 最大 {score.largest} 枚",
            ),
        ],
        widths="equal",
        gap=1,
    )
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    ### 手書きケースの結果

    ケースの写真が同じ組に入っていれば ✅。割れているときは、どの組に散ったかを番号で出す。
    """)
    return


@app.cell
def _(cases, groups, mo, montage_html, rgba_by_id, score):
    def _case_rows():
        rows = []
        for index, (case, indices) in enumerate(zip(cases, score.handmade.group_indices)):
            rows.append(
                {
                    "": "✅" if len(set(indices)) == 1 else "❌",
                    "ケース": index + 1,
                    "写真": mo.Html(montage_html([rgba_by_id[pid] for pid in case])),
                    "入った組": ", ".join(str(i + 1) for i in indices),
                }
            )
        return rows

    case_view = (
        mo.ui.table(
            _case_rows(),
            label="tests/case.json",
            selection=None,
            pagination=False,
            show_column_summaries=False,
            column_widths={"": 50, "ケース": 70, "写真": 620, "入った組": 140},
        )
        if cases
        else mo.md(
            "`tests/case.json` がまだ空。同じ組に入ってほしい写真 ID を並べると、ここで判定される。"
        )
    )
    _ = groups  # ケースの判定はいまのグループ分けに対して行っている
    case_view
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    ### 分かれ方
    """)
    return


@app.cell
def _(groups, mo, montage_html, rgba_by_id):
    mo.ui.table(
        [
            {
                "#": index + 1,
                "枚数": len(group),
                "写真": mo.Html(montage_html([rgba_by_id[pid] for pid in group])),
            }
            for index, group in enumerate(groups)
        ],
        label="グループ",
        page_size=8,
        selection=None,
        show_column_summaries=False,
        column_widths={"#": 50, "枚数": 70, "写真": 700},
    )
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    ## 4. 手法の総当たり

    距離の作り方（**対応付け** × **明度の重み** × **重み方式**）とまとめ方の組み合わせを、
    同じ正解で採点して並べる。並べ替えは列見出しから。

    - **対応付け** `greedy`（現行 / 近い色から 1 対 1）, `hungarian`（最適な 1 対 1）,
      `emd`（色を面積ぶん運ぶ輸送問題として測る）
    - **明度の重み** OKLab の L の差にかける倍率。1.0 が現行。下げるほど露出違いを無視する
    - **まとめ方** `kmedoids`（現行）, `average` / `complete` / `ward`（階層的）, `spectral`
    """)
    return


@app.cell
def _(mo):
    run_search_button = mo.ui.run_button(label="総当たりを実行（枚数によっては数十秒）")
    run_search_button
    return (run_search_button,)


@app.cell
def _(
    GroupingConfig,
    auto_pairs,
    cases,
    evaluate,
    group_count,
    mo,
    palettes,
    photo_meta,
    run_configs,
    run_search_button,
):
    mo.stop(not run_search_button.value, mo.md("ボタンを押すと総当たりを始める。"))

    search_configs = [
        GroupingConfig(weighting=weighting, lightness_weight=lw, matching=matching, method=method)
        for method in ("kmedoids", "average", "complete", "ward", "spectral")
        for matching in ("greedy", "hungarian", "emd")
        for weighting in ("area", "accent")
        for lw in (1.0, 0.5, 0.25)
    ]
    search_results = run_configs(palettes, group_count, search_configs)
    search_rows = [
        evaluate(config.key, search_results[config.key], cases, auto_pairs, photo_meta).as_row()
        | {
            "対応付け": config.matching,
            "明度の重み": config.lightness_weight,
            "重み方式": config.weighting,
            "まとめ方": config.method,
        }
        for config in search_configs
    ]
    search_rows.sort(key=lambda row: (row["手書きペア"], row["自動ペア再現"]), reverse=True)

    mo.ui.table(
        search_rows,
        label=f"{len(search_configs)} 通り（再分割なし・{group_count} グループ）",
        page_size=12,
        selection=None,
        show_column_summaries=False,
        format_mapping={
            "手書きペア": "{:.0%}".format,
            "自動ペア再現": "{:.0%}".format,
            "純度": "{:.1%}".format,
        },
        hidden_columns=["手法"],
    )
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    ## 5. 近い写真

    「1. 写真」の表で選んだ 1 枚について、いまの手法で色味が近い順に並べる。
    """)
    return


@app.cell
def _(
    active_matrix,
    mo,
    nearest_photos,
    palette_by_id,
    palettes,
    photo_meta,
    rgba_by_id,
    selected_ids,
    swatch_bar_html,
    thumb_html,
):
    query_id = selected_ids[0]
    neighbours = nearest_photos(palettes, active_matrix, query_id, 10)

    mo.vstack(
        [
            mo.md("**選んだ写真**"),
            mo.Html(
                f'<div style="display:flex;gap:8px;align-items:center">'
                f"{thumb_html(rgba_by_id[query_id], size=64)}"
                f"{swatch_bar_html(palette_by_id[query_id].swatches, height=28)}</div>"
            ),
            mo.ui.table(
                [
                    {
                        "順": rank + 1,
                        "写真": mo.Html(thumb_html(rgba_by_id[other], title=other)),
                        "パレット": mo.Html(swatch_bar_html(palette_by_id[other].swatches)),
                        "距離": distance,
                        "ワールド": photo_meta.get(other, {}).get("world") or "—",
                    }
                    for rank, (other, distance) in enumerate(neighbours)
                ],
                label="近い順 10 枚",
                selection=None,
                page_size=10,
                show_column_summaries=False,
                format_mapping={"距離": "{:.4f}".format},
                column_widths={"順": 50, "写真": 70, "パレット": 170, "距離": 90, "ワールド": 320},
            ),
        ]
    )
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    ### 距離行列

    色相の順に並べ替えて表示する。うまく効いていれば、対角線に沿って暗い（＝近い）ブロックが浮かぶ。
    """)
    return


@app.cell
def _(active_label, active_matrix, hue_angle, np, palettes, plt):
    hue_order = np.argsort([hue_angle(p.swatches) for p in palettes])
    ordered = active_matrix[np.ix_(hue_order, hue_order)]

    heatmap_figure, heatmap_ax = plt.subplots(figsize=(6, 5), constrained_layout=True)
    heat = heatmap_ax.imshow(ordered, cmap="magma", vmin=0)
    heatmap_ax.set_title(active_label)
    heatmap_ax.set_xlabel("photos sorted by hue")
    heatmap_ax.set_xticks([])
    heatmap_ax.set_yticks([])
    heatmap_figure.colorbar(heat, ax=heatmap_ax, shrink=0.85)
    heatmap_figure
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    ## 6. 不変条件
    """)
    return


@app.cell
def _(
    active_matrix,
    extract_palettes,
    images,
    mo,
    np,
    palette_size_slider,
    palettes,
):
    repeat_palettes = extract_palettes(images, palette_size=palette_size_slider.value)

    checks = [
        (
            f"パレットは常に {palette_size_slider.value} 色",
            all(len(p.swatches) == palette_size_slider.value for p in palettes),
        ),
        (
            "ratio の合計は 1（全画素が透明な写真だけ 0）",
            all(
                abs(sum(s.ratio for s in p.swatches) - 1.0) < 1e-9
                or all(s.ratio == 0 for s in p.swatches)
                for p in palettes
            ),
        ),
        ("距離行列は対称", np.allclose(active_matrix, active_matrix.T)),
        ("対角は 0", np.allclose(np.diag(active_matrix), 0.0)),
        (
            "距離は非負かつ有限",
            bool(np.all(active_matrix >= 0) and np.all(np.isfinite(active_matrix))),
        ),
        (
            "再抽出しても同じパレット",
            [[s.hex for s in p.swatches] for p in palettes]
            == [[s.hex for s in p.swatches] for p in repeat_palettes],
        ),
    ]

    mo.ui.table(
        [{"判定": "✅" if ok else "❌", "確認したこと": label} for label, ok in checks],
        selection=None,
        show_column_summaries=False,
        pagination=False,
        column_widths={"判定": 60, "確認したこと": 480},
    )
    return


if __name__ == "__main__":
    app.run()
