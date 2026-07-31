"""ノートブックに食わせる RGBA 画像を用意する。

本番 (apps/web/src/lib/extractPhotoPalette.ts) は AVIF サムネイルをブラウザで
デコードし、長辺 SAMPLE_MAX_EDGE px に縮小した canvas から RGBA を取り出している。
ここではその前処理だけを Python で再現する。縮小フィルタはブラウザの drawImage と
Pillow で完全には一致しないので、代表色が数値レベルで完全一致する保証は無い
（アルゴリズムの挙動を見る用途では問題にならない差）。
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

# apps/web/src/lib/extractPhotoPalette.ts の SAMPLE_MAX_EDGE と同じ既定値。
# ノートブックではスライダーで変えられるようにしてあるが、本番の値はこちら。
SAMPLE_MAX_EDGE = 192


def fit_to_sample_size(width: int, height: int, max_edge: int = SAMPLE_MAX_EDGE) -> tuple[int, int]:
    """長辺が max_edge 以下になる描画サイズ。拡大方向には効かせない。"""
    longest = max(width, height)
    scale = max_edge / longest if longest > max_edge else 1.0
    return (max(1, round(width * scale)), max(1, round(height * scale)))


def resize_rgba(rgba: np.ndarray, max_edge: int = SAMPLE_MAX_EDGE) -> np.ndarray:
    """(H, W, 4) の uint8 配列を本番と同じ規則で縮小する。"""
    height, width = rgba.shape[0], rgba.shape[1]
    target_width, target_height = fit_to_sample_size(width, height, max_edge)
    if (target_width, target_height) == (width, height):
        return rgba
    image = Image.fromarray(np.ascontiguousarray(rgba), mode="RGBA")
    resized = image.resize((target_width, target_height), Image.Resampling.LANCZOS)
    return np.asarray(resized, dtype=np.uint8)


def decode_image(data: bytes, max_edge: int = SAMPLE_MAX_EDGE) -> np.ndarray:
    """画像のバイト列（AVIF / PNG / JPEG など）を縮小した RGBA にする。"""
    import io

    with Image.open(io.BytesIO(data)) as image:
        rgba = image.convert("RGBA")
        width, height = fit_to_sample_size(rgba.width, rgba.height, max_edge)
        resized = rgba.resize((width, height), Image.Resampling.LANCZOS)
        return np.asarray(resized, dtype=np.uint8)


def load_image(path: Path, max_edge: int = SAMPLE_MAX_EDGE) -> np.ndarray:
    """画像ファイルを縮小して (H, W, 4) の uint8 で返す。"""
    return decode_image(path.read_bytes(), max_edge)


# ---------------------------------------------------------------------------
# 合成画像
# ---------------------------------------------------------------------------
# ノートブックの入力はリモートの写真だけだが、ネットワークもキャッシュも無い状態で
# テストを回せるよう、性質のはっきりした画像を決め打ちで作れるようにしておく。
# 「暗い画面に小さな差し色」「よく似た夕焼け 2 枚」など、判定したい性質が出るものを揃える。
# 乱数は固定シードで再現性を持たせる。

# 生成時の一辺。縮小スライダーの効果が見えるよう、本番の既定値より大きく作る。
_SIZE = 512


def _canvas(rgb: tuple[int, int, int]) -> np.ndarray:
    """単色で埋めた不透明な RGBA キャンバス。"""
    canvas = np.zeros((_SIZE, _SIZE, 4), dtype=np.uint8)
    canvas[..., 0:3] = rgb
    canvas[..., 3] = 255
    return canvas


def _vertical_gradient(top: tuple[int, int, int], bottom: tuple[int, int, int]) -> np.ndarray:
    """上下方向のグラデーション。空や夕焼けの代わり。"""
    ramp = np.linspace(0.0, 1.0, _SIZE, dtype=np.float32)[:, None]
    colours = np.array(top, dtype=np.float32) * (1 - ramp) + np.array(bottom, dtype=np.float32) * ramp
    canvas = np.zeros((_SIZE, _SIZE, 4), dtype=np.uint8)
    canvas[..., 0:3] = np.repeat(colours[:, None, :], _SIZE, axis=1).astype(np.uint8)
    canvas[..., 3] = 255
    return canvas


def _with_patch(base: np.ndarray, rgb: tuple[int, int, int], coverage: float) -> np.ndarray:
    """画面の coverage 割を占める四角い差し色を左上に置く。"""
    side = max(1, int(round(_SIZE * coverage**0.5)))
    patched = base.copy()
    patched[0:side, 0:side, 0:3] = rgb
    return patched


def _noise(base: np.ndarray, amplitude: int, seed: int) -> np.ndarray:
    """単一クラスタに潰れないよう、わずかにざらつきを足す。"""
    rng = np.random.default_rng(seed)
    noise = rng.integers(-amplitude, amplitude + 1, size=(_SIZE, _SIZE, 3))
    noisy = base.copy()
    noisy[..., 0:3] = np.clip(base[..., 0:3].astype(np.int16) + noise, 0, 255).astype(np.uint8)
    return noisy


def synthetic_images(max_edge: int = SAMPLE_MAX_EDGE) -> list[tuple[str, np.ndarray]]:
    """検証用の合成画像一式。(photo_id, RGBA) の並びで返す。

    狙い:
      - night-* : ほぼ黒く、差し色だけが違う 3 枚。area 重みではどれも似て見え、
                  accent 重みでは赤とシアンが離れるはず。
      - sunset-* : よく似た 2 枚。どの重みでも近いままであるべき。
      - all-dark / all-white / transparent : 破綻しやすい端のケース。
    """
    night = _noise(_canvas((12, 14, 20)), amplitude=4, seed=1)
    sunset = _vertical_gradient((250, 170, 90), (120, 60, 130))
    sunset_shifted = _vertical_gradient((245, 160, 100), (110, 70, 140))

    transparent = np.zeros((_SIZE, _SIZE, 4), dtype=np.uint8)

    images = [
        # 面積 4% だけの差し色。accent 重みが効くかどうかがここに出る。
        ("night-red-accent", _with_patch(night, (220, 40, 40), 0.04)),
        ("night-cyan-accent", _with_patch(night, (40, 210, 220), 0.04)),
        ("night-plain", night),
        ("sunset", sunset),
        ("sunset-shifted", sunset_shifted),
        ("forest", _noise(_vertical_gradient((60, 120, 50), (20, 60, 30)), amplitude=6, seed=2)),
        ("mono-gradient", _vertical_gradient((30, 30, 30), (230, 230, 230))),
        ("all-white", _canvas((255, 255, 255))),
        ("all-dark", _canvas((6, 6, 8))),
        ("transparent", transparent),
    ]
    # 実写と同じ経路（縮小してから抽出）に揃える。
    return [(photo_id, resize_rgba(rgba, max_edge)) for photo_id, rgba in images]
