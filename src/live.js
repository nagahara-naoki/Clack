// SPDX-License-Identifier: MIT
//
// Clack — リアルタイム入力表示オーバーレイ (live ウィンドウ) のコントローラ。
//
// 機能:
//  - Rust から流れてくる "live-key" イベントをチップに変換して表示
//  - スタックモード ON: チップは消えず、bar が折り返しで積み上がる
//                       (最大 100 個、超過は最古から DOM 削除)
//  - スタックモード OFF: 1 行固定、新しいチップが右から流れ込み、古いものは
//                        左にクリップ。各チップは一定時間後にフェードアウト
//  - ヘッダーの ✕ ボタンでリアルタイム表示自体をオフ
//  - 内容の縦サイズに応じてウィンドウを自動リサイズ (最小限を保つ)。
//    空 → 1 個目では bar の min-height によりサイズ変動しない。

(() => {
  "use strict";

  const T = window.__TAURI__;
  if (!T) return;
  const listen = T.event.listen;
  const invoke = T.core.invoke;
  const getCurrentWindow = T.window && T.window.getCurrentWindow;
  const LogicalSize = T.window && T.window.LogicalSize;

  /** スタックモード時にバッファに保持するチップの最大個数。
   *  非スタックモードは常に 1 個のみを表示し、新しいキー入力で即座に
   *  入れ替わる (蓄積しない)。 */
  const MAX_CHIPS = 100;

  /** 自動リサイズの最小・最大ウィンドウ高さ (CSS px)。
   *  最小はヘッダー (30) + bar の min-height (58) とほぼ一致するよう
   *  64 を下限にしている。 */
  const MIN_HEIGHT = 64;
  const MAX_HEIGHT = 480;

  /** 自動リサイズの debounce (ms)。連続イベント時の OS リサイズ回数を抑える。 */
  const RESIZE_DEBOUNCE = 60;

  // ============================================================
  // ラベル整形
  // ============================================================

  const KEY_LABEL = {
    Space: "␣ Space",
    Return: "↵ Enter",
    BackSpace: "⌫ BS",
    Tab: "⇥ Tab",
    Escape: "Esc",
    CapsLock: "Caps",
    ShiftLeft: "⇧ Shift", ShiftRight: "Shift ⇧",
    ControlLeft: "Ctrl", ControlRight: "Ctrl",
    Alt: "Alt", AltGr: "AltGr",
    MetaLeft: "❖", MetaRight: "❖",
    Comma: ",", Dot: ".", SemiColon: ";",
    Quote: "'", BackQuote: "`",
    Slash: "/", BackSlash: "\\",
    Equal: "=", Minus: "-",
    LeftBracket: "[", RightBracket: "]",
    UpArrow: "↑", DownArrow: "↓", LeftArrow: "←", RightArrow: "→",
    Insert: "Ins", Delete: "Del",
    Home: "Home", End: "End", PageUp: "PgUp", PageDown: "PgDn",
    PrintScreen: "PrtSc", ScrollLock: "ScrLk", Pause: "Pause", NumLock: "NumLk",
    IntlYen: "¥", IntlBackslash: "\\", IntlRo: "_",
    KanaMode: "かな", ConvertJp: "変換", NonConvert: "無変換",
  };

  const MOUSE_LABEL = {
    Left: "左クリック",
    Right: "右クリック",
    Middle: "中クリック",
  };

  function prettyAtom(raw) {
    if (!raw) return "?";
    if (KEY_LABEL[raw]) return KEY_LABEL[raw];
    if (/^Key[A-Z]$/.test(raw)) return raw.slice(3);
    if (/^Num\d$/.test(raw)) return raw.slice(3);
    if (/^Kp\d$/.test(raw)) return "Num" + raw.slice(2);
    if (/^F\d{1,2}$/.test(raw)) return raw;
    return raw;
  }

  function prettyKeyChain(raw) {
    if (!raw) return "?";
    const parts = String(raw).split("+");
    return parts
      .map((p, i) => (i < parts.length - 1 ? p : prettyAtom(p)))
      .join("+");
  }

  function prettyMouse(raw) {
    if (!raw) return "Mouse";
    const parts = String(raw).split("+");
    const last = parts.pop();
    const tail = MOUSE_LABEL[last] || last;
    if (parts.length === 0) return tail;
    return parts.join("+") + "+" + tail;
  }

  // ============================================================
  // DOM
  // ============================================================

  const bar = document.getElementById("live-bar");
  const header = document.querySelector(".live-header");
  const btnStack = document.getElementById("btn-stack");
  const btnClose = document.getElementById("btn-close");

  /** スタックモード: true = 積み上げ (折り返し) / false = 1 行 (transient)。
   *  初期値は OFF (1 行・フェード) で、ユーザーが必要に応じて ≡ ボタン
   *  で ON にする。 */
  let stackMode = false;

  /** 指定したチップを即座にフェードアウトさせ、アニメ完了で DOM から外す。 */
  function fadeAndRemove(c) {
    if (!c || !c.isConnected) return;
    c.classList.add("is-fading");
    c.addEventListener(
      "animationend",
      () => {
        if (c.parentNode) c.parentNode.removeChild(c);
        scheduleResize();
      },
      { once: true },
    );
  }

  function addChip(payload) {
    if (!bar) return;
    const kind = payload && payload.kind;
    const raw = payload && payload.label;
    if (!kind || !raw) return;

    const text = kind === "mouse" ? prettyMouse(raw) : prettyKeyChain(raw);

    // 直前の "is-recent" を解除 (最新だけがアクセント色)。
    for (const sib of bar.querySelectorAll(".chip.is-recent")) {
      sib.classList.remove("is-recent");
    }

    const chip = document.createElement("span");
    chip.className = "chip is-recent" + (kind === "mouse" ? " is-mouse" : "");
    chip.textContent = text;

    if (stackMode) {
      // スタックモード: 末尾に追加して累積。バッファ上限と画面サイズ
      // 上限の両方で古いチップを切り捨て、常に最新が画面内に残るよう保つ。
      bar.appendChild(chip);
      while (bar.childElementCount > MAX_CHIPS) {
        bar.firstElementChild.remove();
      }
      trimToFitWindow();
    } else {
      // 非スタック (デフォルト): 常に 1 個のみ。既存チップは即フェードアウト、
      // 新しいチップを **先頭に** 入れて左の同じ位置に居座らせる。
      // 古いチップは右側で消えていくので、視線がぶれにくい。
      for (const c of bar.querySelectorAll(".chip:not(.is-fading)")) {
        fadeAndRemove(c);
      }
      bar.insertBefore(chip, bar.firstChild);
    }

    scheduleResize();
  }

  /** スタックモード時、bar が **ウィンドウ可視領域より大きく** なったら
   *  最古のチップから順に DOM を削除して、常に最新行が画面内に収まる
   *  状態を保つ。ウィンドウは最大高さで頭打ちになるので、画面外に
   *  チップが消えていく挙動になる。 */
  function trimToFitWindow() {
    if (!stackMode || !bar) return;
    const headerH = header ? header.offsetHeight : 0;
    const available = document.documentElement.clientHeight - headerH;
    if (available <= 0) return;
    // safety: 想定外のループ暴走を防ぐ。
    let safety = 0;
    while (
      bar.offsetHeight > available &&
      bar.childElementCount > 1 &&
      safety++ < 200
    ) {
      bar.firstElementChild.remove();
    }
  }

  // ============================================================
  // スタックモード切替
  // ============================================================

  function applyStackMode(on) {
    stackMode = !!on;
    if (btnStack) btnStack.classList.toggle("is-active", stackMode);
    if (bar) bar.classList.toggle("is-stack", stackMode);
    if (!stackMode && bar) {
      // スタック → 非スタック切替時: 最新のチップだけ残し、それ以外は
      // 即時フェードアウトする (= 「いまの 1 個」だけを継続表示)。
      const chips = Array.from(bar.querySelectorAll(".chip:not(.is-fading)"));
      chips.slice(0, -1).forEach(fadeAndRemove);
    }
    scheduleResize();
  }

  if (btnStack) {
    btnStack.addEventListener("click", (ev) => {
      if (!ev.isTrusted) return;
      applyStackMode(!stackMode);
    });
  }

  if (btnClose) {
    btnClose.addEventListener("click", async (ev) => {
      if (!ev.isTrusted) return;
      try {
        await invoke("set_live_display", { enabled: false });
      } catch (e) {
        console.error("set_live_display failed", e);
      }
    });
  }

  // ============================================================
  // 自動リサイズ — 高さだけ追従 (幅はユーザー操作を尊重)
  // ============================================================
  // ヘッダーと bar の offsetHeight を合算する。bar には min-height があり、
  // 空状態でも 1 行分の高さを持つので、初回のチップ追加では高さ変動しない。

  let resizeTimer = 0;
  function scheduleResize() {
    if (!getCurrentWindow || !LogicalSize) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(autoResize, RESIZE_DEBOUNCE);
  }

  async function autoResize() {
    if (!bar) return;
    try {
      const headerH = header ? header.offsetHeight : 0;
      const barH = bar.offsetHeight;
      const desired = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, headerH + barH + 2));

      const win = getCurrentWindow();
      const outer = await win.outerSize();
      const scale = await win.scaleFactor();
      const currLogicalW = outer.width / scale;
      const currLogicalH = outer.height / scale;
      if (Math.abs(currLogicalH - desired) >= 2) {
        await win.setSize(new LogicalSize(currLogicalW, desired));
      }
      // リサイズが MAX_HEIGHT で頭打ちになったケースに備え、レイアウト確定後
      // に再度トリム判定を入れる (新たなチップが画面外に行かないよう保証)。
      if (stackMode) {
        requestAnimationFrame(trimToFitWindow);
      }
    } catch (e) {
      console.warn("auto-resize skipped:", e);
    }
  }

  // ============================================================
  // 起動
  // ============================================================

  listen("live-key", (event) => {
    if (event && event.payload) addChip(event.payload);
  });

  // 初期同期 (CSS の既定 = 非スタック と JS state を合わせる)。
  applyStackMode(false);

  // ドラッグ補助: data-tauri-drag-region だけでは反応しない環境があるため、
  // 左クリック押下時に明示的に startDragging を呼ぶフォールバックを置く。
  // - data-tauri-drag-region="false" 配下 (操作ボタン等) は除外
  document.addEventListener("mousedown", async (ev) => {
    if (ev.button !== 0) return;
    if (!ev.target || !ev.target.closest) return;
    if (ev.target.closest("[data-tauri-drag-region=\"false\"]")) return;
    if (ev.target.closest("button")) return;
    if (!getCurrentWindow) return;
    try {
      await getCurrentWindow().startDragging();
    } catch (_e) {
      // 環境差で失敗することはあるが致命的でないので静かに無視。
    }
  });
})();
