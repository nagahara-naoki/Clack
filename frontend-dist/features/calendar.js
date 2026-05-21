"use strict";
// SPDX-License-Identifier: MIT
//
// Clack — カレンダー (ヒートマップ) ビューと期間操作 + 単日詳細ポップオーバー。
//
// 担当する DOM:
//   - #cal-weeks / #cal-months / #cal-dow  (ヒートマップ本体)
//   - #cal-daily-spark                      (日次合計 sparkline)
//   - .cr-range button[data-pos]            (1/3/6/12 ヶ月の期間スイッチ)
//   - #cal-prev / #cal-next                 (前後ナビ)
//   - #day-popover ...                       (セルクリック時の単日詳細)
//
// 公開 API: window.Clack.calendar = {
//   buildHeatmap, renderDailySpark, applyPeriodSelection,
//   selectPeriodByPos, persistMonthsShown,
//   setupPeriodSlider, setupCalNav, setupDayPopover, closeDayPopover,
//   computePeriod,
// }
(function () {
    const C = (window.Clack = window.Clack || {});
    const { $, pad2, fmtNum, fmtDate, parseDate, safeInt, clampMonths, clampPos, prettyKey, POS_TO_MONTHS, } = C.util;
    const { L } = C.i18n;
    // ============================================================
    // 定数 (この章でのみ参照)
    // ============================================================
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
    // ============================================================
    // 期間計算
    // ============================================================
    /**
     * 表示する期間 [start, end] を算出。
     * end は常に「アンカー週の土曜日」、start は end から N 週前の日曜日。
     * オフセットを 1 動かすと N 週まるごとシフトする (期間が重ならない)。
     */
    function computePeriod() {
        const state = C.state;
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
            calGrid?.parentElement,
            $("view-cal"),
            document.querySelector(".card"),
            document.body,
        ];
        for (const el of candidates) {
            if (!el)
                continue;
            const rect = el.getBoundingClientRect();
            const width = Math.floor(rect.width || el.clientWidth || 0);
            if (width >= 120)
                return width;
        }
        return Math.max(320, window.innerWidth - 48);
    }
    /** 1 日の合計値からカラーレベル (0..4) を決定。 */
    function chooseLevel(total) {
        if (total <= LEVEL_THRESHOLDS[0])
            return 0;
        if (total < LEVEL_THRESHOLDS[1])
            return 1;
        if (total < LEVEL_THRESHOLDS[2])
            return 2;
        if (total < LEVEL_THRESHOLDS[3])
            return 3;
        return 4;
    }
    // ============================================================
    // ヒートマップ DOM 構築
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
        const totalDays = Math.round((gridEnd.getTime() - gridStart.getTime()) / 86400000) + 1;
        const totalWeeks = Math.round(totalDays / 7);
        // セルサイズを実際のレイアウト幅から算出して CSS 変数に反映。
        const calGrid = (grid.closest(".cal-grid") || grid.parentNode);
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
                if (dt.getDate() === 1 &&
                    dt.getMonth() !== lastLabeledMonth &&
                    dt >= periodStart &&
                    dt <= periodEnd) {
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
                }
                else if (isFuture) {
                    cell.classList.add("is-future");
                }
                else {
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
    /** 日次合計 sparkline を描画。SVG の細い棒を 1 日 1 本ずつ並べる。
     *  最大値を 100% として高さを正規化し、視覚的な「波形」を出す。 */
    function renderDailySpark(values) {
        const svg = $("cal-daily-spark");
        if (!svg)
            return;
        const n = Math.max(1, values.length);
        const max = values.length ? Math.max(...values, 1) : 1;
        svg.setAttribute("viewBox", `0 0 ${n} 26`);
        svg.replaceChildren();
        const svgNs = "http://www.w3.org/2000/svg";
        const frag = document.createDocumentFragment();
        for (let i = 0; i < values.length; i++) {
            const v = values[i] || 0;
            if (v <= 0)
                continue;
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
    // 期間スイッチ + ナビ UI
    // ============================================================
    /** 期間スイッチ (1/3/6/12ヶ月) のアクティブ状態を monthsShown に同期。
     *  デザイン刷新でスライダー → 4 連ボタンに置き換えたため、対象セレクタも
     *  `.cr-range button[data-pos]` に変更している。 */
    function applyPeriodSelection(months) {
        C.state.monthsShown = clampMonths(months);
        const pos = POS_TO_MONTHS.indexOf(C.state.monthsShown);
        for (const btn of document.querySelectorAll(".cr-range button[data-pos]")) {
            const on = Number(btn.dataset.pos) === pos;
            btn.classList.toggle("is-active", on);
            btn.setAttribute("aria-checked", on ? "true" : "false");
        }
    }
    async function persistMonthsShown(value) {
        try {
            const s = await C.invoke("get_settings");
            s.monthsShown = value;
            await C.invoke("update_settings", { newSettings: s });
        }
        catch (e) {
            console.error("persistMonthsShown failed", e);
        }
    }
    /** スライダー位置 pos に対応する月数を選択。 */
    function selectPeriodByPos(pos) {
        const p = clampPos(pos);
        const m = POS_TO_MONTHS[p];
        if (m === C.state.monthsShown)
            return;
        applyPeriodSelection(m);
        C.state.periodOffset = 0;
        C.refresh();
        persistMonthsShown(m);
    }
    /** 期間スイッチ (1/3/6/12ヶ月) のクリック受付。
     *  デザイン刷新で従来のスライダーは廃止し、4 連ボタン (`.cr-range button[data-pos]`)
     *  に統一した。 */
    function setupPeriodSlider() {
        for (const btn of document.querySelectorAll(".cr-range button[data-pos]")) {
            btn.addEventListener("click", (ev) => {
                if (!ev.isTrusted || !C.navReady())
                    return;
                selectPeriodByPos(Number(btn.dataset.pos));
            });
        }
    }
    /** ヒートマップ前後ナビゲーション (< >)。 */
    function setupCalNav() {
        // 二重の防御:
        //   1. isTrusted で合成クリックを弾く
        //   2. navReady で初期化前のクリックを弾く
        $("cal-prev").addEventListener("click", (ev) => {
            if (!ev.isTrusted || !C.navReady())
                return;
            C.state.periodOffset -= 1;
            C.refresh();
        });
        $("cal-next").addEventListener("click", (ev) => {
            if (!ev.isTrusted || !C.navReady())
                return;
            if (C.state.periodOffset >= 0)
                return;
            C.state.periodOffset += 1;
            C.refresh();
        });
    }
    // ============================================================
    // 単日詳細ポップオーバー
    // ============================================================
    /** main.js から呼ばれる「強制的に閉じる」エントリポイント。
     *  setupDayPopover で本物の close 関数に差し替わる。 */
    let dayPopoverClose = () => { };
    /** ヒートマップセルのクリックで単日詳細ポップオーバーを開く / 閉じる。
     *  - 開: get_day_detail で取得 → DOM 生成 → セル付近に positioning → fade-in
     *  - 閉: × ボタン / 外側クリック / Esc。close 時はトランジション後に hidden 化
     *  - position: viewport 内に収まるように left/top を clamp。 */
    function setupDayPopover() {
        const popover = $("day-popover");
        if (!popover)
            return;
        const closeBtn = $("day-popover-close");
        const dateEl = $("day-popover-date");
        const dowEl = $("day-popover-dow");
        const keysEl = $("day-popover-keys");
        const mouseEl = $("day-popover-mouse");
        const activeEl = $("day-popover-active");
        const hoursEl = $("day-popover-hours");
        const keysListEl = $("day-popover-keys-list");
        const mouseListEl = $("day-popover-mouse-list");
        const emptyEl = $("day-popover-empty");
        let openTimer = 0;
        let closeTimer = 0;
        function close() {
            clearTimeout(openTimer);
            popover.classList.remove("is-open");
            clearTimeout(closeTimer);
            closeTimer = setTimeout(() => {
                popover.hidden = true;
            }, 220);
        }
        dayPopoverClose = close;
        function renderHours(hourly, max) {
            hoursEl.replaceChildren();
            const arr = Array.isArray(hourly) ? hourly : new Array(24).fill(0);
            const safeMax = Math.max(1, max || 0);
            const frag = document.createDocumentFragment();
            const targets = [];
            for (let h = 0; h < 24; h++) {
                const v = safeInt(arr[h] || 0);
                const bar = document.createElement("div");
                bar.className = "cr-popover-hour";
                if (v === 0)
                    bar.dataset.zero = "true";
                bar.dataset.hour = String(h);
                bar.setAttribute("aria-label", L().hourTooltip(h, fmtNum(v)));
                bar.style.setProperty("--delay", `${h * 18}ms`);
                // 開始値は 2px。次フレームで pct% へ。
                bar.style.setProperty("--h", "2px");
                frag.appendChild(bar);
                const pct = v > 0 ? Math.max(8, Math.round((v / safeMax) * 100)) : 0;
                targets.push({ el: bar, pct, hasData: v > 0 });
            }
            hoursEl.appendChild(frag);
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    for (const t of targets) {
                        t.el.style.setProperty("--h", t.hasData ? `${t.pct}%` : "2px");
                    }
                });
            });
        }
        function renderKeyList(items) {
            keysListEl.replaceChildren();
            if (!items || items.length === 0) {
                const p = document.createElement("div");
                p.className = "cr-popover-empty";
                p.style.padding = "10px 0";
                p.textContent = "—";
                keysListEl.appendChild(p);
                return;
            }
            const max = items.reduce((m, it) => Math.max(m, safeInt(it.count)), 1);
            const frag = document.createDocumentFragment();
            const fills = [];
            items.slice(0, 5).forEach((it, idx) => {
                const count = safeInt(it.count);
                const pct = Math.max(8, Math.round((count / max) * 100));
                const row = document.createElement("div");
                row.className = "cr-popover-row";
                const k = document.createElement("div");
                k.className = "k";
                k.textContent = prettyKey(it.label || "");
                const barWrap = document.createElement("div");
                barWrap.className = "bar";
                const fill = document.createElement("span");
                fill.style.setProperty("--delay", `${idx * 40}ms`);
                barWrap.appendChild(fill);
                const n = document.createElement("div");
                n.className = "n";
                n.textContent = fmtNum(count);
                row.append(k, barWrap, n);
                frag.appendChild(row);
                fills.push({ el: fill, pct });
            });
            keysListEl.appendChild(frag);
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    for (const f of fills)
                        f.el.style.width = `${f.pct}%`;
                });
            });
        }
        function renderMouseList(items) {
            mouseListEl.replaceChildren();
            if (!items || items.length === 0) {
                const p = document.createElement("div");
                p.className = "cr-popover-empty";
                p.style.padding = "10px 0";
                p.textContent = "—";
                mouseListEl.appendChild(p);
                return;
            }
            const mouseLabels = L().mouseLabels || {};
            const max = items.reduce((m, it) => Math.max(m, safeInt(it.count)), 1);
            const frag = document.createDocumentFragment();
            const fills = [];
            items.forEach((it, idx) => {
                const count = safeInt(it.count);
                const pct = Math.max(8, Math.round((count / max) * 100));
                const row = document.createElement("div");
                row.className = "cr-popover-row";
                const lbl = document.createElement("div");
                lbl.className = "lbl";
                lbl.textContent = mouseLabels[it.label] || it.label || "";
                const barWrap = document.createElement("div");
                barWrap.className = "bar";
                const fill = document.createElement("span");
                fill.style.setProperty("--delay", `${idx * 50}ms`);
                barWrap.appendChild(fill);
                const n = document.createElement("div");
                n.className = "n";
                n.textContent = fmtNum(count);
                row.append(lbl, barWrap, n);
                frag.appendChild(row);
                fills.push({ el: fill, pct });
            });
            mouseListEl.appendChild(frag);
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    for (const f of fills)
                        f.el.style.width = `${f.pct}%`;
                });
            });
        }
        function render(detail) {
            const d = parseDate(detail.date);
            if (d && dateEl)
                dateEl.textContent = L().dateLabel(d);
            if (d && dowEl) {
                // dateLabel に曜日が含まれているので、別表示の dow は週末カラー切替だけ
                // のために使う (テキストは空)。
                dowEl.textContent = "";
                const dowIdx = d.getDay();
                dowEl.classList.toggle("is-weekend", dowIdx === 0 || dowIdx === 6);
            }
            if (keysEl)
                keysEl.textContent = fmtNum(detail.keys);
            if (mouseEl)
                mouseEl.textContent = fmtNum(detail.mouse);
            if (activeEl)
                activeEl.textContent = L().day_active_fmt(safeInt(detail.activeMs));
            const isEmpty = Boolean(detail.empty);
            if (emptyEl)
                emptyEl.hidden = !isEmpty;
            // 空のときは時間帯 / 内訳をクリアして空表示
            if (isEmpty) {
                if (hoursEl)
                    hoursEl.replaceChildren();
                if (keysListEl)
                    keysListEl.replaceChildren();
                if (mouseListEl)
                    mouseListEl.replaceChildren();
            }
            else {
                renderHours(detail.hourly || [], safeInt(detail.hourlyMax));
                renderKeyList(detail.keyTop || []);
                renderMouseList(detail.mouseBreakdown || []);
            }
        }
        function positionNear(cell) {
            const rect = cell.getBoundingClientRect();
            const popW = popover.offsetWidth || 360;
            const popH = popover.offsetHeight || 280;
            const margin = 8;
            let left = rect.left + rect.width / 2 - popW / 2;
            let top = rect.bottom + 8;
            // 下に出せないなら上に
            if (top + popH > window.innerHeight - margin) {
                top = rect.top - popH - 8;
            }
            // それでも上に出せないなら viewport 内に収める
            if (top < margin)
                top = margin;
            // 横方向 clamp
            if (left < margin)
                left = margin;
            if (left + popW > window.innerWidth - margin) {
                left = window.innerWidth - popW - margin;
            }
            popover.style.left = `${Math.round(left)}px`;
            popover.style.top = `${Math.round(top)}px`;
        }
        async function openForCell(cell) {
            const date = cell.dataset.date;
            if (!date)
                return;
            // future / out-of-range セルは無視
            if (cell.classList.contains("is-future") || cell.classList.contains("is-out"))
                return;
            let detail;
            try {
                detail = await C.invoke("get_day_detail", { date });
            }
            catch (e) {
                console.error("get_day_detail failed", e);
                return;
            }
            if (!detail)
                return;
            render(detail);
            // 一度表示してサイズ確定 → 位置決め → トランジション開始
            popover.hidden = false;
            // レイアウトの確定を強制
            void popover.getBoundingClientRect();
            positionNear(cell);
            clearTimeout(openTimer);
            openTimer = setTimeout(() => {
                popover.classList.add("is-open");
                try {
                    popover.focus();
                }
                catch (_) { }
            }, 10);
        }
        if (closeBtn) {
            closeBtn.addEventListener("click", (ev) => {
                if (!ev.isTrusted)
                    return;
                close();
            });
        }
        // クリックの統合ハンドラ: セルクリック → 開く / それ以外で外側 → 閉じる
        document.addEventListener("click", (ev) => {
            if (!ev.isTrusted)
                return;
            if (!ev.target?.closest)
                return;
            const cell = ev.target.closest(".cal-weeks .cell");
            if (cell) {
                openForCell(cell);
                return;
            }
            // ポップオーバー外のクリックで閉じる
            if (!popover.hidden && !popover.contains(ev.target)) {
                close();
            }
        });
        document.addEventListener("keydown", (ev) => {
            if (ev.key === "Escape" && !popover.hidden)
                close();
        });
        // ウィンドウリサイズ時は閉じる (位置がずれるため)
        window.addEventListener("resize", () => {
            if (!popover.hidden)
                close();
        }, { passive: true });
    }
    /** 外部からポップオーバーを閉じるための入口 (refresh 時など)。 */
    function closeDayPopover() {
        dayPopoverClose();
    }
    // ============================================================
    // 公開
    // ============================================================
    C.calendar = {
        computePeriod,
        buildHeatmap,
        renderDailySpark,
        applyPeriodSelection,
        selectPeriodByPos,
        persistMonthsShown,
        setupPeriodSlider,
        setupCalNav,
        setupDayPopover,
        closeDayPopover,
    };
})();
