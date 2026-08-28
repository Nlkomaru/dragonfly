// API の写真型を、共有 UI（PhotoCard / PhotoGrid）が受け取るデスクトップ向け Photo に寄せる。
// Web ではローカルパスが無いので path/key に API の id を使い、選択や仮想化のキーにしている。

import type { ApiPhoto, Photo, WorldRef } from "@dragonfly/core";
import { toMonthKey } from "@dragonfly/core";

/** ワールド情報が欠ける写真向けのプレースホルダ。 */
const UNKNOWN_WORLD: WorldRef = {
  id: "",
  name: "不明なワールド",
  instanceId: "",
};

/**
 * ApiPhoto を共有 UI 用の Photo に変換する。
 * - path / key = api.id（Web 上の一意キー）
 * - uploaded は常に true（サーバー上の写真なので）
 * - world が null なら「不明なワールド」を入れる
 */
export function apiPhotoToPhoto(api: ApiPhoto): Photo {
  const world = api.world
    ? {
        id: api.world.id,
        // 名前だけ空のケースでも UI が空見出しにならないようにする。
        name: api.world.name || UNKNOWN_WORLD.name,
        instanceId: api.world.instanceId,
      }
    : UNKNOWN_WORLD;

  return {
    path: api.id,
    // ローカルのファイル名は無いので、一覧や詳細の補助表示用に id ベースの名前を合成する。
    fileName: `${api.id}.avif`,
    takenAt: api.takenAt,
    month: toMonthKey(api.takenAt),
    width: api.width,
    height: api.height,
    byteSize: api.byteSize,
    metadata: {
      application: "dragonfly",
      version: 1,
      author: api.author ?? { id: "", displayName: "" },
      world,
      players: api.players,
    },
    sha256: api.sourceSha256,
    uploaded: true,
  };
}
