const MEAL_ORDER = ["Breakfast", "Lunch", "Dinner", "Late Night"];
let menuRequest = 0;
let menuController;

const state = {
  halls: [],
  hall: null,
  meal: null,
  items: [],
  date: null,
};

const el = {
  hallTabs: document.getElementById("hallTabs"),
  mealTabs: document.getElementById("mealTabs"),
  menu: document.getElementById("menu"),
  menuDate: document.getElementById("menuDate"),
  statusMsg: document.getElementById("statusMsg"),
  refreshBtn: document.getElementById("refreshBtn"),
  modal: document.getElementById("modal"),
  modalTitle: document.getElementById("modalTitle"),
  modalBody: document.getElementById("modalBody"),
  modalClose: document.getElementById("modalClose"),
};

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function init() {
  state.halls = Object.keys(HALL_THEMES);
  renderHallTabs();
  try {
    const res = await fetch("/api/halls");
    if (!res.ok) throw new Error("Dining halls unavailable");
    const data = await res.json();
    if (Array.isArray(data.halls) && data.halls.length) state.halls = data.halls;
  } catch (err) { console.error(err); }
  if (!state.hall) await selectHall(state.halls[0]);
  else renderHallTabs();
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

async function selectHall(hall, force = false) {
  const request = ++menuRequest;
  menuController?.abort();
  menuController = new AbortController();
  state.hall = hall;
  state.items = [];
  state.date = null;
  el.menuDate.textContent = "";
  applyHallTheme(hall);
  renderHallTabs();
  el.statusMsg.textContent = "Loading menu…";
  el.menu.innerHTML = "";
  el.mealTabs.innerHTML = "";
  el.refreshBtn.disabled = true;
  try {
    const url = `/api/menu/${encodeURIComponent(hall)}${force ? "?refresh=1" : ""}`;
    const res = await fetch(url, { signal: menuController.signal });
    if (!res.ok) throw new Error("Menu request failed");
    const data = await res.json();
    if (request !== menuRequest) return;
    state.items = Array.isArray(data.items) ? data.items : [];
    state.date = data.date;
    el.menuDate.textContent = data.date
      ? new Date(data.date + "T00:00:00").toLocaleDateString(undefined, {
          weekday: "long", month: "long", day: "numeric", year: "numeric",
        })
      : "";
    el.statusMsg.textContent = `${state.items.length} foods`;
    renderMealTabs();
  } catch (err) {
    if (request !== menuRequest) return;
    el.statusMsg.textContent = "Menu unavailable. Select Refresh to try again.";
    console.error(err);
  } finally {
    if (request === menuRequest) el.refreshBtn.disabled = false;
  }
}

function availableMeals() {
  const present = new Set(state.items.map((i) => i.meal));
  return MEAL_ORDER.filter((m) => present.has(m));
}

function renderMealTabs() {
  const meals = availableMeals();
  el.mealTabs.innerHTML = "";
  if (!meals.length) {
    state.meal = null;
    el.menu.innerHTML = `<p class="empty">No menu available for this hall today.</p>`;
    return;
  }
  if (!meals.includes(state.meal)) state.meal = meals[0];
  for (const meal of meals) {
    const btn = document.createElement("button");
    btn.textContent = meal;
    btn.classList.toggle("active", meal === state.meal);
    btn.onclick = () => {
      state.meal = meal;
      renderMealTabs();
    };
    el.mealTabs.appendChild(btn);
  }
  renderMenu();
}

function renderMenu() {
  const items = state.items.filter((i) => i.meal === state.meal);
  if (!items.length) {
    el.menu.innerHTML = `<p class="empty">No items for ${esc(state.meal)}.</p>`;
    return;
  }
  const byStation = new Map();
  for (const item of items) {
    if (!byStation.has(item.station)) byStation.set(item.station, []);
    byStation.get(item.station).push(item);
  }

  let html = "";
  for (const [station, dishes] of byStation) {
    html += `<div class="station"><h3>${esc(station)}</h3><div class="dish-grid">`;
    for (const dish of dishes) {
      const cal = dish.calories ? `<span class="tag cal">${esc(dish.calories)} cal</span>` : "";
      const diet =
        dish.diets && dish.diets !== "None"
          ? `<span class="tag">${esc(dish.diets)}</span>`
          : "";
      html += `
        <div class="dish" data-id="${dish.id}">
          <div class="dish-name">${esc(dish.dish_name)}</div>
          <div class="dish-meta">${cal}${diet}</div>
        </div>`;
    }
    html += `</div></div>`;
  }
  el.menu.innerHTML = html;

  el.menu.querySelectorAll(".dish").forEach((node) => {
    node.onclick = () => {
      const id = Number(node.dataset.id);
      const dish = state.items.find((i) => i.id === id);
      if (dish) openModal(dish);
    };
  });
}

function nutritionRow(label, value, dv, indent = false) {
  if (!value) return "";
  const name = indent ? `&nbsp;&nbsp;${label}` : `<strong>${label}</strong>`;
  return `<tr>
    <td>${name}</td>
    <td class="val">${esc(value)}</td>
    <td class="dv">${dv ? esc(dv) + "%" : ""}</td>
  </tr>`;
}

function openModal(d) {
  el.modalTitle.textContent = d.dish_name;
  let rows = "";
  rows += nutritionRow("Calories", d.calories, null);
  rows += nutritionRow("Total Fat", d.total_fat, d.total_fat_dv);
  rows += nutritionRow("Saturated Fat", d.sat_fat, d.sat_fat_dv, true);
  rows += nutritionRow("Trans Fat", d.trans_fat, null, true);
  rows += nutritionRow("Cholesterol", d.cholesterol, d.cholesterol_dv);
  rows += nutritionRow("Sodium", d.sodium, d.sodium_dv);
  rows += nutritionRow("Total Carbohydrate", d.total_carb, d.total_carb_dv);
  rows += nutritionRow("Dietary Fiber", d.dietary_fiber, d.dietary_fiber_dv, true);
  rows += nutritionRow("Sugars", d.sugars, d.sugars_dv, true);
  rows += nutritionRow("Protein", d.protein, d.protein_dv);

  const serving = d.serving_size
    ? `<p><strong>Serving size:</strong> ${esc(d.serving_size)}</p>`
    : "";
  const allergens = d.allergens
    ? `<div class="info-block"><strong>Allergens</strong><p>${esc(d.allergens)}</p></div>`
    : "";
  const diets =
    d.diets && d.diets !== "None"
      ? `<div class="info-block"><strong>Diet</strong><p>${esc(d.diets)}</p></div>`
      : "";
  const ingredients = d.ingredients
    ? `<div class="info-block"><strong>Ingredients</strong><p>${esc(d.ingredients)}</p></div>`
    : "";

  el.modalBody.innerHTML = `
    ${serving}
    <table class="nutrition-table">
      <thead><tr><th colspan="3">Nutrition Facts</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="3">No nutrition data.</td></tr>`}</tbody>
    </table>
    ${diets}${allergens}${ingredients}
  `;
  el.modal.classList.remove("hidden");
}

function closeModal() {
  el.modal.classList.add("hidden");
}

el.modalClose.onclick = closeModal;
el.modal.onclick = (e) => {
  if (e.target === el.modal) closeModal();
};
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});
el.refreshBtn.onclick = () => selectHall(state.hall, true);

const initPromise = init();
