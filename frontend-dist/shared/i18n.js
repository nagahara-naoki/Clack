"use strict";
// SPDX-License-Identifier: MIT
//
// Clack — 多言語辞書 (i18n) と適用ヘルパ。
//
// 依存:
//   - Clack.util.pad2 / fmtNum (動的な値整形用)
//   - Clack.state.lang        (現在言語の参照、call-time に取得)
//
// I18N のエントリは「文字列」と「関数」が混在する。
// 関数値は引数を渡して呼ぶ:
//   L().hourTooltip(9, "123")  → "9:00–9:59 ・ 123"
//   L().cal_active_days(261)   → "・ 261 日アクティブ"
// data-i18n 属性で参照される単純文字列は applyLanguage が一括で
// textContent に反映する。
//
// 公開: window.Clack.i18n = { I18N, L, applyLanguage }
(function () {
    const C = (window.Clack = window.Clack || {});
    const { pad2, fmtNum } = C.util;
    const DOW_JA = ["日", "月", "火", "水", "木", "金", "土"];
    const DOW_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const MONTHS_EN = [
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
    ];
    /** 期間タイトル (例: "2025年5月" / "2025年 4〜10月" / "2024年12月 〜 2025年3月")。 */
    function formatTitleJa(start, end) {
        const sy = start.getFullYear(), sm = start.getMonth() + 1;
        const ey = end.getFullYear(), em = end.getMonth() + 1;
        if (sy === ey && sm === em)
            return `${sy}年${sm}月`;
        if (sy === ey)
            return `${sy}年 ${sm}〜${em}月`;
        return `${sy}年${sm}月 〜 ${ey}年${em}月`;
    }
    function formatTitleEn(start, end) {
        const sy = start.getFullYear(), sm = start.getMonth();
        const ey = end.getFullYear(), em = end.getMonth();
        if (sy === ey && sm === em)
            return `${MONTHS_EN[sm]} ${sy}`;
        if (sy === ey)
            return `${MONTHS_EN[sm]} – ${MONTHS_EN[em]} ${sy}`;
        return `${MONTHS_EN[sm]} ${sy} – ${MONTHS_EN[em]} ${ey}`;
    }
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
                if (!Number.isFinite(pct))
                    return "—";
                const sign = pct >= 0 ? "+" : "−";
                return `${sign}${Math.abs(pct).toFixed(1)}%`;
            },
            hero_now_at: (h, m) => `· ${pad2(h)}:${pad2(m)} 時点`,
            trip_goal_to: (name) => `${name}まで`,
            trip_goal_passed: (name) => `${name} 突破`,
            cal_active_days: (n) => (n > 0 ? `· ${fmtNum(n)} 日アクティブ` : ""),
            cal_daily_label: (months) => `日次合計 · 過去 ${months} ヶ月`,
            cal_daily_max: (n) => `最大 ${fmtNum(n)} / 日`,
            cal_period_totals: "期間合計",
            list_today_badge: "今日",
            list_month_summary: (days, keys, mouse) => `${days} 日 · キー ${fmtNum(keys)} · マウス ${fmtNum(mouse)}`,
            day_active: "アクティブ",
            day_hours_title: "時間帯",
            day_keys_title: "よく使ったキー",
            day_mouse_title: "マウス",
            day_no_data: "この日の記録はありません",
            day_future: "未来日",
            day_active_fmt: (ms) => {
                if (!Number.isFinite(ms) || ms <= 0)
                    return "0m";
                const total_min = Math.floor(ms / 60000);
                if (total_min < 60)
                    return `${total_min}m`;
                const h = Math.floor(total_min / 60);
                const m = total_min % 60;
                return m === 0 ? `${h}h` : `${h}h ${m}m`;
            },
            hourTooltip: (hour, val) => `${hour}:00–${hour}:59 ・ ${val}`,
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
            months: [
                "1月",
                "2月",
                "3月",
                "4月",
                "5月",
                "6月",
                "7月",
                "8月",
                "9月",
                "10月",
                "11月",
                "12月",
            ],
            dateLabel: (d) => `${d.getMonth() + 1}月${d.getDate()}日 (${DOW_JA[d.getDay()]})`,
            title: (start, end) => formatTitleJa(start, end),
            tooltip: (k, m) => `キー ${k} ・ マウス ${m}`,
            listDate: (d) => `${d.getMonth() + 1}/${pad2(d.getDate())} (${DOW_JA[d.getDay()]})`,
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
                if (!Number.isFinite(pct))
                    return "—";
                const sign = pct >= 0 ? "+" : "−";
                return `${sign}${Math.abs(pct).toFixed(1)}%`;
            },
            hero_now_at: (h, m) => `· as of ${pad2(h)}:${pad2(m)}`,
            trip_goal_to: (name) => `to ${name}`,
            trip_goal_passed: (name) => `Passed ${name}`,
            cal_active_days: (n) => (n > 0 ? `· ${fmtNum(n)} active days` : ""),
            cal_daily_label: (months) => `Daily total · last ${months} months`,
            cal_daily_max: (n) => `Max ${fmtNum(n)} / day`,
            cal_period_totals: "Period total",
            list_today_badge: "TODAY",
            list_month_summary: (days, keys, mouse) => `${days} days · ${fmtNum(keys)} keys · ${fmtNum(mouse)} mouse`,
            day_active: "Active",
            day_hours_title: "Hours",
            day_keys_title: "Top keys",
            day_mouse_title: "Mouse",
            day_no_data: "No records for this day",
            day_future: "Future",
            day_active_fmt: (ms) => {
                if (!Number.isFinite(ms) || ms <= 0)
                    return "0m";
                const total_min = Math.floor(ms / 60000);
                if (total_min < 60)
                    return `${total_min}m`;
                const h = Math.floor(total_min / 60);
                const m = total_min % 60;
                return m === 0 ? `${h}h` : `${h}h ${m}m`;
            },
            hourTooltip: (hour, val) => `${hour}:00–${hour}:59 · ${val}`,
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
            listDate: (d) => `${MONTHS_EN[d.getMonth()]} ${pad2(d.getDate())} (${DOW_EN[d.getDay()]})`,
        },
    };
    /** 現在言語の辞書オブジェクトを返す。 */
    function L() {
        return (C.state && I18N[C.state.lang]) || I18N.ja;
    }
    /** 言語を切替え、data-i18n 要素の文言を一括更新する。
     *  動的に作られる要素 (ヒートマップなど) は再描画側で次の L() を見て出す。 */
    function applyLanguage(lang) {
        const v = lang === "en" ? "en" : "ja";
        if (C.state)
            C.state.lang = v;
        document.documentElement.lang = v;
        const labels = L();
        for (const el of document.querySelectorAll("[data-i18n]")) {
            const key = el.dataset.i18n;
            if (!key)
                continue;
            const val = labels[key];
            if (typeof val === "string") {
                el.textContent = val;
            }
        }
    }
    C.i18n = { I18N, L, applyLanguage, DOW_JA, DOW_EN, MONTHS_EN };
})();
