// SPDX-License-Identifier: MIT
//! キー / マウス入力の計数とアプリ全体の状態管理。
//!
//! 本モジュールは **プライバシー上もっとも重要なホットパス** を持つ。
//! OS から届くすべての入力イベントを観測するため、以下の不変条件を守る:
//!
//! 1. **外部送信は一切しない。** クレート全体でネットワーク呼び出しは存在
//!    しない。集計と内訳は端末ローカルの `data.json` だけに保存する。
//! 2. **キーの種別 (key_breakdown) / マウスボタン種別 (mouse_breakdown) は
//!    将来分析機能のために保持する**。ただし UI 表示はせず、流出経路も
//!    持たない。記録順序・打鍵間隔・アクティブアプリ等は記録しないため、
//!    記録内容から入力テキストを復元することは不可能。
//! 3. **`handle_event` では panic しない。** 100Hz 規模で呼ばれるホット
//!    パスのため、`saturating_add` と網羅的マッチで panic を構文的に
//!    排除している。これが破られると `Mutex<AppState>` がポイズン化し、
//!    後続イベントを取りこぼす。

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use rdev::{Button, Event, EventType, Key};
use serde::{Deserialize, Serialize};

/// 1 日分の集計結果。`data.json` に 1 日 1 エントリで保存される。
///
/// - `keys` / `mouse`: 合計値。UI のヘッダーに表示。
/// - `key_breakdown` / `mouse_breakdown`: キーコード別・ボタン別の内訳。
///   分析タブで Top N として表示する。
/// - `hourly`: 0〜23 時の時間帯別アクティビティ (keys + mouse の合計)。
///   分析タブの時間帯ヒートマップで使用。
///
/// JSON は camelCase (`keyBreakdown`, `mouseBreakdown`, `hourly`) で
/// 書き出される。古いフォーマット (該当フィールドが無い) からの読込にも
/// 対応するため `#[serde(default)]` を付与している。
/// 全 0 配列は容量節約のため出力を省略する。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DayStats {
    pub keys: u64,
    pub mouse: u64,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub key_breakdown: HashMap<String, u64>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub mouse_breakdown: HashMap<String, u64>,
    #[serde(default = "zero_hourly", skip_serializing_if = "is_zero_hourly")]
    pub hourly: [u64; 24],
    /// アクティブ時間 (ms)。idle 復帰や `paused` 中は加算されない。
    /// イベント間の経過時間 (≤ idle_threshold) を逐次足したもの。
    #[serde(default, skip_serializing_if = "u64_is_zero")]
    pub active_ms: u64,
    /// マウスカーソルの累積移動距離 (ピクセル)。
    /// 「今日マウスで歩いた距離」の素データ。フロントで m / km に換算する。
    #[serde(default, skip_serializing_if = "u64_is_zero")]
    pub mouse_distance_px: u64,
    /// 縦スクロールのホイールティック累計 (絶対値の和)。
    /// 「上下に旅した距離」を出すため、向きは無視して累積する。
    #[serde(default, skip_serializing_if = "u64_is_zero")]
    pub scroll_y_ticks: u64,
    /// 横スクロールのホイールティック累計 (絶対値の和)。
    #[serde(default, skip_serializing_if = "u64_is_zero")]
    pub scroll_x_ticks: u64,
}

fn zero_hourly() -> [u64; 24] { [0; 24] }
fn is_zero_hourly(a: &[u64; 24]) -> bool { a.iter().all(|&v| v == 0) }
fn u64_is_zero(v: &u64) -> bool { *v == 0 }

impl Default for DayStats {
    fn default() -> Self {
        Self {
            keys: 0,
            mouse: 0,
            key_breakdown: HashMap::new(),
            mouse_breakdown: HashMap::new(),
            hourly: zero_hourly(),
            active_ms: 0,
            mouse_distance_px: 0,
            scroll_y_ticks: 0,
            scroll_x_ticks: 0,
        }
    }
}

/// アプリ全体の可変状態。複数スレッドで共有するため、外側で
/// `Mutex<AppState>` にくるんで管理される。
///
/// **ロック規律**: どの利用者も「ロック取得 → 短い処理 → 解放」を徹底し、
/// ロック保持中の I/O は行わない (定期フラッシュも snapshot を取って
/// ロックを解放してから書き込む)。
pub struct AppState {
    /// 現在計数中の日付 ("YYYY-MM-DD")。
    pub today: String,

    /// `today` のライブカウンタ。日付変更時に `history` に移動する。
    pub today_stats: DayStats,

    /// 過去日の集計。`today` のエントリはここには持たない。
    pub history: HashMap<String, DayStats>,

    /// 現在押下中の物理キー集合。**永続化しない**。
    /// オートリピート (同じキーの連続 KeyPress) を 1 回扱いにするため
    /// だけに使う。アイドル復帰時は中身を破棄する (KeyRelease を
    /// 取りこぼした古い状態が残るのを防ぐ)。
    pressed: HashSet<Key>,

    /// 最後に観測した入力時刻。アイドル判定に使用。
    last_input: Instant,

    /// アイドル判定の閾値 (秒数)。設定で変更可能。
    pub idle_threshold: Duration,

    /// 何らかの変更が入ったか。フラッシュ後に false に戻す。
    /// ディスク I/O を必要最小に抑えるためのフラグ。
    pub dirty: bool,

    /// 一時停止フラグ。true の間、`handle_event` は全イベントを破棄して
    /// カウントしない。プロセスを跨いで永続化はしない (起動時は常に
    /// false。ユーザーが意図しないまま計測が止まり続ける事故を防ぐため)。
    pub paused: bool,

    /// リアルタイム入力表示モード。true の間、`handle_event` は計数した
    /// キー/マウスを `LiveKeyEvent` として返し、呼び出し側が live ウィンドウ
    /// に emit する。OFF だと `handle_event` の戻り値は常に None。
    /// プロセス跨ぎ永続化はしない (パスワード等を露出させる機能なので、
    /// 起動時は必ず OFF)。
    pub live_display: bool,

    /// 押下中で **まだ単体チップとして emit されていない** 修飾キー名集合。
    /// `Shift` を押した瞬間はここに積み、その後に非修飾キーが来れば
    /// 「Shift+1」のように結合 emit して `pending` から消す。
    /// 修飾キーが単独でリリースされたときに初めて単独チップ「Shift」を出す。
    /// これで「Shift」と「Shift+1」が二重に出る重複を避けつつ、修飾キー
    /// 単体使用 (例えばかな入力切替) も拾える。
    pending_modifiers: HashSet<&'static str>,

    /// 直前の MouseMove 座標。距離の差分計算に使う。
    /// アイドル復帰時 / 一時停止解除時には `None` にして「最初の一手」で
    /// 不当に大きな距離が積まれないようリセットする。
    last_mouse_pos: Option<(f64, f64)>,
}

/// 即時表示用に出すイベント。`handle_event` の戻り値。
/// `kind` は `"key" | "mouse"` の 2 種。`label` は rdev のキー識別子文字列
/// (`KeyA`, `Space`, `ShiftLeft` 等) またはマウスボタン名 (`Left`, `Right`,
/// `Middle`)。フロント側でユーザー向けに整形する。
#[derive(Debug, Clone, Serialize)]
pub struct LiveKeyEvent {
    pub kind: &'static str,
    pub label: String,
}

/// 修飾キーを「Ctrl / Shift / Alt / AltGr / Meta」の正規化ラベルにする。
/// 左右どちらの物理キーでも同じラベルにすることで、`Shift+1` と
/// `Shift R+1` を同一視できる。
fn modifier_label(key: Key) -> Option<&'static str> {
    match key {
        Key::ShiftLeft | Key::ShiftRight => Some("Shift"),
        Key::ControlLeft | Key::ControlRight => Some("Ctrl"),
        Key::Alt => Some("Alt"),
        Key::AltGr => Some("AltGr"),
        Key::MetaLeft | Key::MetaRight => Some("Meta"),
        _ => None,
    }
}

/// マウスボタンを安定したラベルに変換する。
/// サイドボタン (Unknown) は意図的に **カウントしない** —
/// ゲーミングマウスごとに値がブレるため。
fn mouse_button_label(button: Button) -> Option<&'static str> {
    match button {
        Button::Left => Some("Left"),
        Button::Right => Some("Right"),
        Button::Middle => Some("Middle"),
        _ => None,
    }
}

impl AppState {
    /// 新しいアプリ状態を構築する。
    ///
    /// 起動時、`history` に当日のエントリがあればそれを `today_stats` に
    /// 引き上げ、ライブ計数を中断地点から再開できるようにする。
    pub fn new(
        today: String,
        mut history: HashMap<String, DayStats>,
        idle_threshold_seconds: u64,
    ) -> Self {
        let today_stats = history.remove(&today).unwrap_or_default();
        Self {
            today,
            today_stats,
            history,
            pressed: HashSet::new(),
            last_input: Instant::now(),
            idle_threshold: Duration::from_secs(idle_threshold_seconds),
            dirty: false,
            paused: false,
            live_display: false,
            pending_modifiers: HashSet::new(),
            last_mouse_pos: None,
        }
    }

    /// 現在押下中の修飾キーを正規順 `Ctrl+Shift+Alt+AltGr+Meta` でラベル化。
    /// 1 つも押されていなければ空文字を返す。
    fn held_modifiers_label(&self) -> String {
        let mut parts: Vec<&'static str> = Vec::new();
        let has = |label: &'static str| -> bool {
            self.pressed.iter().any(|k| modifier_label(*k) == Some(label))
        };
        if has("Ctrl")  { parts.push("Ctrl"); }
        if has("Shift") { parts.push("Shift"); }
        if has("Alt")   { parts.push("Alt"); }
        if has("AltGr") { parts.push("AltGr"); }
        if has("Meta")  { parts.push("Meta"); }
        parts.join("+")
    }

    /// 一時停止状態を切替える。OFF にした瞬間に最初の入力を「アイドル
    /// 復帰」として破棄しないよう、`last_input` を直近に更新する。
    /// マウス座標も無効化して、再開後の最初の MouseMove で大ジャンプ
    /// を計上しないようにする。
    pub fn set_paused(&mut self, paused: bool) {
        self.paused = paused;
        if !paused {
            self.last_input = Instant::now();
            self.pressed.clear();
            self.last_mouse_pos = None;
        }
    }

    /// リアルタイム表示モードを切替える。
    pub fn set_live_display(&mut self, on: bool) {
        self.live_display = on;
    }

    /// アイドル閾値を実行中に差し替える (設定 UI から呼ばれる)。
    pub fn set_idle_threshold(&mut self, secs: u64) {
        self.idle_threshold = Duration::from_secs(secs);
    }

    /// 全集計を破棄して初期状態に戻す (設定 UI の「削除」)。
    /// 永続化ファイルの削除は呼び出し側 (commands::clear_data) が行う。
    /// `dirty = false` にしておくことで、直後の定期フラッシュが
    /// 空データでファイルを再生成してしまうのを防ぐ。
    pub fn clear_all(&mut self) {
        self.today_stats = DayStats::default();
        self.history.clear();
        self.pressed.clear();
        self.pending_modifiers.clear();
        self.last_mouse_pos = None;
        self.dirty = false;
    }

    /// 1 件の rdev イベントを処理する。
    ///
    /// 契約:
    /// - panic しない (`saturating_add` + 網羅 match)。
    /// - 関数を超えるリソースを保持しない。
    /// - rdev のリスナースレッドをブロックしないよう、極力高速に戻る。
    ///
    /// `format!("{key:?}")` でキー名を String 化しているのは、
    /// 100 行超の手書きマッピングを避けるためのトレードオフ。実速度
    /// (≤ 30 events/s) なら割当コストは 1% CPU 未満。
    /// 1 件の rdev イベントを処理し、計数した場合は live 表示用の
    /// イベントを返す。一時停止 / アイドル / 非対象イベントは `None`。
    pub fn handle_event(&mut self, event: Event) -> Option<LiveKeyEvent> {
        // 一時停止中はすべて捨てる。`last_input` も更新しない (停止解除
        // 後の最初の入力で「久々の入力 = アイドル復帰」として破棄される
        // のは [set_paused] 側で last_input を再セットすることで防ぐ)。
        if self.paused {
            return None;
        }

        let now = Instant::now();
        let elapsed = now.duration_since(self.last_input);
        let was_idle = elapsed > self.idle_threshold;
        self.last_input = now;

        if was_idle {
            // ユーザーがアプリを「叩き起こした」最初のイベント。
            // アクティブ時間には足さないが、実際のクリック / 打鍵は数える。
            // macOS ではクリック前に MouseMove が届かないことがあり、ここで
            // return すると復帰直後の最初のクリックを失うため。
            self.pressed.clear();
            self.last_mouse_pos = None;
        } else {
            // 「アクティブ時間」の積算: 直前イベントから現在までの経過
            // (≤ idle_threshold) を加算する。アイドル中の長いギャップは除外。
            let delta_ms = elapsed.as_millis() as u64;
            self.today_stats.active_ms = self.today_stats.active_ms.saturating_add(delta_ms);
            self.dirty = true;
        }

        // 時間帯ヒートマップ用に、現在時刻のローカル時 (0..23) を求める。
        // OffsetDateTime::now_utc は単純な clock_gettime 呼び出しで安価。
        // ≤30 events/s のホットパスでは余裕で許容できる。
        let hour = crate::date_util::current_hour();

        match event.event_type {
            EventType::KeyPress(key) => {
                // HashSet::insert は「未挿入なら true」を返す。
                // オートリピート時の連続 KeyPress は false が返り、
                // 1 回押し続けるあいだのカウントは 1 で止まる。
                if self.pressed.insert(key) {
                    self.today_stats.keys = self.today_stats.keys.saturating_add(1);
                    let raw = format!("{key:?}");
                    let entry = self.today_stats.key_breakdown.entry(raw.clone()).or_insert(0);
                    *entry = entry.saturating_add(1);
                    let h = &mut self.today_stats.hourly[hour as usize];
                    *h = h.saturating_add(1);
                    self.dirty = true;

                    // ライブ表示用のロジック:
                    //  - 修飾キー単体 → emit 保留 (pending に積む)。
                    //    後で非修飾キーが来たら結合チップに合成、来なければ
                    //    リリース時に単独チップとして emit する。
                    //  - 非修飾キー → 押下中の修飾キーを前置して結合
                    //    チップを emit (Shift+1, Ctrl+Shift+S など)。
                    //    結合に使った修飾キーは pending から取り除く
                    //    (二重 emit 防止)。
                    if let Some(mod_label) = modifier_label(key) {
                        self.pending_modifiers.insert(mod_label);
                        return None;
                    }
                    let mods = self.held_modifiers_label();
                    let combined = if mods.is_empty() {
                        raw
                    } else {
                        format!("{mods}+{raw}")
                    };
                    self.pending_modifiers.clear();
                    return Some(LiveKeyEvent { kind: "key", label: combined });
                }
                None
            }
            EventType::KeyRelease(key) => {
                // 次回の真の KeyPress を受け付けられるようにする。
                self.pressed.remove(&key);
                // 修飾キーが「単独で押されて単独で離された」場合 (= まだ
                // pending に残っている) は、ここで初めてチップを emit する。
                if let Some(mod_label) = modifier_label(key) {
                    if self.pending_modifiers.remove(mod_label) {
                        return Some(LiveKeyEvent {
                            kind: "key",
                            label: mod_label.to_string(),
                        });
                    }
                }
                None
            }
            EventType::ButtonPress(button) => {
                if let Some(label) = mouse_button_label(button) {
                    self.today_stats.mouse = self.today_stats.mouse.saturating_add(1);
                    let entry = self
                        .today_stats
                        .mouse_breakdown
                        .entry(label.to_string())
                        .or_insert(0);
                    *entry = entry.saturating_add(1);
                    let h = &mut self.today_stats.hourly[hour as usize];
                    *h = h.saturating_add(1);
                    self.dirty = true;

                    // マウスクリックも修飾キーがあれば結合 (Shift+Click 等)。
                    let mods = self.held_modifiers_label();
                    let combined = if mods.is_empty() {
                        label.to_string()
                    } else {
                        format!("{mods}+{label}")
                    };
                    self.pending_modifiers.clear();
                    return Some(LiveKeyEvent {
                        kind: "mouse",
                        label: combined,
                    });
                }
                None
            }
            // ----- マウス移動: 距離だけ累積する (チップは emit しない) -----
            EventType::MouseMove { x, y } => {
                if let Some((px, py)) = self.last_mouse_pos {
                    let dx = x - px;
                    let dy = y - py;
                    let raw_sq = dx * dx + dy * dy;
                    // 過大ジャンプ (マルチモニタ間ワープ・スリープ復帰時の
                    // 合成イベント等) は弾く。500px = 約 13cm を上限に。
                    if raw_sq > 0.0 && raw_sq < 500.0 * 500.0 {
                        let dist = raw_sq.sqrt();
                        self.today_stats.mouse_distance_px = self
                            .today_stats
                            .mouse_distance_px
                            .saturating_add(dist.round() as u64);
                        self.dirty = true;
                    }
                }
                self.last_mouse_pos = Some((x, y));
                None
            }
            // ----- ホイール: 縦横の累計ティック数を **絶対値で** 加算 -----
            EventType::Wheel { delta_x, delta_y } => {
                let dy = (delta_y as i64).unsigned_abs();
                let dx = (delta_x as i64).unsigned_abs();
                self.today_stats.scroll_y_ticks =
                    self.today_stats.scroll_y_ticks.saturating_add(dy);
                self.today_stats.scroll_x_ticks =
                    self.today_stats.scroll_x_ticks.saturating_add(dx);
                self.dirty = true;
                None
            }
            // ButtonRelease などは計数対象外。
            _ => None,
        }
    }

    /// 日付が変わっていたら `today_stats` を `history` に移し、
    /// 新しい日のライブカウンタを 0 から始める。
    pub fn rollover_if_needed(&mut self, today: &str) {
        if today != self.today {
            let prev = std::mem::take(&mut self.today_stats);
            let prev_day = std::mem::replace(&mut self.today, today.to_string());
            // 空エントリは保存しないことで data.json の肥大化を抑える。
            if prev != DayStats::default() {
                self.history.insert(prev_day, prev);
            }
            self.dirty = true;
        }
    }

    /// 永続化用に、全日分のスナップショットを作って返す。
    ///
    /// `history` を clone した上で today を上書き挿入するので、呼び出し
    /// 元はこの戻り値を持ったまま **ロックを解放してから** 書き込める。
    /// 入力ホットパスがディスク I/O でブロックされない仕組み。
    pub fn snapshot_all(&self) -> HashMap<String, DayStats> {
        let mut map = self.history.clone();
        if self.today_stats != DayStats::default() {
            map.insert(self.today.clone(), self.today_stats.clone());
        }
        map
    }

    /// 指定日の集計を読み出す。ヒートマップ・リスト両方で使用。
    pub fn get_stats(&self, date: &str) -> DayStats {
        if date == self.today {
            self.today_stats.clone()
        } else {
            self.history.get(date).cloned().unwrap_or_default()
        }
    }
}

// ----------------------------------------------------------------
// ユニットテスト (副作用なし: 仮想イベントを直接 handle_event に渡すだけ)
// ----------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use rdev::{Event, EventType};
    use std::time::{Duration, SystemTime};

    fn ev(et: EventType) -> Event {
        Event { time: SystemTime::now(), name: None, event_type: et }
    }

    fn state() -> AppState {
        AppState::new("2026-01-01".to_string(), HashMap::new(), 60)
    }

    #[test]
    fn first_keypress_is_counted() {
        let mut s = state();
        s.handle_event(ev(EventType::KeyPress(Key::KeyA)));
        assert_eq!(s.today_stats.keys, 1);
        assert_eq!(s.today_stats.mouse, 0);
    }

    #[test]
    fn autorepeat_is_suppressed() {
        let mut s = state();
        s.handle_event(ev(EventType::KeyPress(Key::KeyA)));
        s.handle_event(ev(EventType::KeyPress(Key::KeyA)));
        s.handle_event(ev(EventType::KeyPress(Key::KeyA)));
        assert_eq!(s.today_stats.keys, 1);
    }

    #[test]
    fn release_then_press_counts_again() {
        let mut s = state();
        s.handle_event(ev(EventType::KeyPress(Key::KeyA)));
        s.handle_event(ev(EventType::KeyRelease(Key::KeyA)));
        s.handle_event(ev(EventType::KeyPress(Key::KeyA)));
        assert_eq!(s.today_stats.keys, 2);
    }

    #[test]
    fn only_lmr_mouse_buttons_count() {
        let mut s = state();
        s.handle_event(ev(EventType::ButtonPress(Button::Left)));
        s.handle_event(ev(EventType::ButtonPress(Button::Right)));
        s.handle_event(ev(EventType::ButtonPress(Button::Middle)));
        s.handle_event(ev(EventType::ButtonPress(Button::Unknown(8))));
        assert_eq!(s.today_stats.mouse, 3);
    }

    #[test]
    fn wheel_and_move_are_ignored() {
        let mut s = state();
        s.handle_event(ev(EventType::Wheel { delta_x: 1, delta_y: 1 }));
        s.handle_event(ev(EventType::MouseMove { x: 10.0, y: 10.0 }));
        assert_eq!(s.today_stats.keys, 0);
        assert_eq!(s.today_stats.mouse, 0);
    }

    #[test]
    fn first_key_after_idle_is_counted() {
        let mut s = state();
        s.idle_threshold = Duration::from_millis(10);
        std::thread::sleep(Duration::from_millis(30));
        s.handle_event(ev(EventType::KeyPress(Key::KeyA)));
        assert_eq!(s.today_stats.keys, 1);
        s.handle_event(ev(EventType::KeyPress(Key::KeyB)));
        assert_eq!(s.today_stats.keys, 2);
    }

    #[test]
    fn first_click_after_idle_is_counted() {
        let mut s = state();
        s.idle_threshold = Duration::from_millis(10);
        std::thread::sleep(Duration::from_millis(30));
        s.handle_event(ev(EventType::ButtonPress(Button::Left)));
        assert_eq!(s.today_stats.mouse, 1);
        assert_eq!(s.today_stats.mouse_breakdown.get("Left").copied().unwrap_or(0), 1);
    }

    #[test]
    fn rollover_moves_today_into_history() {
        let mut s = state();
        s.handle_event(ev(EventType::KeyPress(Key::KeyA)));
        s.handle_event(ev(EventType::ButtonPress(Button::Left)));
        s.rollover_if_needed("2026-01-02");
        assert_eq!(s.today, "2026-01-02");
        assert_eq!(s.today_stats, DayStats::default());
        let prev = s.history.get("2026-01-01").cloned().unwrap_or_default();
        assert_eq!(prev.keys, 1);
        assert_eq!(prev.mouse, 1);
    }

    #[test]
    fn rollover_skips_empty_day() {
        let mut s = state();
        s.rollover_if_needed("2026-01-02");
        assert!(s.history.is_empty());
    }

    #[test]
    fn key_breakdown_records_per_key_counts() {
        let mut s = state();
        s.handle_event(ev(EventType::KeyPress(Key::KeyA)));
        s.handle_event(ev(EventType::KeyRelease(Key::KeyA)));
        s.handle_event(ev(EventType::KeyPress(Key::KeyA)));
        s.handle_event(ev(EventType::KeyRelease(Key::KeyA)));
        s.handle_event(ev(EventType::KeyPress(Key::KeyB)));
        assert_eq!(s.today_stats.key_breakdown.get("KeyA").copied().unwrap_or(0), 2);
        assert_eq!(s.today_stats.key_breakdown.get("KeyB").copied().unwrap_or(0), 1);
    }

    #[test]
    fn mouse_breakdown_records_per_button() {
        let mut s = state();
        s.handle_event(ev(EventType::ButtonPress(Button::Left)));
        s.handle_event(ev(EventType::ButtonPress(Button::Left)));
        s.handle_event(ev(EventType::ButtonPress(Button::Right)));
        s.handle_event(ev(EventType::ButtonPress(Button::Middle)));
        s.handle_event(ev(EventType::ButtonPress(Button::Unknown(8))));
        assert_eq!(s.today_stats.mouse_breakdown.get("Left").copied().unwrap_or(0), 2);
        assert_eq!(s.today_stats.mouse_breakdown.get("Right").copied().unwrap_or(0), 1);
        assert_eq!(s.today_stats.mouse_breakdown.get("Middle").copied().unwrap_or(0), 1);
        assert!(!s.today_stats.mouse_breakdown.contains_key("Unknown"));
    }

    #[test]
    fn key_breakdown_respects_autorepeat() {
        let mut s = state();
        s.handle_event(ev(EventType::KeyPress(Key::KeyA)));
        s.handle_event(ev(EventType::KeyPress(Key::KeyA)));
        s.handle_event(ev(EventType::KeyPress(Key::KeyA)));
        assert_eq!(s.today_stats.keys, 1);
        assert_eq!(s.today_stats.key_breakdown.get("KeyA").copied().unwrap_or(0), 1);
    }

    #[test]
    fn saturating_add_caps_at_u64_max() {
        let mut s = state();
        s.today_stats.keys = u64::MAX - 1;
        s.handle_event(ev(EventType::KeyPress(Key::KeyA)));
        s.handle_event(ev(EventType::KeyRelease(Key::KeyA)));
        s.handle_event(ev(EventType::KeyPress(Key::KeyA)));
        assert_eq!(s.today_stats.keys, u64::MAX);
    }
}
