const { ALLERGENS, goalMetrics, METRICS, RECURRENCE_LABEL } = Nutrition;

const state = {
  name: "",
  allergens: [],
  avoid_foods: [],
  goals: [],
  dirty: false,
};

const el = {
  name: document.getElementById("name"),
  saveState: document.getElementById("saveState"),
  allergenList: document.getElementById("allergenList"),
  avoidForm: document.getElementById("avoidForm"),
  avoidInput: document.getElementById("avoidInput"),
  avoidChips: document.getElementById("avoidChips"),
  goalForm: document.getElementById("goalForm"),
  goalMetric: document.getElementById("goalMetric"),
  goalType: document.getElementById("goalType"),
  goalTarget: document.getElementById("goalTarget"),
  goalUnit: document.getElementById("goalUnit"),
  goalRecurrence: document.getElementById("goalRecurrence"),
  goalChips: document.getElementById("goalChips"),
  saveBtn: document.getElementById("saveBtn"),
  dirtyNote: document.getElementById("dirtyNote"),
};

const TYPE_LABEL = { min: "at least", max: "at most" };

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function metricLabel(key) {
  return (METRICS.find((m) => m.key === key) || {}).label || key;
}
function metricUnit(key) {
  return ((METRICS.find((m) => m.key === key) || {}).unit || "").trim();
}
function markDirty() {
  state.dirty = true;
  el.dirtyNote.textContent = "Unsaved changes";
}

// ---- Init ------------------------------------------------------------------
async function init() {
  // Allergen checkboxes
  el.allergenList.innerHTML = ALLERGENS.map((a) => `
    <label class="chip-check">
      <input type="checkbox" value="${esc(a)}" />
      <span class="dot" aria-hidden="true"></span>${esc(a)}
    </label>`).join("");
  el.allergenList.querySelectorAll("input").forEach((input) => {
    input.onchange = () => {
      state.allergens = [...el.allergenList.querySelectorAll("input:checked")].map((i) => i.value);
      markDirty();
    };
  });

  // Goal metric options (sum metrics only)
  el.goalMetric.innerHTML = goalMetrics()
    .map((m) => `<option value="${m.key}">${esc(m.label)}</option>`)
    .join("");
  // Keep the unit beside the target input in sync with the chosen nutrient.
  const syncUnit = () => { el.goalUnit.textContent = metricUnit(el.goalMetric.value); };
  el.goalMetric.onchange = syncUnit;
  syncUnit();

  // Load saved profile
  try {
    const res = await fetch("/api/profile");
    if (res.ok) {
      const p = await res.json();
      state.name = p.name || "";
      state.allergens = Array.isArray(p.allergens) ? p.allergens : [];
      state.avoid_foods = Array.isArray(p.avoid_foods) ? p.avoid_foods : [];
      state.goals = Array.isArray(p.goals) ? p.goals : [];
    }
  } catch (err) {
    console.error(err);
    el.saveState.textContent = "Couldn't load saved preferences.";
  }

  el.name.value = state.name;
  el.allergenList.querySelectorAll("input").forEach((i) => {
    i.checked = state.allergens.includes(i.value);
  });
  renderAvoid();
  renderGoals();
  el.dirtyNote.textContent = "";
  state.dirty = false;
}

el.name.oninput = () => { state.name = el.name.value; markDirty(); };

// ---- Avoided foods ---------------------------------------------------------
el.avoidForm.onsubmit = (e) => {
  e.preventDefault();
  const term = el.avoidInput.value.trim();
  if (!term) return;
  if (!state.avoid_foods.some((t) => t.toLowerCase() === term.toLowerCase())) {
    state.avoid_foods.push(term);
    markDirty();
    renderAvoid();
  }
  el.avoidInput.value = "";
  el.avoidInput.focus();
};

function renderAvoid() {
  el.avoidChips.innerHTML = state.avoid_foods.map((t, i) => `
    <span class="pill">${esc(t)}<button type="button" data-i="${i}" aria-label="Remove ${esc(t)}">&times;</button></span>
  `).join("");
  el.avoidChips.querySelectorAll("button").forEach((b) => {
    b.onclick = () => { state.avoid_foods.splice(Number(b.dataset.i), 1); markDirty(); renderAvoid(); };
  });
}

// ---- Goals -----------------------------------------------------------------
el.goalForm.onsubmit = (e) => {
  e.preventDefault();
  const metric = el.goalMetric.value;
  const type = el.goalType.value;
  const target = Number(el.goalTarget.value);
  const recurrence = el.goalRecurrence.value;
  if (!metric || !(target > 0)) {
    el.dirtyNote.textContent = "Enter a target greater than zero.";
    return;
  }
  state.goals.push({
    id: Date.now() + "-" + Math.random().toString(36).slice(2, 7),
    metric, type, target, recurrence,
  });
  markDirty();
  renderGoals();
  el.goalTarget.value = "";
};

function renderGoals() {
  el.goalChips.innerHTML = state.goals.map((g) => {
    const unit = metricUnit(g.metric);
    const typeLabel = TYPE_LABEL[g.type] || TYPE_LABEL.min;
    return `
      <div class="goal-pill" data-id="${esc(g.id)}">
        <span>
          <span class="gtext"><b>${esc(metricLabel(g.metric))}</b> — ${esc(typeLabel)} ${esc(g.target)}${unit ? " " + esc(unit) : ""}</span>
          <span class="gmeta"> · ${esc(RECURRENCE_LABEL[g.recurrence] || g.recurrence)}</span>
        </span>
        <button type="button" aria-label="Remove goal">&times;</button>
      </div>`;
  }).join("");
  el.goalChips.querySelectorAll(".goal-pill button").forEach((b) => {
    b.onclick = () => {
      const id = b.closest(".goal-pill").dataset.id;
      state.goals = state.goals.filter((g) => g.id !== id);
      markDirty();
      renderGoals();
    };
  });
}

// ---- Save ------------------------------------------------------------------
el.saveBtn.onclick = async () => {
  el.saveBtn.disabled = true;
  el.saveState.textContent = "Saving…";
  el.dirtyNote.textContent = "";
  try {
    const res = await fetch("/api/profile", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: state.name, allergens: state.allergens,
        avoid_foods: state.avoid_foods, goals: state.goals,
      }),
    });
    if (!res.ok) throw new Error("save failed");
    const saved = await res.json();
    state.goals = saved.goals; // pick up server-normalized ids
    renderGoals();
    state.dirty = false;
    el.saveState.textContent = "Preferences saved ✓";
    setTimeout(() => { if (!state.dirty) el.saveState.textContent = ""; }, 2500);
  } catch (err) {
    console.error(err);
    el.saveState.textContent = "Couldn't save. Please try again.";
  } finally {
    el.saveBtn.disabled = false;
  }
};

window.addEventListener("beforeunload", (e) => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ""; }
});

init();
