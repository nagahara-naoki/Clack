// Clack landing page — heatmap generators.
// 純粋な視覚効果用のため、データはローカル擬似乱数で生成する。
// 外部通信や DOM 入力の取り扱いは無い。

(() => {
  "use strict";

  // ----- 擬似乱数 (xorshift32) -----
  let seed = 0x9b2cd1f7 >>> 0;
  function rand() {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0xffffffff;
  }

  function pickLevel(recency) {
    const bias = 0.40 + recency * 0.45;
    const r = rand() * bias;
    if (r > 0.55) return 4;
    if (r > 0.38) return 3;
    if (r > 0.22) return 2;
    if (r > 0.08) return 1;
    return 0;
  }

  function buildHeatmap({ gridEl, monthsEl, weeks, cellClass }) {
    if (!gridEl) return;
    gridEl.replaceChildren();
    if (monthsEl) monthsEl.replaceChildren();

    const anchor = new Date();
    anchor.setHours(0, 0, 0, 0);
    const dayOfWeek = anchor.getDay();
    const endDate = new Date(anchor);
    endDate.setDate(endDate.getDate() + (6 - dayOfWeek));

    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - (weeks - 1) * 7 - 6);

    let lastLabeledMonth = -1;
    const monthFrag = document.createDocumentFragment();

    for (let col = 0; col < weeks; col++) {
      const colStart = new Date(startDate);
      colStart.setDate(startDate.getDate() + col * 7);

      if (monthsEl) {
        const span = document.createElement("span");
        span.className = "hm-label";
        for (let d = 0; d < 7; d++) {
          const dt = new Date(colStart);
          dt.setDate(colStart.getDate() + d);
          if (dt.getDate() <= 7 && dt.getMonth() !== lastLabeledMonth) {
            span.textContent = `${dt.getMonth() + 1}月`;
            lastLabeledMonth = dt.getMonth();
            break;
          }
        }
        monthFrag.appendChild(span);
      }

      for (let row = 0; row < 7; row++) {
        const cellDate = new Date(colStart);
        cellDate.setDate(colStart.getDate() + row);

        const cell = document.createElement("div");
        cell.className = cellClass;

        if (cellDate > anchor) {
          cell.classList.add("is-future");
        } else {
          const recency = col / Math.max(1, weeks - 1);
          const level = pickLevel(recency);
          if (level > 0) cell.dataset.level = String(level);
        }

        const idx = col * 7 + row;
        cell.style.animationDelay = `${idx * 12}ms`;
        gridEl.appendChild(cell);
      }
    }
    if (monthsEl) monthsEl.appendChild(monthFrag);
  }

  // ヒーロー: 26 週 (≒ 半年)
  buildHeatmap({
    gridEl: document.getElementById("hero-grid"),
    monthsEl: document.getElementById("hero-months"),
    weeks: 26,
    cellClass: "hh-cell",
  });

  // セクション「カレンダー」用のミニ: 18 週。
  // 別 seed で並びを変えて単調さを回避。
  seed = 0x44ce10b3 >>> 0;
  buildHeatmap({
    gridEl: document.getElementById("mc-grid"),
    monthsEl: document.getElementById("mc-head"),
    weeks: 18,
    cellClass: "mc-cell",
  });

  // ----- OS 判定: 訪問者の OS に合うボタンを primary に入れ替える -----
  // どちらのボタンも常にクリック可。primary / ghost のクラスを差し替える
  // ことで「自分の OS のボタンが目立つ」UX を作る。
  function detectOs() {
    const ua = navigator.userAgent || "";
    if (/Mac|iPhone|iPad|iPod/i.test(ua)) return "mac";
    if (/Win/i.test(ua)) return "win";
    return "other";
  }
  const os = detectOs();
  if (os === "mac") {
    document.querySelectorAll(".dl-mac").forEach((b) => {
      b.classList.remove("btn-ghost");
      b.classList.add("btn-primary");
    });
    document.querySelectorAll(".dl-win").forEach((b) => {
      b.classList.remove("btn-primary");
      b.classList.add("btn-ghost");
    });
  }
})();
