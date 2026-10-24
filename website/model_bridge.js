// Bridges the website to the Python model pipeline for the image -> plate flow.
//
//   image (JPEG)  --vision model-->  generic foods + grams
//   generics + menu  --matcher-->    matched menu item ids + grams
//
// Both models are Python CLIs invoked as child processes. The vision model is
// a heavy local dependency (a ~2.6 GB llama.cpp model that must be installed
// via its setup.py); if it isn't installed, generatePlate() fails with a clear
// message instead of crashing the server.

const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, ".."); // repo root (website/ is under it)
const VISION_DIR = path.join(ROOT, "model", "vision model");
const VISION_SCRIPT = path.join(VISION_DIR, "recognize_food.py");
const MATCHER_SCRIPT = path.join(ROOT, "src", "matching", "menu_mathcer.py");

// Prefer the models venv created during setup; fall back to system python3.
function pythonExe() {
  const venv = path.join(ROOT, ".venv-models", "bin", "python");
  return fs.existsSync(venv) ? venv : "python3";
}

// Grams per unit for serving-size parsing. Only mass units convert cleanly;
// count/volume units can't be turned into grams without a density, so those
// fall back to a 1-serving estimate.
const GRAMS_PER = { oz: 28.3495, g: 1, gram: 1, grams: 1, lb: 453.592, kg: 1000 };

// Parse "5 oz", "1 EACH", "1/2 Sandwich" -> { grams:number|null, unit }.
function servingGrams(servingSize) {
  if (!servingSize) return { grams: null, unit: "serving" };
  const s = String(servingSize).trim();
  const m = s.match(/^((\d+\s+\d+\/\d+)|(\d+\/\d+)|(\d+(\.\d+)?))\s*([a-zA-Z]*)/);
  if (!m) return { grams: null, unit: "serving" };
  const qtyStr = m[1];
  let qty;
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
  const unit = (m[6] || "").toLowerCase();
  const perUnit = GRAMS_PER[unit];
  if (!perUnit || !(qty > 0)) return { grams: null, unit: unit || "serving" };
  return { grams: qty * perUnit, unit };
}

// Convert scraped menu_items rows into the matcher's expected menu JSON
// (needs id, name, and nutrition_per_100g). Nutrition fields are the scraped
// per-serving strings; the matcher only uses id+name for matching, so the
// nutrition block here is best-effort and not relied upon downstream.
function toMatcherMenu(hall, date, items) {
  return {
    date: date || null,
    dining_hall: hall || null,
    meal: null,
    items: items.map((it) => ({
      id: it.id,
      name: it.dish_name,
      station: it.station || undefined,
    })),
  };
}

function runPython(scriptArgs, { cwd, input, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(pythonExe(), scriptArgs, { cwd });
    let stdout = "", stderr = "";
    const timer = timeoutMs
      ? setTimeout(() => { proc.kill("SIGKILL"); reject(new Error("Model timed out")); }, timeoutMs)
      : null;
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", (err) => { if (timer) clearTimeout(timer); reject(err); });
    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || `Exited with code ${code}`));
    });
    if (input != null) { proc.stdin.write(input); proc.stdin.end(); }
  });
}

// True if the vision model appears to be installed (weights + runtime present).
function visionInstalled() {
  return (
    fs.existsSync(path.join(VISION_DIR, "weights")) &&
    fs.existsSync(path.join(VISION_DIR, "runtime"))
  );
}

// The vision model only accepts single-frame JPEGs. Phone photos are often
// MPO (iPhone multi-picture) or HEIC, which it rejects. Flatten any input to a
// plain RGB JPEG (first frame) with Pillow before handing it to the model.
async function normalizeToJpeg(srcPath) {
  const outPath = path.join(os.tmpdir(), `norm_${Date.now()}.jpg`);
  const code = [
    "import sys",
    "from PIL import Image, ImageOps",
    "im = Image.open(sys.argv[1])",
    "try:",
    "    im.seek(0)",  // first frame for MPO/animated
    "except Exception:",
    "    pass",
    "im = ImageOps.exif_transpose(im).convert('RGB')",
    "im.save(sys.argv[2], format='JPEG', quality=92)",
  ].join("\n");
  await runPython(["-c", code, srcPath, outPath], { timeoutMs: 60 * 1000 });
  return outPath;
}

// Run the vision model on an image file -> { title, components: [...] }.
async function runVision(imagePath) {
  // Ensure a clean JPEG the model will accept (handles iPhone MPO/HEIC).
  let jpegPath = imagePath;
  let normalized = false;
  try {
    jpegPath = await normalizeToJpeg(imagePath);
    normalized = true;
  } catch (err) {
    // If normalization fails, fall back to the original and let the model try.
    jpegPath = imagePath;
  }
  const outPath = path.join(os.tmpdir(), `vision_${Date.now()}.json`);
  try {
    await runPython([VISION_SCRIPT, jpegPath, "-o", outPath], {
      cwd: VISION_DIR,
      timeoutMs: 10 * 60 * 1000, // first run loads a big model; be generous
    });
    const result = JSON.parse(fs.readFileSync(outPath, "utf8"));
    fs.unlink(outPath, () => {});
    return result;
  } finally {
    if (normalized) fs.unlink(jpegPath, () => {});
  }
}

// Translate the vision model's output shape into what the matcher expects.
// Vision: { title, components: [{ name, query, estimated_weight_grams }] }
// Matcher: { foods: [{ name, weight_g }] }
function visionToMatcherFoods(vision) {
  const components = Array.isArray(vision && vision.components) ? vision.components : [];
  return {
    foods: components.map((c) => ({
      name: c && typeof c.name === "string" ? c.name : null,
      weight_g: typeof c.estimated_weight_grams === "number" ? c.estimated_weight_grams : null,
    })),
  };
}

// Run the matcher: generic foods + menu -> match results.
async function runMatcher(visionResult, matcherMenu) {
  const qwenPath = path.join(os.tmpdir(), `qwen_${Date.now()}.json`);
  const menuPath = path.join(os.tmpdir(), `menu_${Date.now()}.json`);
  // Translate the vision model's { components, estimated_weight_grams } shape
  // into the matcher's expected { foods, weight_g } shape.
  fs.writeFileSync(qwenPath, JSON.stringify(visionToMatcherFoods(visionResult)));
  fs.writeFileSync(menuPath, JSON.stringify(matcherMenu));
  try {
    const { stdout } = await runPython([MATCHER_SCRIPT, qwenPath, menuPath], {
      cwd: path.dirname(MATCHER_SCRIPT),
      timeoutMs: 60 * 1000,
    });
    return JSON.parse(stdout);
  } finally {
    fs.unlink(qwenPath, () => {});
    fs.unlink(menuPath, () => {});
  }
}

// Full pipeline: image + the hall's scraped menu -> plate items for the tracker.
// `items` is the scraped menu_items array for the hall.
// Returns { items: [{ id, dish_name, serving_size, servings, grams,
//                      predicted_name, status }], unmatched: [...] }.
async function generatePlate({ imagePath, hall, date, items }) {
  if (!visionInstalled()) {
    const err = new Error(
      "The food vision model isn't installed on the server. Run setup.py in " +
      "'model/vision model' to download the weights, then try again."
    );
    err.code = "VISION_NOT_INSTALLED";
    throw err;
  }
  const vision = await runVision(imagePath);
  const matcherMenu = toMatcherMenu(hall, date, items);
  const matched = await runMatcher(vision, matcherMenu);

  const byId = new Map(items.map((it) => [String(it.id), it]));
  const plateItems = [];
  const unmatched = [];

  for (const r of matched.results || []) {
    const top = (r.candidates || [])[0];
    if (!top || r.status === "unmatched") {
      unmatched.push({ predicted_name: r.predicted_name, grams: r.estimated_weight_g });
      continue;
    }
    const menuItem = byId.get(String(top.id));
    if (!menuItem) {
      unmatched.push({ predicted_name: r.predicted_name, grams: r.estimated_weight_g });
      continue;
    }
    // Convert the estimated grams into a servings multiplier when the serving
    // size has a mass unit; otherwise fall back to 1 serving.
    const grams = typeof r.estimated_weight_g === "number" ? r.estimated_weight_g : null;
    const { grams: servingG } = servingGrams(menuItem.serving_size);
    let servings = 1;
    if (grams != null && servingG) servings = Math.max(0.25, Math.round((grams / servingG) * 4) / 4);
    plateItems.push({
      id: menuItem.id,
      dish_name: menuItem.dish_name,
      serving_size: menuItem.serving_size,
      servings,
      grams,
      predicted_name: r.predicted_name,
      status: r.status, // auto_match | needs_confirmation
    });
  }

  return { items: plateItems, unmatched, vision_title: vision.title || null };
}

module.exports = { generatePlate, visionInstalled, servingGrams, toMatcherMenu };
