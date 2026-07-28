// 色でまとめるビュー（/groups）。
//
// 写真の代表色パレットは D1 に貯めるが、AVIF のデコードはブラウザにしかできないため
// 「未抽出の写真だけ」をこの画面のマウント後に抽出してサーバへ返す、という流れになる。
// 距離行列は O(n^2) で重いので一度だけ作り、スライダーは union-find のしきい値だけを動かす。

import type {
  ApiPhoto,
  ApiPhotoPalette,
  DistanceMatrix,
  ListPalettesResponse,
  ListPhotosResponse,
  PhotoPalette,
  PutPalettesResponse,
} from "@dragonfly/core";
import {
  PALETTE_PUT_LIMIT,
  PALETTE_VERSION,
  groupByCount,
  groupByThreshold,
  nearestPhotos,
} from "@dragonfly/core";
import { Button, EmptyState, PaletteSwatches, cn } from "@dragonfly/ui";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildDistanceMatrixAsync } from "../../lib/buildDistanceMatrixAsync";
import { ZIP_MAX_PHOTOS, downloadPhotosZip } from "../../lib/downloadPhotosZip";
import { extractPhotoPalette, mapWithConcurrency } from "../../lib/extractPhotoPalette";

/** 集める写真の上限。距離行列が n^2 なので、これ以上は待ち時間が実用外になる。 */
const MAX_PHOTOS = 2000;
/** サムネイルのデコードの同時実行数。増やしても回線とデコーダの取り合いになるだけ。 */
const EXTRACT_CONCURRENCY = 4;

/** しきい値スライダーの範囲。paletteDistance は概ね 0〜1 強なので、実用域だけを切り出す。 */
const THRESHOLD_MIN = 0;
const THRESHOLD_MAX = 0.5;
const THRESHOLD_STEP = 0.005;
/** 既定のしきい値。体感でほどよく分かれる値を初期位置にする。 */
const THRESHOLD_DEFAULT = 0.12;

/** グループ数モードのスライダー範囲。2 未満は分ける意味が無く、50 超は一覧できない。 */
const COUNT_MIN = 2;
const COUNT_MAX = 50;
/** 既定のグループ数。 */
const COUNT_DEFAULT = 10;

/** 「この写真に似た写真」に出す件数。 */
const NEAREST_LIMIT = 24;

/** グループ分けの方式。threshold は色の近さで繋ぐ従来方式、count はグループ数を固定する方式。 */
export type GroupMode = "threshold" | "count";

/** URL 検索パラメータ。共有・リロードで同じグループ分けを再現する。 */
export type GroupsSearch = {
  /** グループ分けの方式。省略時は threshold（従来の色の近さ）。 */
  mode?: GroupMode;
  /** union-find のしきい値。小さいほど細かく分かれる。 */
  threshold?: number;
  /** mode === "count" のときのグループ数。 */
  count?: number;
  /** 「似た写真」の基準にしている写真 ID。 */
  photo?: string;
};

/** 画面の進行状態。取得 → 抽出 → 保存 → 行列作成 → 表示の順に進む。 */
type Phase = "loading" | "extracting" | "saving" | "grouping" | "ready" | "error";

/** しきい値をスライダーの範囲に収める。整数化してはいけないので trunc は使わない。 */
function clampThreshold(value: number): number {
  if (!Number.isFinite(value)) return THRESHOLD_DEFAULT;
  return Math.min(THRESHOLD_MAX, Math.max(THRESHOLD_MIN, value));
}

/** グループ数をスライダーの範囲に収める。こちらは個数なので整数に丸める。 */
function clampCount(value: number): number {
  if (!Number.isFinite(value)) return COUNT_DEFAULT;
  return Math.min(COUNT_MAX, Math.max(COUNT_MIN, Math.trunc(value)));
}

/** 配列を size 件ずつに割る。PUT の上限（PALETTE_PUT_LIMIT）に合わせるのに使う。 */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

export const Route = createFileRoute("/_authed/groups")({
  validateSearch: (raw: Record<string, unknown>): GroupsSearch => {
    const asString = (value: unknown): string | undefined =>
      typeof value === "string" && value.length > 0 ? value : undefined;
    // threshold は小数なので、ギャラリー側の整数パーサ（Math.trunc）は流用できない。
    const asThreshold = (value: unknown): number | undefined => {
      if (typeof value === "number") return Number.isFinite(value) ? clampThreshold(value) : undefined;
      if (typeof value === "string" && value.length > 0) {
        const n = Number(value);
        if (Number.isFinite(n)) return clampThreshold(n);
      }
      return undefined;
    };
    // count は整数なので threshold とは別のパーサにする（clamp の丸め方が違う）。
    const asCount = (value: unknown): number | undefined => {
      if (typeof value === "number") return Number.isFinite(value) ? clampCount(value) : undefined;
      if (typeof value === "string" && value.length > 0) {
        const n = Number(value);
        if (Number.isFinite(n)) return clampCount(n);
      }
      return undefined;
    };
    return {
      // 知らない値は既定（threshold 方式）に落とす。URL を手で書き換えられても壊れないように。
      mode: raw.mode === "count" ? "count" : undefined,
      threshold: asThreshold(raw.threshold),
      count: asCount(raw.count),
      photo: asString(raw.photo),
    };
  },
  component: GroupsPage,
});

function GroupsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const [phase, setPhase] = useState<Phase>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // 集めた写真。パレットの並び順もこの配列に合わせる（行列の添字が配列位置そのものなので）。
  const [apiPhotos, setApiPhotos] = useState<ApiPhoto[]>([]);
  // 上限で打ち切ったか。件数が実際と違って見えるので UI に出す。
  const [truncated, setTruncated] = useState(false);
  // 抽出の進捗（done / total）。抽出が要らなければ total は 0。
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  // 抽出に失敗して読み飛ばした枚数。1 枚の失敗で全体を止めないため、件数だけ伝える。
  const [skipped, setSkipped] = useState(0);
  // 保存に失敗したパレットの枚数。表示は続けられるが、次回また解析することになるので伝える。
  const [unsaved, setUnsaved] = useState(0);
  // 表示に使うパレット。行列を作り直したくないので、パイプラインの最後に一度だけ入れる。
  const [palettes, setPalettes] = useState<PhotoPalette[]>([]);
  // Worker が作った距離行列。Float64Array の行ビューなので、読み取りは number[][] と同じ。
  const [matrix, setMatrix] = useState<DistanceMatrix | null>(null);

  // グループ分けの方式。URL に無ければ従来の「色の近さ」方式。
  const mode: GroupMode = search.mode ?? "threshold";

  // スライダーは掴んでいる間ずっと動くので、離すまでは手元の値だけ動かす。
  // URL に毎フレーム書くと履歴が溢れ、groupByThreshold も走りっぱなしになる。
  const committedThreshold = search.threshold ?? THRESHOLD_DEFAULT;
  const [draftThreshold, setDraftThreshold] = useState(committedThreshold);

  // グループ数のスライダーも同じ理屈で、離すまでは手元の値だけ動かす。
  const committedCount = search.count ?? COUNT_DEFAULT;
  const [draftCount, setDraftCount] = useState(committedCount);

  // 戻る操作や共有 URL 直開きでも、つまみの位置を URL に揃える。
  useEffect(() => {
    setDraftThreshold(committedThreshold);
  }, [committedThreshold]);
  useEffect(() => {
    setDraftCount(committedCount);
  }, [committedCount]);

  // 再生成ボタンを押すたびに増える。これを deps にして、パイプラインを頭から回し直す。
  const [runId, setRunId] = useState(0);
  // その回で「保存済みを無視して全部抽出し直す」かどうか。
  // state にすると再生成のたびに再描画が 1 回増えるだけなので、ref で持つ。
  const forceRef = useRef(false);
  // React の二重実行やしきい値変更で写真を取り直さないよう、着手した runId を覚えておく。
  const startedRunRef = useRef(-1);

  useEffect(() => {
    if (startedRunRef.current === runId) return;
    startedRunRef.current = runId;

    let cancelled = false;
    // 読み取りは 1 回だけ。以降この回の判断は force で固定し、ref はすぐ倒しておく。
    const force = forceRef.current;
    forceRef.current = false;

    void (async () => {
      try {
        // 再生成では前回の結果が残っていると古い表示が混ざるので、まず全部戻す。
        setErrorMessage(null);
        setSkipped(0);
        setUnsaved(0);
        setProgress({ done: 0, total: 0 });
        setMatrix(null);
        setPalettes([]);
        setPhase("loading");

        // 1) 写真を cursor で辿って集める。上限に当たったら打ち切る。
        const collected: ApiPhoto[] = [];
        let cursor: string | null = null;
        for (;;) {
          const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
          const res = await fetch(`/api/v1/users/me/photos${qs}`, { credentials: "include" });
          if (!res.ok) throw new Error(`写真の一覧を取得できませんでした (${res.status})`);
          const body = (await res.json()) as ListPhotosResponse;
          if (cancelled) return;
          collected.push(...body.photos);
          cursor = body.nextCursor;
          if (!cursor) break;
          if (collected.length >= MAX_PHOTOS) break;
        }
        const photos = collected.slice(0, MAX_PHOTOS);
        if (cancelled) return;
        // 打ち切りの判定は「捨てた写真があるか」で決める。最後のページで上限を超えた場合
        // （cursor が無いのに slice で溢れる）を、ループ内の break だけでは拾えないため。
        setTruncated(collected.length > MAX_PHOTOS || cursor !== null);
        setApiPhotos(photos);

        // 2) 保存済みのパレットを引く。全件返ってくるので、集めた写真とだけ突き合わせる。
        const paletteRes = await fetch("/api/v1/users/me/palettes", { credentials: "include" });
        if (!paletteRes.ok) throw new Error(`パレットを取得できませんでした (${paletteRes.status})`);
        const paletteBody = (await paletteRes.json()) as ListPalettesResponse;
        if (cancelled) return;

        const stored = new Map<string, ApiPhotoPalette>();
        for (const palette of paletteBody.palettes) stored.set(palette.photoId, palette);

        // 3) 未抽出、または抽出アルゴリズムが古い写真だけを抽出し直す。
        //    「新しい版」を降格させないよう、比較は < で行う。
        //    再生成のときは保存済みの内容を問わず全部やり直す。
        const pending = force
          ? photos
          : photos.filter((photo) => {
              const palette = stored.get(photo.id);
              return !palette || palette.version < PALETTE_VERSION;
            });

        if (pending.length > 0) {
          setPhase("extracting");
          setProgress({ done: 0, total: pending.length });

          const results = await mapWithConcurrency(
            pending,
            EXTRACT_CONCURRENCY,
            async (photo): Promise<ApiPhotoPalette> => {
              // 画面を離れたら残りの抽出は打ち切る。ここで止めないと、アンマウント後も
              // 最大 MAX_PHOTOS 枚のサムネイル取得とデコードが走り続けてしまう。
              // ここで投げた分は下の cancelled チェックで捨てられるので skipped には出ない。
              if (cancelled) throw new Error("cancelled");
              const swatches = await extractPhotoPalette(photo.thumbUrl, photo.id);
              // 完了のたびに進捗を進める。失敗分も finally 相当で数えたいので、
              // rejected のときは下のループで別途足す。
              if (!cancelled) setProgress((prev) => ({ ...prev, done: prev.done + 1 }));
              return { photoId: photo.id, version: PALETTE_VERSION, swatches };
            },
          );
          if (cancelled) return;

          const extracted: ApiPhotoPalette[] = [];
          let failed = 0;
          for (const result of results) {
            if (result.status === "fulfilled") {
              extracted.push(result.value);
              stored.set(result.value.photoId, result.value);
            } else {
              failed += 1;
            }
          }
          setSkipped(failed);
          // 失敗分も「処理は終わった」ので進捗を埋めておく（進捗が止まって見えるのを防ぐ）。
          setProgress({ done: pending.length, total: pending.length });

          // 4) PALETTE_PUT_LIMIT 件ずつ保存する。上限超過は 400 になるので必ず割る。
          if (extracted.length > 0) {
            setPhase("saving");
            let unsaved = 0;
            for (const part of chunk(extracted, PALETTE_PUT_LIMIT)) {
              try {
                const putRes = await fetch("/api/v1/users/me/palettes", {
                  method: "PUT",
                  credentials: "include",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ palettes: part }),
                });
                if (cancelled) return;
                if (!putRes.ok) throw new Error(`HTTP ${putRes.status}`);
                // 他人の写真や消えた写真は黙って捨てられる仕様なので、saved < 件数は異常ではない。
                (await putRes.json()) as PutPalettesResponse;
              } catch {
                // 保存に失敗しても手元には抽出済みのパレットがあるので、表示までは進める。
                // 次に開いたときに未保存の分だけ抽出し直せばよい。
                unsaved += part.length;
              }
            }
            if (!cancelled) setUnsaved(unsaved);
          }
        }

        // 5) 写真の並び順のまま、パレットが揃っているものだけを確定する。
        //    ここで一度だけ state に入れることで、距離行列の作り直しも一度で済む。
        //    版が違うパレットは抽出条件が違うので距離を比べられない。抽出に失敗した写真
        //    （古い版のパレットが stored に残ったまま）や、新しい版で書かれた写真（降格
        //    させないためあえて再抽出しない）を混ぜないよう、版が一致するものだけを使う。
        const ready: PhotoPalette[] = [];
        for (const photo of photos) {
          const palette = stored.get(photo.id);
          if (palette && palette.version === PALETTE_VERSION) ready.push(palette);
        }
        if (cancelled) return;
        setPalettes(ready);
        // 表示の手前にもう 1 段ある。距離行列は Worker で作るので、そちらの完了を待つ。
        setPhase("grouping");
      } catch (error) {
        if (cancelled) return;
        setErrorMessage(error instanceof Error ? error.message : "グループ分けを準備できませんでした");
        setPhase("error");
      }
    })();

    return () => {
      cancelled = true;
      // 中断したら着手済みの印も戻す。こうしておかないと、同じインスタンスで effect が
      // 貼り直されたとき（React の開発時の二重実行）に、中断済みの 1 回目だけが残って
      // 永久に「読み込み中」で止まってしまう。
      startedRunRef.current = -1;
    };
  }, [runId]);

  /** 保存済みのパレットを無視して、全部の写真を抽出し直す。 */
  const regenerate = useCallback(() => {
    forceRef.current = true;
    setRunId((prev) => prev + 1);
  }, []);

  const photoById = useMemo(() => {
    const map = new Map<string, ApiPhoto>();
    for (const photo of apiPhotos) map.set(photo.id, photo);
    return map;
  }, [apiPhotos]);

  const paletteById = useMemo(() => {
    const map = new Map<string, PhotoPalette>();
    for (const palette of palettes) map.set(palette.photoId, palette);
    return map;
  }, [palettes]);

  // 距離行列の構築は Worker に投げる。パレットが確定した直後（phase === "grouping"）に
  // 一度だけ走らせ、threshold は deps に入れない（入れるとスライダーを動かすたびに作り直しになる）。
  useEffect(() => {
    if (phase !== "grouping") return;

    // 写真が 1 枚も無ければ行列も要らない。Worker を起こさずそのまま表示へ進む。
    if (palettes.length === 0) {
      setMatrix(null);
      setPhase("ready");
      return;
    }

    const controller = new AbortController();
    void (async () => {
      try {
        const built = await buildDistanceMatrixAsync(palettes, controller.signal);
        if (controller.signal.aborted) return;
        setMatrix(built);
        setPhase("ready");
      } catch (error) {
        // 画面を離れたことによる中断は失敗ではないので、エラー表示に落とさない。
        if (controller.signal.aborted) return;
        setErrorMessage(error instanceof Error ? error.message : "グループ分けを計算できませんでした");
        setPhase("error");
      }
    })();

    // 画面を離れたら計算を捨てる。Worker も terminate されるので CPU を掴んだままにならない。
    return () => controller.abort();
  }, [phase, palettes]);

  // しきい値・グループ数・方式を変えたときはここだけが走る（距離計算はやり直さない）。
  const groups = useMemo(() => {
    if (!matrix) return [];
    return mode === "count"
      ? groupByCount(palettes, matrix, committedCount)
      : groupByThreshold(palettes, matrix, committedThreshold);
  }, [matrix, palettes, mode, committedThreshold, committedCount]);

  // 2 枚以上のグループと、1 枚だけの写真を分ける。後者はまとめて末尾に置く。
  // グループ数固定モードでは「頼んだ数のグループを見たい」のが目的なので、
  // 1 枚だけのグループもそのまま 1 つのグループとして見せる。
  const { multiGroups, loners } = useMemo(() => {
    if (mode === "count") return { multiGroups: groups, loners: [] };
    const multi: string[][] = [];
    const single: string[] = [];
    for (const group of groups) {
      if (group.length >= 2) multi.push(group);
      else single.push(...group);
    }
    return { multiGroups: multi, loners: single };
  }, [groups, mode]);

  // 選択中の写真に似た写真（距離の昇順）。行列は同じものを使うので追加の計算は軽い。
  const similar = useMemo(() => {
    if (!matrix || !search.photo) return [];
    return nearestPhotos(palettes, matrix, search.photo, NEAREST_LIMIT);
  }, [matrix, palettes, search.photo]);

  // 「似た写真」タイルの下に出す距離のラベル。基準の写真は載っていない（似た写真だけ）。
  const distanceById = useMemo(
    () => new Map(similar.map((n) => [n.photoId, n.distance])),
    [similar],
  );
  const similarIds = useMemo(() => similar.map((n) => n.photoId), [similar]);

  /** 写真をクリックしたとき。同じ写真をもう一度押したら選択を外す。 */
  const toggleSelected = useCallback(
    (photoId: string) => {
      void navigate({
        search: (prev) => ({ ...prev, photo: prev.photo === photoId ? undefined : photoId }),
        replace: true,
      });
    },
    [navigate],
  );

  /** つまみを離した時点でしきい値を URL に反映する。 */
  const commitThreshold = useCallback(() => {
    void navigate({
      search: (prev) => ({ ...prev, threshold: draftThreshold }),
      replace: true,
    });
  }, [navigate, draftThreshold]);

  /** つまみを離した時点でグループ数を URL に反映する。 */
  const commitCount = useCallback(() => {
    void navigate({
      search: (prev) => ({ ...prev, count: draftCount }),
      replace: true,
    });
  }, [navigate, draftCount]);

  /** 方式を切り替える。既定（threshold）のときは URL を汚さないよう undefined にする。 */
  const switchMode = useCallback(
    (next: GroupMode) => {
      void navigate({
        search: (prev) => ({ ...prev, mode: next === "threshold" ? undefined : next }),
        replace: true,
      });
    },
    [navigate],
  );

  const selectedPhoto = search.photo ? photoById.get(search.photo) : undefined;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {/* 操作バー。ギャラリーのフィルタバーと同じ骨格（border-b + px-4 py-3）に揃える。 */}
      <div className="flex shrink-0 flex-wrap items-center gap-4 border-b px-4 py-3">
        <Link
          to="/"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          ギャラリーへ戻る
        </Link>
        {/* 方式の切り替え。packages/ui にセグメントコントロールが無いので Button を並べる。 */}
        <div className="flex shrink-0 items-center gap-0.5 rounded-md border p-0.5">
          <Button
            type="button"
            size="sm"
            variant={mode === "threshold" ? "secondary" : "ghost"}
            aria-pressed={mode === "threshold"}
            onClick={() => switchMode("threshold")}
            title="色の近いものを繋いでまとめます。グループ数はしきい値しだいで変わります"
          >
            色の近さ
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mode === "count" ? "secondary" : "ghost"}
            aria-pressed={mode === "count"}
            onClick={() => switchMode("count")}
            title="指定した数のグループに写真を振り分けます"
          >
            グループ数固定
          </Button>
        </div>

        {mode === "threshold" ? (
          <label className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            色の近さ
            {/* packages/ui にスライダーが無いので素の input[type=range] を使う。 */}
            <input
              type="range"
              min={THRESHOLD_MIN}
              max={THRESHOLD_MAX}
              step={THRESHOLD_STEP}
              value={draftThreshold}
              onChange={(e) => setDraftThreshold(Number(e.target.value))}
              // ドラッグ終了とキー操作の両方で確定する（キーボードでも動かせるように）。
              onPointerUp={commitThreshold}
              onKeyUp={commitThreshold}
              className="w-48 accent-primary"
              disabled={phase !== "ready"}
            />
            <span className="tabular-nums">{draftThreshold.toFixed(3)}</span>
          </label>
        ) : (
          <label className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            グループ数
            <input
              type="range"
              min={COUNT_MIN}
              max={COUNT_MAX}
              step={1}
              value={draftCount}
              onChange={(e) => setDraftCount(Number(e.target.value))}
              onPointerUp={commitCount}
              onKeyUp={commitCount}
              className="w-48 accent-primary"
              disabled={phase !== "ready"}
            />
            <span className="tabular-nums">{draftCount}</span>
          </label>
        )}

        {/* 抽出アルゴリズムを変えたときや、結果に納得がいかないときの手動やり直し。
            保存済みのパレットを無視して全部取り直すので、枚数ぶんの時間がかかる。 */}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={regenerate}
          disabled={phase !== "ready" && phase !== "error"}
          title="保存済みのパレットを捨てて、すべての写真から代表色を取り直します"
        >
          再生成
        </Button>

        {phase === "ready" ? (
          <p className="text-xs text-muted-foreground tabular-nums">
            {multiGroups.length} グループ · {palettes.length}
            {truncated ? "+" : ""} 枚
            {loners.length > 0 ? ` · グループ無し ${loners.length} 枚` : ""}
          </p>
        ) : null}

        <p className="ml-auto text-xs text-muted-foreground tabular-nums">
          {phase === "loading" ? "写真を読み込み中…" : null}
          {phase === "extracting" ? `色を解析中… ${progress.done}/${progress.total} 枚` : null}
          {phase === "saving" ? "解析結果を保存中…" : null}
          {phase === "grouping" ? `色の近さを計算中… ${palettes.length} 枚` : null}
          {phase === "ready" && skipped > 0 ? `${skipped} 枚は解析できずスキップしました` : null}
          {phase === "ready" && unsaved > 0
            ? `${skipped > 0 ? " · " : ""}${unsaved} 枚は保存できませんでした（次回また解析します）`
            : null}
        </p>
      </div>

      {truncated ? (
        <p className="shrink-0 border-b bg-muted/50 px-4 py-2 text-xs text-muted-foreground">
          写真が多いため、新しい {MAX_PHOTOS} 枚だけをグループ分けの対象にしています。
        </p>
      ) : null}

      {errorMessage ? (
        <p className="shrink-0 border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {errorMessage}
        </p>
      ) : null}

      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {phase !== "ready" && phase !== "error" ? (
          <EmptyState
            title="色を解析しています"
            description={
              phase === "extracting"
                ? `サムネイルから代表色を取り出しています（${progress.done}/${progress.total} 枚）。`
                : phase === "grouping"
                  ? `${palettes.length} 枚ぶんの色の近さを計算しています。`
                  : "写真とパレットを読み込んでいます。"
            }
          />
        ) : palettes.length === 0 ? (
          <EmptyState
            title="グループ分けできる写真がありません"
            description="デスクトップアプリから写真をアップロードすると、色の近い写真がここにまとまります。"
          />
        ) : (
          <div className="flex flex-col gap-8 p-4">
            {/* 似た写真のセクションは、比べやすいように必ず先頭に置く。 */}
            {selectedPhoto ? (
              <section className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <h2 className="text-sm font-medium">この写真に似た写真</h2>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {similarIds.length} 枚
                  </span>
                  <ZipButton
                    photos={[selectedPhoto.id, ...similarIds]
                      .map((id) => photoById.get(id))
                      .filter((photo): photo is ApiPhoto => photo !== undefined)}
                    fileName="dragonfly-similar.zip"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => toggleSelected(selectedPhoto.id)}
                  >
                    閉じる
                  </Button>
                </div>
                {/* similarIds は nearestPhotos が返した距離の昇順そのまま。基準の写真だけ先頭に置く。 */}
                <PhotoTiles
                  photoIds={[selectedPhoto.id, ...similarIds]}
                  photoById={photoById}
                  paletteById={paletteById}
                  selectedId={search.photo}
                  onSelect={toggleSelected}
                  distanceById={distanceById}
                />
              </section>
            ) : null}

            {multiGroups.map((group, index) => (
              <GroupSection
                key={group[0]}
                index={index}
                // 固定数モードは「何番目のグループか」が見出しとして分かりやすい。
                title={mode === "count" ? `グループ ${index + 1}` : "色の近い写真"}
                photoIds={group}
                photoById={photoById}
                paletteById={paletteById}
                selectedId={search.photo}
                onSelect={toggleSelected}
              />
            ))}

            {loners.length > 0 ? (
              <section className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <h2 className="text-sm font-medium text-muted-foreground">グループ無し</h2>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {loners.length} 枚
                  </span>
                </div>
                <PhotoTiles
                  photoIds={loners}
                  photoById={photoById}
                  paletteById={paletteById}
                  selectedId={search.photo}
                  onSelect={toggleSelected}
                />
              </section>
            ) : null}
          </div>
        )}
      </main>
    </div>
  );
}

/** 1 グループ分の見出しと写真。 */
function GroupSection({
  index,
  title,
  photoIds,
  photoById,
  paletteById,
  selectedId,
  onSelect,
}: {
  /** 画面上の何番目のグループか。ZIP のファイル名に使う。 */
  index: number;
  /** セクションの見出し。方式によって呼び分ける（色の近い写真 / グループ N）。 */
  title: string;
  photoIds: string[];
  photoById: Map<string, ApiPhoto>;
  paletteById: Map<string, PhotoPalette>;
  selectedId?: string;
  onSelect: (photoId: string) => void;
}) {
  // 代表色の帯はグループ単位では出さない。写真 1 枚ずつの下に出すので、
  // 見出しにも並べると同じ帯が二重に見えるだけになる。
  const photos = photoIds
    .map((photoId) => photoById.get(photoId))
    .filter((photo): photo is ApiPhoto => photo !== undefined);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-medium">{title}</h2>
        <span className="text-xs text-muted-foreground tabular-nums">{photoIds.length} 枚</span>
        <ZipButton
          photos={photos}
          fileName={`dragonfly-group-${String(index + 1).padStart(2, "0")}.zip`}
        />
      </div>
      <PhotoTiles
        photoIds={photoIds}
        photoById={photoById}
        paletteById={paletteById}
        selectedId={selectedId}
        onSelect={onSelect}
      />
    </section>
  );
}

/**
 * グループの写真を ZIP でまとめて保存するボタン。
 *
 * 落とすのはサムネイルではなく画像の本体なので、枚数ぶんの取得に時間がかかる。
 * 進捗はボタンのラベルに出し、押している間は多重起動できないようにする。
 */
function ZipButton({ photos, fileName }: { photos: ApiPhoto[]; fileName: string }) {
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tooMany = photos.length > ZIP_MAX_PHOTOS;

  const handleClick = useCallback(() => {
    setError(null);
    setProgress({ done: 0, total: photos.length });
    void (async () => {
      try {
        const { skipped } = await downloadPhotosZip(photos, fileName, (done, total) =>
          setProgress({ done, total }),
        );
        // 取れなかった写真があっても保存自体は成功しているので、件数だけ添える。
        if (skipped > 0) setError(`${skipped} 枚は取得できず、除いて保存しました`);
      } catch (e) {
        setError(e instanceof Error ? e.message : "ZIP を作成できませんでした");
      } finally {
        setProgress(null);
      }
    })();
  }, [photos, fileName]);

  return (
    <span className="flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleClick}
        disabled={progress !== null || tooMany}
        title={
          tooMany
            ? `一度に保存できるのは ${ZIP_MAX_PHOTOS} 枚までです`
            : "このグループの写真を、サムネイルではなく元の画像で ZIP に保存します"
        }
      >
        {progress ? `保存中… ${progress.done}/${progress.total}` : "ZIP で保存"}
      </Button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </span>
  );
}

/**
 * 写真 ID の並びをサムネイルのグリッドで並べる。押すと「似た写真」の基準になる。
 * 並び順は呼び出し側が決めたものをそのまま使う（似た写真のセクションでは距離の昇順）。
 */
function PhotoTiles({
  photoIds,
  photoById,
  paletteById,
  selectedId,
  onSelect,
  distanceById,
}: {
  photoIds: string[];
  photoById: Map<string, ApiPhoto>;
  paletteById: Map<string, PhotoPalette>;
  selectedId?: string;
  onSelect: (photoId: string) => void;
  /**
   * 基準の写真からの距離。渡された場合だけタイルの下に数値を出す（似た写真のセクション用）。
   * 載っていない写真（基準そのもの）には「基準」と表示する。
   */
  distanceById?: Map<string, number>;
}) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3">
      {photoIds.map((photoId) => {
        const photo = photoById.get(photoId);
        // パレットだけ残って写真が消えている、といった食い違いは黙って飛ばす。
        if (!photo) return null;
        const palette = paletteById.get(photoId);
        return (
          <button
            key={photoId}
            type="button"
            onClick={() => onSelect(photoId)}
            // 中身が alt 空の装飾画像なので、ボタン自体に名前を持たせる。
            aria-label={
              selectedId === photoId ? "似た写真の表示をやめる" : "この写真に似た写真を見る"
            }
            aria-pressed={selectedId === photoId}
            className="group flex flex-col items-center gap-1.5"
          >
            <span
              className={cn(
                "block aspect-video w-full overflow-hidden rounded-md border bg-muted transition-colors group-hover:border-ring",
                selectedId === photoId && "border-primary ring-2 ring-primary",
              )}
            >
              <img
                src={photo.thumbUrl}
                alt=""
                loading="lazy"
                decoding="async"
                className="size-full object-cover"
              />
            </span>
            {/* その写真自身の代表色。なぜ同じグループに入ったのかが目で分かるようにする。 */}
            {palette ? <PaletteSwatches className="w-4/5" swatches={palette.swatches} /> : null}
            {/* 基準からの距離。しきい値スライダーと同じ尺度なので、値の調整の目安にもなる。 */}
            {distanceById ? (
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {distanceById.has(photoId)
                  ? `距離 ${distanceById.get(photoId)?.toFixed(3)}`
                  : "基準"}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
