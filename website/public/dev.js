const NUMERIC_HINT = /calories|_dv$|healthfulness/;

const state = {
  columns: [],
  rows: [],
  total: 0,
  limit: 200,
  offset: 0,
};

const el = {
  fHall: document.getElementById("fHall"),
  fDate: document.getElementById("fDate"),
  fMeal: document.getElementById("fMeal"),
  fLimit: document.getElementById("fLimit"),
  fSearch: document.getElementById("fSearch"),
  applyBtn: document.getElementById("applyBtn"),
  prevBtn: document.getElementById("prevBtn"),
  nextBtn: document.getElementById("nextBtn"),
  pageInfo: document.getElementById("pageInfo"),
  rowInfo: document.getElementById("rowInfo"),
  headRow: document.getElementById("headRow"),
  bodyRows: document.getElementById("bodyRows"),
};

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function fillSelect(select, values) {
  const current = select.value;
  select.innerHTML = `<option value="">All</option>`;
  for (const v of values) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    select.appendChild(opt);
  }
  if (values.includes(current)) select.value = current;
}

async function loadFilters() {
  const res = await fetch("/api/raw/filters");
  const data = await res.json();
  fillSelect(el.fHall, data.halls);
  fillSelect(el.fDate, data.dates);
  fillSelect(el.fMeal, data.meals);
}

async function loadRows() {
  const params = new URLSearchParams();
  if (el.fHall.value) params.set("hall", el.fHall.value);
  if (el.fDate.value) params.set("date", el.fDate.value);
  if (el.fMeal.value) params.set("meal", el.fMeal.value);
  params.set("limit", el.fLimit.value);
  params.set("offset", state.offset);

  el.rowInfo.textContent = "Loading…";
  const res = await fetch(`/api/raw?${params.toString()}`);
  const data = await res.json();
  state.columns = data.columns;
  state.rows = data.rows;
  state.total = data.total;
  state.limit = data.limit;
  state.offset = data.offset;
  render();
}

function render() {
  // Header
  el.headRow.innerHTML = state.columns.map((c) => `<th>${esc(c)}</th>`).join("");

  // Body (with client-side search over visible rows)
  const q = el.fSearch.value.trim().toLowerCase();
  const visible = q
    ? state.rows.filter((r) =>
        state.columns.some((c) =>
          String(r[c] ?? "").toLowerCase().includes(q)
        )
      )
    : state.rows;

  el.bodyRows.innerHTML = visible
    .map((row) => {
      const tds = state.columns
        .map((c) => {
          const v = row[c];
          if (v === null || v === undefined || v === "") {
            return `<td class="null">null</td>`;
          }
          const numeric = NUMERIC_HINT.test(c) && /^\d+$/.test(String(v));
          const cls = numeric ? "num" : "expandable";
          return `<td class="${cls}">${esc(v)}</td>`;
        })
        .join("");
      return `<tr>${tds}</tr>`;
    })
    .join("");

  // Expand/collapse long cells on click
  el.bodyRows.querySelectorAll("td.expandable").forEach((td) => {
    td.onclick = () => td.classList.toggle("expanded");
  });

  // Status + pager
  const start = state.total === 0 ? 0 : state.offset + 1;
  const end = Math.min(state.offset + state.rows.length, state.total);
  const filteredNote = q ? ` (showing ${visible.length} after filter)` : "";
  el.rowInfo.textContent =
    `Rows ${start}–${end} of ${state.total} total${filteredNote}`;

  const page = Math.floor(state.offset / state.limit) + 1;
  const pages = Math.max(1, Math.ceil(state.total / state.limit));
  el.pageInfo.textContent = `Page ${page} / ${pages}`;
  el.prevBtn.disabled = state.offset <= 0;
  el.nextBtn.disabled = state.offset + state.limit >= state.total;
}

function apply(resetPage = true) {
  if (resetPage) state.offset = 0;
  loadRows();
}

el.applyBtn.onclick = () => apply(true);
el.fHall.onchange = () => apply(true);
el.fDate.onchange = () => apply(true);
el.fMeal.onchange = () => apply(true);
el.fLimit.onchange = () => apply(true);
el.fSearch.oninput = () => render();
el.prevBtn.onclick = () => {
  state.offset = Math.max(0, state.offset - state.limit);
  loadRows();
};
el.nextBtn.onclick = () => {
  state.offset += state.limit;
  loadRows();
};

(async function init() {
  await loadFilters();
  await loadRows();
})();
