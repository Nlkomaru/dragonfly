#!/usr/bin/env bash
#
# ドラフトリリースに添付済みのアセットから updater の latest.json を組み立て、
# 同じリリースに1つだけ添付する。
#
# なぜビルドジョブではなくここで作るのか:
#   latest.json は3プラットフォーム共通の同名アセットなので、各ビルドジョブが
#   個別に書き込むと最後の1つ以外の内容が失われる。以前はそれを避けるために
#   ビルドを直列化していたが、マニフェストの生成を全ビルド完了後の1回に切り出せば
#   ビルド自体は並列で走らせられる。
#
# 必要な環境変数:
#   GH_REPO    - "owner/repo"
#   GH_TOKEN   - gh / curl 用のトークン
#   RELEASE_ID - 対象リリースの id（ドラフトはタグ未作成のため id で扱う）
#   TAG        - リリースタグ（例: v0.2.0）
set -euo pipefail

: "${GH_REPO:?GH_REPO is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${RELEASE_ID:?RELEASE_ID is required}"
: "${TAG:?TAG is required}"

# latest.json の version はタグから先頭の v を落としたもの。
# ビルド時に tauri.conf.json へ書き込んだ値と一致していないと更新が届かない。
version="${TAG#v}"

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

assets="$workdir/assets.json"
gh api --paginate "repos/${GH_REPO}/releases/${RELEASE_ID}/assets" \
  --jq '.[] | {id: .id, name: .name}' | jq -s '.' > "$assets"

echo "assets on release ${RELEASE_ID}:"
jq -r '.[].name' "$assets" | sed 's/^/  - /'

# リリース本文（release-drafter が書いた変更履歴）をそのまま notes に載せる。
notes="$(gh api "repos/${GH_REPO}/releases/${RELEASE_ID}" --jq '.body // ""')"

platforms='{}'

# 1プラットフォーム分の { signature, url } を platforms に足す。
#   $1: latest.json のプラットフォームキー（OS-ARCH）
#   $2: 対応する .sig アセット名にマッチする正規表現
add_platform() {
  local key="$1" pattern="$2"
  local matches count sig_name sig_id bundle_name signature url

  matches="$(jq -c --arg re "$pattern" '[.[] | select(.name | test($re))]' "$assets")"
  count="$(jq 'length' <<<"$matches")"

  # 0個なら明らかな取りこぼし、2個以上は想定外のバンドル構成。
  # どちらも黙って欠けた latest.json を出すより、ここで落とした方が被害が小さい。
  if [ "$count" -ne 1 ]; then
    echo "error: expected exactly 1 asset matching /${pattern}/ for ${key}, found ${count}" >&2
    jq -r '.[].name' <<<"$matches" >&2
    return 1
  fi

  sig_name="$(jq -r '.[0].name' <<<"$matches")"
  sig_id="$(jq -r '.[0].id' <<<"$matches")"
  # 署名の対象バンドルは「.sig を外した名前」のアセット。
  bundle_name="${sig_name%.sig}"

  if [ "$(jq --arg n "$bundle_name" '[.[] | select(.name == $n)] | length' "$assets")" -ne 1 ]; then
    echo "error: bundle asset '${bundle_name}' paired with ${sig_name} was not found" >&2
    return 1
  fi

  # .sig の中身は署名そのもの（パスや URL では動かない）。
  # ドラフトのアセットは公開 URL から取れないので API 経由でダウンロードする。
  # -f が無いとエラーページの HTML がそのまま signature に入り、
  # 「JSON としては妥当だが検証に必ず失敗する」最悪の壊れ方をする。
  signature="$(curl -fsSL --retry 3 \
    -H "Authorization: Bearer ${GH_TOKEN}" \
    -H "Accept: application/octet-stream" \
    "https://api.github.com/repos/${GH_REPO}/releases/assets/${sig_id}")"

  # 空・非 base64 を弾く。空文字でも JSON は作れてしまうため明示的に検査する。
  if ! printf '%s' "$signature" | grep -Eq '^[A-Za-z0-9+/=[:space:]]+$' || [ -z "${signature// /}" ]; then
    echo "error: signature downloaded for ${key} (${sig_name}) is empty or not base64" >&2
    return 1
  fi

  # ドラフトのアセットが持つ browser_download_url は untagged-<hash> を含むことがあり、
  # 公開後は無効になる。公開後に必ず有効な形（タグ配下）を自前で組み立てる。
  # productName は "dragonfly" で空白を含まないため URL エンコードは不要。
  url="https://github.com/${GH_REPO}/releases/download/${TAG}/${bundle_name}"

  platforms="$(jq --arg key "$key" --arg sig "$signature" --arg url "$url" \
    '.[$key] = {signature: $sig, url: $url}' <<<"$platforms")"
  echo "  ${key} -> ${bundle_name}"
}

echo "resolving updater bundles:"
# macOS は aarch64 のみビルドしている（--target aarch64-apple-darwin）。
add_platform "darwin-aarch64" '\.app\.tar\.gz\.sig$'
# Linux は ubuntu-22.04 の x86_64 ビルド。AppImage がそのまま更新バンドルになる。
add_platform "linux-x86_64" '\.AppImage\.sig$'
# Windows は targets: "all" のため .msi と -setup.exe(NSIS) の両方に .sig が出る。
# NSIS を選ぶのは、Tauri が既定の配布形式として推奨しており、
# 更新時のサイレントインストールが素直に通るため（MSI は再起動要求が絡みやすい）。
add_platform "windows-x86_64" '\-setup\.exe\.sig$'

manifest="$workdir/latest.json"
jq -n \
  --arg version "$version" \
  --arg notes "$notes" \
  --arg pub_date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson platforms "$platforms" \
  '{version: $version, notes: $notes, pub_date: $pub_date, platforms: $platforms}' \
  > "$manifest"

echo "generated latest.json:"
jq '.platforms |= map_values({url, signature: (.signature | .[0:16] + "...")})' "$manifest"

# 再実行しても重複させないため、既存の latest.json を消してから上げ直す。
existing_id="$(jq -r '[.[] | select(.name == "latest.json")] | .[0].id // ""' "$assets")"
if [ -n "$existing_id" ]; then
  gh api -X DELETE "repos/${GH_REPO}/releases/assets/${existing_id}" > /dev/null
  echo "removed existing latest.json asset (${existing_id})"
fi

gh api --method POST \
  "https://uploads.github.com/repos/${GH_REPO}/releases/${RELEASE_ID}/assets?name=latest.json" \
  -H "Content-Type: application/json" \
  --input "$manifest" > /dev/null

echo "attached latest.json to release ${RELEASE_ID} (${TAG})"
