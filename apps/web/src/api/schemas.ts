// API の入出力スキーマ。バリデーションと OpenAPI ドキュメントの両方をこの 1 か所から作る。
//
// 形は @dragonfly/core の型がすべて正。Rust のデスクトップクライアントが同じ型で喋るので、
// ここが食い違うと実行時にしか気付けない。それを避けるため、ファイル末尾で
// 「zod から推論した型が core の型に代入できるか」をコンパイル時に検査している。

import {
  BLURHASH_PUT_LIMIT,
  CHECK_HASH_LIMIT,
  PALETTE_PUT_LIMIT,
  PALETTE_SIZE,
} from "@dragonfly/core";
import type {
  ApiPhoto,
  CheckPhotosRequest,
  CheckPhotosResponse,
  ListFacetsResponse,
  ListPalettesResponse,
  ListPhotosResponse,
  ListTagsResponse,
  MeResponse,
  PutBlurhashesRequest,
  PutBlurhashesResponse,
  PutPalettesRequest,
  PutPalettesResponse,
  PutPhotoTagsRequest,
  PutPhotoTagsResponse,
  UploadPhotoMetadata,
  UploadPhotoResponse,
} from "@dragonfly/core";
import { z } from "zod";

/** 変換前 PNG の SHA-256（16 進小文字 64 文字）。 */
const sha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "must be a lowercase hex sha-256")
  .meta({ description: "変換前 PNG の SHA-256", example: "a".repeat(64) });

/**
 * BlurHash の文字列。4x3 成分なら 28 文字だが、成分数が変わっても弾かないよう幅を持たせる。
 * 上限を付けるのは、この値がそのまま D1 の 1 列に入るため（無制限だと行が際限なく膨らむ）。
 * 妥当性そのものは表示側の isValidBlurhash が見るので、ここでは長さだけを見る。
 */
const blurhashSchema = z
  .string()
  .min(1)
  .max(64)
  .meta({
    description: "読み込み前のプレースホルダに使う BlurHash",
    example: "LTFi4E2|sYo$zOR:jujJeqf7fQf7",
  });

export const WorldRefSchema = z.object({
  id: z.string().meta({ description: "VRChat のワールド ID", example: "wrld_00000000" }),
  name: z.string(),
  instanceId: z.string(),
});

export const PlayerRefSchema = z.object({
  id: z.string().meta({ description: "VRChat のユーザー ID", example: "usr_00000000" }),
  displayName: z.string(),
});

export const VrcxMetadataSchema = z.object({
  application: z.string(),
  version: z.number(),
  author: PlayerRefSchema,
  world: WorldRefSchema,
  players: z.array(PlayerRefSchema),
});

// ---------------------------------------------------------------------------
// リクエスト
// ---------------------------------------------------------------------------

/** POST /photos/check のボディ。 */
export const CheckPhotosRequestSchema = z.object({
  hashes: z
    .array(sha256Schema)
    .max(CHECK_HASH_LIMIT)
    .meta({ description: `送信済み判定したいハッシュ。最大 ${CHECK_HASH_LIMIT} 件` }),
});

/** multipart の `metadata` パート（JSON 文字列として送られてくる）。 */
export const UploadPhotoMetadataSchema = z.object({
  sourceSha256: sha256Schema,
  takenAt: z.number().int().meta({ description: "撮影日時（unix ミリ秒）" }),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  // ワールドと同席者が無い写真は検索できないため受け付けない。
  vrcx: VrcxMetadataSchema,
  tags: z.array(z.string()).optional(),
  // デスクトップが変換のついでに計算できたときだけ載る。無ければ後から Web 側が埋める。
  blurhash: blurhashSchema.optional(),
});

/** 1つのタグに許す最大文字数。`packages/ui` の TagEditor と同じ値。 */
export const TAG_MAX_LENGTH = 32;
/** 1枚に付けられるタグの上限。`packages/ui` の TagEditor と同じ値。 */
export const TAG_MAX_COUNT = 32;

/**
 * PUT /photos/:photoId/tags のボディ。
 * 前後の空白は落とす。空文字を許すと (owner_id, name) の一意制約に
 * 「名前の無いタグ」が居座ってしまうため、min(1) で弾く。
 */
export const PutPhotoTagsRequestSchema = z.object({
  tags: z
    .array(z.string().trim().min(1).max(TAG_MAX_LENGTH))
    .max(TAG_MAX_COUNT)
    // 同じ名前を 2 度送られても、写真に付くのは 1 つなので入口で畳む。
    .transform((values) => [...new Set(values)])
    .meta({ description: "この写真に付けるタグ。ここに無いタグは外れる" }),
});

export const PutPhotoTagsResponseSchema = z.object({
  tags: z.array(z.string()).meta({ description: "反映後のタグ" }),
});

/**
 * POST /photos/:photoId/rotate の multipart メタデータ。
 * 画像のピクセル処理はブラウザで行い、Worker は AVIF のストリームを保存する。
 */
export const RotatePhotoRequestSchema = z.object({
  degrees: z
    .union([z.literal(90), z.literal(180), z.literal(270)])
    .meta({ description: "時計回りの回転角（度）", example: 90 }),
  width: z.coerce.number().int().positive().meta({ description: "回転後の幅", example: 1080 }),
  height: z.coerce.number().int().positive().meta({ description: "回転後の高さ", example: 1920 }),
});

// ---------------------------------------------------------------------------
// カラーパレット
// ---------------------------------------------------------------------------

/**
 * 代表色 1 つ。hex は表示用、l/a/b は距離計算用で、同じ色の 2 つの表現。
 * zod v4 の z.number() は NaN も Infinity も弾くので、有限数の指定は要らない。
 */
export const PaletteSwatchSchema = z.object({
  hex: z
    .string()
    .regex(/^#[0-9a-f]{6}$/, "must be a lowercase #rrggbb")
    .meta({ description: "代表色（小文字の #rrggbb）", example: "#3a5f8a" }),
  ratio: z
    .number()
    .min(0)
    .max(1)
    .meta({ description: "この色が占める画素の割合。5 色の合計が 1" }),
  l: z.number().meta({ description: "OKLab の L" }),
  a: z.number().meta({ description: "OKLab の a" }),
  b: z.number().meta({ description: "OKLab の b" }),
});

/**
 * 写真 1 枚のパレット。
 * swatches の長さは抽出側が常に PALETTE_SIZE で揃えるが、
 * 版が上がって色数が変わりうるので上限だけを固定する。
 * 空配列だけは弾く。色を持たないパレットは距離が全写真とほぼ 0 になり、
 * どのグループにも混ざる 1 枚が生まれてしまうため。
 */
export const ApiPhotoPaletteSchema = z.object({
  // 長さの上限を付けるのは、この ID がそのまま inArray の束縛値として D1 へ渡るため。
  // 1 リクエストに PALETTE_PUT_LIMIT 件入るので、無制限だと 1 本の SQL が
  // 際限なく膨らむ。UUIDv7 は 36 文字なので 64 あれば足りる。
  photoId: z.string().min(1).max(64).meta({ description: "写真の ID (UUIDv7)" }),
  version: z
    .number()
    .int()
    .meta({ description: "抽出アルゴリズムの版。古ければクライアントが抽出し直す" }),
  swatches: z.array(PaletteSwatchSchema).min(1).max(PALETTE_SIZE),
  /**
   * 色ヒストグラム（base64）。距離の計算はこれで行う。
   * 版が古いパレットには無いので任意。長さの上限は「600 bin すべてに値が入り、
   * 1 bin 3 バイト」の最悪ケース (2400 文字) に余裕を持たせた値。
   */
  histogram: z
    .string()
    .max(4096)
    .optional()
    .meta({ description: "色ヒストグラムの base64。距離の計算に使う" }),
});

export const ListPalettesResponseSchema = z.object({
  palettes: z
    .array(ApiPhotoPaletteSchema)
    .meta({ description: "このユーザーの全パレット。未抽出の写真は含まれない" }),
});

/** PUT /palettes のボディ。同じ photoId を重ねて送られても、保存されるのは 1 行。 */
export const PutPalettesRequestSchema = z.object({
  palettes: z
    .array(ApiPhotoPaletteSchema)
    .max(PALETTE_PUT_LIMIT)
    .meta({ description: `保存するパレット。最大 ${PALETTE_PUT_LIMIT} 件` }),
});

export const PutPalettesResponseSchema = z.object({
  saved: z
    .number()
    .int()
    .meta({ description: "実際に保存できた件数。自分の写真でないものは含まれない" }),
});

// ---------------------------------------------------------------------------
// BlurHash
// ---------------------------------------------------------------------------

/**
 * 写真 1 枚分の BlurHash。
 * アップロード時に載らなかった写真を、Web クライアントが後から埋めるのに使う。
 */
export const ApiPhotoBlurhashSchema = z.object({
  // パレットと同じ理由で長さの上限を付ける。この ID がそのまま inArray の束縛値として
  // D1 へ渡るので、無制限だと 1 本の SQL が際限なく膨らむ。UUIDv7 は 36 文字。
  photoId: z.string().min(1).max(64).meta({ description: "写真の ID (UUIDv7)" }),
  blurhash: blurhashSchema,
});

/** PUT /blurhashes のボディ。同じ photoId を重ねて送られても、保存されるのは 1 行。 */
export const PutBlurhashesRequestSchema = z.object({
  blurhashes: z
    .array(ApiPhotoBlurhashSchema)
    .max(BLURHASH_PUT_LIMIT)
    .meta({ description: `保存する BlurHash。最大 ${BLURHASH_PUT_LIMIT} 件` }),
});

export const PutBlurhashesResponseSchema = z.object({
  saved: z
    .number()
    .int()
    .meta({ description: "実際に保存できた件数。自分の写真でないものは含まれない" }),
});

export const ListTagsResponseSchema = z.object({
  tags: z.array(z.string()).meta({ description: "このユーザーが使ったことのあるタグ名" }),
});

/** GET /facets のレスポンス。絞り込み UI の選択肢。 */
export const ListFacetsResponseSchema = z.object({
  worlds: z
    .array(
      z.object({
        id: z.string().meta({ description: "VRChat のワールド ID", example: "wrld_00000000" }),
        name: z.string().meta({ description: "最後に記録された表示名" }),
        count: z.number().int().meta({ description: "このワールドで撮った枚数" }),
      }),
    )
    .meta({ description: "写真の多い順" }),
  players: z
    .array(
      z.object({
        id: z.string().meta({ description: "VRChat のユーザー ID", example: "usr_00000000" }),
        displayName: z.string(),
        count: z.number().int().meta({ description: "この人が写っている / 撮った枚数" }),
      }),
    )
    .meta({ description: "写真の多い順" }),
});

/** GET /photos のクエリ。数値は文字列から変換し、変換できない値は 400 で弾く。 */
export const ListPhotosQuerySchema = z.object({
  world: z.string().optional().meta({ description: "ワールド ID で絞る" }),
  player: z
    .string()
    .optional()
    .meta({ description: "VRChat ユーザー ID で絞る（同席者、または撮影者として一致）" }),
  tag: z.string().optional().meta({ description: "タグ名で絞る" }),
  from: z.coerce.number().int().optional().meta({ description: "撮影日時の下限（unix ミリ秒）" }),
  to: z.coerce.number().int().optional().meta({ description: "撮影日時の上限（unix ミリ秒）" }),
  cursor: z.string().optional().meta({ description: "前ページの nextCursor をそのまま渡す" }),
});

/** すべてのユーザースコープのルートが持つパスパラメータ。 */
export const UserParamSchema = z.object({
  id: z.string().meta({
    description: "better-auth のユーザー ID、または呼び出し元を指す別名 `me`",
    example: "me",
  }),
});

export const UserPhotoParamSchema = UserParamSchema.extend({
  photoId: z.string().meta({ description: "写真の ID (UUIDv7)" }),
});

// ---------------------------------------------------------------------------
// レスポンス
// ---------------------------------------------------------------------------

export const CheckPhotosResponseSchema = z.object({
  uploaded: z.array(z.string()).meta({ description: "既にアップロード済みのハッシュだけ" }),
});

export const UploadPhotoResponseSchema = z.object({
  id: z.string(),
  deduplicated: z.boolean().meta({ description: "既存の写真と重複していたら true" }),
});

export const ApiPhotoSchema = z.object({
  id: z.string(),
  sourceSha256: z.string(),
  // 短い有効期限の HMAC 署名付き相対パス。ブラウザの <img src> からそのまま読める。
  url: z
    .string()
    .meta({ description: "画像本体の署名付き API パス（短命の exp/sig 付き）" }),
  thumbUrl: z
    .string()
    .meta({ description: "サムネイルの署名付き API パス（短命の exp/sig 付き）" }),
  takenAt: z.number(),
  width: z.number(),
  height: z.number(),
  byteSize: z.number(),
  world: WorldRefSchema.nullable(),
  players: z.array(PlayerRefSchema),
  tags: z.array(z.string()),
  blurhash: z
    .string()
    .nullable()
    .meta({ description: "読み込み前のプレースホルダ。未計算や古い写真では null" }),
});

export const ListPhotosResponseSchema = z.object({
  photos: z.array(ApiPhotoSchema),
  nextCursor: z.string().nullable().meta({ description: "次ページのカーソル。無ければ null" }),
});

export const MeResponseSchema = z.object({
  userId: z.string(),
  displayName: z.string(),
});

export const ErrorResponseSchema = z.object({
  error: z.string(),
});

// ---------------------------------------------------------------------------
// @dragonfly/core との整合性チェック（コンパイル時にだけ意味がある）
// ---------------------------------------------------------------------------

/** T が U に代入できなければ型エラーになる。 */
type Assignable<T extends U, U> = T;

type _CheckRequest = Assignable<z.infer<typeof CheckPhotosRequestSchema>, CheckPhotosRequest>;
type _CheckResponse = Assignable<z.infer<typeof CheckPhotosResponseSchema>, CheckPhotosResponse>;
type _UploadMetadata = Assignable<z.infer<typeof UploadPhotoMetadataSchema>, UploadPhotoMetadata>;
type _UploadResponse = Assignable<z.infer<typeof UploadPhotoResponseSchema>, UploadPhotoResponse>;
type _Photo = Assignable<z.infer<typeof ApiPhotoSchema>, ApiPhoto>;
type _ListResponse = Assignable<z.infer<typeof ListPhotosResponseSchema>, ListPhotosResponse>;
type _Me = Assignable<z.infer<typeof MeResponseSchema>, MeResponse>;
type _PutTagsRequest = Assignable<z.infer<typeof PutPhotoTagsRequestSchema>, PutPhotoTagsRequest>;
type _PutTagsResponse = Assignable<z.infer<typeof PutPhotoTagsResponseSchema>, PutPhotoTagsResponse>;
type _ListTags = Assignable<z.infer<typeof ListTagsResponseSchema>, ListTagsResponse>;
type _ListFacets = Assignable<z.infer<typeof ListFacetsResponseSchema>, ListFacetsResponse>;
type _ListPalettes = Assignable<z.infer<typeof ListPalettesResponseSchema>, ListPalettesResponse>;
type _PutPalettesRequest = Assignable<z.infer<typeof PutPalettesRequestSchema>, PutPalettesRequest>;
type _PutPalettesResponse = Assignable<
  z.infer<typeof PutPalettesResponseSchema>,
  PutPalettesResponse
>;
type _PutBlurhashesRequest = Assignable<
  z.infer<typeof PutBlurhashesRequestSchema>,
  PutBlurhashesRequest
>;
type _PutBlurhashesResponse = Assignable<
  z.infer<typeof PutBlurhashesResponseSchema>,
  PutBlurhashesResponse
>;
