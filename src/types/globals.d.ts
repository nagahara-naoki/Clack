// SPDX-License-Identifier: MIT
//
// Clack — グローバル名前空間 (`window.Clack`, `window.__TAURI__`) の型拡張。
//
// 本ファイルは ambient. import / export を含まずトップレベル `declare global`
// だけを置くことで、すべての .ts ファイルから無条件にこれらの型が参照できる
// (module: "none" の構成と相性が良い)。

/* ===========================================================
 *  window.__TAURI__  (withGlobalTauri: true 経由で公開される)
 * =========================================================== */

interface TauriRuntime {
  core: {
    /** タイプセーフな invoke。`IpcCommandMap` のキーで cmd を絞り込み、
     *  引数 / 戻り値の型を自動推論する。
     *  引数が undefined のコマンドは第二引数を省略可能。 */
    invoke<K extends keyof IpcCommandMap>(
      cmd: K,
      ...args: IpcCommandMap[K]["args"] extends undefined ? [] : [IpcCommandMap[K]["args"]]
    ): Promise<IpcCommandMap[K]["ret"]>;
  };
  event: {
    /** タイプセーフな listen。`IpcEventMap` のキーで name を絞り込み、
     *  ハンドラ引数の payload 型を自動推論する。 */
    listen<K extends keyof IpcEventMap>(
      name: K,
      handler: (event: TauriEvent<IpcEventMap[K]>) => void,
    ): Promise<() => void>;
    emit(name: string, payload?: unknown): Promise<void>;
  };
  window?: {
    getCurrentWindow(): TauriWebviewWindow;
    LogicalSize: new (w: number, h: number) => object;
  };
}

interface TauriWebviewWindow {
  show(): Promise<void>;
  hide(): Promise<void>;
  setFocus(): Promise<void>;
  startDragging(): Promise<void>;
  outerSize(): Promise<{ width: number; height: number }>;
  scaleFactor(): Promise<number>;
  setSize(size: object): Promise<void>;
}

/* ===========================================================
 *  window.Clack — 各モジュールが augment する名前空間
 * =========================================================== */

interface ClackUtil {
  $: (id: string) => HTMLElement | null;
  pad2: (n: number) => string;
  fmtNum: (n: number | string) => string;
  fmtDate: (d: Date) => string;
  parseDate: (s: string) => Date | null;
  safeInt: (v: unknown) => number;
  clampMonths: (v: number) => MonthsShown;
  clampPos: (p: number) => number;
  prettyKey: (label: string) => string;
  POS_TO_MONTHS: readonly MonthsShown[];
  KEY_LABEL_MAP: Record<string, string>;
  IS_MAC: boolean;
}

interface ClackI18n {
  /** I18N 辞書本体 (任意のキー: string | function)。詳細は i18n.ts 参照。 */
  I18N: Record<Language, Record<string, any>>;
  L: () => Record<string, any>;
  applyLanguage: (lang: string) => void;
  DOW_JA: readonly string[];
  DOW_EN: readonly string[];
  MONTHS_EN: readonly string[];
}

interface ClackCalendar {
  computePeriod: () => CalendarPeriod;
  buildHeatmap: (entries: DayEntry[], period: CalendarPeriod, today: Date) => boolean;
  renderDailySpark: (values: number[]) => void;
  applyPeriodSelection: (months: number) => void;
  selectPeriodByPos: (pos: number) => void;
  persistMonthsShown: (value: number) => Promise<void>;
  setupPeriodSlider: () => void;
  setupCalNav: () => void;
  setupDayPopover: () => void;
  closeDayPopover: () => void;
}

interface ClackAnalytics {
  refresh: () => Promise<void>;
  setupScope: () => void;
  animateCountUp: (el: HTMLElement | null, target: number, durationMs?: number) => void;
  fetchHeroSeries: () => Promise<{ keys: number[]; mouse: number[] }>;
}

interface ClackList {
  build: (entries: DayEntry[], today: Date) => void;
}

interface ClackNamespace {
  state: AppStateShape;
  invoke: TauriRuntime["core"]["invoke"];
  listen: TauriRuntime["event"]["listen"];
  navReady: () => boolean;
  refresh: () => Promise<void>;
  $: (id: string) => HTMLElement | null;
  util: ClackUtil;
  i18n: ClackI18n;
  calendar: ClackCalendar;
  analytics: ClackAnalytics;
  list: ClackList;
}

// module: "none" の構成では各 .ts が script 扱いになるので、
// `declare global` で wrap せず top-level でそのまま Window を augment する。
interface Window {
  __TAURI__?: TauriRuntime;
  Clack: ClackNamespace;
}

/** カスタムプロパティ拡張:
 *  - `_animRaf`: animateCountUp が requestAnimationFrame ID を保持するため
 *  - `_t`: showToast が setTimeout タイマー ID を保持するため (関数オブジェクト
 *    自体に積む変則的な使い方をしている)
 *  どちらも本番コード由来のレガシー pattern。新規追加は避ける。 */
interface HTMLElement {
  _animRaf?: number | null;
  /** form 系要素にしか無いプロパティの簡易拡張 (実体は input.checked 等)。
   *  毎回 cast するのを避けるための実用的な lax 型定義。 */
  checked?: boolean;
  disabled?: boolean;
  value?: string;
}

// Function オブジェクトに任意プロパティを生やしている箇所がある (settings.ts)。
// 該当だけのために Function 全体を loose にする。
interface Function {
  _t?: number | ReturnType<typeof setTimeout> | null;
}

/** `ev.target` (型は EventTarget | null) に対して、HTML 要素であることを
 *  暗黙に仮定しているコードが多い。毎回 `as HTMLElement` を書くのを避ける
 *  ため、よく使う DOM 系メソッド / プロパティを EventTarget 上にも生やす。
 *  実体は基本的に HTMLElement であることを前提とした実用的 lax 型。 */
interface EventTarget {
  closest?(selectors: string): Element | null;
  dataset?: DOMStringMap;
  classList?: DOMTokenList;
  textContent?: string | null;
  disabled?: boolean;
  checked?: boolean;
  value?: string;
  tagName?: string;
}

/** querySelector / querySelectorAll の戻り値 `Element` は dataset / style 等を
 *  持たないが、実質 HTMLElement なので緩めておく。 */
interface Element {
  dataset?: DOMStringMap;
  style?: CSSStyleDeclaration;
  offsetWidth?: number;
  offsetHeight?: number;
}
