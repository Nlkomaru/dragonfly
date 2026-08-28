// Web ギャラリー（issue #6）。
// 初回ページは loader + createServerFn で SSR し、続きはクライアントで
// /api/v1/users/me/photos を credentials: "include" で取る。
// 画像 URL は署名付き相対パス（issue #10）をそのまま <img src> に渡す。

import type {
  ApiPhoto,
  ApiPhotoBlurhash,
  ListFacetsResponse,
  ListPhotosResponse,
  ListTagsResponse,
  Photo,
  PutPhotoTagsResponse,
} from "@dragonfly/core";
import { BLURHASH_PUT_LIMIT } from "@dragonfly/core";
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  FilterCombobox,
  Input,
  Label,
  PhotoDetailDialog,
  PhotoGrid,
  PhotoLightbox,
  type FilterComboboxOption,
} from "@dragonfly/ui";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { apiPhotoToPhoto } from "../../lib/apiPhotoToPhoto";
import { extractPhotoBlurhash } from "../../lib/extractPhotoBlurhash";
import { mapWithConcurrency } from "../../lib/extractPhotoPalette";
import {
  ImageFetchError,
  rotateImageBlob,
  type RotatedImageBlob,
} from "../../lib/rotateImage";

import { fetchPhotosPage } from "../../server/fetchPhotosPage";

/**
 * BlurHash を計算する同時実行数。パレット抽出（/groups の 4）より控えめにしているのは、
 * こちらは画面の裏で勝手に走る処理で、表示中のサムネイル取得と帯域を取り合うため。
 */
const BLURHASH_CONCURRENCY = 2;

/** 配列を size 件ずつに割る。PUT の上限（BLURHASH_PUT_LIMIT）に合わせるのに使う。 */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/**
 * 描画が落ち着いてから cb を呼ぶ。戻り値を呼ぶと取り消せる。
 *
 * requestIdleCallback は Safari に無いので、能力判定は（SSR で焼き付かないよう）
 * 呼び出し時に行い、無ければ短い setTimeout に落とす。
 */
function runWhenIdle(cb: () => void): () => void {
  if (typeof requestIdleCallback === "function") {
    const handle = requestIdleCallback(cb, { timeout: 3_000 });
    return () => cancelIdleCallback(handle);
  }
  const handle = setTimeout(cb, 500);
  return () => clearTimeout(handle);
}

/** URL 検索パラメータ。共有・リロードで再現できるフィルタと詳細 ID。 */
export type GallerySearch = {
  world?: string;
  player?: string;
  tag?: string;
  /** 撮影日時の下限（unix ミリ秒）。 */
  from?: number;
  /** 撮影日時の上限（unix ミリ秒）。 */
  to?: number;
  /** 詳細ダイアログで開く写真 ID。 */
  photo?: string;
};

/** datetime-local の値を unix ms に。空や不正は undefined。 */
function datetimeLocalToMs(value: string): number | undefined {
  if (!value) return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

/** unix ms を datetime-local 用文字列に。 */
function msToDatetimeLocal(ms?: number): string {
  if (ms === undefined) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 一覧 API へ渡すクエリ文字列を組み立てる。 */
function buildListQuery(filters: {
  world?: string;
  player?: string;
  tag?: string;
  from?: number;
  to?: number;
  cursor?: string;
}): string {
  const params = new URLSearchParams();
  if (filters.world) params.set("world", filters.world);
  if (filters.player) params.set("player", filters.player);
  if (filters.tag) params.set("tag", filters.tag);
  if (filters.from !== undefined) params.set("from", String(filters.from));
  if (filters.to !== undefined) params.set("to", String(filters.to));
  if (filters.cursor) params.set("cursor", filters.cursor);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const Route = createFileRoute("/_authed/")({
  validateSearch: (raw: Record<string, unknown>): GallerySearch => {
    // 空文字や不正値を落として、URL に載せる最小の形にする。
    const asString = (value: unknown): string | undefined =>
      typeof value === "string" && value.length > 0 ? value : undefined;
    const asNumber = (value: unknown): number | undefined => {
      if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
      if (typeof value === "string" && value.length > 0) {
        const n = Number(value);
        if (Number.isFinite(n)) return Math.trunc(n);
      }
      return undefined;
    };
    return {
      world: asString(raw.world),
      player: asString(raw.player),
      tag: asString(raw.tag),
      from: asNumber(raw.from),
      to: asNumber(raw.to),
      photo: asString(raw.photo),
    };
  },
  // フィルタが変わったときだけ loader を再実行する（photo は詳細 UI 用なので除外）。
  loaderDeps: ({ search }) => ({
    world: search.world,
    player: search.player,
    tag: search.tag,
    from: search.from,
    to: search.to,
  }),
  loader: async ({ deps }) =>
    fetchPhotosPage({
      data: {
        worldId: deps.world,
        playerId: deps.player,
        tag: deps.tag,
        from: deps.from,
        to: deps.to,
      },
    }),
  // 戻る操作で毎回取り直さない。フィルタ変更時は loaderDeps が変わるので再取得される。
  staleTime: 30_000,
  component: GalleryPage,
});

function GalleryPage() {
  const search = Route.useSearch();
  const loaderData = Route.useLoaderData();
  const navigate = useNavigate({ from: Route.fullPath });

  // loader の 1 ページ目 + クライアントで継ぎ足したページ。
  const [apiPhotos, setApiPhotos] = useState<ApiPhoto[]>(loaderData.photos);
  const [nextCursor, setNextCursor] = useState<string | null>(loaderData.nextCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // 詳細 URL の photo がまだ一覧に無いときの単体取得結果。
  const [detailExtra, setDetailExtra] = useState<ApiPhoto | null>(null);
  // 拡大表示中の写真。共有したいのは詳細（?photo=）のほうなので、これは URL に載せない。
  const [previewPhoto, setPreviewPhoto] = useState<Photo | null>(null);
  // タグ入力の候補。初回に一度だけ取り、保存のたびに増分を足す。
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);
  // タグを保存中の写真 ID。保存中は入力を止める。
  const [savingTagsFor, setSavingTagsFor] = useState<string | null>(null);
  // 保存中に表示するタグ。往復を待つと、追加したタグが一瞬消えて見えるため先に反映する。
  const [pendingTags, setPendingTags] = useState<string[] | null>(null);
  const [tagError, setTagError] = useState<string | null>(null);
  // この画面で計算した BlurHash。apiPhotos には混ぜない（後述のバックフィルのコメント参照）。
  const [computedBlurhashes, setComputedBlurhashes] = useState<Map<string, string>>(new Map());
  // 削除の確認中の写真。null なら確認ダイアログは閉じている。
  const [deleteTarget, setDeleteTarget] = useState<Photo | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // 回転を処理中の写真 ID。処理中は拡大表示の回転・削除ボタンを止める。
  const [rotatingId, setRotatingId] = useState<string | null>(null);
  const [rotateError, setRotateError] = useState<string | null>(null);

  // 絞り込みの選択肢（ワールド / VRChat ユーザー）。ID を覚えていなくても名前で選べるようにする。
  const [facets, setFacets] = useState<ListFacetsResponse>({ worlds: [], players: [] });

  // 日付だけは打ち終わりが分からないので下書きにし、「絞り込み」で URL に反映する。
  // ワールド / プレイヤー / タグは選んだ時点で確定するので、その場で URL に載せる。
  const [draftFrom, setDraftFrom] = useState(msToDatetimeLocal(search.from));
  const [draftTo, setDraftTo] = useState(msToDatetimeLocal(search.to));

  // loader が新しいページを返したら一覧を差し替える（フィルタ変更・戻る操作）。
  useEffect(() => {
    setApiPhotos(loaderData.photos);
    setNextCursor(loaderData.nextCursor);
    setLoadError(null);
    setDetailExtra(null);
  }, [loaderData]);

  // URL の期間が変わったら下書きも揃える（戻る・共有 URL 直開き）。
  useEffect(() => {
    setDraftFrom(msToDatetimeLocal(search.from));
    setDraftTo(msToDatetimeLocal(search.to));
  }, [search.from, search.to]);

  // 詳細 ID が一覧に無いときだけ単体 GET する。
  useEffect(() => {
    const photoId = search.photo;
    if (!photoId) {
      setDetailExtra(null);
      return;
    }
    if (apiPhotos.some((p) => p.id === photoId)) {
      setDetailExtra(null);
      return;
    }
    if (detailExtra?.id === photoId) return;

    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/v1/users/me/photos/${encodeURIComponent(photoId)}`, {
          credentials: "include",
        });
        if (!res.ok) {
          if (!cancelled) setDetailExtra(null);
          return;
        }
        const body = (await res.json()) as ApiPhoto;
        if (!cancelled) setDetailExtra(body);
      } catch {
        if (!cancelled) setDetailExtra(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [search.photo, apiPhotos, detailExtra?.id]);

  const photos: Photo[] = useMemo(() => apiPhotos.map(apiPhotoToPhoto), [apiPhotos]);

  const thumbById = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of apiPhotos) map.set(p.id, p.thumbUrl);
    return map;
  }, [apiPhotos]);

  // カードのプレースホルダに使う BlurHash。
  // サーバーに入っている値を正とし、まだ入っていない写真だけこの画面で計算した値で補う。
  const blurhashById = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of apiPhotos) if (p.blurhash) map.set(p.id, p.blurhash);
    for (const [id, hash] of computedBlurhashes) if (!map.has(id)) map.set(id, hash);
    return map;
  }, [apiPhotos, computedBlurhashes]);

  const urlById = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of apiPhotos) map.set(p.id, p.url);
    if (detailExtra) map.set(detailExtra.id, detailExtra.url);
    return map;
  }, [apiPhotos, detailExtra]);

  const tagsById = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const p of apiPhotos) map.set(p.id, p.tags);
    if (detailExtra) map.set(detailExtra.id, detailExtra.tags);
    return map;
  }, [apiPhotos, detailExtra]);

  const detailApi: ApiPhoto | null = useMemo(() => {
    if (!search.photo) return null;
    return apiPhotos.find((p) => p.id === search.photo) ?? detailExtra;
  }, [search.photo, apiPhotos, detailExtra]);

  const detailPhoto: Photo | null = useMemo(
    () => (detailApi ? apiPhotoToPhoto(detailApi) : null),
    [detailApi],
  );

  // タグ候補は一覧とは独立に一度だけ取る。失敗しても補完が効かないだけなので黙って諦める。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/v1/users/me/tags", { credentials: "include" });
        if (!res.ok) return;
        const body = (await res.json()) as ListTagsResponse;
        if (!cancelled) setTagSuggestions(body.tags);
      } catch {
        // 補完なしで続行する。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 絞り込みの選択肢も一度だけ取る。フィルタを変えるたびに取り直す必要は無いので
  // loader には載せない。失敗しても ID 直打ち（共有 URL）は効くので黙って諦める。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/v1/users/me/facets", { credentials: "include" });
        if (!res.ok) return;
        const body = (await res.json()) as ListFacetsResponse;
        if (!cancelled) setFacets(body);
      } catch {
        // 選択肢なしで続行する。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 一度でも BlurHash の計算に手を付けた写真 ID。成否を問わず入れて、二度は計算しない。
  const attemptedBlurhashRef = useRef<Set<string>>(new Set());

  // まだ BlurHash を持たない写真のぶんを、この画面を開いている間に埋めていく。
  //
  // ここで走らせる理由: プレースホルダが要るのはこのギャラリーなので、
  // 「普通に開いていれば自然に埋まる」形が一番素直で、専用の画面や操作も要らない。
  // 1 回に扱うのは今読み込んでいるぶんだけなので、無限スクロールで写真が増えるたびに
  // この effect が続きを拾う（＝作業量が写真の総数に引きずられない）。
  //
  // 初回描画とスクロールを邪魔しないよう、着手はアイドルまで遅らせる。
  // attempted はマウント単位なので、保存に失敗した写真は次に開いたときにやり直しになる
  // （保存できていれば ApiPhoto に載って返ってくるので、そもそも候補に入らない）。
  useEffect(() => {
    // 候補の条件は blurhashById が「使う」条件のちょうど裏返し。
    // === null ではなく falsy で見るのは、空文字が両方から漏れて
    // 「表示もされないのに計算もされない」写真になるのを防ぐため。
    const pending = apiPhotos.filter(
      (photo) => !photo.blurhash && !attemptedBlurhashRef.current.has(photo.id),
    );
    if (pending.length === 0) return;

    let cancelled = false;
    const cancelIdle = runWhenIdle(() => {
      // 印を付けるのは実際に走り出すこの時点。effect の本体で付けてしまうと、
      // 実行前に effect が貼り直されたとき（React の開発時の二重実行）に
      // 「手は付けていないのに二度と計算しない」写真ができてしまう。
      for (const photo of pending) attemptedBlurhashRef.current.add(photo.id);

      void (async () => {
        const results = await mapWithConcurrency(
          pending,
          BLURHASH_CONCURRENCY,
          async (photo): Promise<ApiPhotoBlurhash> => {
            // 画面を離れたら残りは打ち切る。ここで止めないと、アンマウント後も
            // サムネイルの取得とデコードが走り続けてしまう。
            if (cancelled) throw new Error("cancelled");
            const blurhash = await extractPhotoBlurhash(photo.thumbUrl, photo.id);
            return { photoId: photo.id, blurhash };
          },
        );

        // ここから先は cancelled を見ない。中断で止めたいのは「これから走る取得とデコード」
        // だけで、既に計算し終わったぶんまで捨ててしまうと、無限スクロールで apiPhotos が
        // 増えるたびに effect が貼り直され、直前のバッチの成果が毎回消える
        // （attempted には入っているので、そのマウント中はもう計算し直されない）。
        // 計算の代金は払い済みなので、アンマウント後でも反映と保存はやり切る。

        // 1 枚の失敗で全体を止めない。プレースホルダが出ないだけなので黙って飛ばす。
        const extracted: ApiPhotoBlurhash[] = [];
        for (const result of results) {
          if (result.status === "fulfilled") extracted.push(result.value);
        }
        if (extracted.length === 0) return;

        // まず表示に回す。まだ画面外にある写真のぶんも、ここで入れておけば
        // 今回のスクロールでそのまま効く。
        setComputedBlurhashes((prev) => {
          const next = new Map(prev);
          for (const { photoId, blurhash } of extracted) next.set(photoId, blurhash);
          return next;
        });

        // BLURHASH_PUT_LIMIT 件ずつ保存する。上限超過は 400 になるので必ず割る。
        for (const part of chunk(extracted, BLURHASH_PUT_LIMIT)) {
          try {
            const res = await fetch("/api/v1/users/me/blurhashes", {
              method: "PUT",
              credentials: "include",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ blurhashes: part }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
          } catch (error) {
            // 裏方の処理なので、保存に失敗しても画面には出さない。
            // 表示は手元の値で足りており、次に開いたときにまた計算し直せばよい。
            // ただし黙って消えると気付けないので、理由だけはコンソールに残す。
            console.warn("BlurHash を保存できませんでした", error);
          }
        }
      })();
    });

    return () => {
      cancelled = true;
      cancelIdle();
    };
  }, [apiPhotos]);

  // 名前で探せるように label は名前、value は ID。ID もキーワードに入れて直接引けるようにする。
  const worldOptions: FilterComboboxOption[] = useMemo(
    () =>
      facets.worlds.map((world) => ({
        value: world.id,
        // 名前が取れていない古い行は ID をそのまま見せる。
        label: world.name || world.id,
        keywords: [world.id],
        hint: String(world.count),
      })),
    [facets.worlds],
  );

  const playerOptions: FilterComboboxOption[] = useMemo(
    () =>
      facets.players.map((player) => ({
        value: player.id,
        label: player.displayName || player.id,
        keywords: [player.id],
        hint: String(player.count),
      })),
    [facets.players],
  );

  const tagOptions: FilterComboboxOption[] = useMemo(
    () => tagSuggestions.map((tag) => ({ value: tag, label: tag })),
    [tagSuggestions],
  );

  /** 詳細ダイアログのタグを保存する。成功したら手元の一覧にも反映する。 */
  const saveTags = useCallback(
    async (photoId: string, next: string[]) => {
      setSavingTagsFor(photoId);
      setPendingTags(next);
      setTagError(null);
      try {
        const res = await fetch(`/api/v1/users/me/photos/${encodeURIComponent(photoId)}/tags`, {
          method: "PUT",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tags: next }),
        });
        if (!res.ok) throw new Error(`タグを保存できませんでした (${res.status})`);
        const body = (await res.json()) as PutPhotoTagsResponse;

        // loader は staleTime 中に再実行されないので、手元の一覧を直接書き換える。
        // tagsById はここから導出しているため、これだけで表示が揃う。
        setApiPhotos((prev) =>
          prev.map((photo) => (photo.id === photoId ? { ...photo, tags: body.tags } : photo)),
        );
        setDetailExtra((prev) => (prev && prev.id === photoId ? { ...prev, tags: body.tags } : prev));
        // 新しく作られたタグを候補にも足す。
        setTagSuggestions((prev) => [...new Set([...prev, ...body.tags])].sort());
      } catch (error) {
        setTagError(error instanceof Error ? error.message : "タグを保存できませんでした");
      } finally {
        setSavingTagsFor(null);
        setPendingTags(null);
      }
    },
    [],
  );

  const loadingMoreRef = useRef(false);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setLoadError(null);
    try {
      const qs = buildListQuery({
        world: search.world,
        player: search.player,
        tag: search.tag,
        from: search.from,
        to: search.to,
        cursor: nextCursor,
      });
      const res = await fetch(`/api/v1/users/me/photos${qs}`, {
        credentials: "include",
      });
      if (!res.ok) {
        throw new Error(`一覧の続きを取得できませんでした (${res.status})`);
      }
      const body = (await res.json()) as ListPhotosResponse;
      setApiPhotos((prev) => {
        // 重複排除（稀にカーソル境界で重なる可能性に備える）。
        const seen = new Set(prev.map((p) => p.id));
        const appended = body.photos.filter((p) => !seen.has(p.id));
        return appended.length > 0 ? [...prev, ...appended] : prev;
      });
      setNextCursor(body.nextCursor);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "一覧の続きを取得できませんでした");
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [nextCursor, search.world, search.player, search.tag, search.from, search.to]);

  const handleNearEnd = useCallback(() => {
    void loadMore();
  }, [loadMore]);

  const openDetail = useCallback(
    (photo: Photo) => {
      void navigate({
        search: (prev) => ({ ...prev, photo: photo.path }),
        replace: false,
      });
    },
    [navigate],
  );

  const openPreview = useCallback((photo: Photo) => {
    setPreviewPhoto(photo);
  }, []);

  /** 拡大表示のまま前後の写真へ移動する。一覧の並び順をそのまま辿る。 */
  const stepPreview = useCallback(
    (delta: number) => {
      setPreviewPhoto((current) => {
        if (!current) return current;
        const index = photos.findIndex((photo) => photo.path === current.path);
        // 端では止める。巡回させると、どこまで見たのか分からなくなる。
        return photos[index + delta] ?? current;
      });
    },
    [photos],
  );

  const closeDetail = useCallback(
    (open: boolean) => {
      if (open) return;
      void navigate({
        search: (prev) => {
          const { photo: _removed, ...rest } = prev;
          return rest;
        },
        replace: true,
      });
    },
    [navigate],
  );

  /** 削除ボタンが押されたとき。取り返しが付かないので、まず確認ダイアログを出す。 */
  const requestDelete = useCallback((photo: Photo) => {
    setDeleteTarget(photo);
    setDeleteError(null);
  }, []);

  /** 確認ダイアログで「削除」を押されたとき。成功したら手元の表示も揃える。 */
  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    // Web では Photo.path が ApiPhoto.id（apiPhotoToPhoto がそう詰めている）。
    const photoId = deleteTarget.path;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/v1/users/me/photos/${encodeURIComponent(photoId)}`, {
        method: "DELETE",
        credentials: "include",
      });
      // 成功は 204（本文なし）なので、JSON は読まずに ok だけを見る。
      if (!res.ok) throw new Error(`写真を削除できませんでした (${res.status})`);

      // loader は staleTime 中に再実行されないので、タグ保存と同じく手元を直接書き換える。
      setApiPhotos((prev) => prev.filter((photo) => photo.id !== photoId));
      setDetailExtra((prev) => (prev && prev.id === photoId ? null : prev));
      setPreviewPhoto((prev) => (prev && prev.path === photoId ? null : prev));
      // 一覧から消しただけだと ?photo= が残り、単体 GET が 404 になって
      // 中身の無い詳細ダイアログが開いたままになる。URL からも外す。
      if (search.photo === photoId) closeDetail(false);
      setDeleteTarget(null);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "写真を削除できませんでした");
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, search.photo, closeDetail]);

  /**
   * 写真を回転する。大きな画像のピクセル処理はブラウザで行い、
   * 圧縮済みの AVIF だけをサーバーへ送って R2 の実体を上書きする。
   * 成功したら応答の ApiPhoto で手元を差し替える。
   */
  const rotatePhoto = useCallback(
    async (photo: Photo, degrees: 90 | 270) => {
      const photoId = photo.path;
      const apiPhoto = apiPhotos.find((item) => item.id === photoId) ?? detailApi;
      if (!apiPhoto) {
        setRotateError("写真の情報を取得できませんでした");
        return;
      }

      setRotatingId(photoId);
      setRotateError(null);
      try {
        const image = await rotateImageBlob(apiPhoto.url, degrees);
        let thumb: RotatedImageBlob | null = null;
        try {
          thumb = await rotateImageBlob(apiPhoto.thumbUrl, degrees);
        } catch (error) {
          // サムネイル無しの古い写真は本体だけ回転し、既存の状態を維持する。
          if (!(error instanceof ImageFetchError) || error.status !== 404) throw error;
        }

        const form = new FormData();
        form.append("image", image.blob, `${photoId}.avif`);
        if (thumb) form.append("thumb", thumb.blob, `${photoId}_thumb.avif`);
        form.append("degrees", String(degrees));
        form.append("width", String(image.width));
        form.append("height", String(image.height));

        const res = await fetch(
          `/api/v1/users/me/photos/${encodeURIComponent(photoId)}/rotate`,
          {
            method: "POST",
            credentials: "include",
            body: form,
          },
        );
        if (!res.ok) throw new Error(`写真を回転できませんでした (${res.status})`);
        const body = (await res.json()) as ApiPhoto;

        // loader は staleTime 中に再実行されないので、タグ保存と同じく手元を直接書き換える。
        setApiPhotos((prev) => prev.map((p) => (p.id === body.id ? body : p)));
        setDetailExtra((prev) => (prev && prev.id === body.id ? body : prev));
        // 拡大表示中の Photo は ApiPhoto から導出した別物なので、こちらも作り直す。
        setPreviewPhoto((prev) => (prev && prev.path === body.id ? apiPhotoToPhoto(body) : prev));

        // 回転で BlurHash は無効になる（サーバー側でも null に戻る）。
        // この画面で計算した値と「計算済み」の印も消して、バックフィルに計算し直させる。
        attemptedBlurhashRef.current.delete(body.id);
        setComputedBlurhashes((prev) => {
          if (!prev.has(body.id)) return prev;
          const next = new Map(prev);
          next.delete(body.id);
          return next;
        });
      } catch (error) {
        setRotateError(error instanceof Error ? error.message : "写真を回転できませんでした");
      } finally {
        setRotatingId(null);
      }
    },
    [apiPhotos, detailApi],
  );

  /** 選択式のフィルタ（ワールド / プレイヤー / タグ）をその場で URL に反映する。 */
  const applyFacet = useCallback(
    (key: "world" | "player" | "tag", value: string | undefined) => {
      void navigate({
        // 他のフィルタは触らない。詳細だけは中身が変わるので閉じる。
        search: (prev) => ({ ...prev, [key]: value, photo: undefined }),
      });
    },
    [navigate],
  );

  /** 期間の下書きを URL に反映する。 */
  const applyRange = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      void navigate({
        search: (prev) => ({
          ...prev,
          from: datetimeLocalToMs(draftFrom),
          to: datetimeLocalToMs(draftTo),
          photo: undefined,
        }),
      });
    },
    [navigate, draftFrom, draftTo],
  );

  const clearFilters = useCallback(() => {
    setDraftFrom("");
    setDraftTo("");
    void navigate({
      search: {
        world: undefined,
        player: undefined,
        tag: undefined,
        from: undefined,
        to: undefined,
        photo: search.photo,
      },
    });
  }, [navigate, search.photo]);

  /** 表示に使うタグ。保存中は往復を待たず、送信した値を先に見せる。 */
  const tagsFor = useCallback(
    (photoId: string): string[] => {
      if (savingTagsFor === photoId && pendingTags !== null) return pendingTags;
      return tagsById.get(photoId) ?? [];
    },
    [savingTagsFor, pendingTags, tagsById],
  );

  const hasActiveFilters = Boolean(
    search.world ||
      search.player ||
      search.tag ||
      search.from !== undefined ||
      search.to !== undefined,
  );

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {/* フィルタバー。値は URL に載せ、共有・リロードで再現する。 */}
      <form
        onSubmit={applyRange}
        className="flex shrink-0 flex-wrap items-end gap-3 border-b px-4 py-3"
      >
        {/* ワールド名は長いので、他のフィールドより広めに取る。 */}
        <FilterField id="filter-world" label="ワールド" className="w-64">
          <FilterCombobox
            id="filter-world"
            value={search.world}
            onChange={(next) => applyFacet("world", next)}
            options={worldOptions}
            placeholder="すべてのワールド"
            searchPlaceholder="ワールド名 / ID で検索"
            emptyText="一致するワールドがありません"
          />
        </FilterField>
        <FilterField id="filter-player" label="プレイヤー" className="w-56">
          <FilterCombobox
            id="filter-player"
            value={search.player}
            onChange={(next) => applyFacet("player", next)}
            options={playerOptions}
            placeholder="すべてのプレイヤー"
            searchPlaceholder="表示名 / ID で検索"
            emptyText="一致するプレイヤーがいません"
          />
        </FilterField>
        <FilterField id="filter-tag" label="タグ">
          <FilterCombobox
            id="filter-tag"
            value={search.tag}
            onChange={(next) => applyFacet("tag", next)}
            options={tagOptions}
            placeholder="すべてのタグ"
            searchPlaceholder="タグを検索"
            emptyText="一致するタグがありません"
          />
        </FilterField>
        <FilterField id="filter-from" label="From">
          <Input
            id="filter-from"
            type="datetime-local"
            value={draftFrom}
            onChange={(e) => setDraftFrom(e.target.value)}
          />
        </FilterField>
        <FilterField id="filter-to" label="To">
          <Input
            id="filter-to"
            type="datetime-local"
            value={draftTo}
            onChange={(e) => setDraftTo(e.target.value)}
          />
        </FilterField>
        <div className="flex items-center gap-2 pb-0.5">
          {/* 選択式のフィルタは選んだ時点で効くので、このボタンが要るのは期間だけ。 */}
          <Button type="submit" size="sm">
            期間を適用
          </Button>
          {hasActiveFilters ? (
            <Button type="button" size="sm" variant="ghost" onClick={clearFilters}>
              クリア
            </Button>
          ) : null}
        </div>
        {/* 色でまとめるビューへの導線。フィルタとは独立した画面なので条件は引き継がない。 */}
        <Link
          to="/groups"
          className="self-center rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          色でまとめる
        </Link>
        <p className="ml-auto self-center text-xs text-muted-foreground tabular-nums">
          {apiPhotos.length}
          {nextCursor ? "+" : ""} 枚
          {loadingMore ? " · 読み込み中…" : ""}
        </p>
      </form>

      {loadError ? (
        <p className="shrink-0 border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {loadError}
        </p>
      ) : null}

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {photos.length === 0 ? (
          <EmptyState
            title="表示できる写真がありません"
            description={
              hasActiveFilters
                ? "条件に一致する写真がありません。フィルタを見直してください。"
                : "デスクトップアプリから写真をアップロードすると、ここに表示されます。"
            }
            action={
              hasActiveFilters ? (
                <Button type="button" variant="outline" size="sm" onClick={clearFilters}>
                  フィルタをクリア
                </Button>
              ) : undefined
            }
          />
        ) : (
          <PhotoGrid
            className="min-h-0 flex-1 p-3"
            photos={photos}
            selectable={false}
            onInfo={openDetail}
            onPreview={openPreview}
            thumbnailSrcFor={(photo) => thumbById.get(photo.path)}
            blurhashFor={(photo) => blurhashById.get(photo.path)}
            onDelete={requestDelete}
            onNearEnd={nextCursor ? handleNearEnd : undefined}
          />
        )}
      </main>

      <PhotoDetailDialog
        photo={detailPhoto}
        open={Boolean(search.photo)}
        onOpenChange={closeDetail}
        tags={search.photo ? tagsFor(search.photo) : []}
        tagSuggestions={tagSuggestions}
        tagsPending={savingTagsFor !== null && savingTagsFor === search.photo}
        onTagsChange={
          search.photo ? (next) => void saveTags(search.photo as string, next) : undefined
        }
        onPreview={detailPhoto ? () => openPreview(detailPhoto) : undefined}
        onDelete={detailPhoto ? () => requestDelete(detailPhoto) : undefined}
        showWorldLinkCopy
      />

      {/* 拡大表示。画像を左上に寄せ、右と下に情報を出してその場でタグも編集できる。 */}
      <PhotoLightbox
        photo={previewPhoto}
        open={previewPhoto !== null}
        onOpenChange={(open) => {
          if (!open) setPreviewPhoto(null);
        }}
        imageSrc={previewPhoto ? urlById.get(previewPhoto.path) : undefined}
        onPrev={() => stepPreview(-1)}
        onNext={() => stepPreview(1)}
        onDelete={previewPhoto ? () => requestDelete(previewPhoto) : undefined}
        showWorldLinkCopy
        onRotate={
          previewPhoto ? (degrees) => void rotatePhoto(previewPhoto, degrees) : undefined
        }
        rotatePending={rotatingId !== null && rotatingId === previewPhoto?.path}
        showInfo
        tags={previewPhoto ? tagsFor(previewPhoto.path) : []}
        onTagsChange={
          previewPhoto ? (next) => void saveTags(previewPhoto.path, next) : undefined
        }
        tagSuggestions={tagSuggestions}
        tagsPending={savingTagsFor !== null && savingTagsFor === previewPhoto?.path}
      />

      {/* 削除の確認。元に戻せない操作なので、どの入り口（カード / 拡大表示 / 詳細）からでも
          必ずここを通す。拡大表示や詳細ダイアログは開いたまま重ねるので、
          やめたときは見ていた写真にそのまま戻れる。 */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          // 削除中に閉じられると結果の行き先が無くなるので、終わるまでは閉じさせない。
          if (!open && !deleting) setDeleteTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>この写真を削除しますか？</DialogTitle>
            <DialogDescription>
              サーバー上の画像とサムネイルを消します。元に戻せません。
            </DialogDescription>
          </DialogHeader>

          {/* どの写真を消そうとしているのかを取り違えないよう、サムネイルを添える。 */}
          {deleteTarget ? (
            <div className="flex items-center gap-3">
              <img
                src={thumbById.get(deleteTarget.path)}
                alt=""
                className="h-14 w-24 shrink-0 rounded-md border bg-muted object-cover"
              />
              <div className="min-w-0 text-sm">
                <p className="truncate">{deleteTarget.metadata.world.name}</p>
                <p className="truncate text-xs text-muted-foreground tabular-nums">
                  {new Date(deleteTarget.takenAt).toLocaleString()}
                </p>
              </div>
            </div>
          ) : null}

          {/* 失敗はダイアログの中に出す。閉じずに残しておけば、そのまま押し直せる。 */}
          {deleteError ? <p className="text-sm text-destructive">{deleteError}</p> : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={deleting}
            >
              キャンセル
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void confirmDelete()}
              disabled={deleting}
            >
              {deleting ? "削除中…" : "削除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {tagError ? (
        <p className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-md bg-destructive px-3 py-1.5 text-sm text-destructive-foreground shadow">
          {tagError}
        </p>
      ) : null}
      {rotateError ? (
        <p className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-md bg-destructive px-3 py-1.5 text-sm text-destructive-foreground shadow">
          {rotateError}
        </p>
      ) : null}
    </div>
  );
}

/** ラベル付きの小さなフィルタ入力枠。 */
function FilterField({
  id,
  label,
  children,
  className,
}: {
  id: string;
  label: string;
  children: ReactNode;
  /** 幅を変えたいときだけ渡す（既定は w-40）。 */
  className?: string;
}) {
  return (
    <div className={cn("flex w-40 min-w-0 flex-col gap-1", className)}>
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}
