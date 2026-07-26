// デスクトップアプリの設定。API キーだけは OS のキーチェーンに置くため、この型には含めない。

export interface AppSettings {
  /** スクリーンショットの保存先。空文字なら Rust 側で OS の Pictures/VRChat に解決する。 */
  screenshotDir: string;
  /** 送信先の API。ローカルの Worker に向けたいときのために可変にしてある。 */
  apiBaseUrl: string;
  /** AVIF の品質（0-100、大きいほど高画質）。 */
  avifQuality: number;
  /** 長辺の上限ピクセル。null なら原寸のまま送る。 */
  maxLongEdge: number | null;
}

export const DEFAULT_SETTINGS: AppSettings = {
  screenshotDir: "",
  apiBaseUrl: "https://dragonfly.vrc.nikomaru.dev",
  avifQuality: 55,
  maxLongEdge: null,
};
