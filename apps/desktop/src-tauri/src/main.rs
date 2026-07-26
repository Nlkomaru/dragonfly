// Windows のリリースビルドでコンソールウィンドウが開かないようにする。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    dragonfly_lib::run()
}
