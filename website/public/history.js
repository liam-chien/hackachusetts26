const { METRICS, rowsFromPlate, aggregate, metricNumber, round, goalPerMeal, RECURRENCE_LABEL } = Nutrition;

const state = {
  plates: [],        // full list (with images), newest first
  goals: [],         // user's nutrition goals (for Trends reference lines)
  metric: "calories",
  range: "month",    // week | month | year | all
  query: "",
  dayWidth: 48,      // px per calendar day on the timeline (zoom)
};

// Zoom bounds for the timeline, in pixels per day.
const DAY_W_MIN = 14;
const DAY_W_MAX = 160;

const el = {
  metricSelect: document.getElementById("metricSelect"),
  rangeTabs: document.getElementById("rangeTabs"),
  chart: document.getElementById("chart"),
  chartEmpty: document.getElementById("chartEmpty"),
  chartSummary: document.getElementById("chartSummary"),
  chartWrap: document.querySelector(".chart-wrap"),
  search: document.getElementById("search"),
  listCount: document.getElementById("listCount"),
  mealList: document.getElementById("mealList"),
  timeline: document.getElementById("timeline"),
  timelineAxis: document.getElementById("timelineAxis"),
  timelineScroll: document.getElementById("timelineScroll"),
  timelineEmpty: document.getElementById("timelineEmpty"),
  zoomRange: document.getElementById("zoomRange"),
  zoomIn: document.getElementById("zoomIn"),
  zoomOut: document.getElementById("zoomOut"),
};

const SVGNS = "http://www.w3.org/2000/svg";

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// A plate's date for ordering/plotting: prefer menu_date, fall back to created_at.
function plateDate(p) {
  const d = p.menu_date ? new Date(p.menu_date + "T12:00:00") : new Date(p.created_at);
  return isNaN(d) ? new Date(p.created_at) : d;
}

function metricValue(p, metricKey) {
  const agg = aggregate(rowsFromPlate(p));
  const m = METRICS.find((x) => x.key === metricKey);
  return metricNumber(m, agg);
}

function rangeStart(range) {
  const now = new Date();
  const d = new Date(now);
  if (range === "week") d.setDate(now.getDate() - 7);
  else if (range === "month") d.setMonth(now.getMonth() - 1);
  else if (range === "year") d.setFullYear(now.getFullYear() - 1);
  else return null; // all time
  d.setHours(0, 0, 0, 0);
  return d;
}

function fmtShort(date) {
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function fmtLong(date) {
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

// ---- Init ------------------------------------------------------------------
async function init() {
  el.metricSelect.innerHTML = METRICS.map(
    (m) => `<option value="${m.key}">${esc(m.label)}</option>`
  ).join("");
  el.metricSelect.value = state.metric;

  el.metricSelect.onchange = () => { state.metric = el.metricSelect.value; renderChart(); };
  el.rangeTabs.querySelectorAll("button").forEach((btn) => {
    btn.onclick = () => {
      state.range = btn.dataset.range;
      el.rangeTabs.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
      renderChart();
    };
  });
  el.search.oninput = () => { state.query = el.search.value.trim().toLowerCase(); renderList(); };

  // Timeline zoom controls. The range slider maps 0..100 onto the
  // day-width range (log scale so both ends feel natural).
  const sliderToWidth = (v) => Math.round(DAY_W_MIN * Math.pow(DAY_W_MAX / DAY_W_MIN, v / 100));
  const widthToSlider = (w) => Math.round(100 * Math.log(w / DAY_W_MIN) / Math.log(DAY_W_MAX / DAY_W_MIN));
  const applyZoom = (w, keepCenter = true) => {
    const prev = state.dayWidth;
    state.dayWidth = Math.max(DAY_W_MIN, Math.min(DAY_W_MAX, w));
    el.zoomRange.value = widthToSlider(state.dayWidth);
    // Keep the center of the view roughly fixed while zooming.
    const sc = el.timelineScroll;
    const centerRatio = keepCenter && sc.scrollWidth > sc.clientWidth
      ? (sc.scrollLeft + sc.clientWidth / 2) / sc.scrollWidth : null;
    renderTimeline();
    if (centerRatio != null) {
      sc.scrollLeft = centerRatio * sc.scrollWidth - sc.clientWidth / 2;
    }
  };
  el.zoomRange.oninput = () => applyZoom(sliderToWidth(Number(el.zoomRange.value)));
  el.zoomIn.onclick = () => applyZoom(state.dayWidth * 1.4);
  el.zoomOut.onclick = () => applyZoom(state.dayWidth / 1.4);
  el.zoomRange.value = widthToSlider(state.dayWidth);

  try {
    const res = await fetch("/api/plates?images=1");
    if (!res.ok) throw new Error("Could not load meals");
    const data = await res.json();
    state.plates = (data.plates || []).slice().sort((a, b) => plateDate(b) - plateDate(a));
  } catch (err) {
    console.error(err);
    el.mealList.innerHTML = `<p class="list-empty">We couldn't load your meals. Reload to try again.</p>`;
  }

  // Goals power the reference lines on the Trends chart.
  try {
    const res = await fetch("/api/profile");
    if (res.ok) {
      const p = await res.json();
      state.goals = Array.isArray(p.goals) ? p.goals : [];
    }
  } catch (err) { console.error(err); }
  renderChart();
  renderTimeline();
  renderList();
  // Start scrolled to the most recent meals (right edge).
  el.timelineScroll.scrollLeft = el.timelineScroll.scrollWidth;
}

// ---- Chart -----------------------------------------------------------------
function platesInRange() {
  const start = rangeStart(state.range);
  return state.plates.filter((p) => !start || plateDate(p) >= start);
}

function renderChart() {
  const m = METRICS.find((x) => x.key === state.metric);
  const inRange = platesInRange()
    .map((p) => ({ p, date: plateDate(p), value: metricValue(p, state.metric) }))
    .filter((d) => d.value != null)
    .sort((a, b) => a.date - b.date);

  el.chart.innerHTML = "";
  if (!inRange.length) {
    el.chartEmpty.classList.remove("hidden");
    el.chartSummary.textContent = "";
    return;
  }
  el.chartEmpty.classList.add("hidden");

  // Layout
  const W = el.chart.clientWidth || 700;
  const H = 260;
  const pad = { top: 16, right: 14, bottom: 34, left: 44 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  // Goals for the selected metric, converted to per-meal values (the chart's
  // unit). A per-day goal divides by meals/day; a per-week goal by 7×meals/day.
  const goalLines = state.goals
    .filter((g) => g.metric === state.metric && Number(g.target) > 0)
    .map((g) => ({ goal: g, value: goalPerMeal(g) }))
    .filter((g) => g.value > 0);

  // Make sure goal lines above the tallest bar stay visible.
  const maxV = Math.max(
    ...inRange.map((d) => d.value),
    ...goalLines.map((g) => g.value)
  );
  const yMax = niceMax(maxV);

  // Y axis + gridlines
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const v = (yMax / ticks) * i;
    const y = pad.top + plotH - (v / yMax) * plotH;
    line(pad.left, y, pad.left + plotW, y, i === 0 ? "axis-line" : "grid-line");
    text(pad.left - 8, y + 3, round(v, v < 10 ? 1 : 0), "axis-label", "end");
  }

  // Bars across the range, evenly spaced by index (works for sparse data).
  const n = inRange.length;
  const slot = plotW / n;
  const barW = Math.max(6, Math.min(46, slot * 0.6));
  const labelEvery = Math.ceil(n / Math.min(n, 8));

  inRange.forEach((d, i) => {
    const cx = pad.left + slot * (i + 0.5);
    const h = (d.value / yMax) * plotH;
    const y = pad.top + plotH - h;
    const rect = document.createElementNS(SVGNS, "rect");
    rect.setAttribute("class", "bar");
    rect.setAttribute("x", cx - barW / 2);
    rect.setAttribute("y", y);
    rect.setAttribute("width", barW);
    rect.setAttribute("height", Math.max(0, h));
    rect.setAttribute("rx", Math.min(5, barW / 3));
    rect.addEventListener("mouseenter", (e) => showTip(e, d, m));
    rect.addEventListener("mousemove", (e) => showTip(e, d, m));
    rect.addEventListener("mouseleave", hideTip);
    rect.addEventListener("click", () => { location.href = `edit.html?id=${d.p.id}`; });
    el.chart.appendChild(rect);

    if (i % labelEvery === 0 || i === n - 1) {
      text(cx, pad.top + plotH + 18, fmtShort(d.date), "axis-label", "middle");
    }
  });

  // Goal reference lines (dashed, labeled) for the selected metric. Drawn on
  // top of the bars so they're always visible. Lines go at the true y; labels
  // are stacked when several goals land at (nearly) the same height so they
  // don't overlap into unreadable text.
  const unitStr = m.unit.trim();
  const usedLabelY = [];
  const sortedGoals = [...goalLines].sort((a, b) => b.value - a.value); // top-down
  for (const { goal, value } of sortedGoals) {
    const y = pad.top + plotH - (value / yMax) * plotH;
    const gline = document.createElementNS(SVGNS, "line");
    gline.setAttribute("class", "goal-line");
    gline.setAttribute("x1", pad.left);
    gline.setAttribute("y1", y);
    gline.setAttribute("x2", pad.left + plotW);
    gline.setAttribute("y2", y);
    el.chart.appendChild(gline);

    // Keep each label at least 13px below the previous one.
    let labelY = y - 4;
    while (usedLabelY.some((u) => Math.abs(u - labelY) < 13)) labelY += 13;
    usedLabelY.push(labelY);

    // Label: per-meal target + the original goal, so the scaling is explicit.
    const perMeal = `${round(value, value < 10 ? 1 : 0)}${unitStr ? " " + unitStr : ""}/meal`;
    const orig = `${round(goal.target, 1)}${unitStr ? " " + unitStr : ""} ${RECURRENCE_LABEL[goal.recurrence] || goal.recurrence}`;
    const labelText = goal.recurrence === "meal" ? `Goal · ${perMeal}` : `Goal · ${perMeal} (${orig})`;
    text(pad.left + plotW, labelY, labelText, "goal-label", "end");
  }

  // Summary line
  const vals = inRange.map((d) => d.value);
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const unit = m.unit.trim();
  el.chartSummary.textContent =
    `${n} meal${n === 1 ? "" : "s"} · avg ${round(avg, avg < 10 ? 1 : 0)}${unit ? " " + unit : ""} · ` +
    `max ${round(Math.max(...vals), 1)}${unit ? " " + unit : ""} per meal`;
}

function niceMax(v) {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  const n = v / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * mag;
}

function line(x1, y1, x2, y2, cls) {
  const l = document.createElementNS(SVGNS, "line");
  l.setAttribute("x1", x1); l.setAttribute("y1", y1);
  l.setAttribute("x2", x2); l.setAttribute("y2", y2);
  l.setAttribute("class", cls);
  el.chart.appendChild(l);
}
function text(x, y, str, cls, anchor) {
  const t = document.createElementNS(SVGNS, "text");
  t.setAttribute("x", x); t.setAttribute("y", y);
  t.setAttribute("class", cls);
  if (anchor) t.setAttribute("text-anchor", anchor);
  t.textContent = str;
  el.chart.appendChild(t);
  return t;
}

let tip;
function showTip(e, d, m) {
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "chart-tooltip";
    el.chartWrap.appendChild(tip);
  }
  const unit = m.unit.trim();
  tip.innerHTML = `<b>${esc(d.p.name)}</b><br>${fmtLong(d.date)}<br>${round(d.value, 1)}${unit ? " " + unit : ""}`;
  const wrapRect = el.chartWrap.getBoundingClientRect();
  tip.style.left = `${e.clientX - wrapRect.left}px`;
  tip.style.top = `${e.clientY - wrapRect.top}px`;
  tip.classList.add("show");
}
function hideTip() { if (tip) tip.classList.remove("show"); }

// ---- Timeline --------------------------------------------------------------
// Horizontal, zoomable, scrollable track: x = calendar day, y = time of day.
// One dot per meal. Day boundaries shaded light grey. Reveals meal-frequency
// patterns (e.g. consistently missing mornings => skipped breakfasts).

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
const DAY_MS = 24 * 60 * 60 * 1000;

// Local YYYY-MM-DD for a date.
function isoDate(d) {
  return d.toLocaleDateString("en-CA");
}

// A meal's moment in time: created_at (has time of day); fall back to noon of
// its menu_date so it still plots sensibly if a timestamp is missing.
function plateMoment(p) {
  const c = new Date(p.created_at);
  if (!isNaN(c)) return c;
  return new Date((p.menu_date || "") + "T12:00:00");
}

function renderTimeline() {
  const svg = el.timeline;
  svg.innerHTML = "";

  if (!state.plates.length) {
    el.timelineEmpty.classList.remove("hidden");
    svg.setAttribute("width", 0);
    return;
  }
  el.timelineEmpty.classList.add("hidden");

  const moments = state.plates.map((p) => ({ p, when: plateMoment(p) }))
    .filter((d) => !isNaN(d.when))
    .sort((a, b) => a.when - b.when);
  if (!moments.length) { el.timelineEmpty.classList.remove("hidden"); return; }

  // Day range: from the earliest meal's day through today (inclusive), so the
  // track shows every day even ones with no meals (the gaps are the point).
  const firstDay = startOfDay(moments[0].when);
  const lastDay = startOfDay(new Date(Math.max(Date.now(), moments[moments.length - 1].when)));
  const dayCount = Math.round((lastDay - firstDay) / DAY_MS) + 1;

  const dayW = state.dayWidth;
  const padTop = 22, padBottom = 26, padRight = 16;
  const padLeft = 42; // matches the pinned axis gutter width in CSS
  const H = 260;
  const plotTop = padTop, plotBottom = H - padBottom;
  const plotH = plotBottom - plotTop;
  const W = padLeft + dayCount * dayW + padRight;

  svg.setAttribute("width", W);
  svg.setAttribute("height", H);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

  const todayStr = isoDate(new Date());
  // Only label days when there's enough room, so labels don't overlap.
  const labelEvery = Math.max(1, Math.ceil(64 / dayW));

  // y position for a time of day (hours 0..24 -> plotTop..plotBottom).
  const yForHours = (h) => plotTop + (h / 24) * plotH;

  // Namespaced SVG element helpers (innerHTML on an <svg> wouldn't namespace
  // children, so they must be created with createElementNS).
  const makeEl = (parent) => (tag, attrs, text) => {
    const n = document.createElementNS(SVGNS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = text;
    parent.appendChild(n);
    return n;
  };
  const svgEl = makeEl(svg);

  // Day bands + separators + date labels (drawn first so the hour gridlines
  // sit on top of them and span the whole graph). Offset by padLeft so the
  // first day clears the pinned axis gutter.
  for (let i = 0; i < dayCount; i++) {
    const x = padLeft + i * dayW;
    const dayDate = new Date(firstDay.getTime() + i * DAY_MS);
    const isToday = isoDate(dayDate) === todayStr;
    const bandCls = isToday ? "today-band" : (i % 2 === 0 ? "day-band" : "day-band alt");
    svgEl("rect", { class: bandCls, x, y: plotTop, width: dayW, height: plotH });
    svgEl("line", { class: "day-sep", x1: x, y1: plotTop, x2: x, y2: plotBottom });
    if (i % labelEvery === 0 || isToday) {
      const lbl = dayW >= 44
        ? dayDate.toLocaleDateString(undefined, { month: "short", day: "numeric" })
        : String(dayDate.getDate());
      svgEl("text", { class: "day-label", x: x + dayW / 2, y: plotBottom + 15, "text-anchor": "middle" }, lbl);
    }
  }

  // Dashed hour gridlines every 3 hours, spanning the scrollable track.
  for (const h of [0, 3, 6, 9, 12, 15, 18, 21]) {
    const y = yForHours(h);
    svgEl("line", { class: "hour-line", x1: padLeft, y1: y, x2: W, y2: y });
  }

  // Meal dots.
  const dotR = Math.max(3, Math.min(6, dayW / 8));
  for (const { p, when } of moments) {
    const dayIdx = Math.round((startOfDay(when) - firstDay) / DAY_MS);
    const hours = when.getHours() + when.getMinutes() / 60;
    const cx = padLeft + dayIdx * dayW + dayW / 2;
    const cy = yForHours(hours);
    svgEl("circle", {
      class: "meal-dot", cx, cy, r: dotR,
      "data-id": p.id, "data-name": p.name, "data-when": when.getTime(),
    });
  }

  // Pinned time-of-day axis gutter: hour labels that stay in view while the
  // track scrolls. A small background hides dots/lines sliding behind it.
  const axis = el.timelineAxis;
  axis.innerHTML = "";
  axis.setAttribute("height", H);
  axis.setAttribute("viewBox", `0 0 ${padLeft} ${H}`);
  const axisEl = makeEl(axis);
  axisEl("rect", { class: "timeline-axis-bg", x: 0, y: plotTop, width: padLeft, height: plotH });
  for (const h of [0, 3, 6, 9, 12, 15, 18, 21]) {
    const y = yForHours(h);
    const label = h === 0 ? "12am" : h === 12 ? "noon" : h < 12 ? `${h}am` : `${h - 12}pm`;
    // Midnight's label would clip above the plot, so nudge it below the line.
    const labelY = h === 0 ? y + 9 : y + 3;
    axisEl("text", { class: "hour-label", x: 4, y: labelY }, label);
  }

  // Interactivity: hover tooltip + click to edit.
  svg.querySelectorAll(".meal-dot").forEach((dot) => {
    dot.addEventListener("mouseenter", (e) => showTimelineTip(e, dot));
    dot.addEventListener("mousemove", (e) => showTimelineTip(e, dot));
    dot.addEventListener("mouseleave", hideTimelineTip);
    dot.addEventListener("click", () => { location.href = `edit.html?id=${dot.dataset.id}`; });
  });
}

let tlTip;
function showTimelineTip(e, dot) {
  const scroll = el.timelineScroll;
  if (!tlTip) {
    tlTip = document.createElement("div");
    tlTip.className = "timeline-tooltip";
    scroll.parentElement.style.position = "relative";
    scroll.parentElement.appendChild(tlTip);
  }
  const when = new Date(Number(dot.dataset.when));
  const time = when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  tlTip.innerHTML = `<b>${esc(dot.dataset.name)}</b><br>${fmtLong(when)} · ${time}`;
  const wrapRect = scroll.parentElement.getBoundingClientRect();
  tlTip.style.left = `${e.clientX - wrapRect.left}px`;
  tlTip.style.top = `${e.clientY - wrapRect.top}px`;
  tlTip.classList.add("show");
}
function hideTimelineTip() { if (tlTip) tlTip.classList.remove("show"); }

// ---- List ------------------------------------------------------------------
function matchesQuery(p, q) {
  if (!q) return true;
  const hay = [
    p.name, p.dining_hall, p.menu_date,
    ...(p.items || []).map((i) => i.dish_name),
  ].join(" ").toLowerCase();
  return hay.includes(q);
}

const CAMERA_SVG = `<svg viewBox="0 0 32 32" fill="none"><path d="M11 8l2-3h6l2 3h5a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V11a3 3 0 0 1 3-3h5Z" stroke="currentColor" stroke-width="1.6"/><circle cx="16" cy="18" r="6" stroke="currentColor" stroke-width="1.6"/></svg>`;

function renderList() {
  const q = state.query;
  const list = state.plates.filter((p) => matchesQuery(p, q)); // already newest-first
  el.listCount.textContent = q
    ? `${list.length} of ${state.plates.length} meals match "${el.search.value.trim()}"`
    : `${state.plates.length} meal${state.plates.length === 1 ? "" : "s"}, most recent first`;

  if (!list.length) {
    el.mealList.innerHTML = `<p class="list-empty">${
      state.plates.length ? "No meals match your search." : "No meals yet. Track one to get started."
    }</p>`;
    return;
  }

  el.mealList.innerHTML = list.map((p) => {
    const agg = aggregate(rowsFromPlate(p));
    const cal = metricNumber(METRICS.find((m) => m.key === "calories"), agg);
    const protein = metricNumber(METRICS.find((m) => m.key === "protein"), agg);
    const carbs = metricNumber(METRICS.find((m) => m.key === "total_carb"), agg);
    const fat = metricNumber(METRICS.find((m) => m.key === "total_fat"), agg);
    const foods = (p.items || []).map((i) => i.dish_name).join(", ");
    const thumb = p.image
      ? `<img class="meal-thumb" src="${esc(p.image)}" alt="" />`
      : `<span class="meal-thumb placeholder" aria-hidden="true">${CAMERA_SVG}</span>`;
    const stat = (v, suffix, cls = "") =>
      v == null ? "" : `<span class="meal-stat ${cls}">${round(v, 1)}${suffix}</span>`;
    return `
      <button type="button" class="meal-card" data-id="${p.id}">
        ${thumb}
        <span class="meal-body">
          <span class="meal-row1">
            <span class="meal-name">${esc(p.name)}</span>
            <span class="meal-when">${esc(fmtLong(plateDate(p)))}</span>
          </span>
          <span class="meal-sub">${esc(p.dining_hall || "")}${foods ? " · " + esc(foods) : ""}</span>
          <span class="meal-stats">
            ${stat(cal, " kcal", "cal")}
            ${stat(protein, "g P")}
            ${stat(carbs, "g C")}
            ${stat(fat, "g F")}
          </span>
        </span>
      </button>`;
  }).join("");

  el.mealList.querySelectorAll(".meal-card").forEach((node) => {
    node.onclick = () => { location.href = `edit.html?id=${node.dataset.id}`; };
  });
}

window.addEventListener("resize", () => renderChart());
init();
