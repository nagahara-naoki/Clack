// SPDX-License-Identifier: MIT
//
// Clack — エントリポイント。
//
// 実体のロジックは `clack_lib` クレート (`lib.rs` 配下) に置き、
// 統合テスト・ドキュメント・将来のツールから同じ表面を再利用できる
// ようにしている。`main.rs` は薄い起動シムに留める。

// リリースビルドでは余分なコンソールウィンドウを出さない (GUI 専用)。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    clack_lib::run();
}
