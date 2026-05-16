// SPDX-License-Identifier: MIT
//
// Clack — 設定ウィンドウのフロントエンドコントローラ。
//
// 【方針】 main.js と同じく XSS 対策 (innerHTML 不使用) と CSP に従う。
// 設定値はクライアント側で即時バリデートし、最終的に Rust の
// `update_settings` コマンドでも再バリデーションされる。

(() => {
  "use strict";

  // ============================================================
  // Tauri ランタイム
  // ============================================================
  const T = window.__TAURI__;
  if (!T) {
    document.body.textContent =
      "Clack must be launched from the Tauri runtime.";
    return;
  }
  const invoke = T.core.invoke;
  const listen = T.event.listen;
  const emit = T.event.emit;

  const $ = (id) => document.getElementById(id);

  // ============================================================
  // 定数 (Rust 側の settings.rs と同じ値にすること)
  // ============================================================
  const IDLE_MIN = 5;
  const IDLE_MAX = 3600;
  const IDLE_STEP = 5;

  // ============================================================
  // i18n
  // ============================================================
  const I18N = {
    ja: {
      settingsTitle: "設定",
      lbl_autostart: "自動起動",
      sub_autostart: "OS 起動時に自動で開始する",
      lbl_idle: "アイドル判定の閾値",
      sub_idle: "入力なしでカウントを停止",
      unit_sec: "秒",
      lbl_theme: "テーマ",
      sub_theme: "外観を切り替え",
      lbl_language: "言語",
      sub_language: "表示言語を切り替え",
      lbl_pause: "一時停止",
      sub_pause: "入力カウントを止める (再起動時に解除)",
      lbl_live: "リアルタイム表示",
      sub_live: "入力キーを小さなオーバーレイに即時表示",
      toast_live_on: "リアルタイム表示 ON",
      toast_live_off: "リアルタイム表示 OFF",
      lbl_storage: "保存データ",
      btn_clear: "削除",
      btn_clear_confirm: "本当に削除",
      storage_info: (days, size) =>
        days === 0 ? `データなし ・ ${size}` : `${days} 日分 ・ ${size}`,
      lbl_backup: "バックアップ",
      sub_backup: "JSON は完全形式 ・ CSV は表計算用",
      btn_export_json: "JSON",
      btn_export_csv: "CSV",
      btn_import: "インポート",
      btn_cancel: "キャンセル",
      btn_save: "保存",
      toast_saved: "保存しました",
      toast_save_failed: (e) => `保存に失敗: ${e}`,
      toast_auto_failed: (e) => `自動起動の更新に失敗: ${e}`,
      toast_cleared: "削除しました",
      toast_clear_failed: (e) => `削除に失敗: ${e}`,
      toast_exported: (n) => `エクスポートしました (${n} 日分)`,
      toast_export_failed: (e) => `エクスポートに失敗: ${e}`,
      toast_export_cancelled: "キャンセルしました",
      toast_imported: (n) => `インポートしました (${n} 日分)`,
      toast_import_failed: (e) => `インポートに失敗: ${e}`,
      toast_paused: "一時停止しました",
      toast_resumed: "再開しました",
      confirm_import: "現在のデータが上書きされます。続行しますか?",
    },
    en: {
      settingsTitle: "Settings",
      lbl_autostart: "Autostart",
      sub_autostart: "Launch at OS startup",
      lbl_idle: "Idle threshold",
      sub_idle: "Pause counting after no input",
      unit_sec: "sec",
      lbl_theme: "Theme",
      sub_theme: "Switch appearance",
      lbl_language: "Language",
      sub_language: "Switch display language",
      lbl_pause: "Pause",
      sub_pause: "Stop counting input (resets at restart)",
      lbl_live: "Live display",
      sub_live: "Show pressed keys in a small overlay",
      toast_live_on: "Live display ON",
      toast_live_off: "Live display OFF",
      lbl_storage: "Stored data",
      btn_clear: "Delete",
      btn_clear_confirm: "Confirm delete",
      storage_info: (days, size) =>
        days === 0 ? `No data · ${size}` : `${days} day${days === 1 ? "" : "s"} · ${size}`,
      lbl_backup: "Backup",
      sub_backup: "JSON for full backup · CSV for spreadsheets",
      btn_export_json: "JSON",
      btn_export_csv: "CSV",
      btn_import: "Import",
      btn_cancel: "Cancel",
      btn_save: "Save",
      toast_saved: "Saved",
      toast_save_failed: (e) => `Save failed: ${e}`,
      toast_auto_failed: (e) => `Autostart update failed: ${e}`,
      toast_cleared: "Deleted",
      toast_clear_failed: (e) => `Delete failed: ${e}`,
      toast_exported: (n) => `Exported (${n} day${n === 1 ? "" : "s"})`,
      toast_export_failed: (e) => `Export failed: ${e}`,
      toast_export_cancelled: "Cancelled",
      toast_imported: (n) => `Imported (${n} day${n === 1 ? "" : "s"})`,
      toast_import_failed: (e) => `Import failed: ${e}`,
      toast_paused: "Paused",
      toast_resumed: "Resumed",
      confirm_import: "This will overwrite current data. Continue?",
    },
  };

  // ============================================================
  // ローカル状態
  // ============================================================
  /** 現在画面に表示中の言語。L() から参照される。 */
  let lang = "ja";

  /** 保存前の確定値スナップショット。キャンセル時の復元用。 */
  let initialSettings = {
    idleThresholdSeconds: 60,
    theme: "auto",
    language: "ja",
    monthsShown: 6,
  };

  /** 自動起動の確定値。トグルの差分検出に使う。 */
  let initialAutostart = true;

  /** 直近に取得した保存データの規模。言語切替時に再フォーマットする
   *  ため、IPC のレスポンスを覚えておく。 */
  let lastStorageInfo = { bytes: 0, days: 0 };

  /** 一時停止トグルが Rust 側と同期している前提値。
   *  paused-changed イベントとトグルの両方から書き換わる。 */
  let currentPaused = false;


  const L = () => I18N[lang] || I18N.ja;

  // ============================================================
  // ヘルパ
  // ============================================================

  /** アイドル閾値を許容範囲 [MIN, MAX] に丸めて整数化する。 */
  function clampIdle(v) {
    if (!Number.isFinite(v)) return IDLE_MIN;
    return Math.min(IDLE_MAX, Math.max(IDLE_MIN, Math.round(v)));
  }

  /** バイト数を人が読みやすい単位に整形。1024 基準 (B / KB / MB)。
   *  ロケール依存しない表記なので言語切替に追従不要。 */
  function formatBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return "0 B";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  // ============================================================
  // UI 適用関数
  // ============================================================

  /** テーマプレビュー (保存前の見た目変更)。
   *  選択中の値を localStorage にも保存し、次回ウィンドウ起動時の
   *  初期描画フラッシュを防ぐ。キャンセル時は元の値で applyTheme が
   *  呼ばれ直すので、localStorage も正しい値に戻る。 */
  function applyTheme(name) {
    const t = name === "light" || name === "dark" ? name : "auto";
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem("clack.theme", t); } catch (_) { /* ignore */ }
    for (const btn of document.querySelectorAll("[data-theme-opt]")) {
      const on = btn.dataset.themeOpt === t;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-checked", on ? "true" : "false");
    }
  }

  /** 言語プレビュー (保存前の見た目変更)。 */
  function applyLanguage(name) {
    lang = name === "en" ? "en" : "ja";
    document.documentElement.lang = lang;
    const labels = L();
    for (const el of document.querySelectorAll("[data-i18n]")) {
      const key = el.dataset.i18n;
      const val = labels[key];
      if (typeof val === "string") el.textContent = val;
    }
    for (const btn of document.querySelectorAll("[data-lang-opt]")) {
      const on = btn.dataset.langOpt === lang;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-checked", on ? "true" : "false");
    }
    // data-i18n に乗らない動的な行 (保存データ) も更新する。
    renderStorageInfo();
  }

  /** 現在のフォーム状態から保存ペイロードを組み立てる。 */
  function collectFormState() {
    const idle = clampIdle(parseInt($("opt-idle").value, 10));
    let theme = "auto";
    for (const btn of document.querySelectorAll("[data-theme-opt]")) {
      if (btn.classList.contains("is-active")) {
        theme = btn.dataset.themeOpt || "auto";
        break;
      }
    }
    let language = "ja";
    for (const btn of document.querySelectorAll("[data-lang-opt]")) {
      if (btn.classList.contains("is-active")) {
        language = btn.dataset.langOpt || "ja";
        break;
      }
    }
    return {
      idleThresholdSeconds: idle,
      theme,
      language,
      // monthsShown は本ウィンドウでは編集しないので、サーバ側の値を尊重する
      // (save() で取得し直してマージする)。
    };
  }

  /** 取得済みの値を現在の言語でフォーマットして表示。IPC は呼ばない。 */
  function renderStorageInfo() {
    const days = Number(lastStorageInfo.days) || 0;
    const bytes = Number(lastStorageInfo.bytes) || 0;
    $("storage-info").textContent = L().storage_info(days, formatBytes(bytes));
  }

  /** 保存データの規模を Rust から取得して表示。削除後にも呼ぶ。 */
  async function refreshStorageInfo() {
    try {
      const info = await invoke("get_data_size");
      lastStorageInfo = info || { bytes: 0, days: 0 };
    } catch (e) {
      console.error("get_data_size failed", e);
      lastStorageInfo = { bytes: 0, days: 0 };
    }
    renderStorageInfo();
  }

  /** 起動時に Rust から設定を取得してフォームに反映。 */
  async function loadSettings() {
    try {
      const s = await invoke("get_settings");
      initialSettings = { ...initialSettings, ...s };
      $("opt-idle").value = String(clampIdle(s.idleThresholdSeconds));
      applyLanguage(s.language || "ja");
      applyTheme(s.theme || "auto");
    } catch (e) {
      console.error("get_settings failed", e);
    }
    try {
      const enabled = await invoke("get_autostart_enabled");
      initialAutostart = Boolean(enabled);
      $("opt-autostart").checked = Boolean(enabled);
    } catch (e) {
      console.error("get_autostart_enabled failed", e);
    }
    try {
      currentPaused = Boolean(await invoke("get_paused"));
      $("opt-pause").checked = currentPaused;
    } catch (e) {
      console.error("get_paused failed", e);
    }
  }

  /** トースト表示 (1.6 秒で自動で消える)。 */
  function showToast(text) {
    const el = $("set-toast");
    el.textContent = text;
    el.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => {
      el.hidden = true;
    }, 1600);
  }

  // ============================================================
  // 保存・キャンセル
  // ============================================================

  async function save() {
    // 1) 現在のフォーム値 + サーバ側の monthsShown をマージ
    const formed = collectFormState();
    const next = { ...initialSettings, ...formed };

    // 2) 設定を Rust 側に保存 (バリデーションは Rust が最終確認)
    try {
      await invoke("update_settings", { newSettings: next });
    } catch (e) {
      showToast(L().toast_save_failed(e));
      return;
    }

    // 3) 自動起動 (変更されたときだけ更新)
    const autoNew = Boolean($("opt-autostart").checked);
    if (autoNew !== initialAutostart) {
      try {
        await invoke("set_autostart_enabled", { enabled: autoNew });
        initialAutostart = autoNew;
      } catch (e) {
        showToast(L().toast_auto_failed(e));
        return;
      }
    }

    // 4) スナップショット更新 → 他ウィンドウへ通知 → トースト → 自動で閉じる
    initialSettings = next;
    try { await emit("settings-changed"); } catch { /* 通知失敗は致命的でない */ }
    showToast(L().toast_saved);
    setTimeout(async () => {
      try { await invoke("close_settings_window"); } catch { /* */ }
    }, 400);
  }

  async function cancel() {
    // テーマ・言語のプレビューを保存前の値に戻す
    applyTheme(initialSettings.theme || "auto");
    applyLanguage(initialSettings.language || "ja");
    try { await invoke("close_settings_window"); } catch { /* */ }
  }

  // ============================================================
  // フォームコントロールのバインド
  // ============================================================

  function setupIdleInput() {
    const inp = $("opt-idle");
    const sync = () => {
      inp.value = String(clampIdle(parseInt(inp.value, 10)));
    };
    inp.addEventListener("change", sync);
    inp.addEventListener("blur", sync);
    $("opt-idle-dec").addEventListener("click", (ev) => {
      if (!ev.isTrusted) return;
      inp.value = String(clampIdle(parseInt(inp.value, 10) - IDLE_STEP));
    });
    $("opt-idle-inc").addEventListener("click", (ev) => {
      if (!ev.isTrusted) return;
      inp.value = String(clampIdle(parseInt(inp.value, 10) + IDLE_STEP));
    });
  }

  /** 「削除」ボタンの 2 段階確認 UI を組み立てる。
   *  1 回目クリック: 「キャンセル / 本当に削除」の 2 つに展開。
   *  6 秒で自動的に元に戻す (ユーザーが他の作業に移ったケースを想定)。
   *  innerHTML は使わず createElement / textContent で構築。 */
  function setupClearDataButton() {
    const wrap = $("storage-actions");
    let revertTimer = 0;

    const renderInitial = () => {
      if (revertTimer) { clearTimeout(revertTimer); revertTimer = 0; }
      wrap.replaceChildren();
      const btn = document.createElement("button");
      btn.id = "opt-clear-data";
      btn.type = "button";
      btn.className = "btn danger";
      btn.textContent = L().btn_clear;
      btn.addEventListener("click", (ev) => {
        if (!ev.isTrusted) return;
        renderConfirm();
      });
      wrap.appendChild(btn);
    };

    const renderConfirm = () => {
      wrap.replaceChildren();
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "btn ghost";
      cancel.textContent = L().btn_cancel;
      cancel.addEventListener("click", (ev) => {
        if (!ev.isTrusted) return;
        renderInitial();
      });
      const confirm = document.createElement("button");
      confirm.type = "button";
      confirm.className = "btn danger";
      confirm.textContent = L().btn_clear_confirm;
      confirm.addEventListener("click", async (ev) => {
        if (!ev.isTrusted) return;
        confirm.disabled = true;
        cancel.disabled = true;
        try {
          await invoke("clear_data");
          showToast(L().toast_cleared);
          await refreshStorageInfo();
        } catch (e) {
          showToast(L().toast_clear_failed(e));
        } finally {
          renderInitial();
        }
      });
      wrap.append(cancel, confirm);
      revertTimer = setTimeout(renderInitial, 6000);
    };

    renderInitial();
  }

  /** 一時停止トグル。チェック変更で即時に Rust 側に反映 (保存ボタンを
   *  待たない: pause は「いま停めたい」要望なので即時のほうが直感的)。 */
  function setupPauseToggle() {
    const cb = $("opt-pause");
    cb.addEventListener("change", async (ev) => {
      if (!ev.isTrusted) return;
      const next = Boolean(cb.checked);
      try {
        await invoke("set_paused", { paused: next });
        currentPaused = next;
        showToast(next ? L().toast_paused : L().toast_resumed);
      } catch (e) {
        // 失敗時はトグルを戻す
        cb.checked = currentPaused;
        console.error("set_paused failed", e);
      }
    });
  }

  /** エクスポートボタン: 形式 (json / csv) を指定して呼ぶ。
   *  Rust 側はその形式に固定したダイアログを開き、選ばれたパスへ書き込む。 */
  function setupExportButtons() {
    const handler = (format) => async (ev) => {
      if (!ev.isTrusted) return;
      const btn = ev.currentTarget;
      btn.disabled = true;
      try {
        const path = await invoke("export_data", { format });
        if (!path) {
          showToast(L().toast_export_cancelled);
        } else {
          const info = await invoke("get_data_size").catch(() => ({ days: 0 }));
          showToast(L().toast_exported(Number(info.days) || 0));
        }
      } catch (e) {
        showToast(L().toast_export_failed(e));
      } finally {
        btn.disabled = false;
      }
    };
    $("opt-export-json").addEventListener("click", handler("json"));
    $("opt-export-csv").addEventListener("click", handler("csv"));
  }

  /** インポートボタン: 確認 → ファイル選択 → 置換。 */
  function setupImportButton() {
    $("opt-import").addEventListener("click", async (ev) => {
      if (!ev.isTrusted) return;
      // window.confirm は Tauri 2 では非対応な場合がある。
      // 代替として、削除ボタンと同じ 2 段階確認パターンに合わせて
      // シンプルなインラインダイアログを使ってもよいが、
      // ここではメッセージを toast に出して、もう一度押されたら実行する。
      const btn = ev.currentTarget;
      if (!btn.dataset.armed) {
        btn.dataset.armed = "1";
        const prevText = btn.textContent;
        btn.textContent = L().btn_clear_confirm;
        btn.classList.add("danger");
        btn.classList.remove("ghost");
        showToast(L().confirm_import);
        setTimeout(() => {
          if (btn.dataset.armed) {
            delete btn.dataset.armed;
            btn.textContent = prevText;
            btn.classList.remove("danger");
            btn.classList.add("ghost");
          }
        }, 6000);
        return;
      }
      delete btn.dataset.armed;
      btn.classList.remove("danger");
      btn.classList.add("ghost");
      btn.textContent = L().btn_import;

      btn.disabled = true;
      try {
        const result = await invoke("import_data");
        if (result) {
          showToast(L().toast_imported(Number(result.days) || 0));
          await refreshStorageInfo();
        }
      } catch (e) {
        showToast(L().toast_import_failed(e));
      } finally {
        btn.disabled = false;
      }
    });
  }

  function setupThemeSegment() {
    for (const btn of document.querySelectorAll("[data-theme-opt]")) {
      btn.addEventListener("click", (ev) => {
        if (!ev.isTrusted) return;
        applyTheme(btn.dataset.themeOpt);
      });
    }
  }

  function setupLanguageSegment() {
    for (const btn of document.querySelectorAll("[data-lang-opt]")) {
      btn.addEventListener("click", (ev) => {
        if (!ev.isTrusted) return;
        applyLanguage(btn.dataset.langOpt);
      });
    }
  }

  function setupClose() {
    $("set-close").addEventListener("click", (ev) => {
      if (!ev.isTrusted) return;
      cancel();
    });
    $("set-cancel").addEventListener("click", (ev) => {
      if (!ev.isTrusted) return;
      cancel();
    });
    $("set-save").addEventListener("click", (ev) => {
      if (!ev.isTrusted) return;
      save();
    });
    // キーボードショートカット: ESC でキャンセル、Ctrl/Cmd+Enter で保存。
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") cancel();
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
    });
  }

  async function setupBackendListeners() {
    // トレイから自動起動を切り替えた場合に同期させる。
    await listen("autostart-changed", (event) => {
      const v = Boolean(event && event.payload);
      initialAutostart = v;
      $("opt-autostart").checked = v;
    });
    // トレイから一時停止を切り替えた場合に同期させる。
    await listen("paused-changed", (event) => {
      const v = Boolean(event && event.payload);
      currentPaused = v;
      $("opt-pause").checked = v;
    });
  }

  // ============================================================
  // 初期化
  // ============================================================

  async function init() {
    setupIdleInput();
    setupThemeSegment();
    setupLanguageSegment();
    setupPauseToggle();
    setupExportButtons();
    setupImportButton();
    setupClearDataButton();
    setupClose();
    await loadSettings();
    await refreshStorageInfo();
    await setupBackendListeners();
  }

  window.addEventListener("DOMContentLoaded", () => {
    init().catch((e) => console.error("init failed", e));
  });
})();
