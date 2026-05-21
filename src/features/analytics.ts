// SPDX-License-Identifier: MIT
//
// Clack — 分析ビュー (hero KPI + 時間帯ヒストグラム + ストリップ + 内訳バー)。
//
// 担当する DOM:
//   - #cr-date-str / #cr-clock-str           (サブヘッダの日付・時刻)
//   - #hero-keys-num / hero-keys-avg7 / hero-keys-delta / hero-keys-spark
//   - #hero-mouse-...                         (キー / マウス の hero KPI 2 連)
//   - #kpi-average-num                        (1日平均)
//   - #trip-mouse-... / #trip-scroll-...      (距離 / 高さ のストリップセル)
//   - #hours-cells                            (24 時間ヒストグラム)
//   - #keys-breakdown / #mouse-breakdown      (下段の内訳パネル)
//   - [data-scope]                             (今日 / 7日 / 今月 / 全期間)
//
// 依存:
//   - Clack.util.$ / fmtNum / fmtDate / safeInt / prettyKey
//   - Clack.i18n.L
//   - Clack.state                             (lang, analyticsScope, analyticsLoaded)
//   - Clack.invoke                            (get_analytics, get_today_stats, get_stats_range)
//
// 公開: window.Clack.analytics = {
//   refresh, setupScope, animateCountUp, fetchHeroSeries
// }

(function () {
  const C = (window.Clack = window.Clack || ({} as ClackNamespace));
  const { $, fmtNum, fmtDate, safeInt, prettyKey } = C.util;
  const { L } = C.i18n;

  // ============================================================
  // 定数
  // ============================================================

  /** 分析タブのキー内訳に出す最大件数。Rust 側で 30 まで返してくる。 */
  const KEY_TOP_N = 15;

  // 旅 (マウス距離・スクロール高さ) の換算
  // 96 DPI で 1 inch = 96 px、1 inch = 0.0254 m → 1 m ≈ 3780 px。
  const PX_PER_METER = 3780;
  // ホイール 1 ティック ≒ 3 行 ≒ 51 px ≒ 1.35 cm
  const M_PER_SCROLL_TICK = 0.0135;

  /** マウス向け (横に旅する)。値は m 単位、昇順で固定。 */
  const MOUSE_LANDMARKS = [
    { m: 1, name: "1 メートル" },
    { m: 10, name: "電車 1 両分" },
    { m: 100, name: "100m 走" },
    { m: 333, name: "東京タワー" },
    { m: 634, name: "東京スカイツリー" },
    { m: 1000, name: "1 キロ" },
    { m: 3776, name: "富士山" },
    { m: 8849, name: "エベレスト" },
    { m: 21097, name: "ハーフマラソン" },
    { m: 42195, name: "フルマラソン" },
    { m: 100000, name: "東京〜熱海" },
    { m: 138000, name: "富士山外周一周" },
    { m: 515000, name: "東京〜大阪" },
    { m: 1413000, name: "札幌〜福岡" },
    { m: 2250000, name: "札幌〜那覇" },
    { m: 6371000, name: "地球の半径" },
    { m: 40075000, name: "地球一周" },
  ];

  /** スクロール向け (上に旅する)。値は m 単位、昇順で固定。 */
  const SCROLL_LANDMARKS = [
    { m: 1, name: "1 メートル" },
    { m: 12, name: "電柱" },
    { m: 25, name: "ビル 8 階分" },
    { m: 56, name: "ピサの斜塔" },
    { m: 93, name: "自由の女神" },
    { m: 333, name: "東京タワー" },
    { m: 634, name: "東京スカイツリー" },
    { m: 828, name: "ブルジュ・ハリファ" },
    { m: 3776, name: "富士山" },
    { m: 8849, name: "エベレスト" },
    { m: 12000, name: "ジェット旅客機の巡航高度" },
    { m: 50000, name: "成層圏の上限" },
    { m: 100000, name: "宇宙の境界 (カーマンライン)" },
    { m: 400000, name: "国際宇宙ステーション" },
    { m: 35786000, name: "静止軌道" },
    { m: 384400000, name: "月" },
  ];

  /** 取得対象の日数。スパークラインと 7 日平均の計算に使う。 */
  const HERO_RANGE_DAYS = 14;

  // ============================================================
  // 旅マイルストーン
  // ============================================================

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

  // ============================================================
  // 数値カウントアップ
  // ============================================================

  /** 数値要素を 0 → target にカウントアップ。
   *  分析タブを開いた瞬間に「数字が伸びる」演出を全グラフと揃えるために使う。
   *  reduced-motion の場合は瞬時に最終値を表示する。 */
  function animateCountUp(el, target, durationMs = 900) {
    if (!el) return;
    const end = Math.max(0, Number.isFinite(target) ? Math.round(target) : 0);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
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
      const e = 1 - (1 - t) ** 3;
      el.textContent = fmtNum(Math.round(end * e));
      if (t < 1) {
        el._animRaf = requestAnimationFrame(step);
      } else {
        el._animRaf = null;
      }
    };
    el._animRaf = requestAnimationFrame(step);
  }

  // ============================================================
  // Hero KPI (キー / マウス + スパークライン)
  // ============================================================

  /** 直近 14 日の日次集計を取得 (キー/マウスのスパークライン用)。
   *  失敗時は 0 埋めの配列を返してフロントの描画を壊さない。 */
  async function fetchHeroSeries() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(today.getDate() - (HERO_RANGE_DAYS - 1));
    try {
      const rows = await C.invoke("get_stats_range", {
        start: fmtDate(start),
        end: fmtDate(today),
      });
      if (!Array.isArray(rows) || rows.length === 0) {
        return {
          keys: new Array(HERO_RANGE_DAYS).fill(0),
          mouse: new Array(HERO_RANGE_DAYS).fill(0),
        };
      }
      // Rust 側は範囲内全日 (歯抜けなし) を返してくる前提だが、保険として
      // 日付キーをマップにして 14 日に必ずパディングする。
      const byDate = new Map();
      for (const r of rows) {
        if (r?.date) byDate.set(r.date, { keys: safeInt(r.keys), mouse: safeInt(r.mouse) });
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
      return {
        keys: new Array(HERO_RANGE_DAYS).fill(0),
        mouse: new Array(HERO_RANGE_DAYS).fill(0),
      };
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
   *  線描画アニメは `.is-drawn` クラスの opacity フェードで再生する。 */
  function renderSparkline(svg, data) {
    if (!svg || !Array.isArray(data) || data.length === 0) return;
    const W = 100;
    const H = 24;
    const max = Math.max(1, ...data.map((v) => safeInt(v)));
    const n = data.length;
    // 単一データ点だと stepX が 0 になり Infinity が出る。中央に置く。
    const stepX = n > 1 ? W / (n - 1) : 0;
    const pts = data.map((v, i) => {
      const x = n > 1 ? i * stepX : W / 2;
      const y = H - (safeInt(v) / max) * (H - 2) - 1;
      return [x, y];
    });
    const dLine = pts
      .map((p, i) => (i === 0 ? `M ${p[0]} ${p[1]}` : `L ${p[0]} ${p[1]}`))
      .join(" ");
    const dArea = `${dLine} L ${W} ${H} L 0 ${H} Z`;
    const last = pts[pts.length - 1];

    const line = svg.querySelector(".line");
    const area = svg.querySelector(".area");
    const dot = svg.querySelector(".dot");
    if (line) line.setAttribute("d", dLine);
    if (area) area.setAttribute("d", dArea);
    if (dot) {
      dot.setAttribute("cx", last[0].toFixed(2));
      dot.setAttribute("cy", last[1].toFixed(2));
    }

    // 2-rAF で .is-drawn を付け直し、opacity フェードを再生する。
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
    const numEl = $(`hero-${prefix}-num`);
    const avg7El = $(`hero-${prefix}-avg7`);
    const deltaEl = $(`hero-${prefix}-delta`);
    const sparkEl = $(`hero-${prefix}-spark`);
    if (numEl) animateCountUp(numEl, todayVal);
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

  // ============================================================
  // ストリップ (1日平均 / 距離 / 高さ)
  // ============================================================

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
    const numEl = $(`trip-${prefix}-num`);
    const unitEl = $(`trip-${prefix}-unit`);
    const goalEl = $(`trip-${prefix}-goal`);
    const fillEl = $(`trip-${prefix}-fill`);
    const pctEl = $(`trip-${prefix}-pct`);
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

  // ============================================================
  // 時間帯ヒストグラム + 内訳バー
  // ============================================================

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
      avgBar.dataset.hasAvg = aRaw > 0 ? "true" : "false";

      const tBar = document.createElement("div");
      tBar.className = "cr-hour-bar-today";

      cell.append(avgBar, tBar);
      frag.appendChild(cell);

      // 値が 0 でも見えないだけ。値があるときは 3% 下限で必ず可視。
      const pctAvg = aRaw > 0 ? Math.max(3, (aRaw / max) * 100) : 0;
      const pctT = tRaw > 0 ? Math.max(3, (tRaw / max) * 100) : 0;
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
      const pct = count > 0 ? Math.max(10, Math.round((count / max) * 100)) : 0;
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
      const pct = count > 0 ? Math.max(10, Math.round((count / max) * 100)) : 0;
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

  // ============================================================
  // 統合: refreshAnalytics + setupScope
  // ============================================================

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
  async function refresh() {
    updateAnalyticsSubhead();
    let scopeData, weekData, todayPayload, heroSeries;
    try {
      [scopeData, weekData, todayPayload, heroSeries] = await Promise.all([
        C.invoke("get_analytics", { scope: C.state.analyticsScope }),
        C.invoke("get_analytics", { scope: "week" }),
        C.invoke("get_today_stats"),
        fetchHeroSeries(),
      ]);
    } catch (e) {
      console.error("refreshAnalytics fetch failed", e);
      return;
    }
    C.state.analyticsLoaded = true;

    // ---- Hero: 今日値 + 7日平均 + 14日スパークライン -----------------
    const todayKeys = safeInt(todayPayload?.keys);
    const todayMouse = safeInt(todayPayload?.mouse);
    const avg7Keys = avg7ExcludingToday(heroSeries.keys);
    const avg7Mouse = avg7ExcludingToday(heroSeries.mouse);
    renderHeroKPI({
      prefix: "keys",
      todayVal: todayKeys,
      avg7Val: avg7Keys,
      series: heroSeries.keys,
    });
    renderHeroKPI({
      prefix: "mouse",
      todayVal: todayMouse,
      avg7Val: avg7Mouse,
      series: heroSeries.mouse,
    });

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
    const avg7Hourly = (
      Array.isArray(weekData.hourly) ? weekData.hourly : new Array(24).fill(0)
    ).map((v) => Math.max(0, Number(v) || 0) / 7);
    renderHours(scopeData.hourly || [], avg7Hourly);

    // ---- Bottom split: top keys + マウス内訳 ------------------------
    renderKeysGrid((scopeData.keys || []).slice(0, KEY_TOP_N));
    renderMouseList(scopeData.mouse || []);
  }

  /** スコープ選択 (今日 / 7日 / 今月 / 全期間) のセグメントコントロール。
   *  クリックで state.analyticsScope を変えて分析を再フェッチ。 */
  function setupScope() {
    for (const btn of document.querySelectorAll("[data-scope]")) {
      btn.addEventListener("click", (ev) => {
        if (!ev.isTrusted) return;
        const next = btn.dataset.scope;
        if (next === C.state.analyticsScope) return;
        C.state.analyticsScope = next;
        for (const b of document.querySelectorAll("[data-scope]")) {
          const on = b.dataset.scope === next;
          b.classList.toggle("is-active", on);
          b.setAttribute("aria-checked", on ? "true" : "false");
        }
        refresh().catch((e) => console.error("analytics refresh", e));
      });
    }
  }

  // ============================================================
  // 公開
  // ============================================================

  C.analytics = {
    refresh,
    setupScope,
    animateCountUp,
    fetchHeroSeries,
  };
})();
