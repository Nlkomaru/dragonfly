"""ノートブック一式の場所。あちこちから参照するのでここに置く。"""

from __future__ import annotations

from pathlib import Path

# このファイル (src/dragonfly_lab/paths.py) から見た notebooks/ ディレクトリ。
NOTEBOOKS_DIR = Path(__file__).resolve().parents[2]
