// SPDX-License-Identifier: MIT
//! フロントエンド (WebView) に公開する IPC コマンド一式。
//!
//! 【信頼モデル】
//! ここで定義したコマンドは `index.html` / `settings.html` の JS から
//! `invoke()` で呼び出せる。両ページとも以下を満たすため、外部サイトから
//! このコマンド群に到達する経路は存在しない:
//!   - バイナリに同梱された静的アセットのみ。
//!   - `tauri://` プロトコル経由で配信される。
//!   - 厳格な CSP (`tauri.conf.json::app.security.csp`) が適用される。
//!
//! それでも各コマンドの引数は **信頼できない入力** として扱い、
//! 改ざんに強い形に検証してから副作用 (ディスク書き込み等) を起こす:
//!   - 日付文字列は [`date_util::parse_date`] で厳密パース。
//!   - 年月文字列は長さ・区切り位置を確認。
//!   - 設定値は [`Settings::validate`] を通してから書き込み。
//!   - 範囲指定は [`MAX_RANGE_DAYS`] 日で頭打ち。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::counter::{AppState, DayStats};
use crate::date_util;
use crate::settings::Settings;
use crate::storage;
use crate::tray::AppPaths;

/// 入力イベントカウンタ・スレッド共有状態のエイリアス。
pub type AppStateHandle = Arc<Mutex<AppState>>;

/// 設定キャッシュ。ディスクが正となるが、毎回読み直さないためメモリにも持つ。
pub type SettingsHandle = Arc<Mutex<Settings>>;

/// `get_stats_range` が許す日数の上限。
/// ヒートマップは最大 12 か月分しか出さないので、5 年分あれば十分。
const MAX_RANGE_DAYS: i64 = 365 * 5;

/// `get_month_total` が受け付ける `YYYY-MM` 文字列の正しい長さ。
const YEAR_MONTH_LEN: usize = 7;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TodayPayload {
    pub date: String,
    pub keys: u64,
    pub mouse: u64,
    /// 今日のアクティブ時間 (ms)。
    pub active_ms: u64,
    /// 今日のマウス累積移動距離 (ピクセル)。
    pub mouse_distance_px: u64,
    /// 今日のスクロール累計ティック (絶対値)。
    pub scroll_y_ticks: u64,
}

#[derive(Serialize)]
pub struct DayEntry {
    pub date: String,
    pub keys: u64,
    pub mouse: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthTotal {
    pub year_month: String,
    pub keys: u64,
    pub mouse: u64,
}

/// 永続データの規模 (設定画面の「保存データ」行の表示用)。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataSize {
    /// `data.json` のサイズ。存在しなければ 0。
    pub bytes: u64,
    /// 記録のある日数 (今日が 0/0 でなければ +1)。
    pub days: u64,
}

/// 分析タブが 1 回の IPC で取得する集計結果。
/// 全集計は AppState のロックを 1 回取って行うので、内訳と時間帯を分けて
/// 2 回ロックを取るより整合性が高い (途中で history が変わらない)。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Analytics {
    /// データのある日数 (今日含む)。0 ならフロントは「データなし」を出す。
    pub days: u64,
    /// キー内訳 (label, count) を降順。最大 30 件。
    pub keys: Vec<LabelCount>,
    /// マウス内訳 (label, count) を降順。Left/Right/Middle のみ。
    pub mouse: Vec<LabelCount>,
    /// スコープ内の 1 日あたり平均総操作数。
    pub average_per_day: u64,
    /// 時間帯別 (0..23 時) の活動量合計。スコープ内の全日を合算済み。
    pub hourly: Vec<u64>,
    /// `hourly` の中の最大値。フロントで色階調の正規化に使う。
    pub hourly_max: u64,
    /// スコープ内のマウス累積移動距離 (ピクセル)。フロントで m / km に換算。
    pub mouse_distance_px: u64,
    /// スコープ内の縦スクロール累計 (絶対値ティック)。フロントで m / km に換算。
    pub scroll_y_ticks: u64,
    /// スコープ内のアクティブ時間 (ms)。
    pub active_ms: u64,
}

#[derive(Serialize)]
pub struct LabelCount {
    pub label: String,
    pub count: u64,
}

/// エクスポートファイルの構造体 (バージョン付き)。
/// 将来の互換性のため `version` を必ず確認する。
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportEnvelope {
    /// スキーマバージョン。現状は 1。
    pub version: u32,
    /// `"clack-export"` を必ず含むマーカ。誤読込防止。旧名
    /// `"clickcounter-export"` のファイルも `import_data` 側で受け付ける。
    pub format: String,
    /// エクスポート日時 (ISO 8601 文字列)。情報目的。
    pub exported_at: String,
    /// 日次データ。`storage::Data` と同形。
    pub data: HashMap<String, DayStats>,
    /// 設定 (任意)。インポート時にコピーするかはフロントで選択。
    #[serde(default)]
    pub settings: Option<Settings>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    /// 取り込んだ日数。
    pub days: u64,
    /// 取り込んだファイルのフルパス (UI 通知用)。
    pub path: String,
}

/// Mutex ポイズン化からの回復ヘルパ。`unwrap()` だと一度誰かが panic
/// しただけで IPC 全体が止まるので、内部値を取り出して継続する方針。
/// AppState の不変条件は単純なので、回復したデータも実用上問題ない。
fn lock_state(state: &AppStateHandle) -> std::sync::MutexGuard<'_, AppState> {
    state.lock().unwrap_or_else(|e| e.into_inner())
}

fn lock_settings(s: &SettingsHandle) -> std::sync::MutexGuard<'_, Settings> {
    s.lock().unwrap_or_else(|e| e.into_inner())
}

// ----------------------------------------------------------------
// 集計の取得
// ----------------------------------------------------------------

/// 今日のライブカウンタ。UI 起動時と 1Hz の自動 emit から呼ばれる。
#[tauri::command]
pub fn get_today_stats(state: State<'_, AppStateHandle>) -> TodayPayload {
    let s = lock_state(&state);
    TodayPayload {
        date: s.today.clone(),
        keys: s.today_stats.keys,
        mouse: s.today_stats.mouse,
        active_ms: s.today_stats.active_ms,
        mouse_distance_px: s.today_stats.mouse_distance_px,
        scroll_y_ticks: s.today_stats.scroll_y_ticks,
    }
}

/// 区間 `[start, end]` (両端含む) の日次集計を返す。
/// ヒートマップ・リストビューの両方で使う。
#[tauri::command]
pub fn get_stats_range(
    state: State<'_, AppStateHandle>,
    start: String,
    end: String,
) -> Result<Vec<DayEntry>, String> {
    let s_date = date_util::parse_date(&start).ok_or_else(|| "invalid start date".to_string())?;
    let e_date = date_util::parse_date(&end).ok_or_else(|| "invalid end date".to_string())?;
    if e_date < s_date {
        return Err("end before start".into());
    }
    if (e_date - s_date).whole_days() > MAX_RANGE_DAYS {
        return Err("range too large".into());
    }
    let dates = date_util::date_range(s_date, e_date);
    let s = lock_state(&state);
    let out = dates
        .into_iter()
        .map(|d| {
            let ds = date_util::format_date(d);
            let stats = s.get_stats(&ds);
            DayEntry {
                date: ds,
                keys: stats.keys,
                mouse: stats.mouse,
            }
        })
        .collect();
    Ok(out)
}

/// 当月合計 (フッターの「当月 ・ N 打鍵 ・ M クリック」用)。
/// `year_month` は `YYYY-MM` 形式の文字列を期待する。
#[tauri::command]
pub fn get_month_total(
    state: State<'_, AppStateHandle>,
    year_month: String,
) -> Result<MonthTotal, String> {
    // 厳格に: 長さ 7 で 5 文字目が `-`。UTF-8 マルチバイトに掛からないよう
    // is_char_boundary も確認する。
    if year_month.len() != YEAR_MONTH_LEN
        || !year_month.is_char_boundary(4)
        || &year_month[4..5] != "-"
    {
        return Err("expected YYYY-MM".into());
    }
    let prefix = format!("{year_month}-");
    let s = lock_state(&state);
    let mut keys: u64 = 0;
    let mut mouse: u64 = 0;
    for (k, v) in s.history.iter() {
        if k.starts_with(&prefix) {
            keys = keys.saturating_add(v.keys);
            mouse = mouse.saturating_add(v.mouse);
        }
    }
    if s.today.starts_with(&prefix) {
        keys = keys.saturating_add(s.today_stats.keys);
        mouse = mouse.saturating_add(s.today_stats.mouse);
    }
    Ok(MonthTotal { year_month, keys, mouse })
}

// ----------------------------------------------------------------
// 設定の取得・更新
// ----------------------------------------------------------------

#[tauri::command]
pub fn get_settings(settings: State<'_, SettingsHandle>) -> Settings {
    lock_settings(&settings).clone()
}

/// 設定を検証してからメモリ反映 → ディスク書き込みする。
/// アイドル閾値はその場で計数スレッドに反映される (アプリ再起動不要)。
#[tauri::command]
pub fn update_settings(
    new_settings: Settings,
    state: State<'_, AppStateHandle>,
    settings: State<'_, SettingsHandle>,
    paths: State<'_, AppPaths>,
) -> Result<(), String> {
    new_settings.validate()?;
    lock_state(&state).set_idle_threshold(new_settings.idle_threshold_seconds);
    {
        let mut s = lock_settings(&settings);
        *s = new_settings.clone();
    }
    new_settings
        .write(&paths.settings_path)
        .map_err(|e| e.to_string())
}

// ----------------------------------------------------------------
// 自動起動 (tauri-plugin-autostart 経由)
// ----------------------------------------------------------------

#[tauri::command]
pub fn get_autostart_enabled(app: AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

/// 自動起動の ON/OFF を切替。
/// プラグインが OS 側 (Windows: レジストリ Run キー / macOS: LaunchAgent)
/// に書き込み、同時に `settings.json` へユーザーの意思として保存する。
#[tauri::command]
pub fn set_autostart_enabled(
    app: AppHandle,
    enabled: bool,
    settings: State<'_, SettingsHandle>,
    paths: State<'_, AppPaths>,
) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let res = if enabled {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    };
    res.map_err(|e| e.to_string())?;
    {
        let mut s = lock_settings(&settings);
        s.background_start_enabled = enabled;
        s.write(&paths.settings_path).map_err(|e| e.to_string())?;
    }
    crate::tray::update_autostart_check(&app, enabled);
    Ok(())
}

// ----------------------------------------------------------------
// ウィンドウ制御
// ----------------------------------------------------------------
// いずれも対象ウィンドウが存在しない場合は no-op。panic しない・
// 想定外の作用を起こさない。

#[tauri::command]
pub fn show_main_window(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn hide_main_window(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        win.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn open_settings_window(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("settings") {
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn close_settings_window(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("settings") {
        win.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ----------------------------------------------------------------
// 永続データの確認・削除
// ----------------------------------------------------------------

/// `data.json` のディスク占有量と記録日数。設定画面の表示用。
/// ファイルが無い場合は両方 0 を返す (エラーにはしない)。
#[tauri::command]
pub fn get_data_size(
    state: State<'_, AppStateHandle>,
    paths: State<'_, AppPaths>,
) -> DataSize {
    let bytes = std::fs::metadata(&paths.data_path)
        .map(|m| m.len())
        .unwrap_or(0);
    let s = lock_state(&state);
    let mut days = s.history.len() as u64;
    if s.today_stats != DayStats::default() {
        days = days.saturating_add(1);
    }
    DataSize { bytes, days }
}

/// 全集計を破棄してファイルも削除する。
/// メインウィンドウには `data-cleared` を emit して即時再描画させる。
#[tauri::command]
pub fn clear_data(
    app: AppHandle,
    state: State<'_, AppStateHandle>,
    paths: State<'_, AppPaths>,
) -> Result<(), String> {
    lock_state(&state).clear_all();
    if paths.data_path.exists() {
        std::fs::remove_file(&paths.data_path).map_err(|e| e.to_string())?;
    }
    let _ = app.emit("data-cleared", ());
    Ok(())
}

// ----------------------------------------------------------------
// 分析 (内訳 + 時間帯 + パーソナルベスト + ストリーク)
// ----------------------------------------------------------------

/// 分析タブ用の集計を 1 回の IPC で返す。
///
/// `scope` で集計範囲を絞り込む:
///   - `"today"` 今日だけ
///   - `"week"`  今日含む直近 7 日間
///   - `"month"` 今月 (YYYY-MM)
///   - その他 / 未指定: 全期間
///
/// ロックは 1 回しか取らないので、集計中に履歴の状態が部分的にずれる
/// ことは無い (フラッシュスレッド等と同じ Mutex)。
/// 集計コストは O(days × 平均キー種類数) で、365 日 × 50 種類 ≈ 18k
/// イテレーション程度に収まる。トレイ常駐中は呼ばれないので問題ない。
#[tauri::command]
pub fn get_analytics(
    state: State<'_, AppStateHandle>,
    scope: Option<String>,
) -> Analytics {
    let s = lock_state(&state);
    let scope_str = scope.unwrap_or_else(|| "all".to_string());

    // スコープ判定に使う基準値を事前に作る (各日について再計算しない)。
    let today_str = s.today.clone();
    let today_date = date_util::parse_date(&today_str);
    let month_prefix: String = today_str.chars().take(7).collect();
    let week_start = today_date.and_then(|d| d.checked_sub(time::Duration::days(6)));

    let in_scope = |date_str: &str| -> bool {
        match scope_str.as_str() {
            "today" => date_str == today_str,
            "month" => date_str.starts_with(&month_prefix),
            "week" => match (week_start, today_date, date_util::parse_date(date_str)) {
                (Some(ws), Some(td), Some(d)) => d >= ws && d <= td,
                _ => false,
            },
            _ => true,
        }
    };

    let mut keys_total = 0u64;
    let mut mouse_total = 0u64;
    let mut keys_map: HashMap<String, u64> = HashMap::new();
    let mut mouse_map: HashMap<String, u64> = HashMap::new();
    // hourly[0..23]: スコープ内の全日を時間帯ごとに合算した値。
    let mut hourly = vec![0u64; 24];
    let mut day_count = 0u64;
    // 「旅」用の累計値。スコープ内全日を足す。
    let mut mouse_distance_px_total = 0u64;
    let mut scroll_y_ticks_total = 0u64;
    let mut active_ms_total = 0u64;

    let mut consume = |_date_str: &str, stats: &DayStats| {
        let total = stats.keys.saturating_add(stats.mouse);
        if total > 0 {
            day_count = day_count.saturating_add(1);
        }
        keys_total = keys_total.saturating_add(stats.keys);
        mouse_total = mouse_total.saturating_add(stats.mouse);
        for (k, v) in &stats.key_breakdown {
            let entry = keys_map.entry(k.clone()).or_insert(0);
            *entry = entry.saturating_add(*v);
        }
        for (k, v) in &stats.mouse_breakdown {
            let entry = mouse_map.entry(k.clone()).or_insert(0);
            *entry = entry.saturating_add(*v);
        }
        for (h, &v) in stats.hourly.iter().enumerate() {
            hourly[h] = hourly[h].saturating_add(v);
        }
        mouse_distance_px_total =
            mouse_distance_px_total.saturating_add(stats.mouse_distance_px);
        scroll_y_ticks_total =
            scroll_y_ticks_total.saturating_add(stats.scroll_y_ticks);
        active_ms_total =
            active_ms_total.saturating_add(stats.active_ms);
    };

    for (date_str, stats) in s.history.iter() {
        if in_scope(date_str) {
            consume(date_str, stats);
        }
    }
    if in_scope(&s.today) {
        consume(&s.today, &s.today_stats);
    }

    let mut keys: Vec<LabelCount> = keys_map
        .into_iter()
        .map(|(label, count)| LabelCount { label, count })
        .collect();
    keys.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.label.cmp(&b.label)));
    keys.truncate(30);

    let mut mouse: Vec<LabelCount> = mouse_map
        .into_iter()
        .map(|(label, count)| LabelCount { label, count })
        .collect();
    mouse.sort_by(|a, b| b.count.cmp(&a.count));

    let hourly_max = hourly.iter().copied().max().unwrap_or(0);
    let total_actions = keys_total.saturating_add(mouse_total);
    let average_per_day = if day_count > 0 { total_actions / day_count } else { 0 };

    Analytics {
        days: day_count,
        keys,
        mouse,
        average_per_day,
        hourly,
        hourly_max,
        mouse_distance_px: mouse_distance_px_total,
        scroll_y_ticks: scroll_y_ticks_total,
        active_ms: active_ms_total,
    }
}

// ----------------------------------------------------------------
// 一時停止 (runtime のみ。再起動で OFF に戻る)
// ----------------------------------------------------------------

#[tauri::command]
pub fn get_paused(state: State<'_, AppStateHandle>) -> bool {
    lock_state(&state).paused
}

/// 一時停止状態を切り替える。トレイメニュー / 設定 / メイン UI から呼ばれる。
/// 同期させる先は (a) トレイの check item と tooltip、 (b) 他ウィンドウ。
#[tauri::command]
pub fn set_paused(
    app: AppHandle,
    state: State<'_, AppStateHandle>,
    paused: bool,
) -> Result<(), String> {
    lock_state(&state).set_paused(paused);
    crate::tray::update_paused_state(&app, paused);
    let _ = app.emit("paused-changed", paused);
    Ok(())
}

// ----------------------------------------------------------------
// リアルタイム入力表示 (live overlay)
// ----------------------------------------------------------------

#[tauri::command]
pub fn get_live_display(state: State<'_, AppStateHandle>) -> bool {
    lock_state(&state).live_display
}

/// リアルタイム入力表示モードを切替える。
/// - state.live_display を更新 (これで rdev リスナーが emit を始める/止める)
/// - live ウィンドウを show/hide。show 時は click-through を再適用して
///   ユーザー作業を邪魔しないようにする
/// - トレイ check item と他ウィンドウを同期
#[tauri::command]
pub fn set_live_display(
    app: AppHandle,
    state: State<'_, AppStateHandle>,
    enabled: bool,
) -> Result<(), String> {
    lock_state(&state).set_live_display(enabled);
    if let Some(win) = app.get_webview_window("live") {
        if enabled {
            win.show().map_err(|e| e.to_string())?;
        } else {
            win.hide().map_err(|e| e.to_string())?;
        }
    }
    crate::tray::update_live_display_check(&app, enabled);
    let _ = app.emit("live-display-changed", enabled);
    Ok(())
}

// ----------------------------------------------------------------
// エクスポート / インポート (tauri-plugin-dialog 経由)
// ----------------------------------------------------------------
// 設計メモ:
//  - ダイアログ操作は非同期コールバックなので、`std::sync::mpsc` で
//    1 ショット待機する。
//  - エクスポートは「保存ダイアログでパス選択 → AppState スナップショット
//    を pretty JSON で書き込む」。プログレスは出さず、終わったらフロントに
//    パスを返す。
//  - インポートは「ファイル選択 → JSON 読込 → 検証 (format/version) →
//    AppState を置換 → disk に即書き込み → `data-cleared` emit」。
//    部分マージは複雑化を避けるため非対応 (将来案)。

fn current_iso8601() -> String {
    use time::macros::format_description;
    let fmt = format_description!(
        "[year]-[month]-[day]T[hour]:[minute]:[second]Z"
    );
    time::OffsetDateTime::now_utc()
        .format(&fmt)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

/// 日次データを CSV にシリアライズする。
/// 列: `date,keys,mouse,total` + 時間帯別 `h0..h23` (各時の活動量)。
/// 日付の昇順で出力するので Excel / pandas で時系列分析しやすい。
/// CSV インジェクション対策として、安全な数値・ISO 日付しか書かないが、
/// 念のため値内のカンマや改行は含まれないことを serialize 前提として
/// 保証している (date_util::format_date / u64)。
fn serialize_csv(data: &HashMap<String, DayStats>) -> String {
    let mut keys: Vec<&String> = data.keys().collect();
    keys.sort();
    let mut header = String::from("date,keys,mouse,total");
    for h in 0..24 {
        header.push_str(&format!(",h{h}"));
    }
    let mut out = header;
    out.push('\n');
    for k in keys {
        let s = &data[k];
        let total = s.keys.saturating_add(s.mouse);
        out.push_str(&format!("{},{},{},{}", k, s.keys, s.mouse, total));
        for h in 0..24 {
            out.push(',');
            out.push_str(&s.hourly[h].to_string());
        }
        out.push('\n');
    }
    out
}

/// 全データをエクスポートする。形式は **呼び出し側で明示** する:
///   - `format == "csv"` → 表計算向け CSV (date,keys,mouse,total,h0..h23)
///   - それ以外 (`"json"` または未指定) → 完全 JSON エンベロープ
///
/// 形式に応じてダイアログのフィルタとデフォルトファイル名を切替える。
/// ユーザーがダイアログをキャンセルしたときは `Ok(None)` を返す。
#[tauri::command]
pub fn export_data(
    app: AppHandle,
    state: State<'_, AppStateHandle>,
    settings: State<'_, SettingsHandle>,
    format: Option<String>,
) -> Result<Option<String>, String> {
    let is_csv = matches!(format.as_deref(), Some("csv"));

    // スナップショットはロック保持時間を最短にするためここで取り切る。
    let (data, settings_snap) = {
        let s = lock_state(&state);
        let st = lock_settings(&settings);
        (s.snapshot_all(), st.clone())
    };

    let (filter_label, filter_ext, default_name) = if is_csv {
        ("CSV", "csv", "clack-backup.csv")
    } else {
        ("JSON", "json", "clack-backup.json")
    };

    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .add_filter(filter_label, &[filter_ext])
        .set_file_name(default_name)
        .save_file(move |fp| {
            let _ = tx.send(fp);
        });
    let chosen = rx.recv().map_err(|e| e.to_string())?;
    let Some(file_path) = chosen else {
        return Ok(None);
    };
    let path = file_path.into_path().map_err(|e| e.to_string())?;

    let bytes: Vec<u8> = if is_csv {
        serialize_csv(&data).into_bytes()
    } else {
        let envelope = ExportEnvelope {
            version: 1,
            format: "clack-export".to_string(),
            exported_at: current_iso8601(),
            data,
            settings: Some(settings_snap),
        };
        serde_json::to_vec_pretty(&envelope).map_err(|e| e.to_string())?
    };
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;

    Ok(Some(path.display().to_string()))
}

/// インポートは現在のデータを **置換** する。
/// 部分マージはユーザーの期待が割れやすいので非対応。
#[tauri::command]
pub fn import_data(
    app: AppHandle,
    state: State<'_, AppStateHandle>,
    paths: State<'_, AppPaths>,
) -> Result<Option<ImportResult>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .add_filter("JSON", &["json"])
        .pick_file(move |fp| {
            let _ = tx.send(fp);
        });
    let chosen = rx.recv().map_err(|e| e.to_string())?;
    let Some(file_path) = chosen else {
        return Ok(None);
    };
    let path = file_path.into_path().map_err(|e| e.to_string())?;

    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let envelope: ExportEnvelope = serde_json::from_str(&text)
        .map_err(|e| format!("ファイルが JSON として解釈できません: {e}"))?;

    // 旧名 `clickcounter-export` のファイルも受け付ける (移行救済)。
    if envelope.format != "clack-export" && envelope.format != "clickcounter-export" {
        return Err("Clack のエクスポートファイルではありません".into());
    }
    if envelope.version != 1 {
        return Err(format!(
            "未対応のバージョンです: {} (このアプリは 1 まで)",
            envelope.version
        ));
    }
    // 各日付キーの妥当性を確認する (壊れた値で AppState を汚さない)。
    for k in envelope.data.keys() {
        if date_util::parse_date(k).is_none() {
            return Err(format!("不正な日付キー: {k}"));
        }
    }

    let days = envelope.data.len() as u64;

    // 置換 → 即フラッシュ。プロセス停止しても確実に残るよう
    // フラッシュスレッドの周期を待たない。
    let snapshot = {
        let mut s = lock_state(&state);
        let today = s.today.clone();
        let mut data = envelope.data;
        let today_stats = data.remove(&today).unwrap_or_default();
        s.today_stats = today_stats;
        s.history = data;
        // 物理的に押下中のキーセット (`pressed`) はそのままで OK。
        // 履歴データの置換は「いま手の上にあるキーが何か」と独立しており、
        // 直後の KeyRelease は remove で no-op、新しい KeyPress は insert で
        // 通常通り計数される。
        s.dirty = false;
        s.snapshot_all()
    };
    storage::write_atomic(&paths.data_path, &snapshot).map_err(|e| e.to_string())?;

    let _ = app.emit("data-cleared", ());

    Ok(Some(ImportResult {
        days,
        path: path.display().to_string(),
    }))
}

/// フラッシュ + 終了。`lib.rs::run` の ExitRequested ハンドラでも同じ
/// フラッシュを行うが、ここで先に書き込むことで「終了」操作の体感が
/// 速くなる (Tauri ランタイム破棄を待たずにファイルが書ける)。
#[tauri::command]
pub fn quit_app(
    app: AppHandle,
    state: State<'_, AppStateHandle>,
    paths: State<'_, AppPaths>,
) {
    let snapshot = lock_state(&state).snapshot_all();
    if let Err(e) = storage::write_atomic(&paths.data_path, &snapshot) {
        eprintln!("final flush failed: {e}");
    }
    if let Some(exit) = app.try_state::<crate::ExitState>() {
        exit.request_exit();
    }
    app.exit(0);
}
