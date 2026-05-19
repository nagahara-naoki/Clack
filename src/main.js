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
      anal_hours_title: "時間帯 · 24時間",
      hours_today_label: "本日",
      hours_avg7_label: "7日平均",
      hero_avg7_label: "7日平均",
      anal_keys_title: "よく使うキー",
      anal_keys_sub: "入力回数の多い順 · 全期間",
      anal_mouse_title: "マウス",
      anal_mouse_sub: "ボタン別の内訳 · 全期間",
      kpi_average: "1日平均",
      kpi_average_unit: "操作",
      kpi_average_unit_long: "操作 / 日",
      kpi_average_ctx: "過去 7 日の平均値",
      /** ヒーロー右下の差分表示用フォーマッタ。
       *  通常は "+12.3%" / "−45.6%" などサインを明示。
       *  baseline=0 の場合や算出不能時は "—" を返す。 */
      hero_delta: (pct) => {
        if (!Number.isFinite(pct)) return "—";
        const sign = pct >= 0 ? "+" : "−";
        return `${sign}${Math.abs(pct).toFixed(1)}%`;
      },
      hero_now_at: (h, m) => `· ${pad2(h)}:${pad2(m)} 時点`,
      trip_goal_to: (name) => `${name}まで`,
      trip_goal_passed: (name) => `${name} 突破`,
      cal_active_days: (n) => n > 0 ? `· ${fmtNum(n)} 日アクティブ` : "",
      cal_daily_label: (months) => `日次合計 · 過去 ${months} ヶ月`,
      cal_daily_max: (n) => `最大 ${fmtNum(n)} / 日`,
      cal_period_totals: "期間合計",
      list_today_badge: "今日",
      list_month_summary: (days, keys, mouse) =>
        `${days} 日 · キー ${fmtNum(keys)} · マウス ${fmtNum(mouse)}`,
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
      anal_hours_title: "Hour rhythm · 24h",
      hours_today_label: "Today",
      hours_avg7_label: "7-day avg",
      hero_avg7_label: "7-day avg",
      anal_keys_title: "Most used keys",
      anal_keys_sub: "Top keys by press count · all time",
      anal_mouse_title: "Mouse",
      anal_mouse_sub: "Per-button breakdown · all time",
      kpi_average: "Daily avg",
      kpi_average_unit: "events",
      kpi_average_unit_long: "events / day",
      kpi_average_ctx: "Average over past 7 days",
      hero_delta: (pct) => {
        if (!Number.isFinite(pct)) return "—";
        const sign = pct >= 0 ? "+" : "−";
        return `${sign}${Math.abs(pct).toFixed(1)}%`;
      },
      hero_now_at: (h, m) => `· as of ${pad2(h)}:${pad2(m)}`,
      trip_goal_to: (name) => `to ${name}`,
      trip_goal_passed: (name) => `Passed ${name}`,
      cal_active_days: (n) => n > 0 ? `· ${fmtNum(n)} active days` : "",
      cal_daily_label: (months) => `Daily total · last ${months} months`,
      cal_daily_max: (n) => `Max ${fmtNum(n)} / day`,
      cal_period_totals: "Period total",
      list_today_badge: "TODAY",
      list_month_summary: (days, keys, mouse) =>
        `${days} days · ${fmtNum(keys)} keys · ${fmtNum(mouse)} mouse`,
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
    /** カレンダー初期描画の幅が未確定だったときの再試行回数。 */
    calendarRetry: 0,
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

  /** 期間スイッチ (1/3/6/12ヶ月) のアクティブ状態を monthsShown に同期。
   *  デザイン刷新でスライダー → 4 連ボタンに置き換えたため、対象セレクタも
   *  `.cr-range button[data-pos]` に変更している。 */
  function applyPeriodSelection(months) {
    state.monthsShown = clampMonths(months);
    const pos = POS_TO_MONTHS.indexOf(state.monthsShown);
    for (const btn of document.querySelectorAll(".cr-range button[data-pos]")) {
      const on = Number(btn.dataset.pos) === pos;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-checked", on ? "true" : "false");
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
   *  - 旧 TODAY / STATS 要素 (現在は CSS で非表示) も更新しておく
   *    (他コードが値を参照するケースの保険)
   *  - 分析ビューのヒーロー KPI 数値を 1Hz リアルタイム更新する
   *    (キー入力が検知されているかを画面で確認できるようにするため)。
   *    分析タブの初回表示時に走る count-up アニメと衝突しないよう、
   *    el._animRaf が立っている間 (アニメ中) は上書きしない。 */
  function setTodayCounts(payload) {
    if (!payload || typeof payload !== "object") return;
    const keys = safeInt(payload.keys);
    const mouse = safeInt(payload.mouse);

    // 旧 TODAY 行 (非表示) も同期 (見出し系コードから参照されるかもしれないため)。
    const tk = $("today-keys");
    if (tk) tk.textContent = fmtNum(keys);
    const tm = $("today-mouse");
    if (tm) tm.textContent = fmtNum(mouse);

    // 分析ヒーロー: アニメ中ならスキップ、それ以外は直更新。
    const heroKeys = $("hero-keys-num");
    if (heroKeys && !heroKeys._animRaf) heroKeys.textContent = fmtNum(keys);
    const heroMouse = $("hero-mouse-num");
    if (heroMouse && !heroMouse._animRaf) heroMouse.textContent = fmtNum(mouse);

    const d = parseDate(payload.date);
    if (d) {
      const td = $("today-date");
      if (td) td.textContent = L().dateLabel(d);
    }
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

  function measureCalendarWidth(calGrid) {
    const candidates = [
      calGrid && calGrid.parentElement,
      $("view-cal"),
      document.querySelector(".card"),
      document.body,
    ];
    for (const el of candidates) {
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      const width = Math.floor(rect.width || el.clientWidth || 0);
      if (width >= 120) return width;
    }
    return Math.max(320, window.innerWidth - 48);
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
    const availableW = measureCalendarWidth(calGrid);
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
    return true;
  }

  // ============================================================
  // 11. リスト表示
  // ============================================================

  /** 1 ヶ月キー "YYYY年M月" を作る。
   *  ja: "2026年5月" / en: "May 2026" の形式で月境界の見出しに使う。 */
  function listMonthLabel(d) {
    const labels = L();
    if (state.lang === "en") {
      return `${labels.months[d.getMonth()]} ${d.getFullYear()}`;
    }
    return `${d.getFullYear()}年${d.getMonth() + 1}月`;
  }

  /** リスト 1 行ぶん。
   *  日付セル (日付 + 曜日 + 「今日」バッジ) + キーバー + キー数値
   *  + マウスバー + マウス数値 の 5 列 grid。 */
  function buildListRow(d, todayStr, maxKeys, maxMouse) {
    const keys = safeInt(d.keys);
    const mouse = safeInt(d.mouse);
    const dt = parseDate(d.date);

    const row = document.createElement("div");
    row.className = "cr-list-row";
    if (d.date === todayStr) row.classList.add("is-today");

    // ---- 日付セル ------------------------------------------------------
    const dateCell = document.createElement("div");
    dateCell.className = "date";
    const day = document.createElement("span");
    day.className = "day";
    day.textContent = dt
      ? `${dt.getMonth() + 1}/${pad2(dt.getDate())}`
      : d.date;
    const dow = document.createElement("span");
    dow.className = "dow";
    if (dt) {
      const dowIdx = dt.getDay();
      const dows = state.lang === "en"
        ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
        : ["日", "月", "火", "水", "木", "金", "土"];
      dow.textContent = dows[dowIdx];
      if (dowIdx === 0 || dowIdx === 6) dow.classList.add("is-weekend");
    }
    dateCell.append(day, dow);
    if (d.date === todayStr) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = L().list_today_badge;
      dateCell.appendChild(badge);
    }

    // ---- キーバー + 数値 -----------------------------------------------
    const keysBar = document.createElement("div");
    keysBar.className = "bar";
    const keysFill = document.createElement("span");
    keysFill.style.width = keys > 0 && maxKeys > 0
      ? `${Math.max(6, Math.round((keys / maxKeys) * 100))}%`
      : "0%";
    keysBar.appendChild(keysFill);

    const keysNum = document.createElement("div");
    keysNum.className = keys === 0 ? "num zero" : "num";
    keysNum.textContent = keys === 0 ? "—" : fmtNum(keys);

    // ---- マウスバー + 数値 ---------------------------------------------
    const mouseBar = document.createElement("div");
    mouseBar.className = "bar is-mouse";
    const mouseFill = document.createElement("span");
    mouseFill.style.width = mouse > 0 && maxMouse > 0
      ? `${Math.max(6, Math.round((mouse / maxMouse) * 100))}%`
      : "0%";
    mouseBar.appendChild(mouseFill);

    const mouseNum = document.createElement("div");
    mouseNum.className = mouse === 0 ? "num zero" : "num";
    mouseNum.textContent = mouse === 0 ? "—" : fmtNum(mouse);

    row.append(dateCell, keysBar, keysNum, mouseBar, mouseNum);
    return row;
  }

  /** リスト全体を再構築。
   *  月境界で見出し行を挟み、各月の日数 + 合計 (キー / マウス) を表示。
   *  全 0 の日は今日以外スキップ。最大値は表示行 (全 0 除く) から計算する。 */
  function buildList(entries, today) {
    const body = $("list-body");
    if (!body) return;
    body.replaceChildren();
    const todayStr = fmtDate(today);
    const sorted = [...entries].sort((a, b) => b.date.localeCompare(a.date));

    // 表示対象 (キーまたはマウス > 0、または本日) のみフィルタ。
    const visible = sorted.filter((d) => {
      const k = safeInt(d.keys);
      const m = safeInt(d.mouse);
      return k > 0 || m > 0 || d.date === todayStr;
    });

    if (visible.length === 0) {
      const empty = document.createElement("div");
      empty.className = "cr-list-empty";
      empty.textContent = L().noData;
      body.appendChild(empty);
      return;
    }

    const maxKeys = Math.max(1, ...visible.map((d) => safeInt(d.keys)));
    const maxMouse = Math.max(1, ...visible.map((d) => safeInt(d.mouse)));

    // 表示対象を月でグループ化 (sorted は降順なので、月ヘッダも降順で出る)。
    /** @type {Array<{ key: string, dt: Date, rows: any[] }>} */
    const groups = [];
    /** @type {Map<string, number>} */
    const groupIdx = new Map();
    for (const row of visible) {
      const dt = parseDate(row.date);
      if (!dt) continue;
      const key = `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}`;
      let idx = groupIdx.get(key);
      if (idx === undefined) {
        idx = groups.length;
        groupIdx.set(key, idx);
        groups.push({ key, dt, rows: [] });
      }
      groups[idx].rows.push(row);
    }

    const frag = document.createDocumentFragment();
    for (const g of groups) {
      // 月見出し: ラベル + 当月の日数 / キー総数 / マウス総数
      const head = document.createElement("div");
      head.className = "cr-list-month";
      const label = document.createElement("span");
      label.textContent = listMonthLabel(g.dt);
      const tot = document.createElement("span");
      tot.className = "tot";
      const sumK = g.rows.reduce((a, b) => a + safeInt(b.keys), 0);
      const sumM = g.rows.reduce((a, b) => a + safeInt(b.mouse), 0);
      tot.textContent = L().list_month_summary(g.rows.length, sumK, sumM);
      head.append(label, tot);
      frag.appendChild(head);
      for (const r of g.rows) {
        frag.appendChild(buildListRow(r, todayStr, maxKeys, maxMouse));
      }
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

    // サブヘッダの日付文字列 (本日 5月19日 (火))。カレンダー / リスト 両方を更新。
    const dateStr = L().dateLabel(today);
    const calDate = $("cal-date-str");
    if (calDate) calDate.textContent = dateStr;
    const listDate = $("list-date-str");
    if (listDate) listDate.textContent = dateStr;

    // タイトル更新 (cr-cal-h のメインタイトル)
    const titleEl = $("cal-title");
    if (titleEl) titleEl.textContent = L().title(period.start, period.end);

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

    const heatmapReady = buildHeatmap(data, period, today);
    buildList(data, today);

    // ---- アクティブ日数 (1 操作以上ある日の合計) ------------------------
    let activeDays = 0;
    let totalKeys = 0;
    let totalMouse = 0;
    const dailyTotals = [];
    for (const d of data) {
      const k = safeInt(d.keys);
      const m = safeInt(d.mouse);
      if (k > 0 || m > 0) activeDays += 1;
      totalKeys += k;
      totalMouse += m;
      dailyTotals.push(k + m);
    }
    const activeEl = $("cal-active");
    if (activeEl) activeEl.textContent = L().cal_active_days(activeDays);

    // ---- 期間合計 (キー / マウス) ----------------------------------------
    const tKeys = $("cal-total-keys");
    const tMouse = $("cal-total-mouse");
    if (tKeys)  animateCountUp(tKeys,  totalKeys);
    if (tMouse) animateCountUp(tMouse, totalMouse);

    // ---- 日次合計 sparkline (棒チャート) --------------------------------
    renderDailySpark(dailyTotals);
    const dailyLabelEl = $("cal-daily-label");
    if (dailyLabelEl) dailyLabelEl.textContent = L().cal_daily_label(state.monthsShown);
    const dailyMaxEl = $("cal-daily-max");
    if (dailyMaxEl) {
      const dmax = dailyTotals.length ? Math.max(...dailyTotals) : 0;
      dailyMaxEl.textContent = dmax > 0 ? L().cal_daily_max(dmax) : "—";
    }

    if (!heatmapReady && state.calendarRetry < 6) {
      state.calendarRetry += 1;
      requestAnimationFrame(() => refresh().catch(() => {}));
      return;
    }
    state.calendarRetry = 0;

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

  /** 日次合計 sparkline を描画。SVG の細い棒を 1 日 1 本ずつ並べる。
   *  最大値を 100% として高さを正規化し、視覚的な「波形」を出す。 */
  function renderDailySpark(values) {
    const svg = $("cal-daily-spark");
    if (!svg) return;
    const n = Math.max(1, values.length);
    const max = values.length ? Math.max(...values, 1) : 1;
    svg.setAttribute("viewBox", `0 0 ${n} 26`);
    svg.replaceChildren();
    const svgNs = "http://www.w3.org/2000/svg";
    const frag = document.createDocumentFragment();
    for (let i = 0; i < values.length; i++) {
      const v = values[i] || 0;
      if (v <= 0) continue;
      const h = (v / max) * 24;
      const rect = document.createElementNS(svgNs, "rect");
      rect.setAttribute("x", `${i + 0.15}`);
      rect.setAttribute("y", `${26 - h}`);
      rect.setAttribute("width", "0.7");
      rect.setAttribute("height", `${h}`);
      rect.setAttribute("fill", "var(--accent)");
      rect.setAttribute("opacity", "0.8");
      frag.appendChild(rect);
    }
    // ベースラインの細い罫線
    const line = document.createElementNS(svgNs, "line");
    line.setAttribute("x1", "0");
    line.setAttribute("y1", "25.5");
    line.setAttribute("x2", String(n));
    line.setAttribute("y2", "25.5");
    line.setAttribute("stroke", "var(--border)");
    line.setAttribute("stroke-width", "0.5");
    frag.appendChild(line);
    svg.appendChild(frag);
  }

  // ============================================================
  // 13. UI ハンドラ
  // ============================================================

  /** カレンダー / 分析 / リスト の切替タブ。
   *  分析タブは初回オープン時にデータをロード (起動コストの抑制)。
   *  `.card` に `is-analytics` / `is-list` クラスを付けて CSS 側で
   *  共通 STATS 行 (キー / マウスの大きな数字) の表示を制御する。
   *  カレンダー時のみ STATS を見せ、他ビューは各々の hero / 行内数値に任せる。 */
  function setupTabs() {
    const tabIds = ["cal", "analytics", "list"];
    const card = document.querySelector(".card");
    const activate = (which) => {
      if (which === state.currentTab) return;
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
        }
      }
      if (card) {
        card.classList.toggle("is-analytics", which === "analytics");
        card.classList.toggle("is-list", which === "list");
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

  /** 数値要素を 0 → target にカウントアップ。
   *  分析タブを開いた瞬間に「数字が伸びる」演出を全グラフと揃えるために使う。
   *  reduced-motion の場合は瞬時に最終値を表示する。 */
  function animateCountUp(el, target, durationMs = 900) {
    if (!el) return;
    const end = Math.max(0, Number.isFinite(target) ? Math.round(target) : 0);
    const reduce = window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || end <= 0) {
      el.textContent = fmtNum(end);
      el._animRaf = null;
      return;
    }
    if (el._animRaf) cancelAnimationFrame(el._animRaf);
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / durationMs);
      // ease-out-cubic
      const e = 1 - Math.pow(1 - t, 3);
      el.textContent = fmtNum(Math.round(end * e));
      if (t < 1) {
        el._animRaf = requestAnimationFrame(step);
      } else {
        el._animRaf = null;
      }
    };
    el._animRaf = requestAnimationFrame(step);
  }

  /** 取得対象の日数。スパークラインと 7 日平均の計算に使う。 */
  const HERO_RANGE_DAYS = 14;

  /** 直近 14 日の日次集計を取得 (キー/マウスのスパークライン用)。
   *  失敗時は 0 埋めの配列を返してフロントの描画を壊さない。 */
  async function fetchHeroSeries() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(today.getDate() - (HERO_RANGE_DAYS - 1));
    try {
      const rows = await invoke("get_stats_range", {
        start: fmtDate(start),
        end: fmtDate(today),
      });
      if (!Array.isArray(rows) || rows.length === 0) {
        return { keys: new Array(HERO_RANGE_DAYS).fill(0), mouse: new Array(HERO_RANGE_DAYS).fill(0) };
      }
      // Rust 側は範囲内全日 (歯抜けなし) を返してくる前提だが、保険として
      // 日付キーをマップにして 14 日に必ずパディングする。
      const byDate = new Map();
      for (const r of rows) {
        if (r && r.date) byDate.set(r.date, { keys: safeInt(r.keys), mouse: safeInt(r.mouse) });
      }
      const keys = [];
      const mouse = [];
      for (let i = 0; i < HERO_RANGE_DAYS; i++) {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        const slot = byDate.get(fmtDate(d)) || { keys: 0, mouse: 0 };
        keys.push(slot.keys);
        mouse.push(slot.mouse);
      }
      return { keys, mouse };
    } catch (e) {
      console.error("fetchHeroSeries failed", e);
      return { keys: new Array(HERO_RANGE_DAYS).fill(0), mouse: new Array(HERO_RANGE_DAYS).fill(0) };
    }
  }

  /** 「今日を除いた直近 7 日」の平均を計算。HERO_RANGE_DAYS=14 を前提に、
   *  末尾 (今日) を除外し、その手前 7 日 (= [-8..-1]) の平均を返す。 */
  function avg7ExcludingToday(series) {
    if (!Array.isArray(series) || series.length < 8) return 0;
    const slice = series.slice(series.length - 8, series.length - 1); // 7 日
    if (slice.length === 0) return 0;
    return slice.reduce((s, v) => s + safeInt(v), 0) / slice.length;
  }

  /** 7 日平均と今日値の差分パーセント。avg=0 のときは null (表示は "—")。 */
  function computeDeltaPct(todayVal, avg7) {
    if (!avg7 || avg7 <= 0) return null;
    return ((todayVal - avg7) / avg7) * 100;
  }

  /** スパークラインを描画。
   *  既存の <svg id=...> の中の `.line` / `.area` / `.dot` を更新する。
   *  線描画アニメーションは `.is-drawn` クラス付け外しで再生する: 一旦
   *  クラスを外して stroke-dashoffset を 100% に戻し、次フレームで is-drawn
   *  を付け直すと CSS transition が 0 まで補間する。 */
  function renderSparkline(svg, data) {
    if (!svg || !Array.isArray(data) || data.length === 0) return;
    const W = 100;
    const H = 24;
    const max = Math.max(1, ...data.map(v => safeInt(v)));
    const n = data.length;
    // 単一データ点だと stepX が 0 になり Infinity が出る。中央に置く。
    const stepX = n > 1 ? W / (n - 1) : 0;
    const pts = data.map((v, i) => {
      const x = n > 1 ? i * stepX : W / 2;
      const y = H - (safeInt(v) / max) * (H - 2) - 1;
      return [x, y];
    });
    const dLine = pts.map((p, i) => (i === 0 ? `M ${p[0]} ${p[1]}` : `L ${p[0]} ${p[1]}`)).join(" ");
    const dArea = `${dLine} L ${W} ${H} L 0 ${H} Z`;
    const last = pts[pts.length - 1];

    const line = svg.querySelector(".line");
    const area = svg.querySelector(".area");
    const dot  = svg.querySelector(".dot");
    if (line) line.setAttribute("d", dLine);
    if (area) area.setAttribute("d", dArea);
    if (dot) {
      dot.setAttribute("cx", last[0].toFixed(2));
      dot.setAttribute("cy", last[1].toFixed(2));
    }

    // 線の長さを実測して dasharray の基準にする。viewBox=100x24 の世界で
    // 計算しているので、stroke-dasharray もその尺度で OK。
    let len = 0;
    try {
      len = line ? line.getTotalLength() : W;
    } catch {
      len = W;
    }
    if (!Number.isFinite(len) || len <= 0) len = W;
    svg.style.setProperty("--len", String(len));

    // アニメ再生: いったん is-drawn を外して dashoffset を初期化、
    // 2 フレーム待って付け直すと 0 まで補間が走る。
    svg.classList.remove("is-drawn");
    void svg.getBoundingClientRect();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        svg.classList.add("is-drawn");
      });
    });
  }

  /** ヒーローの KPI を 1 つ更新する。
   *  数値はカウントアップ、スパークラインは線描画、7日平均と差分は静的反映。 */
  function renderHeroKPI({ prefix, todayVal, avg7Val, series }) {
    const numEl   = $(`hero-${prefix}-num`);
    const avg7El  = $(`hero-${prefix}-avg7`);
    const deltaEl = $(`hero-${prefix}-delta`);
    const sparkEl = $(`hero-${prefix}-spark`);
    if (numEl)  animateCountUp(numEl, todayVal);
    if (avg7El) avg7El.textContent = fmtNum(Math.round(avg7Val));
    if (deltaEl) {
      const pct = computeDeltaPct(todayVal, avg7Val);
      const labels = L();
      deltaEl.classList.remove("up", "down", "muted");
      if (pct === null) {
        deltaEl.textContent = "—";
        deltaEl.classList.add("muted");
      } else {
        deltaEl.textContent = labels.hero_delta(pct);
        deltaEl.classList.add(pct >= 0 ? "up" : "down");
      }
    }
    if (sparkEl) renderSparkline(sparkEl, series);
  }

  /** 0 → target にバーを伸ばす 2-rAF パターン。 */
  function animateBarFill(el, targetPct, delayMs = 0) {
    if (!el) return;
    el.style.setProperty("--delay", `${delayMs}ms`);
    el.style.width = "0%";
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.style.width = `${Math.max(0, Math.min(100, targetPct)).toFixed(2)}%`;
      });
    });
  }

  /** ストリップの「マウス距離」「スクロール高さ」セル 1 つを更新。 */
  function renderStripTrip({ prefix, meters, landmarks }) {
    const numEl  = $(`trip-${prefix}-num`);
    const unitEl = $(`trip-${prefix}-unit`);
    const goalEl = $(`trip-${prefix}-goal`);
    const fillEl = $(`trip-${prefix}-fill`);
    const pctEl  = $(`trip-${prefix}-pct`);
    if (!numEl || !unitEl || !goalEl || !fillEl || !pctEl) return;

    const m = Math.max(0, Number(meters) || 0);
    const { num, unit } = fmtTripDistance(m);
    numEl.textContent = num;
    unitEl.textContent = unit;

    const lm = findLandmark(m, landmarks);
    const labels = L();
    if (!lm) {
      goalEl.textContent = labels.trip_goal_to(landmarks[0]?.name || "—");
      animateBarFill(fillEl, 0);
      pctEl.textContent = "0%";
      return;
    }
    if (lm.exceeded) {
      goalEl.textContent = labels.trip_goal_passed(lm.lm.name);
      animateBarFill(fillEl, 100);
      pctEl.textContent = "100%";
      return;
    }
    goalEl.textContent = labels.trip_goal_to(lm.lm.name);
    const pct = Math.min(100, Math.max(0, lm.pct));
    animateBarFill(fillEl, pct);
    pctEl.textContent = `${pct.toFixed(1)}%`;
  }

  /** 24 時間ヒストグラム: 本日 (濃) + 7 日平均 (淡) を 1 セル内で重ねる。
   *  両系列を正規化する際は両系列の最大値の方を分母にし、相対比較が
   *  視覚的に成り立つようにする。 */
  function renderHours(todayHourly, avg7Hourly) {
    const wrap = $("hours-cells");
    if (!wrap) return;
    wrap.replaceChildren();

    const today = Array.isArray(todayHourly) ? todayHourly : new Array(24).fill(0);
    const avg = Array.isArray(avg7Hourly) ? avg7Hourly : new Array(24).fill(0);
    const safeT = (i) => safeInt(today[i] || 0);
    const safeA = (i) => Math.max(0, Number(avg[i] || 0));
    let max = 0;
    for (let i = 0; i < 24; i++) {
      const v = Math.max(safeT(i), safeA(i));
      if (v > max) max = v;
    }
    if (max <= 0) max = 1;

    const frag = document.createDocumentFragment();
    const targets = [];
    for (let h = 0; h < 24; h++) {
      const aRaw = safeA(h);
      const tRaw = safeT(h);

      const cell = document.createElement("div");
      cell.className = "cr-hour-cell";
      cell.dataset.hour = String(h);
      cell.dataset.val = String(tRaw);
      cell.setAttribute("aria-label", L().hourTooltip(h, fmtNum(tRaw)));
      // 左から右へ立ち上がる waves 演出のため時間帯 index で遅延を加算。
      cell.style.setProperty("--delay", `${h * 22}ms`);

      const avgBar = document.createElement("div");
      avgBar.className = "cr-hour-bar-avg";
      // has-avg 属性で 0 のときマーカーを完全に消す。
      avgBar.dataset.hasAvg = aRaw > 0 ? "true" : "false";

      const tBar = document.createElement("div");
      tBar.className = "cr-hour-bar-today";

      // 描画順: 先に avg (背景 + マーカー)、後に today (z-index 1 で前面)。
      // ただし avg::after マーカーは z-index 2 で today より前に出る。
      cell.append(avgBar, tBar);
      frag.appendChild(cell);

      // 値が 0 でも見えないだけ。値があるときは 3% 下限で必ず可視 (今日マーカーも同様)。
      const pctAvg = aRaw > 0 ? Math.max(3, (aRaw / max) * 100) : 0;
      const pctT   = tRaw > 0 ? Math.max(3, (tRaw / max) * 100) : 0;
      targets.push({ avgBar, tBar, pctAvg, pctT });
    }
    wrap.appendChild(frag);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        for (const t of targets) {
          t.avgBar.style.setProperty("--h-avg", `${t.pctAvg.toFixed(2)}%`);
          t.tBar.style.setProperty("--h-today", `${t.pctT.toFixed(2)}%`);
        }
      });
    });
  }

  /** 「よく使うキー」グリッド (2 列)。
   *  各行は モノスペース風のキーキャップ風 chip + バー + 件数。 */
  function renderKeysGrid(items) {
    const grid = $("keys-breakdown");
    if (!grid) return;
    grid.replaceChildren();

    if (!items || items.length === 0) {
      const p = document.createElement("div");
      p.className = "cr-empty";
      p.textContent = L().noAnalytics;
      grid.appendChild(p);
      return;
    }
    const max = items.reduce((m, it) => Math.max(m, safeInt(it.count)), 1);
    const frag = document.createDocumentFragment();
    const fills = [];
    items.forEach((it, idx) => {
      const count = safeInt(it.count);
      // count=0 → 0% (track だけ見える)。count>0 → 最低 10% で必ず可視。
      // 狭いコラム幅でも 10% あれば 4-5px ほど確保できる。
      const pct = count > 0
        ? Math.max(10, Math.round((count / max) * 100))
        : 0;
      const row = document.createElement("div");
      row.className = "cr-keyrow";

      const k = document.createElement("div");
      k.className = "k";
      k.textContent = prettyKey(it.label || "");

      const bar = document.createElement("div");
      bar.className = "bar";
      const fill = document.createElement("span");
      fill.style.width = "0%";
      fill.style.setProperty("--delay", `${idx * 50}ms`);
      bar.appendChild(fill);

      const n = document.createElement("div");
      n.className = "n";
      n.textContent = fmtNum(count);

      row.append(k, bar, n);
      frag.appendChild(row);
      fills.push({ el: fill, pct });
    });
    grid.appendChild(frag);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        for (const f of fills) {
          f.el.style.width = `${f.pct}%`;
        }
      });
    });
  }

  /** マウス内訳: 左/右/中クリックの行を 3 列レイアウトで描画。 */
  function renderMouseList(items) {
    const list = $("mouse-breakdown");
    if (!list) return;
    list.replaceChildren();

    if (!items || items.length === 0) {
      const p = document.createElement("div");
      p.className = "cr-empty";
      p.textContent = L().noAnalytics;
      list.appendChild(p);
      return;
    }

    const labels = L().mouseLabels || {};
    const max = items.reduce((m, it) => Math.max(m, safeInt(it.count)), 1);
    const frag = document.createDocumentFragment();
    const fills = [];
    items.forEach((it, idx) => {
      const count = safeInt(it.count);
      const pct = count > 0
        ? Math.max(10, Math.round((count / max) * 100))
        : 0;
      const row = document.createElement("div");
      row.className = "cr-mouserow";

      const lbl = document.createElement("div");
      lbl.className = "lbl";
      lbl.textContent = labels[it.label] || it.label || "";

      const bar = document.createElement("div");
      bar.className = "bar";
      const fill = document.createElement("span");
      fill.style.width = "0%";
      fill.style.setProperty("--delay", `${idx * 60}ms`);
      bar.appendChild(fill);

      const n = document.createElement("div");
      n.className = "n";
      n.textContent = fmtNum(count);

      row.append(lbl, bar, n);
      frag.appendChild(row);
      fills.push({ el: fill, pct });
    });
    list.appendChild(frag);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        for (const f of fills) {
          f.el.style.width = `${f.pct}%`;
        }
      });
    });
  }

  /** 分析タブ上段のサブヘッダ (日付 + 時刻) を更新。 */
  function updateAnalyticsSubhead() {
    const now = new Date();
    const dateEl = $("cr-date-str");
    if (dateEl) dateEl.textContent = L().dateLabel(now);
    const clockEl = $("cr-clock-str");
    if (clockEl) clockEl.textContent = L().hero_now_at(now.getHours(), now.getMinutes());
  }

  /** 分析データを取得して各セクションを再描画。
   *  4 つのリクエストを並列実行: 今日値、スコープ集計、14日系列、週集計
   *  (時間帯overlay 用)。失敗時は noData フォールバックを各セクション内で出す。 */
  async function refreshAnalytics() {
    updateAnalyticsSubhead();
    let scopeData, weekData, todayPayload, heroSeries;
    try {
      [scopeData, weekData, todayPayload, heroSeries] = await Promise.all([
        invoke("get_analytics", { scope: state.analyticsScope }),
        invoke("get_analytics", { scope: "week" }),
        invoke("get_today_stats"),
        fetchHeroSeries(),
      ]);
    } catch (e) {
      console.error("refreshAnalytics fetch failed", e);
      return;
    }
    state.analyticsLoaded = true;

    // ---- Hero: 今日値 + 7日平均 + 14日スパークライン -----------------
    const todayKeys = safeInt(todayPayload && todayPayload.keys);
    const todayMouse = safeInt(todayPayload && todayPayload.mouse);
    const avg7Keys = avg7ExcludingToday(heroSeries.keys);
    const avg7Mouse = avg7ExcludingToday(heroSeries.mouse);
    renderHeroKPI({ prefix: "keys",  todayVal: todayKeys,  avg7Val: avg7Keys,  series: heroSeries.keys  });
    renderHeroKPI({ prefix: "mouse", todayVal: todayMouse, avg7Val: avg7Mouse, series: heroSeries.mouse });

    // ---- Strip: 1日平均 + マウス距離 + スクロール高 ------------------
    animateCountUp($("kpi-average-num"), safeInt(scopeData.averagePerDay));
    renderStripTrip({
      prefix: "mouse",
      meters: safeInt(scopeData.mouseDistancePx) / PX_PER_METER,
      landmarks: MOUSE_LANDMARKS,
    });
    renderStripTrip({
      prefix: "scroll",
      meters: safeInt(scopeData.scrollYTicks) * M_PER_SCROLL_TICK,
      landmarks: SCROLL_LANDMARKS,
    });

    // ---- Hour histogram: 選択スコープ + 7日平均overlay ---------------
    // 7 日平均 per hour = 週合計 / 7。月や全期間でも比較相手は常に直近7日。
    const avg7Hourly = (Array.isArray(weekData.hourly) ? weekData.hourly : new Array(24).fill(0))
      .map(v => Math.max(0, Number(v) || 0) / 7);
    renderHours(scopeData.hourly || [], avg7Hourly);

    // ---- Bottom split: top keys + マウス内訳 ------------------------
    renderKeysGrid((scopeData.keys || []).slice(0, KEY_TOP_N));
    renderMouseList(scopeData.mouse || []);
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

  /** 期間スイッチ (1/3/6/12ヶ月) のクリック受付。
   *  デザイン刷新で従来のスライダーは廃止し、4 連ボタン (`.cr-range button[data-pos]`)
   *  に統一した。 */
  function setupPeriodSlider() {
    for (const btn of document.querySelectorAll(".cr-range button[data-pos]")) {
      btn.addEventListener("click", (ev) => {
        if (!ev.isTrusted || !navReady()) return;
        selectPeriodByPos(Number(btn.dataset.pos));
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

        // (2) 時間帯ヒストグラムセル (Refinement design)
        const hh = closest(".cr-hour-cell");
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
