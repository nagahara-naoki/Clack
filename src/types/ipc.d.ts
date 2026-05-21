// SPDX-License-Identifier: MIT
//
// Clack — フロント側で参照する型定義 (ambient)。
//
// Rust の `commands.rs` で `Serialize` されている構造体に
// 1:1 で対応する TypeScript インターフェース。`#[serde(rename_all = "camelCase")]`
// なので、TS 側もキャメルケースで揃える。
//
// `interface` は宣言マージで拡張できるので、追加フィールドが Rust 側で
// 増えたらここに追記するだけで型補完が効くようになる。

interface LabelCount {
  label: string;
  count: number;
}

interface TodayPayload {
  date: string;
  keys: number;
  mouse: number;
  activeMs: number;
  mouseDistancePx: number;
  scrollYTicks: number;
}

interface DayEntry {
  date: string;
  keys: number;
  mouse: number;
}

interface DayDetail {
  date: string;
  keys: number;
  mouse: number;
  hourly: number[];
  hourlyMax: number;
  keyTop: LabelCount[];
  mouseBreakdown: LabelCount[];
  mouseDistancePx: number;
  scrollYTicks: number;
  activeMs: number;
  empty: boolean;
}

interface Analytics {
  days: number;
  keys: LabelCount[];
  mouse: LabelCount[];
  averagePerDay: number;
  hourly: number[];
  hourlyMax: number;
  mouseDistancePx: number;
  scrollYTicks: number;
  activeMs: number;
}

interface MonthTotal {
  keys: number;
  mouse: number;
}

interface ImportResult {
  days: number;
  path: string;
}

interface StorageInfo {
  bytes: number;
  days: number;
}

type AnalyticsScope = "today" | "week" | "month" | "all";
type ThemeName = "light" | "dark" | "auto";
type Language = "ja" | "en";
type MonthsShown = 1 | 3 | 6 | 12;

interface ClackSettings {
  theme: ThemeName | string;
  language: Language | string;
  monthsShown: number;
  /** Rust 側で管理する自動起動フラグ。フロントの settings ペイロードでは
   *  省略されることがある (autostart は別 IPC でも操作される)。 */
  backgroundStartEnabled?: boolean;
}

/** Rust 側 `LiveKeyEvent`。`live-key` イベントのペイロード。 */
interface LiveKeyEvent {
  kind: "key" | "mouse";
  label: string;
}

/** invoke コマンドのカタログ。`invoke<K>(cmd, args)` で型推論に使う。
 *  各コマンドは [args, return] のタプルで宣言。 */
interface IpcCommandMap {
  get_today_stats: { args: undefined; ret: TodayPayload };
  get_stats_range: { args: { start: string; end: string }; ret: DayEntry[] };
  get_day_detail: { args: { date: string }; ret: DayDetail };
  get_analytics: { args: { scope: string }; ret: Analytics };
  get_month_total: { args: { yearMonth: string }; ret: MonthTotal };
  get_settings: { args: undefined; ret: ClackSettings };
  update_settings: { args: { newSettings: ClackSettings }; ret: void };
  get_autostart_enabled: { args: undefined; ret: boolean };
  set_autostart_enabled: { args: { enabled: boolean }; ret: void };
  show_main_window: { args: undefined; ret: void };
  hide_main_window: { args: undefined; ret: void };
  open_settings_window: { args: undefined; ret: void };
  close_settings_window: { args: undefined; ret: void };
  get_data_size: { args: undefined; ret: StorageInfo };
  clear_data: { args: undefined; ret: void };
  get_paused: { args: undefined; ret: boolean };
  set_paused: { args: { paused: boolean }; ret: void };
  get_live_display: { args: undefined; ret: boolean };
  set_live_display: { args: { enabled: boolean }; ret: void };
  export_data: { args: { format?: string }; ret: string | null };
  import_data: { args: undefined; ret: ImportResult | null };
  quit_app: { args: undefined; ret: void };
}

/** listen イベントのカタログ。 */
interface IpcEventMap {
  "stats-updated": TodayPayload;
  "settings-changed": void;
  "data-cleared": void;
  "paused-changed": boolean;
  "live-display-changed": boolean;
  "autostart-changed": boolean;
  "live-key": LiveKeyEvent;
}

/** Tauri が emit するイベントの受け口で listen() に渡される payload 形。 */
interface TauriEvent<T> {
  payload: T;
  event: string;
  id?: number;
  windowLabel?: string;
}

/** メインウィンドウのアプリ状態。main.ts で初期化し、`window.Clack.state` に
 *  公開する。他モジュールから読み書きする。
 *  動的に文字列で書き換える運用なので、TS 上は緩い `string` 型で受ける
 *  (実際の取り得る値はコメントで明示)。 */
interface AppStateShape {
  /** "ja" | "en" */
  lang: string;
  /** 1 | 3 | 6 | 12 */
  monthsShown: number;
  periodOffset: number;
  ready: boolean;
  refreshSeq: number;
  analyticsLoaded: boolean;
  /** "cal" | "analytics" | "list" */
  currentTab: string;
  calendarRetry: number;
  paused: boolean;
  /** "today" | "week" | "month" | "all" */
  analyticsScope: string;
}

/** Landmark (旅機能のマイルストーン) 1 つぶん。 */
interface Landmark {
  m: number;
  name: string;
}

interface LandmarkPick {
  lm: Landmark;
  pct: number;
  exceeded: boolean;
  multiple?: number;
}

/** ヒートマップの 1 期間情報。 */
interface CalendarPeriod {
  start: Date;
  end: Date;
  weeks: number;
}
