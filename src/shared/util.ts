// SPDX-License-Identifier: MIT
//
// Clack — 共有ユーティリティ
//
// 他のフロント TS から `window.Clack.util` 経由で利用される最も低レイヤの
// 関数群。state や i18n には依存しない。例外として `fmtNum` だけは現在
// 言語を読むため `window.Clack.state.lang` を call-time に参照する
// (state は main.ts が IIFE 先頭で window.Clack.state にセットする)。
//
// 依存: なし (このファイルが最初にロードされる)

(function () {
  const C = (window.Clack = window.Clack || ({} as ClackNamespace));

  /** 短縮: getElementById */
  function $(id: string): HTMLElement | null {
    return document.getElementById(id);
  }

  /** 2 桁ゼロ詰め */
  function pad2(n: number): string {
    return String(n).padStart(2, "0");
  }

  /** 数値 → ロケール対応の桁区切り表記。負値や NaN は "0"。
   *  ロケールは call-time に `Clack.state.lang` を参照 (en/ja)。 */
  function fmtNum(n: number | string): string {
    if (!Number.isFinite(+n) || +n < 0) return "0";
    const lang = C.state && C.state.lang === "en" ? "en-US" : "ja-JP";
    return Number(n).toLocaleString(lang);
  }

  /** Date → YYYY-MM-DD (ローカル時刻基準)。Rust 側と同じ書式。 */
  function fmtDate(d: Date): string {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  /** YYYY-MM-DD 文字列 → Date。妥当でない値は null。 */
  function parseDate(s: string): Date | null {
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
  function safeInt(v: unknown): number {
    const n = parseInt(v as string, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  /** 期間スライダーで選べる月数。 */
  const POS_TO_MONTHS: readonly MonthsShown[] = [1, 3, 6, 12];

  /** 月数を許可リストに丸める。範囲外は 6 (デフォルト)。 */
  function clampMonths(v: number): MonthsShown {
    return (POS_TO_MONTHS as readonly number[]).includes(v) ? (v as MonthsShown) : 6;
  }

  /** スライダー位置を許可リストに丸める。範囲外は 2 (= 6M)。 */
  function clampPos(p: number): number {
    return Number.isInteger(p) && p >= 0 && p < POS_TO_MONTHS.length ? p : 2;
  }

  /** プラットフォーム判定。Mac 系 (macOS / iPadOS / iOS) なら true。
   *  navigator.platform は非推奨だが、Tauri WebView では十分信頼できる。
   *  userAgentData の OS 取得は非同期のためここでは使わず、
   *  起動時の即値判定に統一する。 */
  const IS_MAC: boolean =
    typeof navigator !== "undefined" &&
    /Mac|iPod|iPhone|iPad/.test(`${navigator.platform || ""} ${navigator.userAgent || ""}`);

  /** rdev のキー識別子 → 表示ラベル (Windows / Linux 標準)。
   *  全件は網羅しないが、よく使われるものは短く読みやすくする。
   *  未登録のキーは raw 文字列にフォールバック。 */
  const KEY_LABEL_MAP_WIN: Record<string, string> = {
    Space: "Space",
    Return: "Enter",
    BackSpace: "BS",
    Tab: "Tab",
    Escape: "Esc",
    CapsLock: "CapsLock",
    ShiftLeft: "Shift L",
    ShiftRight: "Shift R",
    ControlLeft: "Ctrl L",
    ControlRight: "Ctrl R",
    Alt: "Alt",
    AltGr: "AltGr",
    MetaLeft: "Win L",
    MetaRight: "Win R",
    Comma: ",",
    Dot: ".",
    SemiColon: ";",
    Quote: "'",
    BackQuote: "`",
    Slash: "/",
    BackSlash: "\\",
    Equal: "=",
    Minus: "-",
    LeftBracket: "[",
    RightBracket: "]",
    UpArrow: "↑",
    DownArrow: "↓",
    LeftArrow: "←",
    RightArrow: "→",
    Insert: "Ins",
    Delete: "Del",
    Home: "Home",
    End: "End",
    PageUp: "PgUp",
    PageDown: "PgDn",
    PrintScreen: "PrtSc",
    ScrollLock: "ScrLk",
    Pause: "Pause",
    NumLock: "NumLk",
    IntlYen: "¥",
    IntlBackslash: "\\",
    IntlRo: "_",
    KanaMode: "かな",
    ConvertJp: "変換",
    NonConvert: "無変換",
  };

  /** rdev のキー識別子 → 表示ラベル (macOS)。
   *  - Alt → ⌥ Option / Meta → ⌘ Command の Apple 標準呼称
   *  - Mac は BackSpace ではなく "delete"、Delete は "Fn ⌫" (forward delete)
   *  - JIS Mac の "英数 / かな" は ConvertJp / NonConvert にマッピング
   *    (rdev が両方 ConvertJp などに寄せて返すケースに合わせ、両方を載せる) */
  const KEY_LABEL_MAP_MAC: Record<string, string> = {
    Space: "Space",
    Return: "Return",
    BackSpace: "⌫",
    Tab: "⇥",
    Escape: "esc",
    CapsLock: "caps lock",
    ShiftLeft: "⇧ L",
    ShiftRight: "⇧ R",
    ControlLeft: "⌃ L",
    ControlRight: "⌃ R",
    Alt: "⌥ Option",
    AltGr: "⌥ Option",
    MetaLeft: "⌘ L",
    MetaRight: "⌘ R",
    Comma: ",",
    Dot: ".",
    SemiColon: ";",
    Quote: "'",
    BackQuote: "`",
    Slash: "/",
    BackSlash: "\\",
    Equal: "=",
    Minus: "-",
    LeftBracket: "[",
    RightBracket: "]",
    UpArrow: "↑",
    DownArrow: "↓",
    LeftArrow: "←",
    RightArrow: "→",
    Insert: "Help",
    Delete: "⌦",
    Home: "↖",
    End: "↘",
    PageUp: "⇞",
    PageDown: "⇟",
    PrintScreen: "⌥ ⇧ 3",
    ScrollLock: "Scroll",
    Pause: "Pause",
    NumLock: "Clear",
    IntlYen: "¥",
    IntlBackslash: "§",
    IntlRo: "_",
    KanaMode: "かな",
    ConvertJp: "英数",
    NonConvert: "かな",
  };

  /** OS に応じて選ばれる現在のキーラベル辞書。 */
  const KEY_LABEL_MAP: Record<string, string> = IS_MAC ? KEY_LABEL_MAP_MAC : KEY_LABEL_MAP_WIN;

  /** rdev のキー識別子を見やすい短い表示に整える。
   *  KeyA → A, Num0 → 0, Kp1 → Num1 (テンキー識別), F1 → F1。
   *  OS によって特殊キーの呼称が違うので KEY_LABEL_MAP は IS_MAC で
   *  切替済みのものを使う。 */
  function prettyKey(label: string): string {
    if (!label) return "";
    if (KEY_LABEL_MAP[label]) return KEY_LABEL_MAP[label];
    if (/^Key[A-Z]$/.test(label)) return label.slice(3);
    if (/^Num\d$/.test(label)) return label.slice(3);
    if (/^Kp\d$/.test(label)) return `Num${label.slice(2)}`;
    if (/^F\d{1,2}$/.test(label)) return label;
    return label;
  }

  // 公開
  C.util = {
    $,
    pad2,
    fmtNum,
    fmtDate,
    parseDate,
    safeInt,
    clampMonths,
    clampPos,
    prettyKey,
    POS_TO_MONTHS,
    KEY_LABEL_MAP,
    IS_MAC,
  };
  C.$ = $; // よく使うので短縮も top-level に
})();
