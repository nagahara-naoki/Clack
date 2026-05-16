// SPDX-License-Identifier: MIT
//
// Clack — メインウィンドウのフロントエンドコントローラ。
//
// 【セキュリティ方針】
// - innerHTML / eval / Function コンストラクタを一切使用しない。
//   DOM は document.createElement と textContent / dataset で組み立てる。
// - CSP は `script-src 'self'` 厳格化（インラインスクリプト不可）。
// - Tauri ランタイム以外（直接ブラウザで開いた場合など）では即座に
//   無害な案内テキストを表示して終了する。
// - ユーザー入力（スライダー値、日付文字列）は parseDate / safeInt /
//   clampMonths などのバリデータを通してから DOM / IPC に渡す。
//
// 【国際化】
// - 表示文字列はすべて I18N 辞書経由。
// - data-i18n="key" 属性付きの要素は applyLanguage() で一括更新。

(() => {
  "use strict";

  // ============================================================
  // 1. Tauri ランタイムの初期化
  // ============================================================
  const T = window.__TAURI__;
  if (!T) {
    // 通常はあり得ない経路。ブラウザで直接 index.html を開かれた場合の保険。
    document.body.textContent =
      "Clack must be launched from the Tauri runtime.";
    return;
  }
  const invoke = T.core.invoke;
  const listen = T.event.listen;

  // ============================================================
  // 2. 定数
  // ============================================================

  /** 期間スライダーで選べる月数。スライダー位置 (0..3) と対応。 */
  const POS_TO_MONTHS = [1, 3, 6, 12];

  /** 月数 → ヒートマップの週列数。デザインに合わせて手動チューニング。 */
  const WEEKS_FOR_MONTHS = { 1: 5, 3: 13, 6: 26, 12: 52 };

  /** ヒートマップのセル間ギャップ (px)。 */
  const CELL_GAP_PX = 2;
  /** 左端の曜日ラベル領域に確保する幅 (px)。 */
  const DOW_RESERVED_PX = 24;
  /** セルの最小・最大サイズ。視認性と密度のバランス。 */
  const MIN_CELL_PX = 8;
  const MAX_CELL_W_PX = 64;
  const MAX_CELL_H_PX = 32;

  /** 1 日の合計操作数 → ヒートマップの色レベル (0〜4) を決める閾値。
   *  絶対値ベース。データが増えても色味が安定するように設計。 */
  const LEVEL_THRESHOLDS = [0, 1500, 4000, 9000];

  /** ウィンドウ表示直後の誤クリック（フォーカス等で発生し得る）を弾く
   *  ガード時間 (ms)。これより前のナビゲーション操作は無視。
   *  以前は 1500ms あったが、ユーザーに「もっさり」と認識されるため
   *  合成イベント対策に十分かつ体感に乗らない値まで詰めた。 */
  const NAV_GUARD_MS = 400;

  /** 統計の安全ネット再取得間隔 (ms)。日付跨ぎなどに備える。 */
  const SAFETY_REFRESH_MS = 5 * 60 * 1000;

  /** リサイズ後の再レイアウト猶予 (ms)。連続リサイズで負荷を出さないため。 */
  const RESIZE_DEBOUNCE_MS = 120;

  /** ヒートマップ範囲指定の上限 (日数)。サーバ側でも同様に上限が課される。 */
  const MAX_RANGE_DAYS = 365 * 5;

  /** 分析タブのキー内訳に出す最大件数。Rust 側で 30 まで返してくる。 */
  const KEY_TOP_N = 15;

  // ===== 「旅」用の換算と地理マイルストーン =====
  // 96 DPI で 1 inch = 96 px、1 inch = 0.0254 m → 1 m ≈ 3780 px。
  // 4K 等の高 DPI モニタでは過大評価される可能性があるが、
  // 「ネタの単位」用途として簡略化する。
  const PX_PER_METER = 3780;
  // ホイール 1 ティック ≒ 3 行 ≒ 51 px ≒ 1.35 cm
  const M_PER_SCROLL_TICK = 0.0135;

  /** マウス向け (横に旅する)。値は m 単位、昇順で固定。 */
  const MOUSE_LANDMARKS = [
    { m: 1,         name: "1 メートル" },
    { m: 10,        name: "電車 1 両分" },
    { m: 100,       name: "100m 走" },
    { m: 333,       name: "東京タワー" },
    { m: 634,       name: "東京スカイツリー" },
    { m: 1000,      name: "1 キロ" },
    { m: 3776,      name: "富士山" },
    { m: 8849,      name: "エベレスト" },
    { m: 21097,     name: "ハーフマラソン" },
    { m: 42195,     name: "フルマラソン" },
    { m: 100000,    name: "東京〜熱海" },
    { m: 138000,    name: "富士山外周一周" },
    { m: 515000,    name: "東京〜大阪" },
    { m: 1413000,   name: "札幌〜福岡" },
    { m: 2250000,   name: "札幌〜那覇" },
    { m: 6371000,   name: "地球の半径" },
    { m: 40075000,  name: "地球一周" },
  ];

  /** スクロール向け (上に旅する)。値は m 単位、昇順で固定。 */
  const SCROLL_LANDMARKS = [
    { m: 1,           name: "1 メートル" },
    { m: 12,          name: "電柱" },
    { m: 25,          name: "ビル 8 階分" },
    { m: 56,          name: "ピサの斜塔" },
    { m: 93,          name: "自由の女神" },
    { m: 333,         name: "東京タワー" },
    { m: 634,         name: "東京スカイツリー" },
    { m: 828,         name: "ブルジュ・ハリファ" },
    { m: 3776,        name: "富士山" },
    { m: 8849,        name: "エベレスト" },
    { m: 12000,       name: "ジェット旅客機の巡航高度" },
    { m: 50000,       name: "成層圏の上限" },
    { m: 100000,      name: "宇宙の境界 (カーマンライン)" },
    { m: 400000,      name: "国際宇宙ステーション" },
    { m: 35786000,    name: "静止軌道" },
    { m: 384400000,   name: "月" },
  ];

  /** value (m) と昇順 landmarks から「次のマイルストーン」を返す。 */
  function findLandmark(meters, list) {
    if (meters <= 0) return null;
    for (const lm of list) {
      if (meters < lm.m) {
        return { lm, pct: (meters / lm.m) * 100, exceeded: false };
      }
    }
    const last = list[list.length - 1];
    return {
      lm: last,
      pct: 100,
      exceeded: true,
      multiple: meters / last.m,
    };
  }

  /** 距離 m を読みやすい単位に整形。 */
  function fmtTripDistance(meters) {
    if (meters < 1) {
      return { num: (meters * 100).toFixed(1), unit: "cm" };
    }
    if (meters < 100) {
      return { num: meters.toFixed(1), unit: "m" };
    }
    if (meters < 1000) {
      return { num: String(Math.round(meters)), unit: "m" };
    }
    if (meters < 100000) {
      return { num: (meters / 1000).toFixed(2), unit: "km" };
    }
    return { num: (meters / 1000).toFixed(0), unit: "km" };
  }

  /** 距離 m を 1 文字列「N 単位」にする (TOP のサブ統計用)。 */
  function fmtTripCompact(meters) {
    const { num, unit } = fmtTripDistance(meters);
    return `${num} ${unit}`;
  }

  /** ms を「N 時間 N 分 / N 分 / N 秒」に整形 (TOP のアクティブ時間用)。 */
  function fmtDuration(ms) {
    const totalSec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return L().duration_hm(h, m);
    if (m > 0) return L().duration_m(m);
    return L().duration_s(s);
  }

  /** rdev のキー識別子 → 表示ラベル。
   *  全件は網羅しないが、よく使われるものは短く読みやすくする。
   *  未登録のキーは raw 文字列にフォールバック。 */
  const KEY_LABEL_MAP = {
    Space: "Space", Return: "Enter", BackSpace: "BS", Tab: "Tab",
    Escape: "Esc", CapsLock: "CapsLock",
    ShiftLeft: "Shift L", ShiftRight: "Shift R",
    ControlLeft: "Ctrl L", ControlRight: "Ctrl R",
    Alt: "Alt", AltGr: "AltGr",
    MetaLeft: "Meta L", MetaRight: "Meta R",
    Comma: ",", Dot: ".", SemiColon: ";", Quote: "'", BackQuote: "`",
    Slash: "/", BackSlash: "\\", Equal: "=", Minus: "-",
    LeftBracket: "[", RightBracket: "]",
    UpArrow: "↑", DownArrow: "↓", LeftArrow: "←", RightArrow: "→",
    Insert: "Ins", Delete: "Del",
    Home: "Home", End: "End", PageUp: "PgUp", PageDown: "PgDn",
    PrintScreen: "PrtSc", ScrollLock: "ScrLk", Pause: "Pause", NumLock: "NumLk",
    IntlYen: "¥", IntlBackslash: "\\", IntlRo: "_",
    KanaMode: "かな", ConvertJp: "変換", NonConvert: "無変換",
  };

  function prettyKey(label) {
    if (!label) return "";
    if (KEY_LABEL_MAP[label]) return KEY_LABEL_MAP[label];
    // KeyA → A, Num0 → 0, F1 → F1, Kp1 → Num1 (テンキー識別)
    if (/^Key[A-Z]$/.test(label)) return label.slice(3);
    if (/^Num\d$/.test(label)) return label.slice(3);
    if (/^Kp\d$/.test(label)) return `Num${label.slice(2)}`;
    if (/^F\d{1,2}$/.test(label)) return label;
    return label;
  }

  // ============================================================
  // 3. 多言語辞書 (i18n)
  // ============================================================

  const DOW_JA = ["日", "月", "火", "水", "木", "金", "土"];
  const DOW_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTHS_EN = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];

  const I18N = {
    ja: {
      today: "本日",
      keys: "キー",
      mouse: "マウス",
      strokes: "STROKES",
      clicks: "CLICKS",
      calendar: "カレンダー",
      list: "リスト",
      date: "日付",
      monthTotalPrefix: "当月 ・",
      strokes_long: "打鍵 ・",
      clicks_long: "クリック",
      less: "LESS",
      more: "MORE",
      noData: "まだデータがありません",
      period_1m: "1ヶ月",
      period_3m: "3ヶ月",
      period_6m: "6ヶ月",
      period_12m: "12ヶ月",
      analytics: "分析",
      paused_badge: "一時停止中",
      anal_hour_title: "時間帯",
      anal_hour_sub: "0〜23 時の活動量",
      anal_keys_title: "よく使うキー",
      anal_keys_sub: "入力回数の多い順 (全期間)",
      anal_mouse_title: "マウス",
      anal_mouse_sub: "ボタン別の内訳",
      kpi_streak: "連続日数",
      kpi_streak_unit: "日",
      kpi_best: "最多日",
      kpi_best_unit: "操作",
      kpi_active: "アクティブ時間",
      kpi_total: "累計",
      kpi_strokes: "打鍵",
      kpi_clicks: "クリック",
      hourTooltip: (hour, val) =>
        `${hour}:00–${hour}:59 ・ ${val}`,
      noAnalytics: "まだデータがありません",
      mouseLabels: { Left: "左", Right: "右", Middle: "中" },
      scope_today: "今日",
      scope_week: "7日",
      scope_month: "今月",
      scope_all: "全期間",
      trip_mouse_label: "マウスで歩いた距離",
      trip_scroll_label: "スクロールで上った高さ",
      trip_to: (name, pct) => `${name}まで ${pct}%`,
      trip_passed: (name) => `${name}を突破`,
      trip_far_beyond: (name, mult) => `${name}の ${mult} 倍`,
      trip_zero: "まだ動いていません",
      today_active: "アクティブ",
      today_scroll: "スクロール",
      today_moved: "移動",
      duration_hm: (h, m) => `${h}時間 ${m}分`,
      duration_m: (m) => `${m}分`,
      duration_s: (s) => `${s}秒`,
      // ヒートマップ左軸 (空文字は非表示)。インデックスは曜日 0=日..6=土。
      dowAxis: ["", "月", "", "水", "", "金", ""],
      months: ["1月","2月","3月","4月","5月","6月","7月","8月","9月","10月","11月","12月"],
      dateLabel: (d) => `${d.getMonth() + 1}月${d.getDate()}日 (${DOW_JA[d.getDay()]})`,
      title: (start, end) => formatTitleJa(start, end),
      tooltip: (k, m) => `キー ${k} ・ マウス ${m}`,
      listDate: (d) =>
        `${d.getMonth() + 1}/${pad2(d.getDate())} (${DOW_JA[d.getDay()]})`,
    },
    en: {
      today: "TODAY",
      keys: "KEYS",
      mouse: "MOUSE",
      strokes: "STROKES",
      clicks: "CLICKS",
      calendar: "Calendar",
      list: "List",
      date: "DATE",
      monthTotalPrefix: "This month ·",
      strokes_long: "strokes ·",
      clicks_long: "clicks",
      less: "LESS",
      more: "MORE",
      noData: "No data yet",
      period_1m: "1M",
      period_3m: "3M",
      period_6m: "6M",
      period_12m: "12M",
      analytics: "Analytics",
      paused_badge: "PAUSED",
      anal_hour_title: "Activity by hour",
      anal_hour_sub: "0–23 hours",
      anal_keys_title: "Most used keys",
      anal_keys_sub: "Top keys by press count (all time)",
      anal_mouse_title: "Mouse",
      anal_mouse_sub: "Per-button breakdown",
      kpi_streak: "Streak",
      kpi_streak_unit: "d",
      kpi_best: "Best day",
      kpi_best_unit: "events",
      kpi_active: "Active time",
      kpi_total: "Total",
      kpi_strokes: "keys",
      kpi_clicks: "clicks",
      hourTooltip: (hour, val) =>
        `${hour}:00–${hour}:59 · ${val}`,
      noAnalytics: "No data yet",
      mouseLabels: { Left: "Left", Right: "Right", Middle: "Middle" },
      scope_today: "Today",
      scope_week: "7d",
      scope_month: "Month",
      scope_all: "All",
      trip_mouse_label: "Mouse traveled",
      trip_scroll_label: "Scrolled upward",
      trip_to: (name, pct) => `${pct}% of the way to ${name}`,
      trip_passed: (name) => `Passed ${name}`,
      trip_far_beyond: (name, mult) => `${mult}× ${name}`,
      trip_zero: "No movement yet",
      today_active: "Active",
      today_scroll: "Scroll",
      today_moved: "Moved",
      duration_hm: (h, m) => `${h}h ${m}m`,
      duration_m: (m) => `${m}m`,
      duration_s: (s) => `${s}s`,
      dowAxis: ["", "mon", "", "wed", "", "fri", ""],
      months: MONTHS_EN,
      dateLabel: (d) => `${MONTHS_EN[d.getMonth()]} ${d.getDate()} (${DOW_EN[d.getDay()]})`,
      title: (start, end) => formatTitleEn(start, end),
      tooltip: (k, m) => `Keys ${k} · Mouse ${m}`,
      listDate: (d) =>
        `${MONTHS_EN[d.getMonth()]} ${pad2(d.getDate())} (${DOW_EN[d.getDay()]})`,
    },
  };

  function formatTitleJa(start, end) {
    const sy = start.getFullYear(), sm = start.getMonth() + 1;
    const ey = end.getFullYear(), em = end.getMonth() + 1;
    if (sy === ey && sm === em) return `${sy}年${sm}月`;
    if (sy === ey) return `${sy}年 ${sm}〜${em}月`;
    return `${sy}年${sm}月 〜 ${ey}年${em}月`;
  }
  function formatTitleEn(start, end) {
    const sy = start.getFullYear(), sm = start.getMonth();
    const ey = end.getFullYear(), em = end.getMonth();
    if (sy === ey && sm === em) return `${MONTHS_EN[sm]} ${sy}`;
    if (sy === ey) return `${MONTHS_EN[sm]} – ${MONTHS_EN[em]} ${sy}`;
    return `${MONTHS_EN[sm]} ${sy} – ${MONTHS_EN[em]} ${ey}`;
  }

  // ============================================================
  // 4. ユーティリティ
  // ============================================================

  /** 短縮: getElementById */
  const $ = (id) => document.getElementById(id);

  /** 2 桁ゼロ詰め */
  const pad2 = (n) => String(n).padStart(2, "0");

  /** 数値 → ロケール対応の桁区切り表記。負値や NaN は "0"。 */
  function fmtNum(n) {
    if (!Number.isFinite(+n) || +n < 0) return "0";
    return Number(n).toLocaleString(state.lang === "ja" ? "ja-JP" : "en-US");
  }

  /** Date → YYYY-MM-DD (ローカル時刻基準)。Rust 側と同じ書式。 */
  function fmtDate(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  /** YYYY-MM-DD 文字列 → Date。妥当でない値は null。 */
  function parseDate(s) {
    if (typeof s !== "string") return null;
    const parts = s.split("-");
    if (parts.length !== 3) return null;
    const y = Number(parts[0]);
    const m = Number(parts[1]);
    const d = Number(parts[2]);
    if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
    const dt = new Date(y, m - 1, d);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  /** 任意の値 → 非負整数。バリデーション失敗時は 0。 */
  function safeInt(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  /** 月数を許可リストに丸める。範囲外は 6 (デフォルト)。 */
  function clampMonths(v) {
    return POS_TO_MONTHS.includes(v) ? v : 6;
  }

  /** スライダー位置を許可リストに丸める。範囲外は 2 (= 6M)。 */
  function clampPos(p) {
    return Number.isInteger(p) && p >= 0 && p < POS_TO_MONTHS.length ? p : 2;
  }

  // ============================================================
  // 5. アプリ状態 (グローバル)
  // ============================================================

  /**
   * フロント側で管理する状態。setter を介して変更し、
   * 状態に依存する処理が常に最新値を読む構造にする。
   */
  const state = {
    /** 現在の表示言語 ("ja" | "en") */
    lang: "ja",
    /** ヒートマップ表示期間 (1, 3, 6, 12 のいずれか) */
    monthsShown: 6,
    /** 期間オフセット (0 = 今期、-1 = 前期、… ) */
    periodOffset: 0,
    /** 初期化が完了したか。ナビ操作の暴発防止に使う。 */
    ready: false,
    /** リフレッシュ呼び出しの世代カウンタ。古い結果を破棄するため。 */
    refreshSeq: 0,
    /** 分析タブを一度でも描画したか。タブ初回オープンで遅延ロードする。 */
    analyticsLoaded: false,
    /** 現在のタブ名 ("cal" | "analytics" | "list")。 */
    currentTab: "cal",
    /** 一時停止中かどうか (バッジ表示用)。 */
    paused: false,
    /** 分析タブの集計スコープ ("today" | "week" | "month" | "all")。 */
    analyticsScope: "all",
  };

  /** ナビゲーション操作を受け付けてよい時刻 (performance.now() 基準)。
   *  ウィンドウ表示直後はフォーカスや支援技術により合成イベントが
   *  飛んでくることがあるため、最初の一定時間は無視する。 */
  const navReadyAt = performance.now() + NAV_GUARD_MS;
  function navReady() {
    return state.ready && performance.now() >= navReadyAt;
  }

  /** 現在の言語に応じた辞書を返すヘルパ。 */
  const L = () => I18N[state.lang] || I18N.ja;

  // ============================================================
  // 6. テーマ & 言語の適用
  // ============================================================

  /** テーマを html[data-theme] に書き込み、localStorage にも保存する。
   *  保存することで、次回ウィンドウ起動時に theme-boot.js が同期的に
   *  読んで初期描画から正しいテーマを当てられる (= 暗 → 明のフラッシュ
   *  を抑止)。 */
  function applyTheme(name) {
    const t = name === "light" || name === "dark" ? name : "auto";
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem("clack.theme", t); } catch (_) { /* ignore */ }
  }

  /** 言語を切替え、data-i18n 要素の文言を一括更新する。
   *  動的に作られる要素 (ヒートマップなど) は refresh() で再描画される。 */
  function applyLanguage(lang) {
    state.lang = lang === "en" ? "en" : "ja";
    document.documentElement.lang = state.lang;
    const labels = L();
    for (const el of document.querySelectorAll("[data-i18n]")) {
      const key = el.dataset.i18n;
      const val = labels[key];
      if (typeof val === "string") {
        el.textContent = val;
      }
    }
  }

  /** スライダー UI を monthsShown に同期させる。 */
  function applyPeriodSelection(months) {
    state.monthsShown = clampMonths(months);
    const pos = POS_TO_MONTHS.indexOf(state.monthsShown);
    const range = $("period-range");
    if (range) range.value = String(pos);
    for (const tick of document.querySelectorAll(".period-ticks span")) {
      tick.classList.toggle("is-active", Number(tick.dataset.pos) === pos);
    }
  }

  // ============================================================
  // 7. 設定の読み込み・保存 (Rust と双方向)
  // ============================================================

  async function loadAndApplySettings() {
    let s;
    try {
      s = await invoke("get_settings");
    } catch (e) {
      console.error("get_settings failed", e);
      s = {};
    }
    applyTheme(s.theme || "auto");
    applyPeriodSelection(clampMonths(Number(s.monthsShown)));
    applyLanguage(s.language || "ja");
  }

  /** Tauri の WebView は `setup` コールバックよりも早く HTML/JS の読み込みを
   *  始めることがあり、その間 Rust 側で `app.manage()` がまだ呼ばれていない
   *  ため `invoke(...)` が「state not managed」で即座に reject する。
   *  ここでは `get_settings` を成功するまで短いポーリングでリトライし、
   *  バックエンド準備完了を待つ。約 2.5 秒で諦めて先に進む (致命的でない)。
   *  この保険が無いと初回起動でヒートマップが描画されない。 */
  async function waitForBackend() {
    for (let i = 0; i < 50; i++) {
      try {
        await invoke("get_settings");
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }

  async function persistMonthsShown(value) {
    try {
      const s = await invoke("get_settings");
      s.monthsShown = value;
      await invoke("update_settings", { newSettings: s });
    } catch (e) {
      console.error("persistMonthsShown failed", e);
    }
  }

  // ============================================================
  // 8. 今日の統計 (上部の大きな数字)
  // ============================================================

  /** {date, keys, mouse, ...} を画面に反映。
   *  TOP のメインカウンタ (keys / mouse / 日付) のみ更新。
   *  アクティブ時間 / スクロール / 移動は重複表示を避けるため分析タブ側のみ。 */
  function setTodayCounts(payload) {
    if (!payload || typeof payload !== "object") return;
    $("today-keys").textContent = fmtNum(payload.keys);
    $("today-mouse").textContent = fmtNum(payload.mouse);

    const d = parseDate(payload.date);
    if (d) $("today-date").textContent = L().dateLabel(d);
  }

  async function refreshToday() {
    try {
      const p = await invoke("get_today_stats");
      setTodayCounts(p);
    } catch (e) {
      console.error(e);
    }
  }

  // ============================================================
  // 9. ヒートマップ : 期間計算
  // ============================================================

  /**
   * 表示する期間 [start, end] を算出。
   * end は常に「アンカー週の土曜日」、start は end から N 週前の日曜日。
   * オフセットを 1 動かすと N 週まるごとシフトする (期間が重ならない)。
   */
  function computePeriod() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const weeks = WEEKS_FOR_MONTHS[state.monthsShown] || 26;

    const anchor = new Date(today);
    anchor.setDate(today.getDate() + state.periodOffset * weeks * 7);

    const end = new Date(anchor);
    end.setDate(anchor.getDate() + (6 - anchor.getDay()));

    const start = new Date(end);
    start.setDate(start.getDate() - (weeks - 1) * 7 - 6);

    return { start, end, weeks };
  }

  /** セルサイズを計算。横幅をウィンドウ幅いっぱいに使い、縦は適度に制限。 */
  function computeCellSize(weeks, availableWidth) {
    const innerWidth = Math.max(0, availableWidth - DOW_RESERVED_PX);
    const raw = Math.floor((innerWidth - (weeks - 1) * CELL_GAP_PX) / weeks);
    const cellW = Math.max(MIN_CELL_PX, Math.min(MAX_CELL_W_PX, raw));
    const cellH = Math.max(MIN_CELL_PX, Math.min(MAX_CELL_H_PX, cellW));
    return { cellW, cellH };
  }

  /** 1 日の合計値からカラーレベル (0..4) を決定。 */
  function chooseLevel(total) {
    if (total <= LEVEL_THRESHOLDS[0]) return 0;
    if (total < LEVEL_THRESHOLDS[1]) return 1;
    if (total < LEVEL_THRESHOLDS[2]) return 2;
    if (total < LEVEL_THRESHOLDS[3]) return 3;
    return 4;
  }

  // ============================================================
  // 10. ヒートマップ : DOM 構築
  // ============================================================

  function buildHeatmap(entries, period, today) {
    const grid = $("cal-weeks");
    const months = $("cal-months");
    const dow = $("cal-dow");
    grid.replaceChildren();
    months.replaceChildren();
    dow.replaceChildren();

    // 日付 → 集計値のマップ。
    const byDate = new Map();
    for (const e of entries) {
      byDate.set(e.date, { keys: safeInt(e.keys), mouse: safeInt(e.mouse) });
    }

    // 期間とグリッド境界 (期間端を含む週の日曜〜土曜まで広げる)。
    const periodStart = period.start;
    const periodEnd = period.end;
    const gridStart = new Date(periodStart);
    gridStart.setDate(periodStart.getDate() - periodStart.getDay());
    const gridEnd = new Date(periodEnd);
    gridEnd.setDate(periodEnd.getDate() + (6 - periodEnd.getDay()));
    const totalDays = Math.round((gridEnd - gridStart) / 86400000) + 1;
    const totalWeeks = Math.round(totalDays / 7);

    // セルサイズを実際のレイアウト幅から算出して CSS 変数に反映。
    const calGrid = grid.closest(".cal-grid") || grid.parentNode;
    const availableW = calGrid ? calGrid.clientWidth : 720;
    const { cellW, cellH } = computeCellSize(totalWeeks, availableW);
    calGrid.style.setProperty("--cell-w", `${cellW}px`);
    calGrid.style.setProperty("--cell-h", `${cellH}px`);

    // 左の曜日ラベル (mon / wed / fri などを薄く表示)。
    const axisLabels = L().dowAxis;
    for (let i = 0; i < 7; i++) {
      const span = document.createElement("span");
      span.textContent = axisLabels[i] || "";
      dow.appendChild(span);
    }

    // 月ラベル: 各週列に span を 1 つ作り、月初を含む列だけテキストを入れる。
    let lastLabeledMonth = -1;
    for (let col = 0; col < totalWeeks; col++) {
      const label = document.createElement("span");
      label.className = "month-label";
      for (let d = 0; d < 7; d++) {
        const dt = new Date(gridStart);
        dt.setDate(gridStart.getDate() + col * 7 + d);
        if (
          dt.getDate() === 1 &&
          dt.getMonth() !== lastLabeledMonth &&
          dt >= periodStart &&
          dt <= periodEnd
        ) {
          label.textContent = L().months[dt.getMonth()];
          lastLabeledMonth = dt.getMonth();
          break;
        }
      }
      months.appendChild(label);
    }

    // 本体: 縦 7 セル × 横 totalWeeks 列。
    const frag = document.createDocumentFragment();
    for (let col = 0; col < totalWeeks; col++) {
      const colEl = document.createElement("div");
      colEl.className = "cal-col";
      for (let row = 0; row < 7; row++) {
        const dayIdx = col * 7 + row;
        const cellDate = new Date(gridStart);
        cellDate.setDate(gridStart.getDate() + dayIdx);

        const cell = document.createElement("span");
        cell.className = "cell";

        const ds = fmtDate(cellDate);
        cell.dataset.date = ds;

        const inPeriod = cellDate >= periodStart && cellDate <= periodEnd;
        const isFuture = cellDate > today;

        if (!inPeriod) {
          cell.classList.add("is-out");
        } else if (isFuture) {
          cell.classList.add("is-future");
        } else {
          const stat = byDate.get(ds) || { keys: 0, mouse: 0 };
          const total = stat.keys + stat.mouse;
          cell.dataset.level = String(chooseLevel(total));
          cell.dataset.keys = String(stat.keys);
          cell.dataset.mouse = String(stat.mouse);
        }
        colEl.appendChild(cell);
      }
      frag.appendChild(colEl);
    }
    grid.appendChild(frag);

  }

  // ============================================================
  // 11. リスト表示
  // ============================================================

  function buildList(entries, today) {
    const body = $("list-body");
    body.replaceChildren();
    const todayStr = fmtDate(today);
    const sorted = [...entries].sort((a, b) => b.date.localeCompare(a.date));
    let any = false;
    const frag = document.createDocumentFragment();
    for (const d of sorted) {
      const keys = safeInt(d.keys);
      const mouse = safeInt(d.mouse);
      // 全 0 の日は省く (ただし今日だけは常に表示)。
      if (keys === 0 && mouse === 0 && d.date !== todayStr) continue;
      any = true;
      const row = document.createElement("div");
      row.className = "list-row";
      const dateCell = document.createElement("span");
      const dt = parseDate(d.date);
      dateCell.textContent = dt ? L().listDate(dt) : d.date;
      const keysCell = document.createElement("span");
      keysCell.className = "num";
      keysCell.textContent = fmtNum(keys);
      const mouseCell = document.createElement("span");
      mouseCell.className = "num";
      mouseCell.textContent = fmtNum(mouse);
      row.append(dateCell, keysCell, mouseCell);
      frag.appendChild(row);
    }
    if (!any) {
      const empty = document.createElement("div");
      empty.style.cssText = "padding:20px;text-align:center;font-size:12px;";
      empty.className = "muted";
      empty.textContent = L().noData;
      frag.appendChild(empty);
    }
    body.appendChild(frag);
  }

  // ============================================================
  // 12. リフレッシュ (期間切替・初期化・定期同期 共通)
  // ============================================================

  /** ヒートマップ + リスト + 月集計を一括で再取得・再描画する。
   *  並行して複数回呼ばれた場合、最後の呼び出しだけが DOM を更新する
   *  (世代カウンタ refreshSeq で古いものは破棄)。
   */
  async function refresh() {
    const seq = ++state.refreshSeq;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const period = computePeriod();

    // タイトル更新
    $("cal-title").textContent = L().title(period.start, period.end);

    // 範囲データ取得
    let data;
    try {
      data = await invoke("get_stats_range", {
        start: fmtDate(period.start),
        end: fmtDate(period.end),
      });
    } catch (e) {
      console.error("get_stats_range failed", e);
      return;
    }
    if (seq !== state.refreshSeq) return;
    if (!Array.isArray(data)) return;

    buildHeatmap(data, period, today);
    buildList(data, today);

    // フッターの当月合計
    const ym = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}`;
    try {
      const mt = await invoke("get_month_total", { yearMonth: ym });
      if (seq !== state.refreshSeq) return;
      $("month-keys").textContent = fmtNum(mt.keys);
      $("month-mouse").textContent = fmtNum(mt.mouse);
    } catch (e) {
      // フッター表示だけの問題なので握りつぶす。
    }
  }

  // ============================================================
  // 13. UI ハンドラ
  // ============================================================

  /** カレンダー / 分析 / リスト の切替タブ。
   *  分析タブは初回オープン時にデータをロード (起動コストの抑制)。 */
  function setupTabs() {
    const tabIds = ["cal", "analytics", "list"];
    const activate = (which) => {
      state.currentTab = which;
      for (const t of tabIds) {
        const btn = $(`tab-${t}`);
        const view = $(`view-${t}`);
        const on = t === which;
        if (btn) {
          btn.classList.toggle("is-active", on);
          btn.setAttribute("aria-selected", String(on));
        }
        if (view) {
          view.hidden = !on;
          if (on) {
            // 表示されるビューに短いフェードインアニメーションを当て直す。
            view.classList.remove("is-entering");
            // フレームを 1 回挟まないと animation 再起動しない
            requestAnimationFrame(() => view.classList.add("is-entering"));
          }
        }
      }
      if (which === "analytics") {
        refreshAnalytics().catch((e) => console.error("analytics refresh", e));
      }
    };
    $("tab-cal").addEventListener("click", (ev) => {
      if (!ev.isTrusted) return;
      activate("cal");
    });
    $("tab-analytics").addEventListener("click", (ev) => {
      if (!ev.isTrusted) return;
      activate("analytics");
    });
    $("tab-list").addEventListener("click", (ev) => {
      if (!ev.isTrusted) return;
      activate("list");
    });
  }

  // ============================================================
  // 13a. 分析タブ
  // ============================================================

  /** スコープ選択 (今日 / 7日 / 今月 / 全期間) のセグメントコントロール。
   *  クリックで state.analyticsScope を変えて分析を再フェッチ。 */
  function setupAnalyticsScope() {
    for (const btn of document.querySelectorAll("[data-scope]")) {
      btn.addEventListener("click", (ev) => {
        if (!ev.isTrusted) return;
        const next = btn.dataset.scope;
        if (next === state.analyticsScope) return;
        state.analyticsScope = next;
        for (const b of document.querySelectorAll("[data-scope]")) {
          const on = b.dataset.scope === next;
          b.classList.toggle("is-active", on);
          b.setAttribute("aria-checked", on ? "true" : "false");
        }
        refreshAnalytics().catch((e) => console.error("analytics refresh", e));
      });
    }
  }

  /** 分析データを取得して各セクションを再描画。失敗時は noData 表示。 */
  async function refreshAnalytics() {
    let data;
    try {
      data = await invoke("get_analytics", { scope: state.analyticsScope });
    } catch (e) {
      console.error("get_analytics failed", e);
      return;
    }
    state.analyticsLoaded = true;

    // ---- KPI
    $("kpi-streak-num").textContent = fmtNum(data.streak);
    if (data.bestDay && data.bestDay.total > 0) {
      const d = parseDate(data.bestDay.date);
      $("kpi-best-date").textContent = d ? L().listDate(d) : data.bestDay.date;
      $("kpi-best-total").textContent = fmtNum(data.bestDay.total);
    } else {
      $("kpi-best-date").textContent = "—";
      $("kpi-best-total").textContent = "0";
    }
    $("kpi-keys-total").textContent = fmtNum(data.keysTotal);
    $("kpi-mouse-total").textContent = fmtNum(data.mouseTotal);
    $("kpi-active-time").textContent = fmtDuration(data.activeMs);

    // ---- 旅 (マウス移動距離 + スクロール累計の換算)
    renderTrip({
      meters: safeInt(data.mouseDistancePx) / PX_PER_METER,
      landmarks: MOUSE_LANDMARKS,
      numEl: $("trip-mouse-num"),
      unitEl: $("trip-mouse-unit"),
      fillEl: $("trip-mouse-fill"),
      cmpEl: $("trip-mouse-cmp"),
    });
    renderTrip({
      meters: safeInt(data.scrollYTicks) * M_PER_SCROLL_TICK,
      landmarks: SCROLL_LANDMARKS,
      numEl: $("trip-scroll-num"),
      unitEl: $("trip-scroll-unit"),
      fillEl: $("trip-scroll-fill"),
      cmpEl: $("trip-scroll-cmp"),
    });

    // ---- 時間帯ヒートマップ
    buildHourHeatmap(data.hourly || [], safeInt(data.hourlyMax));

    // ---- キー内訳
    buildBreakdownBars($("keys-breakdown"), (data.keys || []).slice(0, KEY_TOP_N), prettyKey);

    // ---- マウス内訳
    const mouseLabels = L().mouseLabels || {};
    buildBreakdownBars(
      $("mouse-breakdown"),
      data.mouse || [],
      (raw) => mouseLabels[raw] || raw,
    );

    // データ皆無時のフォールバック
    const hasAny = data.keysTotal + data.mouseTotal > 0;
    for (const id of ["keys-breakdown", "mouse-breakdown"]) {
      const el = $(id);
      if (!hasAny && el.childElementCount === 0) {
        const p = document.createElement("div");
        p.className = "muted breakdown-empty";
        p.textContent = L().noAnalytics;
        el.appendChild(p);
      }
    }
  }

  /** 「旅」カード 1 枚を描画。
   *  - meters: 換算済みの距離 (m)
   *  - landmarks: 比較に使う昇順リスト
   *  - 各 DOM 要素: 数字 / 単位 / バーの fill / 比較テキスト
   *  バーは前回描画値から新しい値へ CSS transition で滑らかに伸縮する。 */
  function renderTrip({ meters, landmarks, numEl, unitEl, fillEl, cmpEl }) {
    if (!numEl || !unitEl || !fillEl || !cmpEl) return;
    const m = Math.max(0, Number(meters) || 0);
    const { num, unit } = fmtTripDistance(m);
    numEl.textContent = num;
    unitEl.textContent = unit;

    const lm = findLandmark(m, landmarks);
    if (!lm) {
      fillEl.style.width = "0%";
      cmpEl.textContent = L().trip_zero;
      return;
    }
    if (lm.exceeded) {
      fillEl.style.width = "100%";
      const mult = lm.multiple;
      if (mult >= 1.5) {
        cmpEl.textContent = L().trip_far_beyond(lm.lm.name, mult.toFixed(1));
      } else {
        cmpEl.textContent = L().trip_passed(lm.lm.name);
      }
      return;
    }
    fillEl.style.width = `${Math.min(100, Math.max(1, lm.pct)).toFixed(2)}%`;
    cmpEl.textContent = L().trip_to(lm.lm.name, lm.pct.toFixed(1));
  }

  /** 横棒チャートを構築。
   *  最大値で正規化し、ラベル + バー + 数値 の 3 列レイアウト。 */
  function buildBreakdownBars(container, items, labelFn) {
    container.replaceChildren();
    if (!items || items.length === 0) {
      const p = document.createElement("div");
      p.className = "muted breakdown-empty";
      p.textContent = L().noAnalytics;
      container.appendChild(p);
      return;
    }
    const max = items.reduce((m, it) => Math.max(m, safeInt(it.count)), 1);
    const frag = document.createDocumentFragment();
    for (const it of items) {
      const count = safeInt(it.count);
      const pct = Math.max(2, Math.round((count / max) * 100));
      const row = document.createElement("div");
      row.className = "br-row";
      const label = document.createElement("span");
      label.className = "br-label";
      label.textContent = labelFn(it.label || "");
      const track = document.createElement("span");
      track.className = "br-track";
      const fill = document.createElement("span");
      fill.className = "br-fill";
      fill.style.width = `${pct}%`;
      track.appendChild(fill);
      const num = document.createElement("span");
      num.className = "br-num";
      num.textContent = fmtNum(count);
      row.append(label, track, num);
      frag.appendChild(row);
    }
    container.appendChild(frag);
  }

  /** 時間帯ヒートマップ: 24 セル 1 行。
   *  分析タブのスコープ (今日 / 7日 / 今月 / 全期間) で絞った全日を時間帯
   *  ごとに合算した値を、max で正規化して 0..4 レベルの色で表示する。 */
  function buildHourHeatmap(hoursArr, max) {
    const wrap = $("hour-heatmap");
    wrap.replaceChildren();

    // 上段: 3 時間ごとの時刻目盛り (0/3/6/9/12/15/18/21)。
    const labels = document.createElement("div");
    labels.className = "hh-hours";
    for (let h = 0; h < 24; h++) {
      const cell = document.createElement("span");
      cell.className = "hh-hour-cell";
      cell.textContent = (h % 3 === 0) ? String(h) : "";
      labels.appendChild(cell);
    }

    // 下段: 24 セル。
    const grid = document.createElement("div");
    grid.className = "hh-grid";
    grid.setAttribute("data-empty", max === 0 ? "true" : "false");
    const safeMax = max > 0 ? max : 1;
    const threshold = [
      Math.ceil(safeMax * 0.10),
      Math.ceil(safeMax * 0.30),
      Math.ceil(safeMax * 0.55),
      Math.ceil(safeMax * 0.80),
    ];
    for (let h = 0; h < 24; h++) {
      const v = safeInt((hoursArr && hoursArr[h]) || 0);
      let level = 0;
      if (v > 0) {
        if (v >= threshold[3]) level = 4;
        else if (v >= threshold[2]) level = 3;
        else if (v >= threshold[1]) level = 2;
        else level = 1;
      }
      const cell = document.createElement("span");
      cell.className = "hh-cell";
      if (level > 0) cell.dataset.level = String(level);
      cell.dataset.hour = String(h);
      cell.dataset.val = String(v);
      grid.appendChild(cell);
    }

    wrap.append(labels, grid);
  }

  /** PAUSED バッジの表示/非表示。 */
  function applyPaused(paused) {
    state.paused = Boolean(paused);
    const badge = $("pause-badge");
    if (badge) badge.hidden = !state.paused;
  }

  /** ヒートマップ前後ナビゲーション (< >)。 */
  function setupCalNav() {
    // 二重の防御:
    //   1. isTrusted で合成クリックを弾く
    //   2. navReady で初期化前のクリックを弾く
    $("cal-prev").addEventListener("click", (ev) => {
      if (!ev.isTrusted || !navReady()) return;
      state.periodOffset -= 1;
      refresh();
    });
    $("cal-next").addEventListener("click", (ev) => {
      if (!ev.isTrusted || !navReady()) return;
      if (state.periodOffset >= 0) return;
      state.periodOffset += 1;
      refresh();
    });
  }

  /** スライダー位置 pos に対応する月数を選択。 */
  function selectPeriodByPos(pos) {
    const p = clampPos(pos);
    const m = POS_TO_MONTHS[p];
    if (m === state.monthsShown) return;
    applyPeriodSelection(m);
    state.periodOffset = 0;
    refresh();
    persistMonthsShown(m);
  }

  /** 期間スライダー (1M / 3M / 6M / 12M)。 */
  function setupPeriodSlider() {
    const input = $("period-range");
    if (input) {
      input.addEventListener("input", (ev) => {
        if (!ev.isTrusted || !navReady()) return;
        selectPeriodByPos(Number(input.value));
      });
    }
    // 目盛りラベルもクリックで選択可能 (アクセシビリティ + 使いやすさ)。
    for (const tick of document.querySelectorAll(".period-ticks span")) {
      tick.addEventListener("click", (ev) => {
        if (!ev.isTrusted || !navReady()) return;
        selectPeriodByPos(Number(tick.dataset.pos));
      });
    }
  }

  /** 設定ウィンドウを開く歯車アイコン。 */
  function setupSettingsButton() {
    $("open-settings").addEventListener("click", async (ev) => {
      if (!ev.isTrusted) return;
      try { await invoke("open_settings_window"); }
      catch (e) { console.error(e); }
    });
  }

  /** ヘッダーのリアルタイム表示トグル。
   *  - クリックで Rust 側に set_live_display を呼び ON/OFF を切替
   *  - 現在の状態に応じてアイコンに `is-active` を付け、視覚的にも分かるように
   *  - 他経路 (live ウィンドウの ✕、トレイ) からの変更も listen で同期 */
  function setupLiveToggle() {
    const btn = $("live-toggle");
    if (!btn) return;
    const apply = (on) => {
      btn.classList.toggle("is-active", !!on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    };
    btn.addEventListener("click", async (ev) => {
      if (!ev.isTrusted) return;
      const next = !btn.classList.contains("is-active");
      try {
        await invoke("set_live_display", { enabled: next });
        apply(next);
      } catch (e) {
        console.error("set_live_display failed", e);
      }
    });
    // 初期同期
    invoke("get_live_display")
      .then((v) => apply(Boolean(v)))
      .catch(() => {});
  }

  /** カレンダーセル & 時間帯ヒートマップセル & 内訳バー の共通ツールチップ。
   *  mousemove は document に 1 つだけ張る (重複登録による競合を避ける)。 */
  function setupTooltip() {
    const tip = $("tooltip");
    let raf = 0;
    const hide = () => { tip.hidden = true; };
    const setPos = (rect) => {
      tip.style.left = `${Math.round(rect.left + rect.width / 2)}px`;
      tip.style.top = `${Math.round(rect.top - 6)}px`;
      tip.style.transform = "translate(-50%, -100%)";
      tip.hidden = false;
    };
    document.addEventListener("mousemove", (e) => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const tgt = e.target;
        const closest = tgt && tgt.closest ? tgt.closest.bind(tgt) : null;
        if (!closest) { hide(); return; }

        // (1) カレンダーセル
        const cal = closest(".cal-weeks .cell");
        if (cal) {
          if (cal.classList.contains("is-future") || cal.classList.contains("is-out")) {
            hide();
            return;
          }
          const date = cal.dataset.date || "";
          const k = safeInt(cal.dataset.keys);
          const m = safeInt(cal.dataset.mouse);
          tip.textContent = "";
          const b = document.createElement("b");
          b.textContent = date;
          const br = document.createElement("br");
          const tail = document.createTextNode(L().tooltip(fmtNum(k), fmtNum(m)));
          tip.append(b, br, tail);
          setPos(cal.getBoundingClientRect());
          return;
        }

        // (2) 時間帯ヒートマップセル
        const hh = closest(".hh-cell");
        if (hh) {
          const h = safeInt(hh.dataset.hour);
          const v = safeInt(hh.dataset.val);
          tip.textContent = L().hourTooltip(h, fmtNum(v));
          setPos(hh.getBoundingClientRect());
          return;
        }

        hide();
      });
    }, { passive: true });
    document.addEventListener("mouseleave", hide, { passive: true });
  }

  /** Tauri 側からのイベントを購読。 */
  async function setupBackendListeners() {
    // 1Hz のリアルタイム更新 (ウィンドウ表示中のみ Rust から飛んでくる)
    await listen("stats-updated", (event) => {
      if (event && event.payload) setTodayCounts(event.payload);
    });
    // 設定ウィンドウから「保存」されたとき
    await listen("settings-changed", async () => {
      await loadAndApplySettings();
      refresh();
      // 言語切替で曜日ラベルが変わるので、分析タブを開いていれば再描画
      if (state.analyticsLoaded) refreshAnalytics().catch(() => {});
    });
    // 設定ウィンドウから全データ削除されたとき (またはインポート完了時)
    await listen("data-cleared", async () => {
      await refreshToday();
      await refresh();
      if (state.analyticsLoaded || state.currentTab === "analytics") {
        refreshAnalytics().catch(() => {});
      }
    });
    // トレイ・設定からの一時停止トグル
    await listen("paused-changed", (event) => {
      applyPaused(Boolean(event && event.payload));
    });
    // トレイ・live ウィンドウからのリアルタイム表示トグル → ヘッダーアイコンと同期
    await listen("live-display-changed", (event) => {
      const on = Boolean(event && event.payload);
      const btn = $("live-toggle");
      if (btn) {
        btn.classList.toggle("is-active", on);
        btn.setAttribute("aria-pressed", on ? "true" : "false");
      }
    });
    // ウィンドウリサイズ → セルサイズ再計算
    let resizeTimer = 0;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(refresh, RESIZE_DEBOUNCE_MS);
    });
  }

  /** 未捕捉エラー / Promise 拒否を画面上端の赤帯に出す。
   *  リリースビルドは devtools が無いため、無音失敗を防ぐ最後の砦。 */
  function installErrorReporter() {
    const banner = document.createElement("div");
    banner.style.cssText =
      "position:fixed;top:0;left:0;right:0;background:#b91c1c;color:#fff;" +
      "padding:6px 10px;font:12px ui-monospace,monospace;z-index:9999;display:none;";
    document.body.appendChild(banner);
    const show = (msg) => {
      banner.textContent = msg;
      banner.style.display = "block";
    };
    window.addEventListener("error", (e) => show(`Error: ${e.message}`));
    window.addEventListener("unhandledrejection", (e) => {
      const r = e.reason;
      show(`Promise: ${r && r.toString ? r.toString() : String(r)}`);
    });
  }

  // ============================================================
  // 14. 初期化エントリポイント
  // ============================================================

  async function init() {
    installErrorReporter();
    setupTabs();
    setupCalNav();
    setupPeriodSlider();
    setupSettingsButton();
    setupLiveToggle();
    setupTooltip();
    setupAnalyticsScope();

    // バックエンドが State を管理し終えるのを待ってから IPC を叩く。
    await waitForBackend();

    // 設定を取得 → テーマ・言語・期間に反映 → 初回描画。
    await loadAndApplySettings();
    await refreshToday();
    await refresh();

    // 一時停止状態を初期反映 (再起動跨ぎはしないので通常 false)
    try {
      applyPaused(Boolean(await invoke("get_paused")));
    } catch (e) {
      console.error("get_paused failed", e);
    }

    // ウィンドウが `visible: false` で生成されてから show() されるため、
    // 初回 refresh の時点では `cal-grid` の clientWidth が 0 で、セルが
    // 最小サイズで固まってしまうケースがある。レイアウト確定後にもう
    // 一度描画し直して幅を実測値に合わせる。
    requestAnimationFrame(() => {
      requestAnimationFrame(() => { refresh().catch(() => {}); });
    });

    state.ready = true;

    await setupBackendListeners();
  }

  window.addEventListener("DOMContentLoaded", () => {
    init().catch((e) => console.error("init failed", e));
  });

  // 長時間起動・日付跨ぎ対策の安全ネット。
  setInterval(() => {
    refresh().catch(() => {});
  }, SAFETY_REFRESH_MS);
})();
