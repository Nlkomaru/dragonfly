"""dragonfly の色パレット / グルーピングを試すための道具一式（Python のみ）。

- `palette` … 現行アルゴリズム (packages/core/src/palette.ts) の移植。比較の基準。
- `methods` … 精度を上げるための候補（距離の作り方・まとめ方の差し替え）。
- `evaluation` / `cases` … 手書きと自動の正解でグループ分けを採点する。
- `remote` / `images` … 写真の取得とキャッシュ、前処理。
- `display` … 表に埋め込むサムネイルとパレットの帯。
"""

from dragonfly_lab.cases import (
    CaseScore,
    available_case_files,
    filter_cases,
    load_case_files,
    load_cases,
    score_groups,
)
from dragonfly_lab.display import (
    THUMB_SIZE,
    data_url,
    format_taken_at,
    hue_angle,
    montage_html,
    swatch_bar_html,
    thumb_html,
)
from dragonfly_lab.evaluation import Evaluation, build_auto_pairs, evaluate
from dragonfly_lab.histogram import (
    DEFAULT_BINS,
    DEFAULT_GAMMA,
    build_histograms,
    histogram_distance_matrix,
)
from dragonfly_lab.images import (
    SAMPLE_MAX_EDGE,
    decode_image,
    fit_to_sample_size,
    load_image,
    resize_rgba,
    synthetic_images,
)
from dragonfly_lab.methods import (
    CURRENT,
    RECOMMENDED,
    GroupingConfig,
    build_distance_matrix,
    cluster_labels,
    group_by_target_size,
    group_photos,
    run_configs,
    split_oversized_labels,
)
from dragonfly_lab.palette import (
    PALETTE_SIZE,
    PALETTE_VERSION,
    Palette,
    Swatch,
    distance_matrix,
    extract_palettes,
    group_by_count,
    group_by_threshold,
    nearest_photos,
)
from dragonfly_lab.remote import (
    DEFAULT_BASE_URL,
    REMOTE_CACHE_DIR,
    RemotePhoto,
    cached_photo_count,
    download_to_cache,
    fetch_thumbnails,
    list_photos,
    load_cache,
    load_cache_metadata,
)

__all__ = [
    "CURRENT",
    "DEFAULT_BINS",
    "DEFAULT_GAMMA",
    "DEFAULT_BASE_URL",
    "PALETTE_SIZE",
    "RECOMMENDED",
    "PALETTE_VERSION",
    "REMOTE_CACHE_DIR",
    "SAMPLE_MAX_EDGE",
    "THUMB_SIZE",
    "CaseScore",
    "Evaluation",
    "GroupingConfig",
    "Palette",
    "RemotePhoto",
    "Swatch",
    "available_case_files",
    "build_auto_pairs",
    "build_histograms",
    "build_distance_matrix",
    "cached_photo_count",
    "cluster_labels",
    "data_url",
    "decode_image",
    "distance_matrix",
    "download_to_cache",
    "evaluate",
    "extract_palettes",
    "fetch_thumbnails",
    "filter_cases",
    "fit_to_sample_size",
    "format_taken_at",
    "group_by_count",
    "group_by_target_size",
    "group_by_threshold",
    "group_photos",
    "histogram_distance_matrix",
    "hue_angle",
    "list_photos",
    "load_cache",
    "load_cache_metadata",
    "load_case_files",
    "load_cases",
    "load_image",
    "montage_html",
    "nearest_photos",
    "resize_rgba",
    "run_configs",
    "score_groups",
    "split_oversized_labels",
    "swatch_bar_html",
    "synthetic_images",
    "thumb_html",
]
