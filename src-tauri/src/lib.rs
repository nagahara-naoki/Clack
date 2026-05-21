// SPDX-License-Identifier: MIT
//! Clack — アプリ全体のオーケストレーション。
//!
//! # スレッドモデル
//!
//! 各スレッドは [`run`] から **1 度ずつ** 生成され、プロセス終了まで
//! 生存する。共有状態はすべて 1 つの `Arc<Mutex<AppState>>`
//! ([`commands::AppStateHandle`]) に集約。
//!
//! | スレッド                | 役割                                | 頻度        |
//! | ----------------------- | ----------------------------------- | ----------- |
//! | main (Tauri ランタイム) | ウィンドウ / トレイ / IPC           | イベント駆動 |
//! | clack-rdev       | OS のグローバル入力監視             | ≤ 100 Hz    |
//! | clack-rollover   | 日付変更の検知 → today を巻き戻し   | 30 秒毎    |
//! | clack-flush      | data.json のアトミック書き込み      | 10 秒毎    |
//! | clack-emit       | UI への "stats-updated" 1Hz プッシュ | ウィンドウ表示中のみ |
//!
//! ロックは「短く取って即解放」が原則。ディスク I/O はロック解放後の
//! スナップショットに対して行うため、入力ホットパスが I/O 待ちで
//! 止まることは無い。
//!
//! # プライバシー
//!
//! rdev リスナーは OS のすべての入力を観測する。本クレートに **ネット
//! ワーク呼び出しは存在しない** ため、観測内容が端末外に出る経路は
//! 設計上ゼロ。詳細は [`crate::counter`] のモジュール docs を参照。
//!
//! # 失敗時の振る舞い
//!
//! - **プロセス panic**: リリースビルドは `panic = "abort"` のため即終了。
//!   直近 10 秒分の新カウントは失われ得るが、`data.json` 自体は
//!   `tmp + rename` パターンで保護されているため壊れない。
//! - **Mutex ポイズン**: すべての `lock()` を `unwrap_or_else(into_inner)`
//!   でリカバリ。デッドロックの伝搬を防ぐ。
//! - **rdev のフック失敗**: stderr に出力するだけで他スレッドは継続。
//!   ユーザーは過去データの閲覧は可能なまま (macOS の権限不足等)。

mod commands;
mod counter;
mod date_util;
mod macos_permissions;
mod settings;
mod storage;
mod tray;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::{Emitter, Manager};
use tauri_plugin_autostart::MacosLauncher;

use crate::commands::{AppStateHandle, SettingsHandle, TodayPayload};
use crate::counter::AppState;
use crate::settings::Settings;
use crate::tray::AppPaths;

/// OS 標準データディレクトリ配下に作るアプリ専用フォルダ名。
/// Windows: `%APPDATA%\Clack\`、macOS: `~/Library/Application
/// Support/Clack/`。仕様 §3.3 に合わせて固定名を使う。
const APP_DIR_NAME: &str = "Clack";

/// アプリの旧称。`ClickCounter` → `Clack` に改名したため、旧ディレクトリ
/// にデータがあれば一度だけ自動で引き継ぐ。
const LEGACY_APP_DIR_NAME: &str = "ClickCounter";

/// 各種スレッドのインターバル。
/// 「短すぎる → 無駄に CPU/IO」「長すぎる → ロストが増える」を
/// それぞれ天秤にかけてチューニングした既定値。
const ROLLOVER_CHECK_INTERVAL: Duration = Duration::from_secs(30);
const FLUSH_INTERVAL: Duration = Duration::from_secs(10);
const EMIT_INTERVAL: Duration = Duration::from_millis(1000);
const INPUT_RETRY_INTERVAL: Duration = Duration::from_secs(3);

/// アプリを本当に終了してよいかを表すフラグ。
///
/// macOS の `Cmd+Q` や Dock からの終了は、ユーザー感覚では「閉じる」に近く
/// 扱われることがある。Clack は常駐して入力を記録するアプリなので、トレイや
/// 設定画面の「終了」から来た操作だけを明示終了として扱う。
pub(crate) struct ExitState {
    requested: AtomicBool,
}

impl ExitState {
    pub(crate) fn request_exit(&self) {
        self.requested.store(true, Ordering::SeqCst);
    }

    fn is_requested(&self) -> bool {
        self.requested.load(Ordering::SeqCst)
    }
}

impl Default for ExitState {
    fn default() -> Self {
        Self {
            requested: AtomicBool::new(false),
        }
    }
}

fn hide_all_windows(app: &tauri::AppHandle) {
    for label in ["main", "settings", "live"] {
        if let Some(win) = app.get_webview_window(label) {
            let _ = win.hide();
        }
    }
}

/// `data.json` / `settings.json` のパスを解決する。
/// Tauri 既定の app-data-dir はアイデンティファイア接頭辞付き
/// (`com.clack.desktop\`) なので、より馴染みやすい `Clack\` 直下を使う。
///
/// 旧アプリ名 (ClickCounter) からの移行: 新しい `Clack/` ディレクトリに
/// `data.json` / `settings.json` のどちらも存在しないとき **だけ**、
/// 旧 `ClickCounter/` から最大 2 ファイルをコピーする。元ファイルは
/// 触らないので、移行に失敗しても旧アプリで読み戻せる。
fn resolve_paths(app: &tauri::AppHandle) -> tauri::Result<AppPaths> {
    let root = app.path().data_dir()?;
    let base = root.join(APP_DIR_NAME);
    let data_path = base.join("data.json");
    let settings_path = base.join("settings.json");

    if !data_path.exists() && !settings_path.exists() {
        let legacy = root.join(LEGACY_APP_DIR_NAME);
        if legacy.exists() {
            let _ = std::fs::create_dir_all(&base);
            for name in ["data.json", "settings.json"] {
                let from = legacy.join(name);
                let to = base.join(name);
                if from.exists() && !to.exists() {
                    if let Err(e) = std::fs::copy(&from, &to) {
                        eprintln!("legacy migration failed for {name}: {e}");
                    }
                }
            }
        }
    }

    Ok(AppPaths {
        data_path,
        settings_path,
    })
}

/// アプリのビルド〜起動を行う本体。通常 return しない (Tauri がメイン
/// スレッドのイベントループを掴むため)。
pub fn run() {
    // スレッド生成前にローカルタイムオフセットを確定させる
    // (`date_util::init` の docs を参照)。
    date_util::init();

    let builder = tauri::Builder::default()
        // 二重起動防止: 既存インスタンスがあれば、そちらのメインウィンドウを
        // 前面化して新プロセスは即終了する。トレイアイコンが増殖する事故を
        // 防ぎ、ユーザーから見ても「ダブルクリック → 開く」が常に成立する。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        // データのエクスポート / インポートでファイル選択ダイアログを使う。
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            // 自動起動の LaunchAgent / Windows レジストリにはこの引数が
            // 入る。アプリ側はこれを「OS の自動起動から来た」サインとして
            // 解釈し、ウィンドウを開かずトレイのみで常駐する。
            Some(vec!["--minimized"]),
        ))
        .invoke_handler(tauri::generate_handler![
            commands::get_today_stats,
            commands::get_stats_range,
            commands::get_day_detail,
            commands::get_month_total,
            commands::get_settings,
            commands::update_settings,
            commands::get_autostart_enabled,
            commands::set_autostart_enabled,
            commands::show_main_window,
            commands::hide_main_window,
            commands::open_settings_window,
            commands::close_settings_window,
            commands::get_data_size,
            commands::clear_data,
            commands::get_analytics,
            commands::get_paused,
            commands::set_paused,
            commands::get_live_display,
            commands::set_live_display,
            commands::export_data,
            commands::import_data,
            commands::quit_app,
        ])
        .on_window_event(|window, event| {
            // OS の閉じるボタン → アプリは終了せず、ウィンドウを隠す。
            // トレイ常駐は維持され、「終了」メニューでだけプロセス終了する。
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            let app_handle = app.handle().clone();
            let paths = resolve_paths(&app_handle)?;

            #[cfg(target_os = "macos")]
            {
                // Dock に出さず、メニューバー常駐の補助アプリとして扱う。
                // これで起動中も Dock にアイコンが残らず、バックグラウンド
                // 計測の見た目だけを静かに保てる。
                let _ = app_handle.set_activation_policy(tauri::ActivationPolicy::Accessory);
                let _ = app_handle.set_dock_visibility(false);
            }

            // Ask after Tauri has initialized the bundled app. macOS TCC tracks
            // permissions against the app identity, and prompting too early can
            // make unsigned release builds look untrusted on every launch.
            macos_permissions::request_input_monitoring();

            // 初回起動判定: settings.json が無ければ初回扱い。
            // (a) 仕様 §3.6 に従い自動起動をデフォルト ON にする
            // (b) アプリが起動していることをユーザーに知らせるためメイン
            //     ウィンドウを 1 回だけ自動表示する
            let first_run = !paths.settings_path.exists();

            // 設定 + 履歴を読み込んでアプリ状態を構築。
            let user_settings = Settings::read(&paths.settings_path);
            let background_start_enabled = user_settings.background_start_enabled;
            let history = storage::read(&paths.data_path);
            let today_str = date_util::today();
            let app_state = AppState::new(today_str, history);

            let state_arc: AppStateHandle = Arc::new(Mutex::new(app_state));
            let settings_arc: SettingsHandle = Arc::new(Mutex::new(user_settings));

            app.manage(state_arc.clone());
            app.manage(settings_arc.clone());
            app.manage(paths.clone());
            app.manage(ExitState::default());

            // 仕様 §3.6 — 初回セットアップ後は OS ログイン時に裏で常駐する。
            // 旧バージョンで OS 側の LaunchAgent / Run 登録が消えていても、
            // settings.json の意思 (既存ユーザーは default true) を正として復元する。
            use tauri_plugin_autostart::ManagerExt;
            if background_start_enabled {
                let _ = app_handle.autolaunch().enable();
            }
            let auto_enabled = app_handle.autolaunch().is_enabled().unwrap_or(false);

            // システムトレイ (Tauri メインスレッドで構築する必要あり)。
            tray::build_tray(&app_handle, auto_enabled)?;

            // ------------------------------------------------------
            // 入力リスナースレッド (rdev)
            // ------------------------------------------------------
            // 安全・プライバシー: グローバル入力イベントを観測するスレッド。
            // 守らなければならない不変条件:
            //   - キー識別子を stdout / stderr / ログに出さない
            //   - 端末外への送信を一切しない (本クレートはネットワーク機能を持たない)
            //   - panic しない (panic = abort で全カウントが失われる)
            //
            // `handle_event` 自体は構造的に panic フリー。ロックが
            // ポイズンしていても `into_inner` でリカバリし、計数の
            // 継続性を最優先する。
            let state_input_outer = Arc::clone(&state_arc);
            let handle_input_outer = app_handle.clone();
            thread::Builder::new()
                .name("clack-rdev".into())
                .spawn(move || {
                    macos_permissions::request_input_monitoring();
                    loop {
                        let state_input = Arc::clone(&state_input_outer);
                        let handle_input = handle_input_outer.clone();
                        if let Err(e) = rdev::listen(move |event| {
                            // ロック保持中に IPC emit を呼ばないこと。
                            // ロック解放後にライブイベントを送ることで、
                            // emit のレイテンシが入力ホットパスを止めないようにする。
                            let (live_event, live_on) = {
                                let mut s = state_input
                                    .lock()
                                    .unwrap_or_else(|poison| poison.into_inner());
                                let ev = s.handle_event(event);
                                (ev, s.live_display)
                            };
                            if live_on {
                                if let Some(payload) = live_event {
                                    let _ = handle_input.emit_to("live", "live-key", payload);
                                }
                            }
                        }) {
                            eprintln!("global input hook failed: {e:?}; retrying");
                            thread::sleep(INPUT_RETRY_INTERVAL);
                        }
                    }
                })
                .expect("spawn rdev listener");

            // ------------------------------------------------------
            // 日付ロールオーバ検知スレッド
            // ------------------------------------------------------
            let state_roll = Arc::clone(&state_arc);
            thread::Builder::new()
                .name("clack-rollover".into())
                .spawn(move || loop {
                    thread::sleep(ROLLOVER_CHECK_INTERVAL);
                    let today = date_util::today();
                    let mut s = state_roll
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner());
                    s.rollover_if_needed(&today);
                })
                .expect("spawn rollover thread");

            // ------------------------------------------------------
            // 定期フラッシュスレッド
            // ------------------------------------------------------
            // dirty フラグはディスク書き込みを始める前に楽観的にクリアし、
            // 書き込みに失敗したら再度立てる。書き込み中に新規イベントが
            // 入った場合も次のフラッシュで拾われる。
            let state_flush = Arc::clone(&state_arc);
            let flush_path = paths.data_path.clone();
            thread::Builder::new()
                .name("clack-flush".into())
                .spawn(move || loop {
                    thread::sleep(FLUSH_INTERVAL);
                    let snapshot = {
                        let mut s = state_flush
                            .lock()
                            .unwrap_or_else(|poison| poison.into_inner());
                        if !s.dirty { continue; }
                        s.dirty = false;
                        s.snapshot_all()
                    };
                    if let Err(e) = storage::write_atomic(&flush_path, &snapshot) {
                        eprintln!("flush failed: {e}");
                        let mut s = state_flush
                            .lock()
                            .unwrap_or_else(|poison| poison.into_inner());
                        s.dirty = true;
                    }
                })
                .expect("spawn flush thread");

            // ------------------------------------------------------
            // 1Hz 統計プッシュスレッド
            // ------------------------------------------------------
            // ウィンドウ非表示中は emit をスキップ。トレイ常駐時には
            // 完全に静かになる (IPC トラフィックゼロ)。
            let state_emit = Arc::clone(&state_arc);
            let handle_emit = app_handle.clone();
            thread::Builder::new()
                .name("clack-emit".into())
                .spawn(move || loop {
                    thread::sleep(EMIT_INTERVAL);
                    let Some(win) = handle_emit.get_webview_window("main") else { continue; };
                    if !win.is_visible().unwrap_or(false) { continue; }
                    let payload = {
                        let s = state_emit
                            .lock()
                            .unwrap_or_else(|poison| poison.into_inner());
                        TodayPayload {
                            date: s.today.clone(),
                            keys: s.today_stats.keys,
                            mouse: s.today_stats.mouse,
                            active_ms: s.today_stats.active_ms,
                            mouse_distance_px: s.today_stats.mouse_distance_px,
                            scroll_y_ticks: s.today_stats.scroll_y_ticks,
                        }
                    };
                    let _ = handle_emit.emit("stats-updated", payload);
                })
                .expect("spawn emit thread");

            // ウィンドウを開くべきかの判定:
            //   - 初回起動            → 必ず開く (ユーザーへの存在通知)
            //   - 自動起動 (--minimized) → 開かない (トレイ常駐のみ)
            //   - 手動起動 (ダブルクリック等) → 開く
            // これにより「アイコンをダブルクリックしても何も起こらない」
            // という UX 不良が起きない。
            let started_minimized = std::env::args().any(|a| a == "--minimized");
            if first_run || !started_minimized {
                if let Some(win) = app_handle.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }

            Ok(())
        });

    // ここでの失敗は「バイナリ自体が壊れている (アイコン欠落・権限
    // 設定の typo 等)」を意味し、ユーザー操作で復旧不可能なので
    // 派手に死ぬ。
    #[allow(clippy::expect_used)]
    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        // 正常終了時の最終フラッシュ。
        // Tauri 2 の RunEvent は non_exhaustive のため `if let` で必要分のみ捕捉。
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            let explicit_exit = app_handle
                .try_state::<ExitState>()
                .map(|state| state.is_requested())
                .unwrap_or(false);

            if !explicit_exit {
                api.prevent_exit();
                hide_all_windows(app_handle);
                return;
            }

            if let (Some(state), Some(paths)) = (
                app_handle.try_state::<AppStateHandle>(),
                app_handle.try_state::<AppPaths>(),
            ) {
                let snapshot = state
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner())
                    .snapshot_all();
                if let Err(e) = storage::write_atomic(&paths.data_path, &snapshot) {
                    eprintln!("final flush failed: {e}");
                }
            }
        }
    });
}
