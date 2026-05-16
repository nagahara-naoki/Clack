// SPDX-License-Identifier: MIT
//! システムトレイ (Windows 通知領域 / macOS メニューバー) のアイコンと
//! 右クリックメニュー。
//!
//! Tauri 2 の `TrayIcon` にはメニューを後から取得する API が無いため、
//! 「自動起動」チェック項目だけは `CheckMenuItem` の参照を管理 state
//! ([`TrayHandles`]) に保持しておき、設定変更時に [`set_checked()`] で
//! 表示を同期させる。

use std::path::PathBuf;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

/// トレイ tooltip のベース文字列。`update_paused_state` で「(一時停止中)」
/// を足し外しする。
const TOOLTIP_BASE: &str = "Clack";
const TOOLTIP_PAUSED_SUFFIX: &str = " — 一時停止中";

/// ユーザーデータディレクトリ内のファイルパス 2 種。
/// 任意のコマンドから state として参照できる。
#[derive(Clone)]
pub struct AppPaths {
    pub data_path: PathBuf,
    pub settings_path: PathBuf,
}

/// トレイメニュー上で後から更新したいハンドルを保持する構造体。
/// 「自動起動」「一時停止」「リアルタイム表示」のチェックを設定/メイン側
/// からも反映させるためにメニュー項目自体への参照を保管しておく。
pub struct TrayHandles {
    pub autostart_check: CheckMenuItem<Wry>,
    pub pause_check: CheckMenuItem<Wry>,
    pub live_check: CheckMenuItem<Wry>,
}

/// トレイアイコンとコンテキストメニューを構築する。
/// `lib.rs::run` の setup フェーズから 1 度だけ呼ばれる。
pub fn build_tray(app: &AppHandle, autostart_enabled: bool) -> tauri::Result<()> {
    let open_item      = MenuItem::with_id(app, "open", "ウィンドウを開く", true, None::<&str>)?;
    let pause_item     = CheckMenuItem::with_id(
        app,
        "pause",
        "一時停止",
        true,
        false, // 起動時は常に未停止
        None::<&str>,
    )?;
    let live_item      = CheckMenuItem::with_id(
        app,
        "live",
        "リアルタイム表示",
        true,
        false, // 起動時は常に OFF (パスワード露出を避けるため)
        None::<&str>,
    )?;
    let autostart_item = CheckMenuItem::with_id(
        app,
        "autostart",
        "自動起動",
        true,
        autostart_enabled,
        None::<&str>,
    )?;
    let settings_item = MenuItem::with_id(app, "settings", "設定…", true, None::<&str>)?;
    let sep1          = PredefinedMenuItem::separator(app)?;
    let sep2          = PredefinedMenuItem::separator(app)?;
    let sep3          = PredefinedMenuItem::separator(app)?;
    let quit_item     = MenuItem::with_id(app, "quit", "終了", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &open_item, &sep1,
            &pause_item, &live_item, &sep2,
            &autostart_item, &settings_item, &sep3,
            &quit_item,
        ],
    )?;

    // アイコンはバンドル時にビルドへ埋め込まれている既定アイコンを使う。
    // 取得失敗 = ビルドの問題なので startup でちゃんと落とす。
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("default-window-icon".into()))?;

    let _tray = TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip(TOOLTIP_BASE)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open"      => show_window(app),
            "pause"     => toggle_pause(app),
            "live"      => toggle_live_display(app),
            "autostart" => toggle_autostart(app),
            "settings"  => open_settings(app),
            "quit"      => quit(app),
            // 未知の ID は panic させず無視する (将来ハンドラ追加忘れの保険)。
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 左クリック → メイン窓トグル。それ以外はメニューが OS から表示される。
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    // 後で `set_checked` するためにハンドルを保管。
    app.manage(TrayHandles {
        autostart_check: autostart_item,
        pause_check: pause_item,
        live_check: live_item,
    });

    Ok(())
}

/// トレイメニュー上の「自動起動」チェック表示を `checked` に合わせる。
/// 設定ウィンドウ / トレイ自身 / 起動時の同期 すべてから呼ばれる。
pub fn update_autostart_check(app: &AppHandle, checked: bool) {
    if let Some(handles) = app.try_state::<TrayHandles>() {
        let _ = handles.autostart_check.set_checked(checked);
    }
}

/// 一時停止状態を UI に反映する。チェック項目と tooltip を同期させる。
/// トレイ / 設定 / コマンドからの操作経路すべてが最終的にこれを呼ぶ。
pub fn update_paused_state(app: &AppHandle, paused: bool) {
    if let Some(handles) = app.try_state::<TrayHandles>() {
        let _ = handles.pause_check.set_checked(paused);
    }
    if let Some(tray) = app.tray_by_id("main-tray") {
        let tip = if paused {
            format!("{TOOLTIP_BASE}{TOOLTIP_PAUSED_SUFFIX}")
        } else {
            TOOLTIP_BASE.to_string()
        };
        let _ = tray.set_tooltip(Some(tip));
    }
}

/// リアルタイム表示のチェック表示を UI に同期する。
pub fn update_live_display_check(app: &AppHandle, checked: bool) {
    if let Some(handles) = app.try_state::<TrayHandles>() {
        let _ = handles.live_check.set_checked(checked);
    }
}

// ----------------------------------------------------------------
// 個別ハンドラ
// ----------------------------------------------------------------

fn show_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

fn toggle_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        match win.is_visible() {
            Ok(true) => { let _ = win.hide(); }
            _ => {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
        }
    }
}

fn open_settings(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// トレイの「一時停止」項目を切替。
/// 現在の状態を AppState から読んで反転させ、通知 + チェック表示の更新を
/// `commands::set_paused` 経由で一括処理する (1 か所に集約)。
fn toggle_pause(app: &AppHandle) {
    use crate::commands::AppStateHandle;
    let Some(state) = app.try_state::<AppStateHandle>() else {
        return;
    };
    let current = state
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .paused;
    let next = !current;
    {
        let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
        s.set_paused(next);
    }
    update_paused_state(app, next);
    use tauri::Emitter;
    let _ = app.emit("paused-changed", next);
}

/// トレイの「リアルタイム表示」項目を切替。
/// state 反転 + live ウィンドウ show/hide + チェック更新 + emit を 1 か所で。
fn toggle_live_display(app: &AppHandle) {
    use crate::commands::AppStateHandle;
    let Some(state) = app.try_state::<AppStateHandle>() else {
        return;
    };
    let current = state
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .live_display;
    let next = !current;
    {
        let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
        s.set_live_display(next);
    }
    if let Some(win) = app.get_webview_window("live") {
        if next {
            let _ = win.show();
        } else {
            let _ = win.hide();
        }
    }
    update_live_display_check(app, next);
    use tauri::Emitter;
    let _ = app.emit("live-display-changed", next);
}

/// トレイの「自動起動」項目を切替。チェック表示と他ウィンドウへの通知も
/// 同期して行う (設定ウィンドウが開いていれば即座に反映される)。
fn toggle_autostart(app: &AppHandle) {
    use tauri_plugin_autostart::ManagerExt;
    let enabled = app.autolaunch().is_enabled().unwrap_or(false);
    let res = if enabled { app.autolaunch().disable() } else { app.autolaunch().enable() };
    if let Err(e) = res {
        eprintln!("autostart toggle failed: {e}");
        return;
    }
    let new_state = !enabled;
    update_autostart_check(app, new_state);
    use tauri::Emitter;
    let _ = app.emit("autostart-changed", new_state);
}

/// 「終了」メニューの実装。`commands::quit_app` と同じく最終フラッシュ
/// を行ってから `app.exit(0)`。
fn quit(app: &AppHandle) {
    use crate::commands::AppStateHandle;
    if let (Some(state), Some(paths)) = (
        app.try_state::<AppStateHandle>(),
        app.try_state::<AppPaths>(),
    ) {
        let snapshot = state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .snapshot_all();
        if let Err(e) = crate::storage::write_atomic(&paths.data_path, &snapshot) {
            eprintln!("final flush failed: {e}");
        }
    }
    app.exit(0);
}
