//! dragonfly のデスクトップ側バックエンド。
//! 走査 → ハッシュ → 変換 → 送信 という写真パイプラインを Tauri コマンドとして公開する。

pub mod avif_meta;
pub mod converter;
pub mod hash;
pub mod metadata;
pub mod scanner;
pub mod settings;
pub mod uploader;

/// Tauri アプリのエントリポイント。プラグイン登録とコマンド定義をここに集約する。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // 設定の永続化とフォルダ選択ダイアログ。
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init());

    // updater / process はデスクトップのみで有効。フロントエンドの
    // UpdateNotifier がこの2つのプラグイン経由で更新と再起動を行う。
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    builder
        .setup(|app| {
            // 起動時点の保存先を asset プロトコルのスコープに入れておく。
            // 保存先が未作成でも起動は妨げないので、失敗しても警告だけにする。
            if let Err(e) = scanner::allow_root_dir_asset_scope(app.handle()) {
                eprintln!("warning: {e}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            settings::get_settings,
            settings::set_settings,
            settings::set_api_key,
            settings::has_api_key,
            settings::clear_api_key,
            settings::pick_screenshot_dir,
            scanner::scan_photos,
            hash::hash_photos,
            uploader::check_uploaded,
            uploader::upload_photos,
            uploader::test_connection,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
