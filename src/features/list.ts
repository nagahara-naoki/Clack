// SPDX-License-Identifier: MIT
//
// Clack — リストビューの DOM 構築。
//
// 5 列 grid: [日付 + 曜日 + バッジ] [キーバー] [キー数] [マウスバー] [マウス数]
// 月境界で見出し行 (cr-list-month) を挿入し、当月の日数 / キー / マウス 合計
// を表示する。全 0 の日は今日以外スキップ。
//
// 依存:
//   - Clack.util.$ / pad2 / safeInt / fmtDate / parseDate / fmtNum
//   - Clack.i18n.L
//   - Clack.state.lang        (曜日配列の選択)
//
// 公開: window.Clack.list = { build }

(function () {
  const C = (window.Clack = window.Clack || ({} as ClackNamespace));
  const { $, pad2, safeInt, fmtDate, parseDate, fmtNum } = C.util;
  const { L } = C.i18n;

  /** 1 ヶ月キー "YYYY年M月" を作る。
   *  ja: "2026年5月" / en: "May 2026" の形式で月境界の見出しに使う。 */
  function listMonthLabel(d) {
    const labels = L();
    if (C.state.lang === "en") {
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
    day.textContent = dt ? `${dt.getMonth() + 1}/${pad2(dt.getDate())}` : d.date;
    const dow = document.createElement("span");
    dow.className = "dow";
    if (dt) {
      const dowIdx = dt.getDay();
      const dows =
        C.state.lang === "en"
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
    keysFill.style.width =
      keys > 0 && maxKeys > 0 ? `${Math.max(6, Math.round((keys / maxKeys) * 100))}%` : "0%";
    keysBar.appendChild(keysFill);

    const keysNum = document.createElement("div");
    keysNum.className = keys === 0 ? "num zero" : "num";
    keysNum.textContent = keys === 0 ? "—" : fmtNum(keys);

    // ---- マウスバー + 数値 ---------------------------------------------
    const mouseBar = document.createElement("div");
    mouseBar.className = "bar is-mouse";
    const mouseFill = document.createElement("span");
    mouseFill.style.width =
      mouse > 0 && maxMouse > 0 ? `${Math.max(6, Math.round((mouse / maxMouse) * 100))}%` : "0%";
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
  function build(entries, today) {
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

  C.list = { build };
})();
