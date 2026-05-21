// SPDX-License-Identifier: MIT
//
// Clack — メインウィンドウのフロントエンドコントローラ (オーケストレータ)。
//
// 役割分担:
//   - util.js       … 共有の整形・パース関数
//   - i18n.js       … 多言語辞書 + applyLanguage
//   - calendar.js   … ヒートマップ / 期間スイッチ / 単日詳細ポップオーバー
//   - analytics.js  … 分析タブの全描画 (hero / hours / strip / breakdowns)
//   - list.js       … リストビューの DOM 構築
//   - main.js (この) … state, init, タブ切替, 設定/今日ストリーム, IPC リスナー,
//                       ツールチップ, エラー報告, リフレッシュ統合
//
// 【セキュリティ方針】
//   - innerHTML / eval / Function コンストラクタを一切使用しない。
//   - DOM は document.createElement と textContent / dataset で組み立てる。
//   - CSP は `script-src 'self'` 厳格化 (インラインスクリプト不可)。
//   - Tauri ランタイム以外で開かれた場合 (= ブラウザ直接アクセス) は即時無害化。

(() => {
  // ============================================================
  // 1. Tauri ランタイムの初期化
  // ============================================================

  const T = window.__TAURI__;
  if (!T) {
    document.body.textContent = "Clack must be launched from the Tauri runtime.";
    return;
  }
  const invoke = T.core.invoke;
  const listen = T.event.listen;

  // 子モジュール (util / i18n / calendar / analytics / list) は HTML で先に
  // ロードされているので、window.Clack 上に既に揃っている前提。
  const C = (window.Clack = window.Clack || ({} as ClackNamespace));
  C.invoke = invoke;
  C.listen = listen;

  // util / i18n などからよく使うものを取り出して、この関数スコープ内では
  // 短い名前で参照できるようにしておく。
  const { $, pad2, fmtNum, fmtDate, parseDate, safeInt, clampMonths } = C.util;
  const { L, applyLanguage } = C.i18n;

  // ============================================================
  // 2. 定数
  // ============================================================

  /** ウィンドウ表示直後の誤クリック (フォーカス等で発生し得る) を弾く
   *  ガード時間 (ms)。これより前のナビゲーション操作は無視。 */
  const NAV_GUARD_MS = 400;

  /** 統計の安全ネット再取得間隔 (ms)。日付跨ぎなどに備える。 */
  const SAFETY_REFRESH_MS = 5 * 60 * 1000;

  /** リサイズ後の再レイアウト猶予 (ms)。連続リサイズで負荷を出さないため。 */
  const RESIZE_DEBOUNCE_MS = 120;

  // ============================================================
  // 3. アプリ状態 (グローバル)
  // ============================================================

  /**
   * フロント側で管理する状態。setter を介して変更し、
   * 状態に依存する処理が常に最新値を読む構造にする。
   * window.Clack.state にも参照を置き、他モジュールから読める。
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
  C.state = state;

  /** ナビゲーション操作を受け付けてよい時刻 (performance.now() 基準)。 */
  const navReadyAt = performance.now() + NAV_GUARD_MS;
  function navReady() {
    return state.ready && performance.now() >= navReadyAt;
  }
  C.navReady = navReady;

  // ============================================================
  // 4. テーマ & 言語の適用
  // ============================================================

  /** テーマを html[data-theme] に書き込み、localStorage にも保存する。
   *  保存することで、次回ウィンドウ起動時に theme-boot.js が同期的に
   *  読んで初期描画から正しいテーマを当てられる (= 暗 → 明のフラッシュ抑止)。 */
  function applyTheme(name) {
    const t = name === "light" || name === "dark" ? name : "auto";
    document.documentElement.dataset.theme = t;
    try {
      localStorage.setItem("clack.theme", t);
    } catch (_) {
      /* ignore */
    }
  }

  // ============================================================
  // 5. 設定の読み込み・保存 (Rust と双方向)
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
    C.calendar.applyPeriodSelection(clampMonths(Number(s.monthsShown)));
    applyLanguage(s.language || "ja");
  }

  /** Tauri の WebView は `setup` コールバックよりも早く HTML/JS の読み込みを
   *  始めることがあり、その間 Rust 側で `app.manage()` がまだ呼ばれていない
   *  ため `invoke(...)` が「state not managed」で即座に reject する。
   *  ここでは `get_settings` を成功するまで短いポーリングでリトライし、
   *  バックエンド準備完了を待つ。約 2.5 秒で諦めて先に進む (致命的でない)。 */
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

  // ============================================================
  // 6. 今日の統計 (上部の大きな数字 + 分析ヒーロー)
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

    // TODAY 行 (カレンダータブで可視) を同期。
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
  // 7. リフレッシュ (期間切替・初期化・定期同期 共通)
  // ============================================================

  /** ヒートマップ + リスト + 月集計を一括で再取得・再描画する。
   *  並行して複数回呼ばれた場合、最後の呼び出しだけが DOM を更新する
   *  (世代カウンタ refreshSeq で古いものは破棄)。 */
  async function refresh() {
    const seq = ++state.refreshSeq;
    // ヒートマップが再構築されるとセル DOM が入れ替わるので、開いていた
    // 単日詳細ポップオーバーは閉じておく (古いセル位置を指したままになる
    // のを防ぐ)。
    C.calendar.closeDayPopover();

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const period = C.calendar.computePeriod();

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

    const heatmapReady = C.calendar.buildHeatmap(data, period, today);
    C.list.build(data, today);

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
    if (tKeys) C.analytics.animateCountUp(tKeys, totalKeys);
    if (tMouse) C.analytics.animateCountUp(tMouse, totalMouse);

    // ---- 日次合計 sparkline (棒チャート) --------------------------------
    C.calendar.renderDailySpark(dailyTotals);
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
  C.refresh = refresh;

  // ============================================================
  // 8. UI ハンドラ
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
        C.analytics.refresh().catch((e) => console.error("analytics refresh", e));
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

  /** 設定ウィンドウを開く歯車アイコン。 */
  function setupSettingsButton() {
    $("open-settings").addEventListener("click", async (ev) => {
      if (!ev.isTrusted) return;
      try {
        await invoke("open_settings_window");
      } catch (e) {
        console.error(e);
      }
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

  /** カレンダーセル & 時間帯ヒストグラムセル の共通ツールチップ。
   *  mousemove は document に 1 つだけ張る (重複登録による競合を避ける)。 */
  function setupTooltip() {
    const tip = $("tooltip");
    let raf = 0;
    const hide = () => {
      tip.hidden = true;
    };
    /** ツールチップを cell の真上中央に置く。
     *  transform: translate(-50%) は使わない — `position: fixed` の要素が
     *  viewport の右端を越えると WebView2 が document の幅を広げて横
     *  スクロールを発生させてしまうため、実測した tooltip 幅で必ず
     *  viewport 内に clamp する。
     *  上端に余地が無いときは下側に反転表示する。
     *  ちらつき防止: 測定中は visibility: hidden で隠して位置決め後に表示。 */
    const setPos = (rect) => {
      // 1. 計測可能にする (hidden=true は display:none 相当)
      tip.hidden = false;
      tip.style.visibility = "hidden";
      tip.style.transform = "none";
      // 一旦原点へ寄せて純粋な intrinsic 幅を取る
      tip.style.left = "0px";
      tip.style.top = "0px";

      const tipW = tip.offsetWidth;
      const tipH = tip.offsetHeight;
      const margin = 4;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      // 中央寄せ目標 → viewport 内に clamp
      let left = rect.left + rect.width / 2 - tipW / 2;
      if (left < margin) left = margin;
      if (left + tipW > vw - margin) left = vw - tipW - margin;

      // 上側を優先。出ない時は下側にフリップ。
      let top = rect.top - tipH - 6;
      if (top < margin) top = Math.min(rect.bottom + 6, vh - tipH - margin);

      tip.style.left = `${Math.round(left)}px`;
      tip.style.top = `${Math.round(top)}px`;
      tip.style.visibility = "";
    };
    document.addEventListener(
      "mousemove",
      (e) => {
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          const tgt = e.target;
          const closest = tgt?.closest ? tgt.closest.bind(tgt) : null;
          if (!closest) {
            hide();
            return;
          }

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
      },
      { passive: true },
    );
    document.addEventListener("mouseleave", hide, { passive: true });
  }

  /** PAUSED バッジの表示/非表示。 */
  function applyPaused(paused) {
    state.paused = Boolean(paused);
    const badge = $("pause-badge");
    if (badge) badge.hidden = !state.paused;
  }

  /** Tauri 側からのイベントを購読。 */
  async function setupBackendListeners() {
    // 1Hz のリアルタイム更新 (ウィンドウ表示中のみ Rust から飛んでくる)
    await listen("stats-updated", (event) => {
      if (event?.payload) setTodayCounts(event.payload);
    });
    // 設定ウィンドウから「保存」されたとき
    await listen("settings-changed", async () => {
      await loadAndApplySettings();
      refresh();
      // 言語切替で曜日ラベルが変わるので、分析タブを開いていれば再描画
      if (state.analyticsLoaded) C.analytics.refresh().catch(() => {});
    });
    // 設定ウィンドウから全データ削除されたとき (またはインポート完了時)
    await listen("data-cleared", async () => {
      await refreshToday();
      await refresh();
      if (state.analyticsLoaded || state.currentTab === "analytics") {
        C.analytics.refresh().catch(() => {});
      }
    });
    // トレイ・設定からの一時停止トグル
    await listen("paused-changed", (event) => {
      applyPaused(Boolean(event?.payload));
    });
    // トレイ・live ウィンドウからのリアルタイム表示トグル → ヘッダーアイコンと同期
    await listen("live-display-changed", (event) => {
      const on = Boolean(event?.payload);
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
      show(`Promise: ${r?.toString ? r.toString() : String(r)}`);
    });
  }

  // ============================================================
  // 9. 初期化エントリポイント
  // ============================================================

  async function init() {
    installErrorReporter();
    setupTabs();
    C.calendar.setupCalNav();
    C.calendar.setupPeriodSlider();
    setupSettingsButton();
    setupLiveToggle();
    setupTooltip();
    C.calendar.setupDayPopover();
    C.analytics.setupScope();

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
      requestAnimationFrame(() => {
        refresh().catch(() => {});
      });
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
