# UMass Dining — Menus & Nutrition

A website + database for UMass dining halls. When a hall's menu is loaded, the
server scrapes today's menu and all nutrition facts from umassdining.com and
saves them into a local SQLite database, then serves them to the frontend.

Dining halls: **Berkshire, Worcester, Franklin, Hampshire**
Source: `https://www.umassdining.com/locations-menus/{hall}/menu`

## Stack

- **Backend:** Node.js + Express
- **Scraper:** `cheerio` (parses nutrition facts from the page's `data-*` attributes)
- **Database:** SQLite via `better-sqlite3` (file: `dining.db`, created automatically)
- **Frontend:** static HTML/CSS/JS in `public/`

## How it works

1. The browser requests `GET /api/menu/:hall`.
2. The server scrapes that hall's live menu page (throttled to once every 5
   minutes per hall) and parses every dish: meal, station, name, serving size,
   calories, fat, saturated/trans fat, cholesterol, sodium, carbs, fiber,
   sugars, protein (with % daily values), plus allergens, ingredients, diet
   tags, healthfulness and carbon rating.
3. It **replaces** that hall's rows for today's date in `dining.db`
   (`replaceForHallDate`), then returns the saved rows.
4. The frontend renders tabs per hall and per meal, grouped by station. Click a
   dish to see its full nutrition facts panel.

## Run it

Requires Node.js 18+ (uses the built-in `fetch`).

```bash
cd website
npm install
npm start
```

Then open http://localhost:3000.

> Note: during setup Node was installed locally at `~/.local/node`. If `node`
> isn't on your PATH, run:
> ```bash
> export PATH="$HOME/.local/node/bin:$PATH"
> ```

## Pages

- `/` — **Meal Tracker** (front page): track what's on your plate at a hall.
- `/menu.html` — browse full menus & nutrition by hall/meal.
- `/dev.html` — raw database table (developer tool).

## Meal Tracker (front page)

Mobile-first page to log a plate:

- **Hall buttons** along the top pick the dining hall. Switching halls while a
  plate has content prompts: *"Warning: switching dining halls will clear your
  current plate."*
- **Photo box** uploads a plate photo (opens the camera on mobile via
  `capture`, gallery otherwise).
- **Plate name** is editable, defaulting to *Unnamed Plate*.
- **`+` button** adds a food row. When the plate is empty it shows
  *"Select [+] to add food to your plate!"*
- Each **food row** is a chip with two sub-chips:
  - *Food*: a searchable dropdown of today's foods for that hall; an invalid
    search shows *"no food found in {hall} for today."*
  - *Portion*: shows the food's scraped serving unit and a servings multiplier,
    defaulting to 1 serving. Nutrition scales by servings.
- **Nutrition overview** aggregates the plate: additive nutrients (calories,
  protein, carbs, fats, sodium, etc.) are summed and scaled by servings;
  healthfulness and carbon score are averaged. "Choose metrics" toggles which
  cards show (saved in `localStorage`).
- **Save** stores the plate (photo + foods + totals) to the `plates` table.
  **Load (dev)** lists saved plates and restores one.

## Developer page

`http://localhost:3000/dev.html` (linked from the home page header) shows the
raw `menu_items` table in tabular form, straight from the database:

- every column in the table, with sticky headers and horizontal scroll
- filter by hall / date / meal, choose page size, and page through all rows
- client-side text filter over the currently loaded rows
- click a long cell (ingredients, allergens) to expand/collapse it

## API

- `GET /api/halls` → list of dining halls
- `GET /api/menu/:hall` → `{ hall, date, count, items[] }` (scrapes if stale, saves to DB)
- `GET /api/menu/:hall?refresh=1` → force a re-scrape now
- `GET /api/raw/filters` → `{ halls, dates, meals, total }` distinct values for the dev page
- `GET /api/raw?hall=&date=&meal=&limit=&offset=` → raw rows `{ total, limit, offset, columns, rows }`
- `POST /api/plates` → save a tracked plate `{ name, dining_hall, menu_date, image, items[], totals }`
- `GET /api/plates` → list saved plates (images omitted; `?images=1` to include)
- `GET /api/plates/:id` → one saved plate, including its photo

## Database schema

- `menu_items` — one row per dish per hall/date/meal/station, uniquely keyed on
  `(dining_hall, menu_date, meal, station, dish_name)`.
- `plates` — one row per saved plate: `name`, `dining_hall`, `menu_date`,
  `image` (data URL), `items_json`, `totals_json`, `created_at`.

See `db.js` for the full column list.

## Files

- `server.js` — Express server, scrape-on-load + API
- `scraper.js` — fetches and parses the UMass Dining pages
- `db.js` — SQLite schema and queries
- `public/index.html`, `tracker.css`, `tracker.js` — meal tracker front page
- `public/menu.html`, `styles.css`, `app.js` — menu browser
- `public/dev.html`, `dev.css`, `dev.js` — developer raw-database table view

## Dining hall covers and saved nutrition

- `public/hall-theme.js` maps each hall to its photograph, crop position, accent
  and residential area. The default photos are the banners on the respective
  official UMass Dining location pages. Replace an `image` URL with a local asset
  such as `images/halls/worcester.webp` to use your own photo.
- The tracker and menu browser share the same cover configuration. The photo
  fades in after loading; a hall-specific gradient remains if it fails.
- New meals save per-serving nutrition in `items[].nutrition`, inside the existing
  `items_json` column. No schema migration is required. Historical meals use that
  snapshot, even when today's menu changes or is unavailable. Older saves without
  snapshots retain their stored aggregate totals until food or portions are edited;
  unavailable values are shown as an em dash rather than zero.
- Run `npm test` for the menu race and nutrition-history regression checks.
