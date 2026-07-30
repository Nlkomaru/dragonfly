import { useEffect, useMemo, useRef, useState } from "react";
import { decodeBlurhashToRgba, isValidBlurhash } from "@dragonfly/core";
import { ImageOff } from "lucide-react";

import { cn } from "../lib/utils";

/**
 * BlurHash を展開する canvas の一辺(px)。
 *
 * BlurHash が持っているのは数個の低周波成分だけなので、これより大きく展開しても
 * ぼけた絵が引き伸びるだけで情報は増えず、デコードのコスト（幅 * 高さ * 成分数）
 * だけが増える。実際の表示サイズへは CSS（size-full）で拡大させる。
 */
const PLACEHOLDER_SIZE = 32;

export interface BlurhashImageProps {
  /** 画像の URL。未取得のうちは undefined を渡すと、プレースホルダだけを出す。 */
  src?: string;
  /**
   * プレースホルダに使う BlurHash。
   * null / undefined / 不正な文字列のときはスケルトン表示にフォールバックする。
   */
  blurhash?: string | null;
  alt: string;
  /** 画像のドラッグを許すか。既定は false（グリッドの選択操作と干渉するため）。 */
  draggable?: boolean;
  /** 外枠に足すクラス。大きさは親要素が決める前提で、既定は size-full。 */
  className?: string;
  /** img 自体に足すクラス。既定は object-cover なので、contain にしたいときに使う。 */
  imgClassName?: string;
}

/**
 * 遅延読み込みする画像。読み込みが終わるまでは BlurHash のぼかしを敷いておく。
 *
 * 一覧では画面外の画像まで一斉に取りに行くと帯域を食い潰すので `loading="lazy"` にし、
 * その代わり「まだ何も無い四角」が並ばないよう、DB に持っている BlurHash を先に描く。
 * BlurHash が無い写真（デスクトップのローカル一覧など）では、これまで通り
 * スケルトン（animate-pulse + ImageOff）に落ちるので見た目は退化しない。
 */
export function BlurhashImage({
  src,
  blurhash,
  alt,
  draggable = false,
  className,
  imgClassName,
}: BlurhashImageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [loaded, setLoaded] = useState(false);
  // デコードに失敗したかどうか。失敗したときだけスケルトンへ落とす。
  // 「描けた」ではなく「失敗した」を持つのは、初期値 false のまま 1 フレーム目を
  // 描いてもスケルトンが一瞬映らないようにするため（仮想化スクロールでちらつく）。
  const [failed, setFailed] = useState(false);

  // 文字列の検証は DOM に触らないので描画中に済ませてよい。
  // ここで弾いておけば、壊れた値のときに canvas 自体をマウントせずに済む。
  const hasBlurhash = useMemo(
    () => typeof blurhash === "string" && blurhash.length > 0 && isValidBlurhash(blurhash),
    [blurhash],
  );

  // 別の写真に差し替わったら読み込み前の状態に戻す。前の画像が残って見えるのを防ぐ。
  useEffect(() => {
    setLoaded(false);
  }, [src]);

  // canvas / ImageData はブラウザにしか無い。apps/web は SSR されるので、
  // 描画中ではなく必ず effect の中（＝クライアント）でだけ触る。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !hasBlurhash || !blurhash) return;

    try {
      const rgba = decodeBlurhashToRgba(blurhash, PLACEHOLDER_SIZE, PLACEHOLDER_SIZE);
      const context = canvas.getContext("2d");
      if (!context) {
        setFailed(true);
        return;
      }
      // new ImageData(...) ではなく createImageData を使うのは、
      // ImageData というグローバルに直接触らずに済ませるため。
      const imageData = context.createImageData(PLACEHOLDER_SIZE, PLACEHOLDER_SIZE);
      imageData.data.set(rgba);
      context.putImageData(imageData, 0, 0);
      setFailed(false);
    } catch {
      // 検証を通っても decode が落ちることはありうる。一覧ごと落とさずスケルトンにする。
      setFailed(true);
    }
  }, [blurhash, hasBlurhash]);

  // キャッシュ済みの画像は React がハンドラを付ける前に load が済んでいることがあり、
  // onLoad が来ないままぼかしが残ってしまう。マウント後に complete を見て救う。
  useEffect(() => {
    const image = imgRef.current;
    if (image?.complete && image.naturalWidth > 0) setLoaded(true);
  }, [src]);

  return (
    <div className={cn("relative size-full overflow-hidden bg-muted", className)}>
      {/* BlurHash 層。ref を付け外しすると再描画の管理が要るので、
          有効なハッシュがある限りマウントしたままにして不透明度だけ切り替える。
          canvas のビットマップは 32x32 固定で、CSS 側が枠いっぱいに引き伸ばす。 */}
      {hasBlurhash ? (
        <canvas
          ref={canvasRef}
          width={PLACEHOLDER_SIZE}
          height={PLACEHOLDER_SIZE}
          aria-hidden
          className={cn(
            "absolute inset-0 size-full transition-opacity duration-200",
            loaded ? "opacity-0" : "opacity-100",
          )}
        />
      ) : null}

      {/* BlurHash が無い / デコードできなかったときの読み込み中表示。
          読み込みが終わったら外して、animate-pulse を回し続けないようにする。 */}
      {(!hasBlurhash || failed) && !loaded ? (
        <div className="absolute inset-0 flex animate-pulse items-center justify-center bg-muted">
          <ImageOff className="size-6 text-muted-foreground/50" aria-hidden />
        </div>
      ) : null}

      {src ? (
        <img
          ref={imgRef}
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          draggable={draggable}
          onLoad={() => setLoaded(true)}
          className={cn(
            "relative size-full object-cover transition-opacity duration-200",
            loaded ? "opacity-100" : "opacity-0",
            imgClassName,
          )}
        />
      ) : null}
    </div>
  );
}
