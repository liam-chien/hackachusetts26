const { METRICS, aggregate, metricDisplay, rowsFromPlate } = Nutrition;
const DEFAULT_VISIBLE = ["calories", "protein", "total_carb", "total_fat", "healthfulness", "carbon"];
const STORAGE_KEY = "tracker_visible_metrics";

const params = new URLSearchParams(location.search);
const plateId = Number(params.get("id"));

const state = {
  plate: null,
  menuItems: [],      // today's menu for the plate's hall (for the food dropdown)
  rows: [],           // [{ uid, item, servings }]
  photo: null,
  visible: loadVisible(),
  legacyTotals: null, // when a food lacks a nutrition snapshot
  saving: false,
};
let uidCounter = 1;

const el = {
  editTitle: document.getElementById("editTitle"),
  editDate: document.getElementById("editDate"),
  editNotice: document.getElementById("editNotice"),
  editLayout: document.getElementById("editLayout"),
  photoBox: document.getElementById("photoBox"),
  photoInput: document.getElementById("photoInput"),
  photoPlaceholder: document.getElementById("photoPlaceholder"),
  photoPreview: document.getElementById("photoPreview"),
  removePhotoBtn: document.getElementById("removePhotoBtn"),
  plateName: document.getElementById("plateName"),
  addFoodBtn: document.getElementById("addFoodBtn"),
  emptyHelp: document.getElementById("emptyHelp"),
  plateItems: document.getElementById("plateItems"),
  editHallNote: document.getElementById("editHallNote"),
  overview: document.getElementById("overview"),
  nutritionNote: document.getElementById("nutritionNote"),
  metricsBtn: document.getElementById("metricsBtn"),
  saveBtn: document.getElementById("saveBtn"),
  cancelBtn: document.getElementById("cancelBtn"),
  deleteBtn: document.getElementById("deleteBtn"),
  actionStatus: document.getElementById("actionStatus"),
  metricsModal: document.getElementById("metricsModal"),
  metricsClose: document.getElementById("metricsClose"),
  metricsList: document.getElementById("metricsList"),
};

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function loadVisible() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (Array.isArray(saved)) return saved.filter((k) => METRICS.some((m) => m.key === k));
  } catch {}
  return [...DEFAULT_VISIBLE];
}
function saveVisible() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.visible)); } catch {} }

function notice(msg = "") {
  el.editNotice.textContent = msg;
  el.editNotice.classList.toggle("hidden", !msg);
}
function fmtLong(dateStr) {
  const d = dateStr ? new Date(dateStr + "T12:00:00") : null;
  return d && !isNaN(d) ? d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" }) : "Unknown date";
}

// ---- Init ------------------------------------------------------------------
async function init() {
  if (!plateId) {
    el.editDate.textContent = "";
    notice("No meal selected. Go back to your meal history and pick a meal to edit.");
    return;
  }
  try {
    const res = await fetch(`/api/plates/${plateId}`);
    if (!res.ok) throw new Error("Meal not found");
    state.plate = await res.json();
  } catch (err) {
    console.error(err);
    el.editDate.textContent = "";
    notice("This meal couldn't be loaded. It may have been deleted.");
    return;
  }

  const p = state.plate;
  el.editTitle.textContent = "Edit meal";
  el.editDate.textContent = `${p.dining_hall || "Meal"} · ${fmtLong(p.menu_date)}`;
  el.plateName.value = p.name || "";
  setPhoto(p.image || null);

  // Rebuild rows from the saved snapshot (immutable per-serving values).
  state.rows = (p.items || []).map((saved) => {
    const hasSnapshot = saved.nutrition && typeof saved.nutrition === "object";
    const item = { id: saved.id, dish_name: saved.dish_name, serving_size: saved.serving_size, nutritionUnavailable: !hasSnapshot };
    for (const m of METRICS) item[m.field] = hasSnapshot ? (saved.nutrition[m.field] ?? null) : null;
    return { uid: uidCounter++, item, servings: Number.isFinite(saved.servings) ? Math.max(0, saved.servings) : 1 };
  });
  state.legacyTotals = state.rows.some((r) => r.item.nutritionUnavailable) ? p.totals : null;

  el.editLayout.hidden = false;
  renderPlate();
  renderOverview();

  // Load the hall's current menu so "Add food" / changing a food works.
  // Editing is still possible without it (existing foods keep their snapshot).
  loadHallMenu(p.dining_hall);
}

async function loadHallMenu(hall) {
  if (!hall) { el.editHallNote.textContent = ""; renderPlate(); return; }
  try {
    const res = await fetch(`/api/menu/${encodeURIComponent(hall)}`);
    if (!res.ok) throw new Error("menu");
    const data = await res.json();
    state.menuItems = Array.isArray(data.items) ? data.items : [];
    el.editHallNote.textContent = state.menuItems.length
      ? `Add food pulls from today's ${hall} menu.`
      : `Today's ${hall} menu isn't available, so you can adjust portions and remove foods, but can't add new ones.`;
  } catch {
    state.menuItems = [];
    el.editHallNote.textContent = `Couldn't load the ${hall} menu; you can still adjust portions and remove foods.`;
  }
  renderPlate();
}

// ---- Photo -----------------------------------------------------------------
function setPhoto(photo) {
  state.photo = photo || null;
  el.photoInput.value = "";
  if (photo) el.photoPreview.src = photo; else el.photoPreview.removeAttribute("src");
  el.photoPreview.classList.toggle("hidden", !photo);
  el.photoPlaceholder.classList.toggle("hidden", !!photo);
  el.removePhotoBtn.classList.toggle("hidden", !photo);
}
el.photoInput.onchange = () => {
  const file = el.photoInput.files[0];
  if (!file) return;
  if (!file.type.startsWith("image/") || file.size > 8 * 1024 * 1024) {
    el.actionStatus.textContent = "Choose an image smaller than 8 MB.";
    el.photoInput.value = ""; return;
  }
  const reader = new FileReader();
  reader.onload = () => setPhoto(reader.result);
  reader.readAsDataURL(file);
};
el.removePhotoBtn.onclick = (e) => { e.preventDefault(); setPhoto(null); };
el.photoBox.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); el.photoInput.click(); } };

// ---- Rows ------------------------------------------------------------------
el.addFoodBtn.onclick = () => {
  if (!state.menuItems.length) return;
  state.legacyTotals = null;
  state.rows.push({ uid: uidCounter++, item: null, servings: 1 });
  renderPlate();
  renderOverview();
};

function renderPlate() {
  el.addFoodBtn.disabled = !state.menuItems.length;
  el.emptyHelp.classList.toggle("hidden", state.rows.length > 0);
  el.plateItems.innerHTML = state.rows.map((row) => foodRowHtml(row)).join("");

  state.rows.forEach((row) => {
    const node = el.plateItems.querySelector(`[data-uid="${row.uid}"]`);
    if (!node) return;
    const label = node.querySelector(".food-label");
    const dropdown = node.querySelector(".food-dropdown");
    const search = node.querySelector(".food-search");
    const options = node.querySelector(".food-options");

    if (label && dropdown) {
      label.onclick = () => {
        if (!state.menuItems.length) return;
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
    }
    const portion = node.querySelector(".portion-input");
    if (portion) {
      portion.oninput = () => {
        state.legacyTotals = null;
        const amount = parseFloat(portion.value);
        row.servings = Number.isFinite(amount) ? Math.max(0, amount) : 0;
        renderOverview();
      };
    }
    node.querySelector(".remove-food").onclick = () => {
      state.legacyTotals = null;
      state.rows = state.rows.filter((r) => r.uid !== row.uid);
      renderPlate();
      renderOverview();
    };
  });
}

function foodRowHtml(row) {
  const item = row.item;
  const canEditFood = state.menuItems.length > 0;
  const foodLabel = item
    ? `<button type="button" class="food-label" title="${esc(item.dish_name)}"${canEditFood ? "" : " disabled"}>${esc(item.dish_name)}</button>`
    : `<button type="button" class="food-label placeholder">Select food…</button>`;
  let portion;
  if (item) {
    portion = `
      <input type="number" class="portion-input" min="0" step="0.25" value="${row.servings}" aria-label="Number of servings" />
      <span class="portion-unit">× ${esc(item.serving_size || "1 serving")}</span>`;
  } else {
    portion = `<span class="portion-unit">—</span>`;
  }
  return `
    <div class="food-row" data-uid="${row.uid}">
      <div class="subchip food">
        ${foodLabel}${canEditFood ? '<span class="caret">▾</span>' : ""}
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
  const matches = state.menuItems
    .filter((it) => it.dish_name && it.dish_name.toLowerCase().includes(q))
    .filter((it, i, arr) => arr.findIndex((x) => x.dish_name === it.dish_name) === i)
    .slice(0, 50);
  if (!matches.length) {
    container.innerHTML = `<div class="food-none">No matching food in the available ${esc(state.plate.dining_hall)} menu.</div>`;
    return;
  }
  container.innerHTML = matches.map((it) => {
    const cal = it.calories ? `${it.calories} cal` : "";
    return `<button type="button" class="food-option" data-id="${it.id}">${esc(it.dish_name)}<span class="opt-meta">${esc(cal)}</span></button>`;
  }).join("");
  container.querySelectorAll(".food-option").forEach((opt) => {
    opt.onclick = () => {
      const menuItem = state.menuItems.find((i) => i.id === Number(opt.dataset.id));
      state.legacyTotals = null;
      // Snapshot the chosen food's current nutrition.
      const item = { id: menuItem.id, dish_name: menuItem.dish_name, serving_size: menuItem.serving_size, nutritionUnavailable: false };
      for (const m of METRICS) item[m.field] = menuItem[m.field] ?? null;
      row.item = item;
      row.servings = 1;
      closeAllDropdowns();
      renderPlate();
      renderOverview();
    };
  });
}

function closeAllDropdowns() {
  document.querySelectorAll(".food-dropdown").forEach((d) => d.classList.add("hidden"));
}
document.addEventListener("click", (e) => { if (!e.target.closest(".subchip.food")) closeAllDropdowns(); });

// ---- Overview --------------------------------------------------------------
function hasPartial(agg) {
  return METRICS.some((m) => state.visible.includes(m.key) && agg[m.key].count > 0 && agg[m.key].missing > 0);
}
function renderOverview() {
  const chosen = state.rows.filter((r) => r.item && r.servings > 0);
  el.saveBtn.disabled = state.saving;
  const agg = aggregate(state.rows.map((r) => ({ item: r.item, servings: r.servings })));
  let note;
  if (state.legacyTotals) note = "Showing saved totals. Per-food nutrition wasn't recorded for this meal; editing foods or portions will recalculate from available data.";
  else if (!chosen.length) note = "Add a food to see this meal's nutrition.";
  else if (hasPartial(agg)) note = "~ means some foods are missing that value (partial estimate); — means none have it.";
  else note = "Totals reflect the foods and portions above.";
  el.nutritionNote.textContent = note;

  const visible = METRICS.filter((m) => state.visible.includes(m.key));
  if (!visible.length) { el.overview.innerHTML = `<p class="overview-empty">No metrics selected. Use Customize.</p>`; return; }
  el.overview.innerHTML = visible.map((m) => `
    <div class="metric-card">
      <div class="metric-value">${esc(state.legacyTotals?.[m.key] ?? metricDisplay(m, agg))}</div>
      <div class="metric-label">${esc(m.label)}</div>
    </div>`).join("");
}

// ---- Metrics chooser -------------------------------------------------------
el.metricsBtn.onclick = () => {
  el.metricsList.innerHTML = METRICS.map((m) => `
    <label><input type="checkbox" data-key="${m.key}" ${state.visible.includes(m.key) ? "checked" : ""} /> ${esc(m.label)}</label>`).join("");
  el.metricsList.querySelectorAll("input").forEach((input) => {
    input.onchange = () => {
      const key = input.dataset.key;
      if (input.checked) { if (!state.visible.includes(key)) state.visible.push(key); }
      else state.visible = state.visible.filter((k) => k !== key);
      saveVisible();
      renderOverview();
    };
  });
  el.metricsModal.classList.remove("hidden");
  el.metricsClose.focus();
};
el.metricsClose.onclick = () => el.metricsModal.classList.add("hidden");
el.metricsModal.onclick = (e) => { if (e.target === el.metricsModal) el.metricsModal.classList.add("hidden"); };

// ---- Save / Cancel / Delete ------------------------------------------------
el.saveBtn.onclick = async () => {
  if (state.saving) return;
  const chosen = state.rows.filter((r) => r.item && r.servings > 0);
  if (!chosen.length) { el.actionStatus.textContent = "Add at least one food with a portion greater than zero."; return; }

  const agg = aggregate(state.rows.map((r) => ({ item: r.item, servings: r.servings })));
  const totals = {};
  for (const m of METRICS) totals[m.key] = state.legacyTotals?.[m.key] ?? metricDisplay(m, agg);

  // Note: no menu_date / created_at sent — the server preserves the original.
  const payload = {
    name: el.plateName.value.trim() || `${state.plate.dining_hall || ""} meal`.trim(),
    dining_hall: state.plate.dining_hall,
    image: state.photo,
    items: chosen.map((r) => ({
      id: r.item.id,
      dish_name: r.item.dish_name,
      serving_size: r.item.serving_size,
      servings: r.servings,
      nutrition: r.item.nutritionUnavailable ? null : Object.fromEntries(METRICS.map((m) => [m.field, r.item[m.field] ?? null])),
    })),
    totals,
  };

  state.saving = true;
  el.saveBtn.textContent = "Saving…";
  renderOverview();
  try {
    const res = await fetch(`/api/plates/${plateId}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error("Update failed");
    el.actionStatus.textContent = "Changes saved. Returning to your history…";
    setTimeout(() => { location.href = "history.html"; }, 700);
  } catch (err) {
    console.error(err);
    el.actionStatus.textContent = "Your changes couldn't be saved. Please try again.";
    state.saving = false;
    el.saveBtn.textContent = "Save changes";
    renderOverview();
  }
};

el.cancelBtn.onclick = () => { location.href = "history.html"; };

el.deleteBtn.onclick = async () => {
  if (!confirm("Delete this meal? This can't be undone.")) return;
  el.deleteBtn.disabled = true;
  try {
    const res = await fetch(`/api/plates/${plateId}`, { method: "DELETE" });
    if (!res.ok) throw new Error("Delete failed");
    location.href = "history.html";
  } catch (err) {
    console.error(err);
    el.actionStatus.textContent = "Couldn't delete this meal. Please try again.";
    el.deleteBtn.disabled = false;
  }
};

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeAllDropdowns(); el.metricsModal.classList.add("hidden"); }
});

init();
