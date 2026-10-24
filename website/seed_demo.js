// Demo seeding: clears saved plates and generates ~10 example meals spread
// across the past few months, using real scraped foods so nutrition is
// realistic. Each meal's menu_date and created_at are set to its historical
// date. Run with:  node seed_demo.js
const { db, clearPlates, savePlateAt } = require("./db");
const { scrapeHall, DINING_HALLS } = require("./scraper");
const Nutrition = require("./public/nutrition.js");

// Names grouped by the time of day they represent (no breakfast names for the
// recent week on purpose — the demo shows a skipped-breakfast pattern).
const LUNCH_NAMES = ["Quick lunch", "Light lunch", "Grab and go", "Midday refuel", "Between classes"];
const DINNER_NAMES = ["Post-gym dinner", "Dinner with friends", "Midweek dinner", "Rainy day comfort food", "Game day feast"];
const OLDER_NAMES = [
  "Breakfast before class", "Sunday brunch", "Pre-exam fuel", "Late night study snack",
  "Quick lunch", "Dinner with friends",
];

function iso(date) {
  return date.toISOString();
}
function ymd(date) {
  return date.toLocaleDateString("en-CA"); // YYYY-MM-DD, local
}
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function sampleFoods(items, n) {
  const pool = [...items];
  const out = [];
  for (let i = 0; i < n && pool.length; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

async function ensureMenus() {
  const have = db.prepare("SELECT COUNT(*) c FROM menu_items").get().c;
  if (have > 0) return;
  console.log("No menu data found; scraping halls for realistic foods…");
  for (const hall of DINING_HALLS) {
    try {
      const { date, items } = await scrapeHall(hall);
      const { replaceForHallDate } = require("./db");
      replaceForHallDate(hall, date, items);
      console.log(`  scraped ${hall}: ${items.length} items`);
    } catch (e) {
      console.warn(`  could not scrape ${hall}: ${e.message}`);
    }
  }
}

function foodsForHall(hall) {
  return db
    .prepare(`SELECT * FROM menu_items WHERE dining_hall = ? AND calories IS NOT NULL`)
    .all(hall);
}

async function main() {
  await ensureMenus();

  const cleared = clearPlates();
  console.log(`Cleared ${cleared} existing plate(s).`);

  const METRICS = Nutrition.METRICS;
  const now = new Date();
  let created = 0;

  // Build and save one meal on `day` at `hour`:`minute`, named `name`.
  function makeMeal(day, hour, minute, name) {
    const hall = pick(DINING_HALLS);
    const foods = foodsForHall(hall);
    if (!foods.length) { console.warn(`No foods for ${hall}; skipping`); return; }

    const when = new Date(day);
    when.setHours(hour, minute, 0, 0);

    const chosen = sampleFoods(foods, 2 + Math.floor(Math.random() * 3)); // 2-4 foods
    const items = chosen.map((f) => ({
      id: f.id,
      dish_name: f.dish_name,
      serving_size: f.serving_size,
      servings: pick([0.5, 1, 1, 1, 1.5, 2]),
      nutrition: Object.fromEntries(METRICS.map((m) => [m.field, f[m.field] ?? null])),
    }));
    const totals = Nutrition.displayTotals(Nutrition.rowsFromPlate({ items }));

    savePlateAt({ name, dining_hall: hall, menu_date: ymd(when), image: null, items, totals }, iso(when));
    created++;
    console.log(`  + ${ymd(when)} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}  ${hall.padEnd(10)} "${name}" (${items.length} foods, ${totals.calories})`);
  }

  // --- Past 7 days: exactly two meals per day (lunch + dinner), NO breakfast.
  // This produces a clear "skipping breakfast" pattern on the timeline: dots
  // only ever appear midday and evening, never in the morning window.
  console.log("Recent week (lunch + dinner only, breakfast skipped):");
  const rndMin = () => Math.floor(Math.random() * 60);
  for (let d = 6; d >= 0; d--) {
    const day = new Date(now);
    day.setDate(now.getDate() - d);
    // Lunch: 12:xx or 1:xx pm
    makeMeal(day, pick([12, 13]), rndMin(), pick(LUNCH_NAMES));
    // Dinner: 6:xx or 7:xx pm
    makeMeal(day, pick([18, 19]), rndMin(), pick(DINNER_NAMES));
  }

  // --- Older history for timeline depth (a few scattered meals further back).
  console.log("Older history:");
  for (const daysAgo of [12, 20, 33, 47, 70]) {
    const day = new Date(now);
    day.setDate(now.getDate() - daysAgo);
    makeMeal(day, 8 + Math.floor(Math.random() * 12), Math.floor(Math.random() * 60), pick(OLDER_NAMES));
  }

  console.log(`\nSeeded ${created} demo meals.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
