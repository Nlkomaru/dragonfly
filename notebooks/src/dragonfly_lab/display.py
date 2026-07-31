"""ノートブックの表に埋め込む見た目の部品。

marimo の `mo.ui.table` はセルに HTML を置けるので、サムネイルやパレットの帯は
ここで文字列として組み立てて渡す。数字だけの表より、写真と色を並べたほうが
「この分け方は妥当か」を目で判断しやすい。
"""

from __future__ import annotations

import base64
import io
from datetime import datetime

import numpy as np
from PIL import Image

# 表のセルに置くサムネイルの一辺 (px)。
# 200 枚ぶんを base64 で埋め込むので、大きくすると出力サイズが一気に膨らむ。
THUMB_SIZE = 48


def data_url(rgba: np.ndarray, size: int = THUMB_SIZE) -> str:
    """RGBA 配列を、表に埋め込める PNG の data URL にする。"""
    image = Image.fromarray(np.ascontiguousarray(rgba), mode="RGBA")
    image.thumbnail((size, size), Image.Resampling.LANCZOS)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return f"data:image/png;base64,{base64.b64encode(buffer.getvalue()).decode('ascii')}"


def thumb_html(rgba: np.ndarray, size: int = THUMB_SIZE, title: str = "") -> str:
    """サムネイル 1 枚ぶんの img タグ。透明部分が分かるよう市松模様を敷く。"""
    return (
        f'<img src="{data_url(rgba, size)}" title="{title}" '
        f'style="width:{size}px;height:{size}px;object-fit:cover;border-radius:4px;'
        'background:repeating-conic-gradient(#ddd 0 25%,#fff 0 50%) 0 0/8px 8px" />'
    )


def montage_html(rgbas: list[np.ndarray], size: int = 40, limit: int = 14) -> str:
    """複数枚を横 1 列に並べる。多すぎるときは打ち切って残り枚数を出す。

    表のセルに入れるため、折り返さず（`white-space: nowrap`）1 行に収める。
    折り返すと列幅の狭い表では 1 枚ずつ縦に積まれてしまい、行がとても高くなる。
    """
    shown = "".join(thumb_html(rgba, size) for rgba in rgbas[:limit])
    rest = len(rgbas) - limit
    more = (
        f'<span style="font-size:11px;opacity:.6;align-self:center">+{rest}</span>'
        if rest > 0
        else ""
    )
    # grid + grid-auto-flow:column なら、子要素が block でも必ず横 1 列に並ぶ。
    # 表のセルの CSS が img を block にしていても影響を受けない。
    return (
        '<div style="display:grid;grid-auto-flow:column;justify-content:start;'
        f'gap:3px;width:max-content">{shown}{more}</div>'
    )


def swatch_bar_html(swatches, height: int = 22) -> str:
    """パレットを占有率どおりの幅で 1 本の帯にする。"""
    cells = "".join(
        f'<div style="flex:{max(s.ratio, 0.02)};background:{s.hex};height:{height}px" '
        f'title="{s.hex} {s.ratio:.1%}"></div>'
        for s in swatches
    )
    return (
        f'<div style="display:flex;width:150px;border-radius:3px;overflow:hidden">{cells}</div>'
    )


def format_taken_at(taken_at_ms: int | None) -> str:
    """unix ミリ秒を「2026-07-31 19:04」の形にする。無ければ空文字。"""
    if not taken_at_ms:
        return ""
    return datetime.fromtimestamp(taken_at_ms / 1000).strftime("%Y-%m-%d %H:%M")


def hue_angle(swatches) -> float:
    """パレットの代表的な色相（ラジアン）。距離行列を色順に並べ替えるのに使う。

    彩度で重み付けした平均の向きを取る。無彩色ばかりのときは 0 になる。
    """
    x = sum(s.a * s.ratio for s in swatches)
    y = sum(s.b * s.ratio for s in swatches)
    return float(np.arctan2(y, x))
