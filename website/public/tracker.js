// ---- Metric definitions ----------------------------------------------------
// Each metric knows how to pull a value from a menu item and how it aggregates.
// kind "sum": additive nutrient scaled by servings; "avg": averaged score.
const METRICS = [
  { key: "calories",      label: "Calories",     field: "calories",       unit: " kcal", kind: "sum" },
  { key: "protein",       label: "Protein",      field: "protein",        unit: "g",   kind: "sum" },
  { key: "total_carb",    label: "Carbs",        field: "total_carb",     unit: "g",   kind: "sum" },
  { key: "total_fat",     label: "Total Fat",    field: "total_fat",      unit: "g",   kind: "sum" },
  { key: "sat_fat",       label: "Sat. Fat",     field: "sat_fat",        unit: "g",   kind: "sum" },
  { key: "trans_fat",     label: "Trans Fat",    field: "trans_fat",      unit: "g",   kind: "sum" },
  { key: "cholesterol",   label: "Cholesterol",  field: "cholesterol",    unit: "mg",  kind: "sum" },
  { key: "sodium",        label: "Sodium",       field: "sodium",         unit: "mg",  kind: "sum" },
  { key: "dietary_fiber", label: "Fiber",        field: "dietary_fiber",  unit: "g",   kind: "sum" },
  { key: "sugars",        label: "Sugars",       field: "sugars",         unit: "g",   kind: "sum" },
  { key: "healthfulness", label: "Healthfulness",field: "healthfulness",  unit: "",    kind: "avg" },
  { key: "carbon",        label: "Carbon Score", field: "carbon_rating",  unit: "",    kind: "carbon" },
];

const DEFAULT_VISIBLE = [
  "calories", "protein", "total_carb", "total_fat", "healthfulness", "carbon",
];

// Carbon rating is a letter (A best … C worst). Map to a number for averaging.
const CARBON_SCORE = { A: 1, B: 2, C: 3, D: 4, E: 5 };
const CARBON_LETTER = { 1: "A", 2: "B", 3: "C", 4: "D", 5: "E" };

const STORAGE_KEY = "tracker_visible_metrics";

// ---- State -----------------------------------------------------------------
const state = {
  halls: [],
  hall: null,
  date: null,
  items: [],              // menu items for the current hall
  photo: null,            // data URL
  rows: [],               // [{ uid, item|null, servings }]
  visible: loadVisible(),
  loadedPlateId: null,
  loading: true,
  saving: false,
  legacyTotals: null,
  profile: { name: "", allergens: [], avoid_foods: [], goals: [] },
  // Nutrition already eaten in the current day/week (from saved meals),
  // keyed by metric key, used as the baseline for per-day/week goal progress.
  baseline: { day: {}, week: {} },
  // Map of lower-cased meal name -> plate id for meals already in the user's
  // history, used to block saving a duplicate name and link to its editor.
  existingNames: new Map(),
};

let uidCounter = 1;
let menuRequest = 0;
let plateLoadRequest = 0;
let photoRequest = 0;
let menuController;

const el = {
  hallTabs: document.getElementById("hallTabs"),
  trackerDate: document.getElementById("trackerDate"),
  photoBox: document.getElementById("photoBox"),
  photoInput: document.getElementById("photoInput"),
  photoPlaceholder: document.getElementById("photoPlaceholder"),
  photoPreview: document.getElementById("photoPreview"),
  removePhotoBtn: document.getElementById("removePhotoBtn"),
  plateName: document.getElementById("plateName"),
  addFoodBtn: document.getElementById("addFoodBtn"),
  emptyHelp: document.getElementById("emptyHelp"),
  plateItems: document.getElementById("plateItems"),
  overview: document.getElementById("overview"),
  metricsBtn: document.getElementById("metricsBtn"),
  saveBtn: document.getElementById("saveBtn"),
  loadBtn: document.getElementById("loadBtn"),
  metricsModal: document.getElementById("metricsModal"),
  metricsClose: document.getElementById("metricsClose"),
  metricsList: document.getElementById("metricsList"),
  menuNotice: document.getElementById("menuNotice"),
  nutritionNote: document.getElementById("nutritionNote"),
  actionStatus: document.getElementById("actionStatus"),
  plateWarnings: document.getElementById("plateWarnings"),
  goalProgress: document.getElementById("goalProgress"),
};

// ---- Helpers ---------------------------------------------------------------
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function loadVisible() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (Array.isArray(saved)) return saved.filter((key) => METRICS.some((m) => m.key === key));
  } catch {}
  return [...DEFAULT_VISIBLE];
}

function saveVisible() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.visible)); } catch {}
}

function notice(message = "") {
  el.menuNotice.textContent = message;
  el.menuNotice.classList.toggle("hidden", !message);
}

function formatDate(date) {
  if (!date) return "";
  return new Date(date + "T00:00:00").toLocaleDateString(undefined, {
    weekday: "long", month: "long", day: "numeric",
  });
}

// Safe setter: the date readout is an optional bit of UI, so a missing
// #trackerDate element must never break the rest of the page.
function setTrackerDate(text) {
  if (el.trackerDate) el.trackerDate.textContent = text;
}

function plateChanged() {
  state.legacyTotals = null;
  el.actionStatus.textContent = "";
}

function setPhoto(photo) {
  ++photoRequest;
  state.photo = photo || null;
  el.photoInput.value = "";
  if (photo) el.photoPreview.src = photo;
  else el.photoPreview.removeAttribute("src");
  el.photoPreview.classList.toggle("hidden", !photo);
  el.photoPlaceholder.classList.toggle("hidden", !!photo);
  el.removePhotoBtn.classList.toggle("hidden", !photo);
}

// Parse a numeric nutrient string like "2.2g" or "637.1mg" or "222".
function parseNum(str) {
  if (str == null) return 0;
  const m = String(str).match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : 0;
}

// Parse a serving size like "3 oz", "1 EACH", "1/2 Sandwich" into
// { qty, unit } where qty is numeric (fractions supported).
function parseServing(str) {
  if (!str) return { qty: 1, unit: "serving" };
  const s = String(str).trim();
  // leading quantity: integer, decimal, "1 1/2", or "1/2"
  const m = s.match(/^((\d+\s+\d+\/\d+)|(\d+\/\d+)|(\d+(\.\d+)?))\s*(.*)$/);
  if (!m) return { qty: 1, unit: s || "serving" };
  const qtyStr = m[1];
  let qty = 0;
  if (qtyStr.includes(" ")) {
    const [whole, frac] = qtyStr.split(/\s+/);
    const [a, b] = frac.split("/").map(Number);
    qty = Number(whole) + a / b;
  } else if (qtyStr.includes("/")) {
    const [a, b] = qtyStr.split("/").map(Number);
    qty = a / b;
  } else {
    qty = Number(qtyStr);
  }
  const unit = (m[6] || "serving").trim() || "serving";
  return { qty: qty || 1, unit };
}

function round(n, d = 0) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

// ---- Init ------------------------------------------------------------------
async function init() {
  // Render useful empty states even when the API is unavailable.
  state.halls = Object.keys(HALL_THEMES);
  renderHallTabs();
  loadProfileAndBaseline(); // fire-and-forget; re-renders when ready
  renderPlate();
  renderOverview();
  try {
    const res = await fetch("/api/halls");
    if (!res.ok) throw new Error("Could not load dining halls");
    const data = await res.json();
    if (!Array.isArray(data.halls) || !data.halls.length) throw new Error("No dining halls available");
    state.halls = data.halls;
  } catch (err) {
    console.error(err);
  }
  // Do not override a hall the user picked while initialization was pending.
  if (!state.hall) await selectHall(state.halls[0], { skipWarn: true });
  else renderHallTabs();
}

// Load the user's saved preferences and compute how much of each goal metric
// has already been eaten today / this week from saved meals (the baseline that
// the current plate adds onto for per-day / per-week goals).
async function loadProfileAndBaseline() {
  loadExistingNames(); // fire-and-forget; re-renders when ready
  try {
    const pRes = await fetch("/api/profile");
    if (pRes.ok) {
      const p = await pRes.json();
      state.profile = {
        name: p.name || "",
        allergens: Array.isArray(p.allergens) ? p.allergens : [],
        avoid_foods: Array.isArray(p.avoid_foods) ? p.avoid_foods : [],
        goals: Array.isArray(p.goals) ? p.goals : [],
      };
    }
  } catch (err) { console.error(err); }

  // Baselines only matter if the user has day/week goals.
  const needsDay = state.profile.goals.some((g) => g.recurrence === "day");
  const needsWeek = state.profile.goals.some((g) => g.recurrence === "week");
  if (needsDay || needsWeek) {
    try {
      const today = new Date();
      const todayStr = isoDate(today);
      const weekAgo = new Date(today); weekAgo.setDate(today.getDate() - 6);
      const from = needsWeek ? isoDate(weekAgo) : todayStr;
      const res = await fetch(`/api/plates-between?from=${from}&to=${todayStr}`);
      if (res.ok) {
        const { plates } = await res.json();
        state.baseline = computeBaseline(plates || [], todayStr, isoDate(weekAgo));
      }
    } catch (err) { console.error(err); }
  }
  renderPlate();
  renderOverview();
}

function isoDate(d) {
  return d.toLocaleDateString("en-CA"); // YYYY-MM-DD local
}

// Load the names of meals already in the user's history so we can block saving
// a duplicate name.
async function loadExistingNames() {
  try {
    const res = await fetch("/api/plates");
    if (!res.ok) return;
    const { plates } = await res.json();
    if (!Array.isArray(plates)) return;
    const map = new Map();
    // Most-recent-first from the API; keep the first id seen for a given name.
    for (const p of plates) {
      const key = String(p.name || "").trim().toLowerCase();
      if (key && !map.has(key)) map.set(key, p.id);
    }
    state.existingNames = map;
    renderOverview();
  } catch (err) { console.error(err); }
}

// The name this meal would actually be saved under (same fallback as save).
function effectiveName() {
  return el.plateName.value.trim() || `${state.hall} meal`;
}

// True if the effective name collides with an existing saved meal.
function nameInUse() {
  return state.existingNames.has(effectiveName().toLowerCase());
}

// The id of the existing meal whose name collides, or null.
function conflictingPlateId() {
  return state.existingNames.get(effectiveName().toLowerCase()) ?? null;
}

// Sum each goal metric across saved plates for "today" and "this week".
function computeBaseline(plates, todayStr, weekStartStr) {
  const day = {}, week = {};
  for (const g of state.profile.goals) {
    if (g.recurrence === "day") day[g.metric] = 0;
    if (g.recurrence === "week") week[g.metric] = 0;
  }
  for (const p of plates) {
    const d = (p.menu_date || "").slice(0, 10);
    if (!d) continue;
    const rows = Nutrition.rowsFromPlate(p);
    const agg = Nutrition.aggregate(rows);
    for (const key of Object.keys(day)) {
      if (d === todayStr) day[key] += numFromAgg(agg, key);
    }
    for (const key of Object.keys(week)) {
      if (d >= weekStartStr && d <= todayStr) week[key] += numFromAgg(agg, key);
    }
  }
  return { day, week };
}

function numFromAgg(agg, metricKey) {
  const m = Nutrition.METRICS.find((x) => x.key === metricKey);
  return (m && Nutrition.metricNumber(m, agg)) || 0;
}

// Allergen + avoided-food analysis for the current plate rows.
function analyzeWarnings() {
  const perRow = {}; // uid -> { allergens: [], avoided: [] }
  const allAllergens = new Set();
  const allAvoided = new Set();
  for (const row of state.rows) {
    if (!row.item) continue;
    const a = Nutrition.matchedAllergens(row.item, state.profile.allergens);
    const v = Nutrition.matchedAvoided(row.item, state.profile.avoid_foods);
    if (a.length || v.length) perRow[row.uid] = { allergens: a, avoided: v };
    a.forEach((x) => allAllergens.add(x));
    v.forEach((x) => allAvoided.add(x));
  }
  return { perRow, allergens: [...allAllergens], avoided: [...allAvoided] };
}

function renderHallTabs() {
  el.hallTabs.innerHTML = "";
  for (const hall of state.halls) {
    const btn = document.createElement("button");
    btn.textContent = hall;
    btn.classList.toggle("active", hall === state.hall);
    btn.setAttribute("aria-pressed", String(hall === state.hall));
    btn.onclick = () => selectHall(hall);
    el.hallTabs.appendChild(btn);
  }
}

function plateIsEmpty() {
  return state.rows.length === 0 && !state.photo &&
    !el.plateName.value.trim();
}

async function selectHall(hall, { skipWarn = false, force = false, keepPlate = false } = {}) {
  if (hall === state.hall && !force) return;
  // Warn if switching halls would clear a non-empty plate.
  if (!skipWarn && !keepPlate && !plateIsEmpty()) {
    const ok = confirm(
      "Warning: switching dining halls will clear your current plate"
    );
    if (!ok) return;
  }
  if (!keepPlate) {
    ++plateLoadRequest;
    clearPlate();
  }
  const request = ++menuRequest;
  menuController?.abort();
  menuController = new AbortController();
  state.hall = hall;
  state.items = [];
  state.loading = true;
  if (!keepPlate) state.date = null;
  applyHallTheme(hall);
  el.plateName.placeholder = `e.g. Lunch at ${hall}`;
  setTrackerDate(keepPlate
    ? `Saved meal · ${formatDate(state.date) || "Date unavailable"}`
    : `${hall} · Loading menu…`);
  notice();
  closeAllDropdowns();
  renderHallTabs();
  renderPlate();
  renderOverview();
  try {
    const res = await fetch(`/api/menu/${encodeURIComponent(hall)}`, { signal: menuController.signal });
    if (!res.ok) throw new Error("Menu request failed");
    const data = await res.json();
    if (request !== menuRequest) return;
    state.items = Array.isArray(data.items) ? data.items : [];
    if (!keepPlate) {
      state.date = data.date;
      setTrackerDate(data.date ? `${hall} · ${formatDate(data.date)}` : hall);
    }
    if (!state.items.length) notice("No menu is available for this dining hall. Try another hall or reload to retry.");
    else if (data.date !== new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" })) {
      notice(`Showing the latest available menu (${data.date}). Today's menu is not available yet.`);
    }
  } catch (err) {
    if (request !== menuRequest) return;
    console.error(err);
    if (!keepPlate) setTrackerDate(`${hall} · Menu unavailable`);
    notice("We couldn't load the menu. Check your connection and reload to retry, or choose another hall.");
    state.items = [];
  } finally {
    if (request === menuRequest) {
      state.loading = false;
      renderPlate();
      renderOverview();
    }
  }
}

function clearPlate() {
  state.rows = [];
  state.photo = null;
  state.loadedPlateId = null;
  state.legacyTotals = null;
  el.plateName.value = "";
  el.actionStatus.textContent = "";
  setPhoto(null);
}

// ---- Photo -----------------------------------------------------------------
el.photoInput.onchange = () => {
  const file = el.photoInput.files[0];
  if (!file) return;
  if (!file.type.startsWith("image/") || file.size > 8 * 1024 * 1024) {
    el.actionStatus.textContent = "Choose an image smaller than 8 MB.";
    el.photoInput.value = "";
    return;
  }
  const request = ++photoRequest;
  const reader = new FileReader();
  reader.onload = () => {
    if (request !== photoRequest) return;
    setPhoto(reader.result);
    el.actionStatus.textContent = "Photo added. Select the foods below to calculate nutrition.";
  };
  reader.onerror = () => {
    if (request === photoRequest) el.actionStatus.textContent = "This photo couldn't be read. Please choose another image.";
  };
  reader.readAsDataURL(file);
};

el.removePhotoBtn.onclick = (e) => {
  e.preventDefault();
  setPhoto(null);
};
el.photoBox.onkeydown = (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); el.photoInput.click(); }
};

// Re-check the duplicate-name rule as the user types the meal name.
el.plateName.oninput = () => renderOverview();

// ---- Plate rows ------------------------------------------------------------
el.addFoodBtn.onclick = () => {
  if (state.loading || !state.items.length) return;
  plateChanged();
  state.rows.push({ uid: uidCounter++, item: null, servings: 1 });
  renderPlate();
  renderOverview();
};

function renderPlate() {
  el.addFoodBtn.disabled = state.loading || !state.items.length;
  el.emptyHelp.classList.toggle("hidden", state.rows.length > 0);

  const warnings = analyzeWarnings();
  renderPlateWarnings(warnings);

  el.plateItems.innerHTML = state.rows
    .map((row) => foodRowHtml(row, warnings.perRow[row.uid]))
    .join("");

  // Wire up each row
  state.rows.forEach((row) => {
    const node = el.plateItems.querySelector(`[data-uid="${row.uid}"]`);
    if (!node) return;

    const label = node.querySelector(".food-label");
    const dropdown = node.querySelector(".food-dropdown");
    const search = node.querySelector(".food-search");
    const options = node.querySelector(".food-options");

    label.onclick = () => {
      const open = !dropdown.classList.contains("hidden");
      closeAllDropdowns();
      if (!open) {
        dropdown.classList.remove("hidden");
        search.value = "";
        renderOptions(options, "", row);
        search.focus();
      }
    };
    search.oninput = () => renderOptions(options, search.value, row);
    search.onclick = (e) => e.stopPropagation();

    const portion = node.querySelector(".portion-input");
    if (portion) {
      portion.oninput = () => {
        plateChanged();
        const amount = parseFloat(portion.value);
        row.servings = Number.isFinite(amount) ? Math.max(0, amount) : 0;
        renderOverview();
      };
    }

    node.querySelector(".remove-food").onclick = () => {
      plateChanged();
      state.rows = state.rows.filter((r) => r.uid !== row.uid);
      renderPlate();
      renderOverview();
    };
  });
}

function foodRowHtml(row, warn) {
  const item = row.item;
  const foodLabel = item
    ? `<button type="button" class="food-label" title="${esc(item.dish_name)}">${esc(item.dish_name)}</button>`
    : `<button type="button" class="food-label placeholder">Select food…</button>`;

  let portion = "";
  if (item) {
    portion = `
      <input type="number" class="portion-input" min="0" step="0.25"
             value="${row.servings}" aria-label="Number of servings" />
      <span class="portion-unit">× ${esc(item.serving_size || "1 serving")}</span>`;
  } else {
    portion = `<span class="portion-unit">—</span>`;
  }

  // Allergen / avoided-food warning for this food.
  let warnText = "";
  const reasons = [];
  if (warn && warn.allergens.length) reasons.push(`contains ${warn.allergens.join(", ")} (allergy)`);
  if (warn && warn.avoided.length) reasons.push(`contains ${warn.avoided.join(", ")} (food you avoid)`);
  if (reasons.length) {
    warnText = `<p class="row-warn-text">⚠ This food ${reasons.join("; ")}.</p>`;
  }

  return `
    <div class="food-row${reasons.length ? " warn" : ""}" data-uid="${row.uid}">
      <span class="row-flag" aria-hidden="true">!</span>
      <div class="subchip food">
        ${foodLabel}<span class="caret">▾</span>
        <div class="food-dropdown hidden">
          <input class="food-search" type="search" placeholder="Search food…" />
          <div class="food-options"></div>
        </div>
      </div>
      <div class="subchip portion">${portion}</div>
      <button class="remove-food" aria-label="Remove food">×</button>
      ${warnText}
    </div>`;
}

function renderPlateWarnings(warnings) {
  const flagged = Object.keys(warnings.perRow).length;
  if (!flagged) {
    el.plateWarnings.classList.add("hidden");
    el.plateWarnings.innerHTML = "";
    return;
  }
  const parts = [];
  if (warnings.allergens.length) {
    parts.push(`<strong>Allergens on this plate:</strong> ${esc(warnings.allergens.join(", "))}.`);
  }
  if (warnings.avoided.length) {
    parts.push(`<strong>Foods you avoid:</strong> ${esc(warnings.avoided.join(", "))}.`);
  }
  const foodWord = flagged === 1 ? "food" : "foods";
  el.plateWarnings.innerHTML = `
    <span class="warn-mark" aria-hidden="true">!</span>
    <span class="warn-body">
      <span class="warn-title">Heads up — ${flagged} ${foodWord} flagged</span>
      <p class="warn-list">${parts.join("<br>")}</p>
    </span>`;
  el.plateWarnings.classList.remove("hidden");
}

function renderOptions(container, query, row) {
  const q = query.trim().toLowerCase();
  const matches = state.items
    .filter((it) => it.dish_name && it.dish_name.toLowerCase().includes(q))
    // de-duplicate dishes that appear in multiple meals
    .filter((it, i, arr) =>
      arr.findIndex((x) => x.dish_name === it.dish_name) === i
    )
    .slice(0, 50);

  if (!matches.length) {
    container.innerHTML =
      `<div class="food-none">${state.loading ? "Loading menu…" : `No matching food in the available ${esc(state.hall)} menu.`}</div>`;
    return;
  }

  container.innerHTML = matches
    .map((it) => {
      const cal = it.calories ? `${it.calories} cal` : "";
      return `<button type="button" class="food-option" data-id="${it.id}">
        ${esc(it.dish_name)}<span class="opt-meta">${esc(cal)}</span>
      </button>`;
    })
    .join("");

  container.querySelectorAll(".food-option").forEach((opt) => {
    opt.onclick = () => {
      const item = state.items.find((i) => i.id === Number(opt.dataset.id));
      plateChanged();
      row.item = item;
      row.servings = 1; // default to one serving on selection
      closeAllDropdowns();
      renderPlate();
      renderOverview();
    };
  });
}

function closeAllDropdowns() {
  document.querySelectorAll(".food-dropdown").forEach((d) => d.classList.add("hidden"));
}

document.addEventListener("click", (e) => {
  if (!e.target.closest(".subchip.food")) closeAllDropdowns();
});

// ---- Nutrition aggregation -------------------------------------------------
function aggregate() {
  const totals = {};
  for (const m of METRICS) totals[m.key] = { sum: 0, count: 0, missing: 0 };

  for (const row of state.rows) {
    if (!row.item) continue;
    const s = row.servings || 0;
    if (s <= 0) continue;
    for (const m of METRICS) {
      const raw = row.item[m.field];
      if (raw == null || String(raw).trim() === "" || (m.kind !== "carbon" && !/-?\d+(\.\d+)?/.test(String(raw)))) {
        totals[m.key].missing += 1;
        continue;
      }
      if (m.kind === "carbon") {
        const score = CARBON_SCORE[String(raw).trim().toUpperCase()];
        if (score) {
          totals[m.key].sum += score;
          totals[m.key].count += 1;
        } else totals[m.key].missing += 1;
      } else if (m.kind === "avg") {
        totals[m.key].sum += parseNum(raw);
        totals[m.key].count += 1;
      } else {
        totals[m.key].sum += parseNum(raw) * s;
        totals[m.key].count += 1;
      }
    }
  }
  return totals;
}

function metricDisplay(m, agg) {
  const t = agg[m.key];
  // Show "—" only when no food on the plate has this value at all.
  if (!t.count) return "—";
  // Partial coverage: some foods have the value, others don't. Show what we
  // know, prefixed with "~" so the number reads as an estimate, not a total.
  const partial = t.missing > 0 ? "~" : "";
  if (m.kind === "carbon") {
    const avg = t.sum / t.count;
    return partial + (CARBON_LETTER[Math.round(avg)] || round(avg, 1));
  }
  if (m.kind === "avg") {
    return partial + round(t.sum / t.count, 0);
  }
  return `${partial}${round(t.sum, m.unit === "g" || m.unit === "mg" ? 1 : 0)}${m.unit}`;
}

// True if any visible metric is only partially covered by the plate's foods.
function hasPartialMetric(agg) {
  return METRICS.some(
    (m) => state.visible.includes(m.key) && agg[m.key].count > 0 && agg[m.key].missing > 0
  );
}

function renderOverview() {
  const chosen = state.rows.filter((r) => r.item && r.servings > 0);
  const duplicateName = chosen.length && nameInUse();
  el.saveBtn.disabled = !chosen.length || state.saving || duplicateName;
  const agg = aggregate();
  el.nutritionNote.classList.toggle("note-error", !!duplicateName);
  if (duplicateName) {
    // Rendered as HTML so we can include an "edit it" link to the conflict.
    const id = conflictingPlateId();
    const link = id != null
      ? ` <a class="note-link" href="edit.html?id=${encodeURIComponent(id)}">Edit it</a>`
      : "";
    el.nutritionNote.innerHTML = `A meal with this name already exists in your history.${link}`;
  } else {
    let note;
    if (state.legacyTotals) {
      note = "Saved totals from an older meal. Per-food nutrition was not recorded; editing may make totals unavailable.";
    } else if (!chosen.length) {
      note = "Add foods to see your meal's nutrition.";
    } else if (hasPartialMetric(agg)) {
      note = "Based on the portions you enter. ~ means some foods are missing that value, so the total is a partial estimate; — means no food has it.";
    } else {
      note = "Based on the portions you enter. — means nutrition data is unavailable.";
    }
    el.nutritionNote.textContent = note;
  }
  const visible = METRICS.filter((m) => state.visible.includes(m.key));
  if (!visible.length) {
    el.overview.innerHTML =
      `<p class="overview-empty">No metrics selected. Use Customize to choose some.</p>`;
    return;
  }
  el.overview.innerHTML = visible
    .map((m) => `
      <div class="metric-card">
        <div class="metric-value">${esc(state.legacyTotals?.[m.key] ?? metricDisplay(m, agg))}</div>
        <div class="metric-label">${esc(m.label)}</div>
      </div>`)
    .join("");

  renderGoals(agg);
}

// Render a progress bar for each saved goal. For per-day / per-week goals the
// current plate is added on top of what's already been eaten in that window.
function renderGoals(agg) {
  const goals = state.profile.goals || [];
  if (!goals.length) { el.goalProgress.innerHTML = ""; return; }

  el.goalProgress.innerHTML = goals.map((g) => {
    const m = METRICS.find((x) => x.key === g.metric);
    if (!m) return "";
    const unit = (m.unit || "").trim();
    // Current plate's contribution to this metric.
    const t = agg[g.metric];
    const plateVal = t && t.count ? round(t.sum, 1) : 0;
    const baseline =
      g.recurrence === "day" ? (state.baseline.day[g.metric] || 0)
      : g.recurrence === "week" ? (state.baseline.week[g.metric] || 0)
      : 0;
    const consumed = round(baseline + plateVal, 1);
    const target = g.target || 0;
    const type = g.type === "max" ? "max" : "min";
    const pct = target > 0 ? Math.min(100, (consumed / target) * 100) : 0;
    const ratio = target > 0 ? consumed / target : 0;

    // Behavior differs by goal type:
    // - "at most": staying under is good -> green while under, amber as you
    //   approach the cap, red once exceeded.
    // - "at least": reaching it is good -> fills green, marked met at/over 100%,
    //   never red (exceeding a minimum is fine).
    let fillCls, itemCls;
    if (type === "max") {
      fillCls = ratio > 1 ? "over" : ratio >= 0.85 ? "near" : "";
      itemCls = ratio > 1 ? "over" : "";
    } else {
      fillCls = ""; // green fill as it grows
      itemCls = ratio >= 1 ? "met" : "";
    }

    const recLabel = Nutrition.RECURRENCE_LABEL[g.recurrence] || g.recurrence;
    const typeLabel = type === "max" ? "at most" : "at least";
    const u = unit ? " " + unit : "";
    return `
      <div class="goal-item ${itemCls}">
        <div class="goal-top">
          <span class="goal-name">${esc(m.label)}<span class="goal-rec">${esc(recLabel)} · ${esc(typeLabel)}</span></span>
          <span class="goal-val">${consumed}${u} / ${target}${u}</span>
        </div>
        <div class="goal-bar"><div class="goal-fill ${fillCls}" style="width:${pct}%"></div></div>
      </div>`;
  }).join("");
}

// ---- Metrics chooser -------------------------------------------------------
el.metricsBtn.onclick = () => {
  el.metricsList.innerHTML = METRICS.map((m) => `
    <label>
      <input type="checkbox" data-key="${m.key}" ${
        state.visible.includes(m.key) ? "checked" : ""
      } />
      ${esc(m.label)}
    </label>`).join("");
  el.metricsList.querySelectorAll("input").forEach((input) => {
    input.onchange = () => {
      const key = input.dataset.key;
      if (input.checked) {
        if (!state.visible.includes(key)) state.visible.push(key);
      } else {
        state.visible = state.visible.filter((k) => k !== key);
      }
      saveVisible();
      renderOverview();
    };
  });
  openModal(el.metricsModal, el.metricsClose);
};
el.metricsClose.onclick = () => closeModal(el.metricsModal);

// ---- Save / Load -----------------------------------------------------------
el.saveBtn.onclick = async () => {
  if (state.saving) return;
  const chosen = state.rows.filter((r) => r.item && r.servings > 0);
  if (!chosen.length) {
    el.actionStatus.textContent = "Add a food with a portion greater than zero before saving.";
    return;
  }
  if (nameInUse()) {
    el.actionStatus.textContent = "A meal with this name already exists in your history";
    return;
  }
  const name = effectiveName();
  const agg = aggregate();
  const totals = {};
  for (const m of METRICS) totals[m.key] = state.legacyTotals?.[m.key] ?? metricDisplay(m, agg);
  const payload = {
    name,
    dining_hall: state.hall,
    menu_date: state.date,
    image: state.photo,
    items: chosen.map((r) => ({
      id: r.item.id,
      dish_name: r.item.dish_name,
      serving_size: r.item.serving_size,
      servings: r.servings,
      // Immutable per-serving values; a later menu refresh must not rewrite history.
      nutrition: r.item.nutritionUnavailable ? null : Object.fromEntries(
        METRICS.map((m) => [m.field, r.item[m.field] ?? null])
      ),
    })),
    totals,
  };
  const request = menuRequest;
  state.saving = true;
  renderOverview();
  el.saveBtn.textContent = "Saving…";
  try {
    const res = await fetch("/api/plates", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error("Save failed");
    const saved = await res.json();
    // Remember the saved name -> id so the same name can't be saved again.
    state.existingNames.set(String(saved.name || name).trim().toLowerCase(), saved.id);
    if (request === menuRequest) {
      state.loadedPlateId = saved.id;
      el.actionStatus.textContent = "Meal saved. Find it in your meal history.";
    }
  } catch (err) {
    console.error(err);
    if (request === menuRequest) el.actionStatus.textContent = "Your meal couldn't be saved. Please try again.";
  } finally {
    state.saving = false;
    el.saveBtn.textContent = "Save meal";
    renderOverview();
  }
};

// "Meal history" now opens the dedicated history page (which routes editing
// through the date-preserving edit page). The old in-tracker load modal is kept
// below but no longer wired to a button.
el.loadBtn.onclick = () => { location.href = "history.html"; };

// Keep keyboard focus inside dialogs and return it to the opening control.
let modalOpener = null;
function openModal(modal, firstControl) {
  modalOpener = document.activeElement;
  modal.classList.remove("hidden");
  firstControl.focus();
}
function closeModal(modal) {
  modal.classList.add("hidden");
  modalOpener?.focus();
}

// Close modals on backdrop click / Escape
el.metricsModal.onclick = (e) => { if (e.target === el.metricsModal) closeModal(el.metricsModal); };
document.addEventListener("keydown", (e) => {
  const modal = el.metricsModal.classList.contains("hidden") ? null : el.metricsModal;
  if (e.key === "Tab" && modal) {
    const controls = [...modal.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex="0"]')];
    const first = controls[0], last = controls[controls.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  if (e.key === "Escape") {
    closeAllDropdowns();
    if (!el.metricsModal.classList.contains("hidden")) closeModal(el.metricsModal);
  }
});

const initPromise = init();
