const path = require("path");
const os = require("os");
const fs = require("fs");
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
  updatePlate,
  deletePlate,
  getProfile,
  saveProfile,
  getPlatesBetween,
} = require("./db");
const { generatePlate, visionInstalled } = require("./model_bridge");

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

// Update a saved plate in place. The original date is preserved (editing a past
// meal must not move it to today).
app.put("/api/plates/:id", (req, res) => {
  try {
    const plate = updatePlate(Number(req.params.id), req.body || {});
    if (!plate) return res.status(404).json({ error: "Plate not found" });
    res.json(plate);
  } catch (err) {
    console.error("[plates] update failed:", err.message);
    res.status(400).json({ error: "Could not update plate" });
  }
});

// Delete a saved plate.
app.delete("/api/plates/:id", (req, res) => {
  const ok = deletePlate(Number(req.params.id));
  if (!ok) return res.status(404).json({ error: "Plate not found" });
  res.json({ deleted: true });
});

// Saved plates within a date window (for per-day / per-week goal progress).
// ?from=YYYY-MM-DD&to=YYYY-MM-DD (inclusive). Images omitted.
app.get("/api/plates-between", (req, res) => {
  const { from, to } = req.query;
  const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!isDate(from) || !isDate(to)) {
    return res.status(400).json({ error: "from and to must be YYYY-MM-DD" });
  }
  res.json({ plates: getPlatesBetween(from, to) });
});

// --- User profile ---

app.get("/api/profile", (_req, res) => {
  res.json(getProfile());
});

app.put("/api/profile", (req, res) => {
  try {
    res.json(saveProfile(req.body || {}));
  } catch (err) {
    console.error("[profile] save failed:", err.message);
    res.status(400).json({ error: "Could not save profile" });
  }
});

// --- Image -> plate (vision model + menu matcher) ---

// Whether the local vision model is installed, so the UI can show a helpful
// message instead of making a request that will fail.
app.get("/api/generate-plate/status", (_req, res) => {
  res.json({ available: visionInstalled() });
});

// Decode an uploaded photo, run it through the vision model + matcher against
// the hall's scraped menu, and return matched plate items (with servings).
app.post("/api/generate-plate", async (req, res) => {
  const { image, hall: rawHall } = req.body || {};
  const hall = normalizeHall(rawHall);
  if (!hall) return res.status(400).json({ error: "Unknown or missing dining hall" });
  if (typeof image !== "string" || !image.startsWith("data:image/")) {
    return res.status(400).json({ error: "A plate photo is required" });
  }

  // The hall's current menu is what we match against.
  const date = getLatestDate(hall);
  const items = date ? getMenu(hall, date) : [];
  if (!items.length) {
    return res.status(409).json({ error: `No menu is loaded for ${hall}.` });
  }

  // Write the data URL to a temp JPEG for the Python vision CLI.
  const base64 = image.slice(image.indexOf(",") + 1);
  const tmpImg = path.join(os.tmpdir(), `plate_${Date.now()}.jpg`);
  try {
    fs.writeFileSync(tmpImg, Buffer.from(base64, "base64"));
  } catch (err) {
    return res.status(400).json({ error: "Could not read the uploaded image" });
  }

  try {
    const result = await generatePlate({ imagePath: tmpImg, hall, date, items });
    res.json({ hall, date, ...result });
  } catch (err) {
    console.error("[generate-plate] failed:", err.message);
    if (err.code === "VISION_NOT_INSTALLED") {
      return res.status(503).json({ error: err.message, code: "VISION_NOT_INSTALLED" });
    }
    res.status(500).json({ error: "Could not analyze the photo. Please try again." });
  } finally {
    fs.unlink(tmpImg, () => {});
  }
});

app.listen(PORT, () => {
  console.log(`UMass Dining server running at http://localhost:${PORT}`);
});
