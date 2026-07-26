//! アプリ設定の永続化と、API キーの安全な保管。
//!
//! 設定本体は tauri-plugin-store の JSON ファイルに保存するが、
//! API キーだけは OS のキーチェーン（keyring）に置く。
//! キーはストアファイルにもログにも出さず、フロントエンドにも返さない。

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;

/// 設定を書き出すストアファイル名。
const STORE_FILE: &str = "settings.json";
/// ストア内で設定オブジェクトを収めるキー。
const SETTINGS_KEY: &str = "appSettings";
/// キーチェーン上のサービス名とアカウント名。
const KEYRING_SERVICE: &str = "dev.nikomaru.vrc.dragonfly";
const KEYRING_ACCOUNT: &str = "api-key";

/// デスクトップアプリの設定。API キーはキーチェーンにあるためこの型には含めない。
/// `packages/core/src/settings.ts` の `AppSettings` に対応する。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    /// スクリーンショットの保存先。空文字なら OS の Pictures/VRChat に解決する。
    pub screenshot_dir: String,
    /// 送信先の API。ローカルの Worker に向けたいときのために可変。
    pub api_base_url: String,
    /// AVIF の品質（0-100、大きいほど高画質）。
    pub avif_quality: u8,
    /// 長辺の上限ピクセル。None なら原寸のまま送る。
    /// null を明示的に返す必要があるので skip_serializing_if は付けない。
    pub max_long_edge: Option<u32>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            screenshot_dir: String::new(),
            api_base_url: "https://dragonfly.vrc.nikomaru.dev".to_string(),
            avif_quality: 70,
            max_long_edge: Some(3840),
        }
    }
}

/// ストアから設定を読み出す。未保存・壊れている場合は既定値を返す。
pub fn load_settings<R: Runtime>(app: &AppHandle<R>) -> Result<AppSettings, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let settings = store
        .get(SETTINGS_KEY)
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default();
    Ok(settings)
}

/// 設定をストアへ保存する。
pub fn save_settings<R: Runtime>(app: &AppHandle<R>, settings: &AppSettings) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let value = serde_json::to_value(settings).map_err(|e| e.to_string())?;
    store.set(SETTINGS_KEY, value);
    store.save().map_err(|e| e.to_string())
}

/// キーチェーンのエントリを作る。
fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|e| e.to_string())
}

/// キーチェーンから API キーを取り出す。未設定なら None。
/// 戻り値はバックエンド内部でのみ使い、フロントエンドへは決して返さない。
pub fn read_api_key() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// 現在の設定を返す。
#[tauri::command]
pub fn get_settings(app: AppHandle) -> Result<AppSettings, String> {
    load_settings(&app)
}

/// 設定を丸ごと置き換えて保存し、保存後の値を返す。
#[tauri::command]
pub fn set_settings(app: AppHandle, settings: AppSettings) -> Result<AppSettings, String> {
    save_settings(&app, &settings)?;
    Ok(settings)
}

/// API キーをキーチェーンに保存する。空文字なら削除と同じ扱いにする。
#[tauri::command]
pub fn set_api_key(key: String) -> Result<(), String> {
    if key.trim().is_empty() {
        return clear_api_key();
    }
    entry()?.set_password(&key).map_err(|e| e.to_string())
}

/// API キーが保存済みかどうかだけを返す。値そのものは返さない。
#[tauri::command]
pub fn has_api_key() -> Result<bool, String> {
    Ok(read_api_key()?.is_some())
}

/// 保存済みの API キーを削除する。未保存でもエラーにしない。
#[tauri::command]
pub fn clear_api_key() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// フォルダ選択ダイアログを開き、選ばれたパスを返す。キャンセル時は None。
#[tauri::command]
pub fn pick_screenshot_dir(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app.dialog().file().blocking_pick_folder();
    Ok(picked.map(|path| path.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_serialize_in_camel_case_with_explicit_null() {
        let settings = AppSettings {
            screenshot_dir: "/tmp".into(),
            api_base_url: "http://localhost:8787".into(),
            avif_quality: 60,
            max_long_edge: None,
        };
        let json = serde_json::to_string(&settings).unwrap();
        assert!(json.contains("\"screenshotDir\":\"/tmp\""));
        assert!(json.contains("\"maxLongEdge\":null"));
    }
}
