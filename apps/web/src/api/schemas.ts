// API の入出力スキーマ。バリデーションと OpenAPI ドキュメントの両方をこの 1 か所から作る。
//
// 形は @dragonfly/core の型がすべて正。Rust のデスクトップクライアントが同じ型で喋るので、
// ここが食い違うと実行時にしか気付けない。それを避けるため、ファイル末尾で
// 「zod から推論した型が core の型に代入できるか」をコンパイル時に検査している。

import { CHECK_HASH_LIMIT } from "@dragonfly/core";
import type {
  ApiPhoto,
  CheckPhotosRequest,
  CheckPhotosResponse,
  ListPhotosResponse,
  MeResponse,
  UploadPhotoMetadata,
  UploadPhotoResponse,
} from "@dragonfly/core";
import { z } from "zod";

/** 変換前 PNG の SHA-256（16 進小文字 64 文字）。 */
const sha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "must be a lowercase hex sha-256")
  .meta({ description: "変換前 PNG の SHA-256", example: "a".repeat(64) });

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
});

/** GET /photos のクエリ。数値は文字列から変換し、変換できない値は 400 で弾く。 */
export const ListPhotosQuerySchema = z.object({
  world: z.string().optional().meta({ description: "ワールド ID で絞る" }),
  player: z.string().optional().meta({ description: "同席していた VRChat ユーザー ID で絞る" }),
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
