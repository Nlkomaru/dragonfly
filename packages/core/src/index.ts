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
  ApiPhoto,
  ListPhotosResponse,
  ApiKeySummary,
  CreateApiKeyResponse,
  MeResponse,
} from "./api";
export { CHECK_HASH_LIMIT } from "./api";

export type { AppSettings } from "./settings";
export { DEFAULT_SETTINGS } from "./settings";
