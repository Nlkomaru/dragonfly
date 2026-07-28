// Web ギャラリー（issue #6）。
// 初回ページは loader + createServerFn で SSR し、続きはクライアントで
// /api/v1/users/me/photos を credentials: "include" で取る。
// 画像 URL は署名付き相対パス（issue #10）をそのまま <img src> に渡す。

import type {
  ApiPhoto,
  ListFacetsResponse,
  ListPhotosResponse,
  ListTagsResponse,
  Photo,
  PutPhotoTagsResponse,
} from "@dragonfly/core";
import {
  Button,
  cn,
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
import { fetchPhotosPage } from "../../server/fetchPhotosPage";

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
        showInfo
        tags={previewPhoto ? tagsFor(previewPhoto.path) : []}
        onTagsChange={
          previewPhoto ? (next) => void saveTags(previewPhoto.path, next) : undefined
        }
        tagSuggestions={tagSuggestions}
        tagsPending={savingTagsFor !== null && savingTagsFor === previewPhoto?.path}
      />

      {tagError ? (
        <p className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-md bg-destructive px-3 py-1.5 text-sm text-destructive-foreground shadow">
          {tagError}
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
