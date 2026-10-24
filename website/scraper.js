const cheerio = require("cheerio");

const DINING_HALLS = ["Berkshire", "Worcester", "Franklin", "Hampshire"];

const MEALS = [
  { id: "breakfast_menu", name: "Breakfast" },
  { id: "lunch_menu", name: "Lunch" },
  { id: "dinner_menu", name: "Dinner" },
  { id: "latenight_menu", name: "Late Night" },
];

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function slug(hall) {
  return hall.toLowerCase();
}

/**
 * Parse "Menu For Sat October 24, 2026" (or similar) into YYYY-MM-DD.
 * Falls back to today's local date if it can't be parsed.
 */
function parseMenuDate(html) {
  const m = html.match(/Menu For\s+([A-Za-z]+\s+[A-Za-z]+\s+\d{1,2},\s*\d{4})/);
  if (m) {
    const d = new Date(m[1]);
    if (!isNaN(d)) return toISODate(d);
  }
  return toISODate(new Date());
}

function toISODate(d) {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

async function fetchMenuHtml(hall) {
  const url = `https://www.umassdining.com/locations-menus/${slug(hall)}/menu`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

/**
 * Extract menu items (with nutrition facts) for a single dining hall.
 * Returns { date, items[] }.
 */
function parseMenu(hall, html) {
  const $ = cheerio.load(html);
  const date = parseMenuDate(html);
  const scrapedAt = new Date().toISOString();
  const items = [];

  for (const meal of MEALS) {
    const container = $(`#${meal.id}`);
    if (!container.length) continue;

    // Walk the content in document order so each dish is tied to the
    // most recent "menu_category_name" heading (the station).
    const content = container.find("#content_text").first();
    const root = content.length ? content : container;

    let station = "General";
    root.find("h2.menu_category_name, li.lightbox-nutrition").each((_, el) => {
      const node = $(el);
      if (node.is("h2")) {
        station = node.text().trim() || "General";
        return;
      }
      const a = node.find("a[data-dish-name]").first();
      if (!a.length) return;
      const d = (name) => {
        const v = a.attr(name);
        return v === undefined || v === "" ? null : v.trim();
      };

      items.push({
        dining_hall: hall,
        menu_date: date,
        meal: meal.name,
        station,
        dish_name: d("data-dish-name") || a.text().trim(),

        serving_size: d("data-serving-size"),
        calories: d("data-calories"),
        calories_from_fat: d("data-calories-from-fat"),
        total_fat: d("data-total-fat"),
        total_fat_dv: d("data-total-fat-dv"),
        sat_fat: d("data-sat-fat"),
        sat_fat_dv: d("data-sat-fat-dv"),
        trans_fat: d("data-trans-fat"),
        cholesterol: d("data-cholesterol"),
        cholesterol_dv: d("data-cholesterol_dv"),
        sodium: d("data-sodium"),
        sodium_dv: d("data-sodium-dv"),
        total_carb: d("data-total-carb"),
        total_carb_dv: d("data-total-carb-dv"),
        dietary_fiber: d("data-dietary-fiber"),
        dietary_fiber_dv: d("data-dietary-fiber-dv"),
        sugars: d("data-sugars"),
        sugars_dv: d("data-sugars-dv"),
        protein: d("data-protein"),
        protein_dv: d("data-protein-dv"),

        allergens: d("data-allergens"),
        ingredients: d("data-ingredient-list"),
        diets: d("data-clean-diet-str"),
        healthfulness: d("data-healthfulness"),
        carbon_rating: d("data-carbon-list"),

        scraped_at: scrapedAt,
      });
    });
  }

  return { date, items };
}

async function scrapeHall(hall) {
  const html = await fetchMenuHtml(hall);
  return parseMenu(hall, html);
}

module.exports = { DINING_HALLS, scrapeHall, parseMenu, fetchMenuHtml };
