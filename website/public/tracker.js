// ---- Metric definitions ----------------------------------------------------
// Each metric knows how to pull a value from a menu item and how it aggregates.
// kind "sum": additive nutrient scaled by servings; "avg": averaged score.
const METRICS = [
  { key: "calories",      label: "Calories",     field: "calories",       unit: "",    kind: "sum" },
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
};

let uidCounter = 1;

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
  loadModal: document.getElementById("loadModal"),
  loadClose: document.getElementById("loadClose"),
  loadList: document.getElementById("loadList"),
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
    if (Array.isArray(saved) && saved.length) return saved;
  } catch {}
  return [...DEFAULT_VISIBLE];
}

function saveVisible() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.visible));
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
  const res = await fetch("/api/halls");
  state.halls = (await res.json()).halls;
  renderHallTabs();
  await selectHall(state.halls[0], { skipWarn: true });
  renderPlate();
  renderOverview();
}

function renderHallTabs() {
  el.hallTabs.innerHTML = "";
  for (const hall of state.halls) {
    const btn = document.createElement("button");
    btn.textContent = hall;
    btn.classList.toggle("active", hall === state.hall);
    btn.onclick = () => selectHall(hall);
    el.hallTabs.appendChild(btn);
  }
}

function plateIsEmpty() {
  return state.rows.length === 0 && !state.photo &&
    el.plateName.value.trim() === "Unnamed Plate";
}

async function selectHall(hall, { skipWarn = false } = {}) {
  if (hall === state.hall) return;
  // Warn if switching halls would clear a non-empty plate.
  if (!skipWarn && !plateIsEmpty()) {
    const ok = confirm(
      "Warning: switching dining halls will clear your current plate"
    );
    if (!ok) return;
    clearPlate();
  }
  state.hall = hall;
  renderHallTabs();
  try {
    const res = await fetch(`/api/menu/${encodeURIComponent(hall)}`);
    const data = await res.json();
    state.items = data.items || [];
    state.date = data.date;
    el.trackerDate.textContent = data.date
      ? `${hall} · ${new Date(data.date + "T00:00:00").toLocaleDateString(undefined, {
          weekday: "long", month: "long", day: "numeric",
        })}`
      : hall;
  } catch (err) {
    console.error(err);
    el.trackerDate.textContent = `${hall} · failed to load menu`;
    state.items = [];
  }
  // Re-render any open food dropdowns against the new hall's items.
  renderPlate();
  renderOverview();
}

function clearPlate() {
  state.rows = [];
  state.photo = null;
  state.loadedPlateId = null;
  el.plateName.value = "Unnamed Plate";
  el.photoPreview.src = "";
  el.photoPreview.classList.add("hidden");
  el.photoPlaceholder.classList.remove("hidden");
  el.removePhotoBtn.classList.add("hidden");
}

// ---- Photo -----------------------------------------------------------------
el.photoInput.onchange = () => {
  const file = el.photoInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    state.photo = reader.result;
    el.photoPreview.src = reader.result;
    el.photoPreview.classList.remove("hidden");
    el.photoPlaceholder.classList.add("hidden");
    el.removePhotoBtn.classList.remove("hidden");
  };
  reader.readAsDataURL(file);
};

el.removePhotoBtn.onclick = (e) => {
  e.preventDefault();
  state.photo = null;
  el.photoInput.value = "";
  el.photoPreview.src = "";
  el.photoPreview.classList.add("hidden");
  el.photoPlaceholder.classList.remove("hidden");
  el.removePhotoBtn.classList.add("hidden");
};

// ---- Plate rows ------------------------------------------------------------
el.addFoodBtn.onclick = () => {
  state.rows.push({ uid: uidCounter++, item: null, servings: 1 });
  renderPlate();
  renderOverview();
};

function renderPlate() {
  el.emptyHelp.classList.toggle("hidden", state.rows.length > 0);

  el.plateItems.innerHTML = state.rows
    .map((row) => foodRowHtml(row))
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
        row.servings = Math.max(0, parseFloat(portion.value) || 0);
        renderOverview();
      };
    }

    node.querySelector(".remove-food").onclick = () => {
      state.rows = state.rows.filter((r) => r.uid !== row.uid);
      renderPlate();
      renderOverview();
    };
  });
}

function foodRowHtml(row) {
  const item = row.item;
  const foodLabel = item
    ? `<span class="food-label" title="${esc(item.dish_name)}">${esc(item.dish_name)}</span>`
    : `<span class="food-label placeholder">Select food…</span>`;

  let portion = "";
  if (item) {
    const { unit } = parseServing(item.serving_size);
    portion = `
      <input type="number" class="portion-input" min="0" step="0.25"
             value="${row.servings}" aria-label="Number of servings" />
      <span class="portion-unit">× ${esc(item.serving_size || "1 serving")}</span>`;
  } else {
    portion = `<span class="portion-unit">—</span>`;
  }

  return `
    <div class="food-row" data-uid="${row.uid}">
      <div class="subchip food">
        ${foodLabel}<span class="caret">▾</span>
        <div class="food-dropdown hidden">
          <input class="food-search" type="search" placeholder="Search food…" />
          <div class="food-options"></div>
        </div>
      </div>
      <div class="subchip portion">${portion}</div>
      <button class="remove-food" aria-label="Remove food">×</button>
    </div>`;
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
      `<div class="food-none">no food found in ${esc(state.hall)} for today</div>`;
    return;
  }

  container.innerHTML = matches
    .map((it) => {
      const cal = it.calories ? `${it.calories} cal` : "";
      return `<div class="food-option" data-id="${it.id}">
        ${esc(it.dish_name)}<span class="opt-meta">${esc(cal)}</span>
      </div>`;
    })
    .join("");

  container.querySelectorAll(".food-option").forEach((opt) => {
    opt.onclick = () => {
      const item = state.items.find((i) => i.id === Number(opt.dataset.id));
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
  for (const m of METRICS) totals[m.key] = { sum: 0, count: 0 };

  for (const row of state.rows) {
    if (!row.item) continue;
    const s = row.servings || 0;
    for (const m of METRICS) {
      const raw = row.item[m.field];
      if (raw == null || raw === "") continue;
      if (m.kind === "carbon") {
        const score = CARBON_SCORE[String(raw).trim().toUpperCase()];
        if (score) {
          totals[m.key].sum += score;
          totals[m.key].count += 1;
        }
      } else if (m.kind === "avg") {
        totals[m.key].sum += parseNum(raw);
        totals[m.key].count += 1;
      } else {
        totals[m.key].sum += parseNum(raw) * s;
      }
    }
  }
  return totals;
}

function metricDisplay(m, agg) {
  const t = agg[m.key];
  if (m.kind === "carbon") {
    if (!t.count) return "—";
    const avg = t.sum / t.count;
    return CARBON_LETTER[Math.round(avg)] || round(avg, 1);
  }
  if (m.kind === "avg") {
    return t.count ? round(t.sum / t.count, 0) : "—";
  }
  return `${round(t.sum, m.unit === "g" || m.unit === "mg" ? 1 : 0)}${m.unit}`;
}

function renderOverview() {
  const agg = aggregate();
  const visible = METRICS.filter((m) => state.visible.includes(m.key));
  if (!visible.length) {
    el.overview.innerHTML =
      `<p class="overview-empty">No metrics selected. Use “Choose metrics”.</p>`;
    return;
  }
  el.overview.innerHTML = visible
    .map((m) => `
      <div class="metric-card">
        <div class="metric-value">${metricDisplay(m, agg)}</div>
        <div class="metric-label">${esc(m.label)}</div>
      </div>`)
    .join("");
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
  el.metricsModal.classList.remove("hidden");
};
el.metricsClose.onclick = () => el.metricsModal.classList.add("hidden");

// ---- Save / Load -----------------------------------------------------------
el.saveBtn.onclick = async () => {
  const chosen = state.rows.filter((r) => r.item);
  if (!chosen.length) {
    alert("Add at least one food before saving.");
    return;
  }
  const agg = aggregate();
  const totals = {};
  for (const m of METRICS) totals[m.key] = metricDisplay(m, agg);

  const payload = {
    name: el.plateName.value.trim() || "Unnamed Plate",
    dining_hall: state.hall,
    menu_date: state.date,
    image: state.photo,
    items: chosen.map((r) => ({
      id: r.item.id,
      dish_name: r.item.dish_name,
      serving_size: r.item.serving_size,
      servings: r.servings,
    })),
    totals,
  };

  el.saveBtn.disabled = true;
  el.saveBtn.textContent = "Saving…";
  try {
    const res = await fetch("/api/plates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error("save failed");
    const saved = await res.json();
    state.loadedPlateId = saved.id;
    el.saveBtn.textContent = "Saved ✓";
    setTimeout(() => (el.saveBtn.textContent = "Save"), 1500);
  } catch (err) {
    console.error(err);
    alert("Could not save plate.");
    el.saveBtn.textContent = "Save";
  } finally {
    el.saveBtn.disabled = false;
  }
};

el.loadBtn.onclick = async () => {
  el.loadList.innerHTML = `<p class="load-empty">Loading…</p>`;
  el.loadModal.classList.remove("hidden");
  try {
    const res = await fetch("/api/plates");
    const { plates } = await res.json();
    if (!plates.length) {
      el.loadList.innerHTML = `<p class="load-empty">No saved plates yet.</p>`;
      return;
    }
    el.loadList.innerHTML = plates
      .map((p) => `
        <div class="load-item" data-id="${p.id}">
          <div class="load-thumb"></div>
          <div class="load-info">
            <div class="ln">${esc(p.name)}</div>
            <div class="lm">${esc(p.dining_hall || "")} · ${esc(
              (p.menu_date || "").slice(0, 10)
            )} · ${p.items.length} items</div>
          </div>
        </div>`)
      .join("");
    el.loadList.querySelectorAll(".load-item").forEach((node) => {
      node.onclick = () => loadPlate(Number(node.dataset.id));
    });
  } catch (err) {
    console.error(err);
    el.loadList.innerHTML = `<p class="load-empty">Failed to load plates.</p>`;
  }
};
el.loadClose.onclick = () => el.loadModal.classList.add("hidden");

async function loadPlate(id) {
  try {
    const res = await fetch(`/api/plates/${id}`);
    if (!res.ok) throw new Error("not found");
    const plate = await res.json();

    // Switch to the plate's hall so food lookups resolve against that menu.
    if (plate.dining_hall && plate.dining_hall !== state.hall) {
      state.hall = plate.dining_hall;
      renderHallTabs();
      const mRes = await fetch(`/api/menu/${encodeURIComponent(plate.dining_hall)}`);
      const data = await mRes.json();
      state.items = data.items || [];
      state.date = data.date;
      el.trackerDate.textContent = `${plate.dining_hall} · ${(plate.menu_date || "").slice(0, 10)}`;
    }

    el.plateName.value = plate.name || "Unnamed Plate";

    // Photo
    if (plate.image) {
      state.photo = plate.image;
      el.photoPreview.src = plate.image;
      el.photoPreview.classList.remove("hidden");
      el.photoPlaceholder.classList.add("hidden");
      el.removePhotoBtn.classList.remove("hidden");
    } else {
      state.photo = null;
      el.photoPreview.classList.add("hidden");
      el.photoPlaceholder.classList.remove("hidden");
      el.removePhotoBtn.classList.add("hidden");
    }

    // Rebuild rows, re-linking to today's menu item by id or name so
    // nutrition still aggregates. Fall back to the stored snapshot.
    state.rows = plate.items.map((saved) => {
      const live =
        state.items.find((i) => i.id === saved.id) ||
        state.items.find((i) => i.dish_name === saved.dish_name);
      return {
        uid: uidCounter++,
        item: live || {
          id: saved.id,
          dish_name: saved.dish_name,
          serving_size: saved.serving_size,
        },
        servings: saved.servings ?? 1,
      };
    });
    state.loadedPlateId = plate.id;

    el.loadModal.classList.add("hidden");
    renderPlate();
    renderOverview();
  } catch (err) {
    console.error(err);
    alert("Could not load plate.");
  }
}

// Close modals on backdrop click / Escape
[el.metricsModal, el.loadModal].forEach((m) => {
  m.onclick = (e) => { if (e.target === m) m.classList.add("hidden"); };
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    el.metricsModal.classList.add("hidden");
    el.loadModal.classList.add("hidden");
  }
});

init();
