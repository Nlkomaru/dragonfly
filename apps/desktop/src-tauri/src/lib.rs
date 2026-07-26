/// Tauri アプリのエントリポイント。プラグイン登録とコマンド定義をここに集約する。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());

    // updater / process はデスクトップのみで有効。フロントエンドの
    // UpdateNotifier がこの2つのプラグイン経由で更新と再起動を行う。
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    builder
        .invoke_handler(tauri::generate_handler![])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
