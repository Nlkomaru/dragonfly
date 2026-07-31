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
  ApiPhotoBlurhash,
  PutBlurhashesRequest,
  PutBlurhashesResponse,
} from "./api";
export { CHECK_HASH_LIMIT, PALETTE_PUT_LIMIT, BLURHASH_PUT_LIMIT } from "./api";

export type { PaletteSwatch, PhotoPalette, DistanceMatrix, PaletteWeighting } from "./palette";
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
  groupByCount,
  nearestPhotos,
} from "./palette";

export type { PhotoHistogram, PhotoRef } from "./histogram";
export {
  HISTOGRAM_VERSION,
  HISTOGRAM_BINS,
  HISTOGRAM_SIZE,
  buildHistogram,
  encodeHistogram,
  decodeHistogram,
  histogramDistance,
  buildHistogramMatrixFlat,
  averageLinkageLabels,
  splitOversizedLabels,
  groupByTargetSize,
} from "./histogram";

export {
  BLURHASH_COMPONENTS_X,
  BLURHASH_COMPONENTS_Y,
  encodeBlurhash,
  decodeBlurhashToRgba,
  isValidBlurhash,
} from "./blurhash";

export type { AppSettings } from "./settings";
export { DEFAULT_SETTINGS } from "./settings";

export type { ZipEntry } from "./zip";
export { buildStoredZip, crc32 } from "./zip";
