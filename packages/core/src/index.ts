// ドメインの型とプラットフォーム非依存のロジックを置く。
// デスクトップ / Web の両方から参照されるため、Tauri や DOM の API に依存しないこと。
export type {
  WorldRef,
  PlayerRef,
  VrcxMetadata,
  Photo,
  ScanResult,
  MonthBucket,
} from "./photo";
export { buildMonthBuckets, parseVrchatFileName, toMonthKey } from "./photo";

export type {
  CheckPhotosRequest,
  CheckPhotosResponse,
  UploadPhotoMetadata,
  UploadPhotoResponse,
  UploadOutcome,
  UploadSummary,
  UploadProgress,
  ConvertProgress,
  ApiPhoto,
  ListPhotosResponse,
  PutPhotoTagsRequest,
  PutPhotoTagsResponse,
  ListTagsResponse,
  WorldFacet,
  PlayerFacet,
  ListFacetsResponse,
  ApiKeySummary,
  CreateApiKeyResponse,
  MeResponse,
  ApiPhotoPalette,
  ListPalettesResponse,
  PutPalettesRequest,
  PutPalettesResponse,
} from "./api";
export { CHECK_HASH_LIMIT, PALETTE_PUT_LIMIT } from "./api";

export type { PaletteSwatch, PhotoPalette, DistanceMatrix } from "./palette";
export {
  PALETTE_VERSION,
  PALETTE_SIZE,
  srgbToOklab,
  oklabToHex,
  extractPalette,
  paletteDistance,
  buildDistanceMatrix,
  buildDistanceMatrixFlat,
  reshapeDistanceMatrix,
  groupByThreshold,
  nearestPhotos,
} from "./palette";

export type { AppSettings } from "./settings";
export { DEFAULT_SETTINGS } from "./settings";
