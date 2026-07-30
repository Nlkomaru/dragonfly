//! Web API（Cloudflare Workers）への送信。
//!
//! 認証は OS のキーチェーンに置いた API キーによる Bearer 認証。
//! ネットワークや 5xx は失敗しやすいので、指数バックオフで再試行する。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::Semaphore;

use crate::converter::{convert_png, ConvertProgress, CONVERT_PROGRESS_EVENT};
use crate::hash::hash_file;
use crate::metadata::{parse_png_meta, VrcxMetadata};
use crate::scanner::parse_vrchat_file_name;
use crate::settings::{load_settings, read_api_key, AppSettings};

/// 送信の進捗イベント名。
pub const UPLOAD_PROGRESS_EVENT: &str = "upload_progress";

/// 1リクエストで問い合わせられるハッシュ数の上限（`packages/core/src/api.ts` と同じ値）。
const CHECK_HASH_LIMIT: usize = 500;

/// バージョン付き API のプレフィックス。API の版が上がったらここだけを変える。
const API_V1_PREFIX: &str = "/api/v1";

/// 呼び出し元自身を指すユーザーのエイリアス。
/// サーバーが API キーからユーザーを解決するため、クライアントは自分の ID を知らなくてよい。
const CURRENT_USER: &str = "me";

/// バージョン付き API のパスを組み立てる。`suffix` は `/` 始まりで渡す。
fn v1_path(suffix: &str) -> String {
    format!("{API_V1_PREFIX}{suffix}")
}

/// ユーザーに紐づくリソースのパスを組み立てる。
/// `owner` には `CURRENT_USER` のほか、将来的に具体的なユーザー ID も渡せる。
fn user_path(owner: &str, suffix: &str) -> String {
    v1_path(&format!("/users/{owner}{suffix}"))
}

/// 再試行の最大回数。
const MAX_ATTEMPTS: u32 = 4;
/// 再試行の基準待ち時間。試行ごとに倍にする。
const RETRY_BASE_DELAY: Duration = Duration::from_millis(500);

/// アップロード時に画像と一緒に送るメタデータ。multipart の `metadata` パート。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadPhotoMetadata {
    /// 変換前 PNG の SHA-256。サーバー上の一意キー。
    pub source_sha256: String,
    pub taken_at: i64,
    pub width: u32,
    pub height: u32,
    /// AVIF 変換で失われるため、抽出済みの VRCX メタデータをそのまま送る。
    pub vrcx: VrcxMetadata,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    /// 読み込み前に出すプレースホルダ用の BlurHash。
    /// サーバー側のスキーマは `.optional()` なのでキーが無いのは通るが、
    /// `null` は 400 で弾かれる。計算できなかったときは必ずキーごと落とす。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blurhash: Option<String>,
}

/// `/api/v1/users/{owner}/photos` のレスポンス。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadPhotoResponse {
    pub id: String,
    /// 既存の写真と重複していた場合は true。
    pub deduplicated: bool,
}

/// `/api/v1/users/{owner}/photos/check` のレスポンス。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckPhotosResponse {
    uploaded: Vec<String>,
}

/// `/api/v1/me` のレスポンス。設定画面での接続テストに使う。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeResponse {
    pub user_id: String,
    pub display_name: String,
}

/// 送信1件ごとの結果。失敗しても全体を止めず、理由を持ち帰る。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadOutcome {
    pub path: String,
    pub sha256: Option<String>,
    pub uploaded: bool,
    pub deduplicated: bool,
    pub error: Option<String>,
}

/// 送信全体のまとめ。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadSummary {
    pub results: Vec<UploadOutcome>,
    pub succeeded: usize,
    pub failed: usize,
}

/// 送信の進捗。
/// 1 枚終わるごとに成否が確定するので、待っている間に内訳が動くよう
/// 完了件数だけでなく成功・失敗の数もその都度送る。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadProgress {
    pub processed: usize,
    pub total: usize,
    pub current_path: String,
    /// ここまでに送信できた件数（重複扱いも成功に数える）。
    pub succeeded: usize,
    /// ここまでに失敗した件数。
    pub failed: usize,
}

/// API 呼び出しに必要な情報をひとまとめにする。API キーはここから外に出さない。
struct ApiContext {
    client: reqwest::Client,
    base_url: String,
    api_key: String,
    settings: AppSettings,
}

impl ApiContext {
    /// 設定とキーチェーンから API 呼び出しの前提を組み立てる。
    fn build(app: &AppHandle) -> Result<Self, String> {
        let settings = load_settings(app)?;
        let api_key = read_api_key()?.ok_or("API key is not configured")?;
        let base_url = settings.api_base_url.trim_end_matches('/').to_string();
        if base_url.is_empty() {
            return Err("API base URL is not configured".into());
        }
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            client,
            base_url,
            api_key,
            settings,
        })
    }

    /// エンドポイントの絶対 URL を作る。
    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }
}

/// 再試行すべき状態かどうか。5xx とネットワークエラーだけを対象にする。
fn is_retryable(status: Option<reqwest::StatusCode>) -> bool {
    match status {
        Some(status) => {
            status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS
        }
        // ステータスが無い = 接続自体に失敗した場合。
        None => true,
    }
}

/// 指数バックオフ付きでリクエストを実行する。`build` は毎回新しいリクエストを作る。
///
/// 409 は「既に存在する」= 成功扱いなので、エラーにせず呼び出し側に返す。
async fn send_with_retry<F>(build: F) -> Result<reqwest::Response, String>
where
    F: Fn() -> reqwest::RequestBuilder,
{
    send_with_retry_allowing(build, &[reqwest::StatusCode::CONFLICT]).await
}

/// [`send_with_retry`] の一般形。`allowed` のステータスはエラーにせずそのまま返す。
///
/// 呼び出しごとに「失敗ではない 4xx」が違う（削除なら 404 = 既に無い）ので、
/// 既定の 409 だけを見る [`send_with_retry`] とは別に、渡せる形も用意する。
async fn send_with_retry_allowing<F>(
    build: F,
    allowed: &[reqwest::StatusCode],
) -> Result<reqwest::Response, String>
where
    F: Fn() -> reqwest::RequestBuilder,
{
    let mut last_error = String::new();
    for attempt in 0..MAX_ATTEMPTS {
        match build().send().await {
            Ok(response) if response.status().is_success() => return Ok(response),
            Ok(response) => {
                let status = response.status();
                if allowed.contains(&status) {
                    return Ok(response);
                }
                if !is_retryable(Some(status)) {
                    let body = response.text().await.unwrap_or_default();
                    return Err(format!("request failed with {status}: {body}"));
                }
                last_error = format!("request failed with {status}");
            }
            Err(e) => {
                if !is_retryable(e.status()) {
                    return Err(e.to_string());
                }
                last_error = e.to_string();
            }
        }
        // 最後の試行の後は待たずに抜ける。
        if attempt + 1 < MAX_ATTEMPTS {
            tokio::time::sleep(RETRY_BASE_DELAY * 2u32.pow(attempt)).await;
        }
    }
    Err(last_error)
}

/// 送信済みのハッシュを問い合わせる。上限を超える分は分割して送る。
#[tauri::command]
pub async fn check_uploaded(app: AppHandle, hashes: Vec<String>) -> Result<Vec<String>, String> {
    let ctx = ApiContext::build(&app)?;
    let mut uploaded = Vec::new();
    for chunk in hashes.chunks(CHECK_HASH_LIMIT) {
        let body = serde_json::json!({ "hashes": chunk });
        let response = send_with_retry(|| {
            ctx.client
                .post(ctx.url(&user_path(CURRENT_USER, "/photos/check")))
                .bearer_auth(&ctx.api_key)
                .json(&body)
        })
        .await?;
        let parsed: CheckPhotosResponse = response.json().await.map_err(|e| e.to_string())?;
        uploaded.extend(parsed.uploaded);
    }
    Ok(uploaded)
}

/// SHA-256 の 16 進表現として妥当かどうか。
///
/// ハッシュをそのまま URL のパスに埋めるため、ここで形を確かめてから送る。
/// 変な値を投げてサーバー側の 404 と区別が付かなくなるのを防ぐ意味もある。
fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

/// サーバー上の写真を 1 枚削除する。ローカルの PNG には触らない。
///
/// デスクトップ側はサーバーの写真 ID を持っていないので、元 PNG のハッシュで引く
/// エンドポイントを使う。404 は「サーバー側に既に無い」= 望んだ状態なので成功扱いにする。
#[tauri::command]
pub async fn delete_remote_photo(app: AppHandle, sha256: String) -> Result<(), String> {
    if !is_sha256_hex(&sha256) {
        return Err(format!("{sha256} is not a SHA-256 hex digest"));
    }
    let ctx = ApiContext::build(&app)?;
    let path = user_path(CURRENT_USER, &format!("/photos/by-hash/{sha256}"));
    let response = send_with_retry_allowing(
        || ctx.client.delete(ctx.url(&path)).bearer_auth(&ctx.api_key),
        &[reqwest::StatusCode::NOT_FOUND],
    )
    .await?;

    // 成功と 404 以外はここへ来ない（それ以外は send_with_retry_allowing が Err にする）。
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        eprintln!("warning: the photo was already gone on the server: {sha256}");
    }
    Ok(())
}

/// API キーの有効性とサーバー到達性を確かめる。
/// 401 と接続失敗を区別できるよう、エラーメッセージを分けて返す。
#[tauri::command]
pub async fn test_connection(app: AppHandle) -> Result<MeResponse, String> {
    let ctx = ApiContext::build(&app)?;
    let response = ctx
        .client
        .get(ctx.url(&v1_path("/me")))
        .bearer_auth(&ctx.api_key)
        .send()
        .await
        .map_err(|e| format!("could not reach the server: {e}"))?;

    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("the API key was rejected (401)".into());
    }
    if !response.status().is_success() {
        return Err(format!("the server returned {}", response.status()));
    }
    response.json().await.map_err(|e| e.to_string())
}

/// 1枚分の変換とアップロードを行う。
async fn upload_one(ctx: &ApiContext, path: &Path) -> Result<UploadOutcome, String> {
    let path_string = path.to_string_lossy().into_owned();

    // ハッシュと変換は CPU を使うためブロッキングプールへ。
    let owned = path.to_path_buf();
    let quality = ctx.settings.avif_quality;
    let max_long_edge = ctx.settings.max_long_edge;
    let (sha256, vrcx, converted) = tauri::async_runtime::spawn_blocking(move || {
        let sha256 = hash_file(&owned)?;
        let bytes = std::fs::read(&owned).map_err(|e| e.to_string())?;
        let meta = parse_png_meta(&bytes).map_err(|e| e.to_string())?;
        let vrcx = meta.vrcx.ok_or("the photo has no VRCX metadata")?;
        let json = serde_json::to_string(&vrcx).map_err(|e| e.to_string())?;
        let converted = convert_png(&owned, quality, max_long_edge, Some(&json))?;
        Ok::<_, String>((sha256, vrcx, converted))
    })
    .await
    .map_err(|e| e.to_string())??;

    let taken_at = parse_vrchat_file_name(
        &path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
    )
    .taken_at
    .unwrap_or_else(|| chrono::Local::now().timestamp_millis());

    let metadata = UploadPhotoMetadata {
        source_sha256: sha256.clone(),
        taken_at,
        width: converted.width,
        height: converted.height,
        vrcx,
        tags: None,
        blurhash: converted.blurhash.clone(),
    };
    let metadata_json = serde_json::to_string(&metadata).map_err(|e| e.to_string())?;

    let response = send_with_retry(|| {
        // multipart のパートは送信ごとに作り直す必要がある。
        let form = reqwest::multipart::Form::new()
            .part(
                "image",
                reqwest::multipart::Part::bytes(converted.image.clone())
                    .file_name(format!("{sha256}.avif"))
                    .mime_str("image/avif")
                    .expect("image/avif is a valid MIME type"),
            )
            .part(
                "thumb",
                reqwest::multipart::Part::bytes(converted.thumbnail.clone())
                    .file_name(format!("{sha256}_thumb.avif"))
                    .mime_str("image/avif")
                    .expect("image/avif is a valid MIME type"),
            )
            .part(
                "metadata",
                reqwest::multipart::Part::text(metadata_json.clone())
                    .mime_str("application/json")
                    .expect("application/json is a valid MIME type"),
            );
        ctx.client
            .post(ctx.url(&user_path(CURRENT_USER, "/photos")))
            .bearer_auth(&ctx.api_key)
            .multipart(form)
    })
    .await?;

    // 409 は重複。サーバー側は冪等なので成功として扱う。
    let deduplicated = if response.status() == reqwest::StatusCode::CONFLICT {
        true
    } else {
        response
            .json::<UploadPhotoResponse>()
            .await
            .map(|body| body.deduplicated)
            .unwrap_or(false)
    };

    Ok(UploadOutcome {
        path: path_string,
        sha256: Some(sha256),
        uploaded: true,
        deduplicated,
        error: None,
    })
}

/// 指定された写真を AVIF に変換して送信する。1枚の失敗で全体は止めない。
#[tauri::command]
pub async fn upload_photos(app: AppHandle, paths: Vec<String>) -> Result<UploadSummary, String> {
    let ctx = Arc::new(ApiContext::build(&app)?);
    let total = paths.len();
    // 変換が CPU バウンドなので、同時実行数はコア数までに抑える。
    let permits = Arc::new(Semaphore::new(num_cpus::get().max(1)));
    // 並列実行なので完了順は入力順と一致しない。進捗は完了件数のカウンタで数える。
    let converted = Arc::new(AtomicUsize::new(0));
    let uploaded = Arc::new(AtomicUsize::new(0));
    // 成功だけを別に数える。失敗は「完了 - 成功」で出せるので、カウンタは 1 本で足りる。
    let succeeded = Arc::new(AtomicUsize::new(0));

    let mut tasks = Vec::with_capacity(total);
    for path in paths.into_iter() {
        let ctx = ctx.clone();
        let permits = permits.clone();
        let app = app.clone();
        let converted = converted.clone();
        let uploaded = uploaded.clone();
        let succeeded = succeeded.clone();
        tasks.push(tauri::async_runtime::spawn(async move {
            let _permit = permits.acquire_owned().await.expect("semaphore is open");
            let path = PathBuf::from(&path);
            let display = path.to_string_lossy().into_owned();

            // 変換開始を通知する。processed は「変換に着手した件数」。
            let _ = app.emit(
                CONVERT_PROGRESS_EVENT,
                ConvertProgress {
                    processed: converted.fetch_add(1, Ordering::Relaxed) + 1,
                    total,
                    current_path: display.clone(),
                },
            );

            let outcome = match upload_one(&ctx, &path).await {
                Ok(outcome) => outcome,
                Err(error) => UploadOutcome {
                    path: display.clone(),
                    sha256: None,
                    uploaded: false,
                    deduplicated: false,
                    error: Some(error),
                },
            };

            // 成功を先に数えてから完了を数える。逆順だと、他のタスクが成功を
            // 加える前に完了だけが増えて、失敗数が一瞬多く見えてしまう。
            if outcome.uploaded {
                succeeded.fetch_add(1, Ordering::Relaxed);
            }
            let done = uploaded.fetch_add(1, Ordering::Relaxed) + 1;
            let ok = succeeded.load(Ordering::Relaxed);
            let _ = app.emit(
                UPLOAD_PROGRESS_EVENT,
                UploadProgress {
                    processed: done,
                    total,
                    current_path: display,
                    succeeded: ok,
                    // 並列なので ok が done を一時的に上回りうる。差が負にならないようにする。
                    failed: done.saturating_sub(ok),
                },
            );
            outcome
        }));
    }

    let mut results = Vec::with_capacity(total);
    for task in tasks {
        results.push(task.await.map_err(|e| e.to_string())?);
    }

    let succeeded = results.iter().filter(|r| r.uploaded).count();
    Ok(UploadSummary {
        failed: results.len() - succeeded,
        succeeded,
        results,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_server_errors_and_throttling_are_retried() {
        assert!(is_retryable(Some(
            reqwest::StatusCode::INTERNAL_SERVER_ERROR
        )));
        assert!(is_retryable(Some(reqwest::StatusCode::TOO_MANY_REQUESTS)));
        assert!(is_retryable(None));
        assert!(!is_retryable(Some(reqwest::StatusCode::UNAUTHORIZED)));
    }

    #[test]
    fn api_paths_are_versioned_and_user_scoped() {
        assert_eq!(v1_path("/me"), "/api/v1/me");
        assert_eq!(
            user_path(CURRENT_USER, "/photos/check"),
            "/api/v1/users/me/photos/check"
        );
        // owner に具体的なユーザー ID を渡せることの確認。
        assert_eq!(user_path("u_123", "/photos"), "/api/v1/users/u_123/photos");
    }

    #[test]
    fn only_a_64_character_hex_digest_is_accepted() {
        assert!(is_sha256_hex(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        ));
        // 短い / 16 進でない文字が混じるものは弾く。
        assert!(!is_sha256_hex("ba7816bf"));
        assert!(!is_sha256_hex(&"z".repeat(64)));
    }
}
