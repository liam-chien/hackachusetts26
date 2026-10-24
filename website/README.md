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
- `/history.html` — **Meal history**: trend chart (week/month/year/all) + a searchable, recency-sorted list of saved meals.
- `/edit.html?id=<id>` — **Edit meal**: change a saved meal's foods/portions/photo/name. The original date is preserved (editing never moves a meal to today). Also supports delete.
- `/menu.html` — browse full menus & nutrition by hall/meal.
- `/dev.html` — raw database table (developer tool).

## Meal history & editing

- The history page reads every saved plate, derives numeric nutrition from each
  meal's per-food snapshot (`public/nutrition.js`, shared with the tracker), and
  plots one bar per meal for the chosen metric and time range.
- The list is sorted newest-first and searches across name, hall, date, and food
  names. Clicking a meal opens the edit page.
- Editing uses `PUT /api/plates/:id`, which updates name/hall/image/items/totals
  but **preserves `menu_date` and `created_at`**.

## Account & preferences

`/account.html` stores a single user profile (there is no auth yet):

- **Name**
- **Allergen categories** (Milk, Eggs, Gluten, Wheat, Soy, Corn, Sesame, Tree
  Nuts, Peanuts, Fish, Shellfish) — the categories present in the scraped data.
- **Foods to avoid** — free-text terms matched against dish names.
- **Nutrition goals** — addable chips, each a macronutrient + target + recurrence
  (per meal / per day / per week).

These drive two things on the meal tracker:

- **Goal progress bars** render in the Nutrition overview. Per-meal goals track
  the current plate; per-day/week goals add the current plate on top of what
  was already eaten in that window (from saved meals, via `/api/plates-between`).
- **Allergen / avoided warnings**: any plate food containing a chosen allergen
  or an avoided term gets a red highlight and a red "!" badge, with a line
  explaining why, plus a summary banner above the plate.

## Demo data

`node seed_demo.js` clears all saved plates and generates ~11 example meals
spread across the past few months, using real scraped foods (scrapes menus
first if the DB is empty) so nutrition is realistic. Each meal is dated in the
past via its `menu_date` and `created_at`.

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
- `PUT /api/plates/:id` → update a saved plate in place (preserves `menu_date` + `created_at`)
- `DELETE /api/plates/:id` → delete a saved plate
- `GET /api/plates-between?from=&to=` → saved plates in a date window (for goal baselines)
- `GET /api/profile` → the user's profile `{ name, allergens[], avoid_foods[], goals[] }`
- `PUT /api/profile` → save the profile

## Database schema

- `menu_items` — one row per dish per hall/date/meal/station, uniquely keyed on
  `(dining_hall, menu_date, meal, station, dish_name)`.
- `plates` — one row per saved plate: `name`, `dining_hall`, `menu_date`,
  `image` (data URL), `items_json`, `totals_json`, `created_at`.
- `profile` — single row (`id = 1`): `name`, `allergens`, `avoid_foods`,
  `goals` (all JSON), `updated_at`.

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

## Generate plate from image (vision + matcher)

When a photo is added to a plate on the tracker, a **Generate plate from image**
button appears (only if the vision model is installed on the server). It runs a
two-stage pipeline:

1. **Vision model** (`model/vision model/recognize_food.py`) — a local
   Qwen3-VL food model (via llama.cpp) classifies the photo into generic foods
   with estimated gram weights.
2. **Menu matcher** (`src/matching/menu_mathcer.py`) — maps each generic food
   to the most likely item on the hall's scraped menu.

The server bridges to these Python CLIs in `website/model_bridge.js`, converts
the matcher's gram estimates into serving multipliers (using each item's
`serving_size`), and returns plate items the tracker fills in. Unmatched foods
are reported so you can add them manually.

### Server endpoints

- `GET /api/generate-plate/status` → `{ available }` (is the vision model installed?)
- `POST /api/generate-plate` `{ image (data URL), hall }` → `{ items[], unmatched[] }`

### Setup (optional; needed only for this feature)

The vision model is a heavy local dependency (~2.6 GB of weights plus a
`llama-server` binary) and is **not** required to run the rest of the site.
If it isn't installed, the button stays hidden and the endpoint returns a clear
"not installed" message.

```bash
# one-time: Python deps for the matcher (+ vision) used by the server bridge
python3 -m venv .venv-models
.venv-models/bin/pip install rapidfuzz            # matcher
# vision model weights + runtime:
cd "model/vision model" && python3 setup.py       # downloads ~2.6 GB
```

The server prefers `.venv-models/bin/python` if present, else falls back to
system `python3`.
