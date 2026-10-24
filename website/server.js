const path = require("path");
const express = require("express");
const { DINING_HALLS, scrapeHall } = require("./scraper");
const {
  replaceForHallDate,
  getMenu,
  getLatestDate,
  getRawRows,
  getRawFilters,
  savePlate,
  getPlate,
  listPlates,
} = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

// Plate photos are sent as base64 data URLs, so allow a generous body size.
app.use(express.json({ limit: "12mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Avoid hammering UMass Dining: don't re-scrape a hall more than once
// every REFRESH_MS when its page is loaded.
const REFRESH_MS = 5 * 60 * 1000;
const lastScrape = new Map();

function isValidHall(hall) {
  return DINING_HALLS.some((h) => h.toLowerCase() === String(hall).toLowerCase());
}

function normalizeHall(hall) {
  return DINING_HALLS.find((h) => h.toLowerCase() === String(hall).toLowerCase());
}

async function refreshHall(hall, force = false) {
  const last = lastScrape.get(hall) || 0;
  if (!force && Date.now() - last < REFRESH_MS) return;
  const { date, items } = await scrapeHall(hall);
  replaceForHallDate(hall, date, items);
  lastScrape.set(hall, Date.now());
  console.log(`[scrape] ${hall}: ${items.length} items for ${date}`);
}

// Scrape (if stale) and return a hall's menu from the database.
app.get("/api/menu/:hall", async (req, res) => {
  const hall = normalizeHall(req.params.hall);
  if (!hall) {
    return res.status(404).json({ error: "Unknown dining hall" });
  }
  try {
    const force = req.query.refresh === "1";
    await refreshHall(hall, force);
  } catch (err) {
    console.error(`[scrape] ${hall} failed:`, err.message);
    // Fall through and serve whatever is already in the DB.
  }

  const date = getLatestDate(hall);
  const items = date ? getMenu(hall, date) : [];
  res.json({ hall, date, count: items.length, items });
});

app.get("/api/halls", (_req, res) => {
  res.json({ halls: DINING_HALLS });
});

// --- Developer endpoints: raw database access ---

// Distinct filter values + total row count for the developer page.
app.get("/api/raw/filters", (_req, res) => {
  res.json(getRawFilters());
});

// Raw menu_items rows with optional hall/date/meal filtering and paging.
app.get("/api/raw", (req, res) => {
  const { hall, date, meal, limit, offset } = req.query;
  res.json(getRawRows({ hall, date, meal, limit, offset }));
});

// --- Plates (meal tracking) ---

// Save a tracked plate (photo + chosen foods + aggregated totals).
app.post("/api/plates", (req, res) => {
  try {
    const plate = savePlate(req.body || {});
    res.status(201).json(plate);
  } catch (err) {
    console.error("[plates] save failed:", err.message);
    res.status(400).json({ error: "Could not save plate" });
  }
});

// List saved plates. ?images=1 includes the stored photos.
app.get("/api/plates", (req, res) => {
  res.json({ plates: listPlates(req.query.images === "1") });
});

// Fetch a single saved plate (including its image).
app.get("/api/plates/:id", (req, res) => {
  const plate = getPlate(Number(req.params.id));
  if (!plate) return res.status(404).json({ error: "Plate not found" });
  res.json(plate);
});

app.listen(PORT, () => {
  console.log(`UMass Dining server running at http://localhost:${PORT}`);
});
