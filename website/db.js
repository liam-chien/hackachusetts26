const path = require("path");
const Database = require("better-sqlite3");

const db = new Database(path.join(__dirname, "dining.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS menu_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dining_hall      TEXT NOT NULL,
    menu_date        TEXT NOT NULL,   -- YYYY-MM-DD
    meal             TEXT NOT NULL,   -- Breakfast / Lunch / Dinner / Late Night
    station          TEXT NOT NULL,   -- e.g. Grill Station
    dish_name        TEXT NOT NULL,

    serving_size     TEXT,
    calories         TEXT,
    calories_from_fat TEXT,
    total_fat        TEXT,
    total_fat_dv     TEXT,
    sat_fat          TEXT,
    sat_fat_dv       TEXT,
    trans_fat        TEXT,
    cholesterol      TEXT,
    cholesterol_dv   TEXT,
    sodium           TEXT,
    sodium_dv        TEXT,
    total_carb       TEXT,
    total_carb_dv    TEXT,
    dietary_fiber    TEXT,
    dietary_fiber_dv TEXT,
    sugars           TEXT,
    sugars_dv        TEXT,
    protein          TEXT,
    protein_dv       TEXT,

    allergens        TEXT,
    ingredients      TEXT,
    diets            TEXT,            -- clean-diet-str, e.g. "Halal, Vegetarian"
    healthfulness    TEXT,
    carbon_rating    TEXT,            -- carbon-list A/B/C

    scraped_at       TEXT NOT NULL,
    UNIQUE(dining_hall, menu_date, meal, station, dish_name)
  );

  CREATE INDEX IF NOT EXISTS idx_hall_date
    ON menu_items (dining_hall, menu_date);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS plates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    dining_hall  TEXT,
    menu_date    TEXT,
    image        TEXT,            -- data URL of the uploaded plate photo
    items_json   TEXT NOT NULL,   -- JSON array of chosen foods + portions
    totals_json  TEXT,            -- JSON of the aggregated nutrition overview
    created_at   TEXT NOT NULL
  );
`);

const insertStmt = db.prepare(`
  INSERT INTO menu_items (
    dining_hall, menu_date, meal, station, dish_name,
    serving_size, calories, calories_from_fat, total_fat, total_fat_dv,
    sat_fat, sat_fat_dv, trans_fat, cholesterol, cholesterol_dv,
    sodium, sodium_dv, total_carb, total_carb_dv, dietary_fiber,
    dietary_fiber_dv, sugars, sugars_dv, protein, protein_dv,
    allergens, ingredients, diets, healthfulness, carbon_rating,
    scraped_at
  ) VALUES (
    @dining_hall, @menu_date, @meal, @station, @dish_name,
    @serving_size, @calories, @calories_from_fat, @total_fat, @total_fat_dv,
    @sat_fat, @sat_fat_dv, @trans_fat, @cholesterol, @cholesterol_dv,
    @sodium, @sodium_dv, @total_carb, @total_carb_dv, @dietary_fiber,
    @dietary_fiber_dv, @sugars, @sugars_dv, @protein, @protein_dv,
    @allergens, @ingredients, @diets, @healthfulness, @carbon_rating,
    @scraped_at
  )
  ON CONFLICT(dining_hall, menu_date, meal, station, dish_name)
  DO UPDATE SET
    serving_size=@serving_size, calories=@calories,
    calories_from_fat=@calories_from_fat, total_fat=@total_fat,
    total_fat_dv=@total_fat_dv, sat_fat=@sat_fat, sat_fat_dv=@sat_fat_dv,
    trans_fat=@trans_fat, cholesterol=@cholesterol,
    cholesterol_dv=@cholesterol_dv, sodium=@sodium, sodium_dv=@sodium_dv,
    total_carb=@total_carb, total_carb_dv=@total_carb_dv,
    dietary_fiber=@dietary_fiber, dietary_fiber_dv=@dietary_fiber_dv,
    sugars=@sugars, sugars_dv=@sugars_dv, protein=@protein,
    protein_dv=@protein_dv, allergens=@allergens, ingredients=@ingredients,
    diets=@diets, healthfulness=@healthfulness, carbon_rating=@carbon_rating,
    scraped_at=@scraped_at
`);

const replaceForHallDate = db.transaction((hall, date, items) => {
  db.prepare(
    `DELETE FROM menu_items WHERE dining_hall = ? AND menu_date = ?`
  ).run(hall, date);
  for (const item of items) insertStmt.run(item);
});

function getMenu(hall, date) {
  return db
    .prepare(
      `SELECT * FROM menu_items
       WHERE dining_hall = ? AND menu_date = ?
       ORDER BY
         CASE meal
           WHEN 'Breakfast' THEN 1
           WHEN 'Lunch' THEN 2
           WHEN 'Dinner' THEN 3
           WHEN 'Late Night' THEN 4
           ELSE 5 END,
         station, dish_name`
    )
    .all(hall, date);
}

// Developer view: raw table rows with optional filtering + paging.
function getRawRows({ hall, date, meal, limit = 200, offset = 0 } = {}) {
  const where = [];
  const params = {};
  if (hall) {
    where.push("dining_hall = @hall");
    params.hall = hall;
  }
  if (date) {
    where.push("menu_date = @date");
    params.date = date;
  }
  if (meal) {
    where.push("meal = @meal");
    params.meal = meal;
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = db
    .prepare(`SELECT COUNT(*) AS c FROM menu_items ${whereSql}`)
    .get(params).c;

  params.limit = Math.max(1, Math.min(Number(limit) || 200, 1000));
  params.offset = Math.max(0, Number(offset) || 0);

  const rows = db
    .prepare(
      `SELECT * FROM menu_items ${whereSql}
       ORDER BY dining_hall, menu_date DESC, id
       LIMIT @limit OFFSET @offset`
    )
    .all(params);

  const columns = db.prepare(`PRAGMA table_info(menu_items)`).all().map((c) => c.name);

  return { total, limit: params.limit, offset: params.offset, columns, rows };
}

// Distinct values used to populate developer-page filter dropdowns.
function getRawFilters() {
  const halls = db
    .prepare(`SELECT DISTINCT dining_hall FROM menu_items ORDER BY dining_hall`)
    .all()
    .map((r) => r.dining_hall);
  const dates = db
    .prepare(`SELECT DISTINCT menu_date FROM menu_items ORDER BY menu_date DESC`)
    .all()
    .map((r) => r.menu_date);
  const meals = db
    .prepare(`SELECT DISTINCT meal FROM menu_items ORDER BY meal`)
    .all()
    .map((r) => r.meal);
  const total = db.prepare(`SELECT COUNT(*) AS c FROM menu_items`).get().c;
  return { halls, dates, meals, total };
}

function getLatestDate(hall) {
  const row = db
    .prepare(
      `SELECT menu_date FROM menu_items
       WHERE dining_hall = ? ORDER BY menu_date DESC LIMIT 1`
    )
    .get(hall);
  return row ? row.menu_date : null;
}

// --- Plates (meal tracking) ---

const insertPlateStmt = db.prepare(`
  INSERT INTO plates (name, dining_hall, menu_date, image, items_json, totals_json, created_at)
  VALUES (@name, @dining_hall, @menu_date, @image, @items_json, @totals_json, @created_at)
`);

function savePlate({ name, dining_hall, menu_date, image, items, totals }) {
  const info = insertPlateStmt.run({
    name: name || "Unnamed Plate",
    dining_hall: dining_hall || null,
    menu_date: menu_date || null,
    image: image || null,
    items_json: JSON.stringify(items || []),
    totals_json: JSON.stringify(totals || null),
    created_at: new Date().toISOString(),
  });
  return getPlate(info.lastInsertRowid);
}

function parsePlate(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    dining_hall: row.dining_hall,
    menu_date: row.menu_date,
    image: row.image,
    items: JSON.parse(row.items_json || "[]"),
    totals: row.totals_json ? JSON.parse(row.totals_json) : null,
    created_at: row.created_at,
  };
}

function getPlate(id) {
  return parsePlate(db.prepare(`SELECT * FROM plates WHERE id = ?`).get(id));
}

// List plates. By default omits the (large) image for a lightweight listing;
// pass withImages=true to include them.
function listPlates(withImages = false) {
  const cols = withImages
    ? "*"
    : "id, name, dining_hall, menu_date, items_json, totals_json, created_at";
  return db
    .prepare(`SELECT ${cols} FROM plates ORDER BY created_at DESC`)
    .all()
    .map((row) => {
      const p = parsePlate({ image: null, ...row });
      return p;
    });
}

module.exports = {
  db,
  replaceForHallDate,
  getMenu,
  getLatestDate,
  getRawRows,
  getRawFilters,
  savePlate,
  getPlate,
  listPlates,
};
