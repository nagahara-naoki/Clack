// SPDX-License-Identifier: MIT
//
// テーマブートストラップ。
// styles.css / メインスクリプトより **先に <head> で実行** することで、
// 「初期描画は data-theme="auto" → OS ダーク」というフラッシュを防ぐ。
//
// 仕組み:
//  - main.js / settings.js が `applyTheme(name)` で localStorage に保存
//  - 次回起動時は本スクリプトが同期的に読み出して <html data-theme>
//    を上書きしてから CSS が反映される
//
// 失敗してもアプリは動くので例外は握りつぶす (Tauri WebView では
// localStorage は常に使えるが、念のための防御)。

(function () {
  try {
    var t = window.localStorage && window.localStorage.getItem("clack.theme");
    if (t === "light" || t === "dark" || t === "auto") {
      document.documentElement.dataset.theme = t;
    }
  } catch (_) { /* ignore */ }
})();
