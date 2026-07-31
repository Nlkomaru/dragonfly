"""本番の Web API から写真のサムネイルを取ってくる。

認証は API キー（`Authorization: Bearer dfly_...`）。デスクトップアプリが使うのと同じ鍵で、
Web の設定画面から発行できる。読み取り (GET) しかしないので、ノートブックから写真が
変更・削除されることはない。

鍵はノートブックのファイルには一切書かないこと。marimo はセルのコードだけを保存し
UI の入力値は保存しないので、画面のパスワード欄に貼るぶんには残らない。
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from dragonfly_lab.paths import NOTEBOOKS_DIR
from dragonfly_lab.images import SAMPLE_MAX_EDGE, decode_image

# apps/desktop/src-tauri/src/settings.rs の api_base_url と同じ既定値。
DEFAULT_BASE_URL = "https://dragonfly.vrc.nikomaru.dev"

# サムネイルの同時取得数。相手は Cloudflare Workers なので、行儀よく控えめにしておく。
_FETCH_CONCURRENCY = 6

# 名乗る User-Agent。
#
# 既定のままだと urllib は `Python-urllib/3.x` を送るが、これは Cloudflare の
# Browser Integrity Check に引っかかり、API に届く前に 403 (Error 1010) で弾かれる。
# 何かしら別の名前を送れば通るので、正直に自分の名前を名乗っておく。
# （デスクトップアプリも reqwest の既定 UA で問題なく通っている。）
_USER_AGENT = "dragonfly-notebooks/0.1"


@dataclass(frozen=True)
class RemotePhoto:
    """一覧 API が返す写真のうち、ノートブックで使うぶんだけ。"""

    id: str
    thumb_url: str
    taken_at: int
    world: str | None


def _request(url: str, api_key: str, accept: str) -> bytes:
    """API キー付きで GET する。失敗は理由の分かる例外にして投げ直す。"""
    request = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Accept": accept,
            "User-Agent": _USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        # Cloudflare が API の手前で弾いたケース。鍵の問題と紛らわしいので分けて伝える。
        if "error-1010" in detail or "Error 1010" in detail:
            raise RuntimeError(
                "Cloudflare にブロックされました (Error 1010)。"
                "User-Agent が原因のことが多いので、_USER_AGENT を変えて試してほしい。"
            ) from error
        # API 本体のエラーは {"error": "..."} で返る。読めるならその文言だけを見せる。
        try:
            message = json.loads(detail).get("error", detail[:200])
        except json.JSONDecodeError:
            message = detail[:200]
        # 鍵が無効なときは better-auth が 403 を返す（401 ではない）。
        if error.code in (401, 403):
            raise RuntimeError(f"API キーが受け付けられませんでした ({error.code}): {message}") from error
        raise RuntimeError(f"API が {error.code} を返しました: {message}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"API に接続できません: {error.reason}") from error


def list_photos(
    api_key: str,
    limit: int = 24,
    base_url: str = DEFAULT_BASE_URL,
    **filters: str | int,
) -> list[RemotePhoto]:
    """新しい順に写真を limit 枚ぶん集める。

    一覧はカーソル方式で 1 ページの件数を選べないため、limit に届くまでページを辿る。
    filters には API の対応するクエリ（world / player / tag / from / to）をそのまま渡せる。
    """
    collected: list[RemotePhoto] = []
    cursor: str | None = None
    base = base_url.rstrip("/")

    while len(collected) < limit:
        query = {**{k: str(v) for k, v in filters.items() if v is not None}}
        if cursor:
            query["cursor"] = cursor
        suffix = f"?{urllib.parse.urlencode(query)}" if query else ""
        payload: dict[str, Any] = json.loads(
            _request(f"{base}/api/v1/users/me/photos{suffix}", api_key, "application/json")
        )

        for photo in payload.get("photos", []):
            collected.append(
                RemotePhoto(
                    id=photo["id"],
                    thumb_url=photo["thumbUrl"],
                    taken_at=photo["takenAt"],
                    world=(photo.get("world") or {}).get("name"),
                )
            )
            if len(collected) >= limit:
                break

        cursor = payload.get("nextCursor")
        # 次ページが無ければ、limit に届いていなくてもそこで終わり。
        if not cursor:
            break

    return collected


def fetch_thumbnails(
    photos: list[RemotePhoto],
    api_key: str,
    base_url: str = DEFAULT_BASE_URL,
) -> list[tuple[RemotePhoto, bytes]]:
    """サムネイル (AVIF) のバイト列を取ってくる。

    デコードも縮小もここではしない。取ってきたものをそのままキャッシュに置き、
    縮小サイズを変えるたびにキャッシュから読み直せるようにするため。
    thumbUrl は署名付きの相対パスなので、ベース URL を前に付けて叩く。
    """
    base = base_url.rstrip("/")

    def fetch(photo: RemotePhoto) -> tuple[RemotePhoto, bytes]:
        url = photo.thumb_url if photo.thumb_url.startswith("http") else f"{base}{photo.thumb_url}"
        return (photo, _request(url, api_key, "image/avif"))

    with ThreadPoolExecutor(max_workers=_FETCH_CONCURRENCY) as pool:
        return list(pool.map(fetch, photos))


# ---------------------------------------------------------------------------
# ローカルキャッシュ (notebooks/remote/)
# ---------------------------------------------------------------------------
# 一度取ってきたサムネイルはここに置き、次からは API を叩かずに読む。
# 中身は他人の写真ではなく自分のものだが、リポジトリには入れない（.gitignore 済み）。
# 取り直したいときはディレクトリごと消せばよい。

# notebooks/remote/。
REMOTE_CACHE_DIR = NOTEBOOKS_DIR / "remote"

# 一覧の情報（撮影日時・ワールド名）を添える索引。並び順もこれで決める。
_INDEX_NAME = "index.json"


def cached_photo_count(cache_dir: Path = REMOTE_CACHE_DIR) -> int:
    """キャッシュ済みの枚数。0 ならまだ取得していない。"""
    if not cache_dir.is_dir():
        return 0
    return len([p for p in cache_dir.iterdir() if p.suffix == ".avif"])


def download_to_cache(
    api_key: str,
    limit: int = 24,
    base_url: str = DEFAULT_BASE_URL,
    cache_dir: Path = REMOTE_CACHE_DIR,
) -> int:
    """写真を取ってきてキャッシュに保存し、保存した枚数を返す。

    既にあるファイルは上書きする。索引は「今回取得した分」で置き換えるので、
    キャッシュの内容と索引は常に一致する。
    """
    # 取得を最後まで済ませてから消す。途中で失敗しても、既にあるキャッシュは失われない。
    photos = list_photos(api_key, limit=limit, base_url=base_url)
    downloaded = fetch_thumbnails(photos, api_key, base_url=base_url)

    cache_dir.mkdir(parents=True, exist_ok=True)
    # 前回のファイルが混ざると索引と食い違うので、先に消してから書く。
    for stale in cache_dir.glob("*.avif"):
        stale.unlink()

    index = []
    for photo, blob in downloaded:
        (cache_dir / f"{photo.id}.avif").write_bytes(blob)
        index.append({"id": photo.id, "takenAt": photo.taken_at, "world": photo.world})

    (cache_dir / _INDEX_NAME).write_text(
        json.dumps({"photos": index}, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return len(index)


def load_cache(
    cache_dir: Path = REMOTE_CACHE_DIR, max_edge: int = SAMPLE_MAX_EDGE, limit: int | None = None
) -> list[tuple[str, np.ndarray]]:
    """キャッシュを読んで (photo_id, RGBA) の並びにする。

    並びは索引の順（API と同じ撮影日時の新しい順）。索引が無ければファイル名順。
    """
    if not cache_dir.is_dir():
        return []

    index_path = cache_dir / _INDEX_NAME
    if index_path.is_file():
        entries = json.loads(index_path.read_text(encoding="utf-8")).get("photos", [])
        ids = [entry["id"] for entry in entries]
    else:
        ids = sorted(p.stem for p in cache_dir.glob("*.avif"))

    images: list[tuple[str, np.ndarray]] = []
    for photo_id in ids[:limit] if limit else ids:
        path = cache_dir / f"{photo_id}.avif"
        # 索引にあってもファイルが消えていることはある。その 1 枚だけ飛ばす。
        if not path.is_file():
            continue
        images.append((photo_id, decode_image(path.read_bytes(), max_edge)))
    return images


def load_cache_metadata(cache_dir: Path = REMOTE_CACHE_DIR) -> dict[str, dict[str, Any]]:
    """photo_id をキーにした撮影日時・ワールド名。表示用で、無くても動く。"""
    index_path = cache_dir / _INDEX_NAME
    if not index_path.is_file():
        return {}
    entries = json.loads(index_path.read_text(encoding="utf-8")).get("photos", [])
    return {entry["id"]: entry for entry in entries}
