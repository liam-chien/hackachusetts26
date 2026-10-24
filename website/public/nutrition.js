// Shared nutrition definitions + aggregation. Used by the tracker, the meal
// edit page, the history graph, and the demo seed script. Works both in the
// browser (attaches to window) and in Node (module.exports).
(function (root) {
  // Each metric knows how to pull a value from a food and how it aggregates.
  // kind "sum": additive nutrient scaled by servings; "avg": averaged score;
  // "carbon": letter grade averaged via a numeric scale.
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

  const CARBON_SCORE = { A: 1, B: 2, C: 3, D: 4, E: 5 };
  const CARBON_LETTER = { 1: "A", 2: "B", 3: "C", 4: "D", 5: "E" };

  function parseNum(str) {
    if (str == null) return 0;
    const m = String(str).match(/-?\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : 0;
  }

  // Parse a serving size like "3 oz", "1 EACH", "1/2 Sandwich".
  function parseServing(str) {
    if (!str) return { qty: 1, unit: "serving" };
    const s = String(str).trim();
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

  // rows: [{ item: {<field>: value...}, servings }]. Returns per-metric
  // { sum, count, missing }.
  function aggregate(rows) {
    const totals = {};
    for (const m of METRICS) totals[m.key] = { sum: 0, count: 0, missing: 0 };
    for (const row of rows) {
      if (!row.item) continue;
      const s = row.servings || 0;
      if (s <= 0) continue;
      for (const m of METRICS) {
        const raw = row.item[m.field];
        if (raw == null || String(raw).trim() === "" ||
            (m.kind !== "carbon" && !/-?\d+(\.\d+)?/.test(String(raw)))) {
          totals[m.key].missing += 1;
          continue;
        }
        if (m.kind === "carbon") {
          const score = CARBON_SCORE[String(raw).trim().toUpperCase()];
          if (score) { totals[m.key].sum += score; totals[m.key].count += 1; }
          else totals[m.key].missing += 1;
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

  // Display string for a metric, with "~" for partial coverage, "—" for none.
  function metricDisplay(m, agg) {
    const t = agg[m.key];
    if (!t.count) return "—";
    const partial = t.missing > 0 ? "~" : "";
    if (m.kind === "carbon") {
      const avg = t.sum / t.count;
      return partial + (CARBON_LETTER[Math.round(avg)] || round(avg, 1));
    }
    if (m.kind === "avg") return partial + round(t.sum / t.count, 0);
    return `${partial}${round(t.sum, m.unit === "g" || m.unit === "mg" ? 1 : 0)}${m.unit}`;
  }

  // Numeric value for a metric (for graphing). null when unavailable.
  function metricNumber(m, agg) {
    const t = agg[m.key];
    if (!t.count) return null;
    if (m.kind === "carbon" || m.kind === "avg") return round(t.sum / t.count, 2);
    return round(t.sum, 1);
  }

  // Build a totals object of display strings for every metric.
  function displayTotals(rows) {
    const agg = aggregate(rows);
    const out = {};
    for (const m of METRICS) out[m.key] = metricDisplay(m, agg);
    return out;
  }

  // Convert a saved plate's items into aggregation rows using their nutrition
  // snapshots. Returns null-safe rows the aggregate() function understands.
  function rowsFromPlate(plate) {
    return (plate.items || []).map((saved) => {
      const hasSnapshot = saved.nutrition && typeof saved.nutrition === "object";
      const item = { dish_name: saved.dish_name, serving_size: saved.serving_size };
      for (const m of METRICS) item[m.field] = hasSnapshot ? (saved.nutrition[m.field] ?? null) : null;
      item.nutritionUnavailable = !hasSnapshot;
      return { item, servings: Number.isFinite(saved.servings) ? Math.max(0, saved.servings) : 1 };
    });
  }

  // Allergen categories present in the scraped data.
  const ALLERGENS = [
    "Milk", "Eggs", "Gluten", "Wheat", "Soy", "Corn",
    "Sesame", "Tree Nuts", "Peanuts", "Fish", "Shellfish",
  ];

  const RECURRENCE_LABEL = { meal: "per meal", day: "per day", week: "per week" };

  // Goals can only target additive ("sum") metrics — averaged scores like
  // healthfulness/carbon don't accumulate toward a daily/weekly total.
  function goalMetrics() {
    return METRICS.filter((m) => m.kind === "sum");
  }

  // Which of the user's allergen categories a food contains (from its
  // "allergens" field, e.g. "Milk, Eggs, Gluten"). Case-insensitive.
  function matchedAllergens(food, userAllergens) {
    if (!userAllergens || !userAllergens.length) return [];
    const raw = String(food && food.allergens ? food.allergens : "").toLowerCase();
    if (!raw) return [];
    return userAllergens.filter((a) => raw.includes(String(a).toLowerCase()));
  }

  // Which avoided-food terms appear in a food's ingredient list.
  // Case-insensitive substring match against the scraped ingredients.
  function matchedAvoided(food, avoidFoods) {
    if (!avoidFoods || !avoidFoods.length) return [];
    const ingredients = String(food && food.ingredients ? food.ingredients : "").toLowerCase();
    if (!ingredients) return [];
    return avoidFoods.filter((term) => term && ingredients.includes(String(term).toLowerCase()));
  }

  // Assumed meals per day, used to convert day/week goals into a comparable
  // per-meal target for the Trends chart (which plots one bar per meal).
  const MEALS_PER_DAY = 3;

  // Convert a goal's target to a per-meal-equivalent value, so day/week goals
  // can be drawn against a per-meal chart. e.g. 60 g/day -> 20 g/meal;
  // 420 g/week -> 20 g/meal (420 / 7 / 3).
  function goalPerMeal(goal) {
    const t = Number(goal.target) || 0;
    if (goal.recurrence === "day") return t / MEALS_PER_DAY;
    if (goal.recurrence === "week") return t / (7 * MEALS_PER_DAY);
    return t; // per meal
  }

  // Numeric contribution of a single food row toward a metric (scaled by
  // servings for sum metrics). Returns 0 when unavailable.
  function rowMetricNumber(row, metricKey) {
    const m = METRICS.find((x) => x.key === metricKey);
    if (!m || !row || !row.item) return 0;
    const agg = aggregate([{ item: row.item, servings: row.servings }]);
    return metricNumber(m, agg) || 0;
  }

  const api = {
    METRICS, CARBON_SCORE, CARBON_LETTER, ALLERGENS, RECURRENCE_LABEL,
    parseNum, parseServing, round, goalMetrics,
    aggregate, metricDisplay, metricNumber, displayTotals, rowsFromPlate,
    matchedAllergens, matchedAvoided, rowMetricNumber,
    MEALS_PER_DAY, goalPerMeal,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Nutrition = api;
})(typeof window !== "undefined" ? window : globalThis);
