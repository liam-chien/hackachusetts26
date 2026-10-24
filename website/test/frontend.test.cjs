const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// Small DOM boundary for testing the actual page controllers without a browser
// or listening socket. Layout and native file upload are checked in Chrome.
class Element {
  constructor() {
    this.value = ''; this.textContent = ''; this.innerHTML = ''; this.children = [];
    this.style = { setProperty(key, value) { this[key] = value; } };
    this.attributes = {}; this.disabled = false;
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      contains: (name) => classes.has(name),
      toggle(name, enabled = !classes.has(name)) {
        if (enabled) classes.add(name); else classes.delete(name);
      },
    };
  }
  appendChild(child) { this.children.push(child); }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; delete this[name]; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  focus() {}
}
const response = (data, ok = true) => ({ ok, json: async () => data });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const food = (overrides = {}) => ({ id: 1, dish_name: 'Rice', serving_size: '1 cup', calories: '100', protein: '2g', total_carb: '22g', total_fat: '1g', healthfulness: '4', carbon_rating: 'A', ...overrides });

async function page(script = 'tracker.js') {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) {
        const element = new Element();
        if (/Modal$|photoPreview|removePhotoBtn|menuNotice/.test(id)) element.classList.add('hidden');
        elements.set(id, element);
      }
      return elements.get(id);
    },
    createElement: () => new Element(),
    querySelectorAll: () => [], addEventListener() {},
    documentElement: new Element(), activeElement: new Element(),
  };
  const images = [];
  const context = vm.createContext({
    document, AbortController, Date, console: { error() {} }, confirm: () => true,
    localStorage: { getItem: () => null, setItem() {} },
    Image: class { constructor() { images.push(this); } },
    FileReader: class { readAsDataURL() {} },
    fetch: async (url) => url === '/api/halls'
      ? response({ halls: ['Berkshire', 'Worcester', 'Franklin', 'Hampshire'] })
      : response({ date: '2026-10-24', items: [food()] }),
  });
  const publicDir = path.join(__dirname, '..', 'public');
  const theme = fs.readFileSync(path.join(publicDir, 'hall-theme.js'), 'utf8');
  const source = fs.readFileSync(path.join(publicDir, script), 'utf8');
  const exports = script === 'tracker.js'
    ? 'state, el, initPromise, selectHall, loadPlate, aggregate, metricDisplay, METRICS, clearPlate, setPhoto, plateChanged, applyHallTheme'
    : 'state, el, initPromise, selectHall, applyHallTheme';
  vm.runInContext(`${theme}\n${source}\nglobalThis.api = { ${exports} };`, context);
  await context.api.initPromise;
  return { context, ...context.api, images, elements, document };
}

for (const script of ['tracker.js', 'app.js']) {
  test(`${script}: late response cannot replace the newest hall`, async () => {
    const p = await page(script);
    const old = deferred(), latest = deferred();
    p.context.fetch = async (url) => {
      // Deliberately ignore AbortSignal: request identity must also protect JSON parsing.
      const data = await (url.includes('Worcester') ? latest.promise : old.promise);
      return response(data);
    };
    const a = p.selectHall('Franklin');
    const b = p.selectHall('Worcester');
    assert.equal(p.state.items.length, 0);
    latest.resolve({ date: '2026-10-24', items: [food({ dish_name: 'Worcester rice' })] });
    await b;
    old.resolve({ date: '2026-10-23', items: [food({ dish_name: 'Franklin rice' })] });
    await a;
    assert.equal(p.state.hall, 'Worcester');
    assert.equal(p.state.items[0].dish_name, 'Worcester rice');
    assert.equal(p.state.date, '2026-10-24');
  });
  test(`${script}: HTTP failure clears stale menu and leaves retryable state`, async () => {
    const p = await page(script);
    p.context.fetch = async () => response({ error: 'offline' }, false);
    await p.selectHall('Hampshire');
    assert.equal(p.state.items.length, 0);
    assert.equal(p.state.date, null);
    if (script === 'tracker.js') {
      assert.equal(p.el.addFoodBtn.disabled, true);
      assert.match(p.el.menuNotice.textContent, /couldn't load/);
    } else {
      assert.equal(p.el.refreshBtn.disabled, false);
      assert.match(p.el.statusMsg.textContent, /Refresh/);
    }
  });
}

test('saved nutrition survives a different current menu and can be rescaled', async () => {
  const p = await page();
  p.state.rows = [{ uid: 1, item: food(), servings: 2 }];
  let saved;
  p.context.fetch = async (url, options) => {
    if (url === '/api/plates') {
      saved = { id: 9, ...JSON.parse(options.body) };
      return response(saved);
    }
    if (url === '/api/plates/9') return response(saved);
    return response({ date: '2026-10-25', items: [food({ calories: '999' })] });
  };
  await p.el.saveBtn.onclick();
  assert.equal(saved.items[0].nutrition.calories, '100');
  assert.equal(saved.totals.calories, '200 kcal');
  await p.loadPlate(9);
  assert.equal(p.state.rows[0].item.calories, '100');
  assert.equal(p.state.date, '2026-10-24');
  assert.equal(p.metricDisplay(p.METRICS[0], p.aggregate()), '200 kcal');
  p.state.rows[0].servings = 0.5;
  assert.equal(p.metricDisplay(p.METRICS[0], p.aggregate()), '50 kcal');
});

test('legacy meals retain saved totals without substituting current nutrition', async () => {
  const p = await page();
  p.context.fetch = async (url) => url.startsWith('/api/plates/')
    ? response({ id: 3, name: 'Old lunch', dining_hall: 'Berkshire', menu_date: '2026-09-01', items: [{ id: 1, dish_name: 'Rice', servings: 1 }], totals: { calories: '321' } })
    : response({ date: '2026-10-24', items: [food({ calories: '999' })] });
  await p.loadPlate(3);
  assert.equal(p.state.legacyTotals.calories, '321');
  assert.match(p.el.overview.innerHTML, /321/);
  assert.equal(p.state.rows[0].item.calories, null);
  p.plateChanged();
  assert.equal(p.state.legacyTotals, null);
  assert.equal(p.metricDisplay(p.METRICS[0], p.aggregate()), '—');
});

test('zero portions do not affect scores; missing nutrients never appear as zero', async () => {
  const p = await page();
  p.state.rows = [{ item: food(), servings: 1 }, { item: food({ calories: null, carbon_rating: 'E' }), servings: 0 }];
  assert.equal(p.metricDisplay(p.METRICS[0], p.aggregate()), '100 kcal');
  assert.equal(p.metricDisplay(p.METRICS.at(-1), p.aggregate()), 'A');
  p.state.rows[1].servings = 1;
  assert.equal(p.metricDisplay(p.METRICS[0], p.aggregate()), '—');
  p.state.rows[1].item.calories = 'N/A';
  assert.equal(p.metricDisplay(p.METRICS[0], p.aggregate()), '—');
});

test('a saved meal remains usable when its menu is offline', async () => {
  const p = await page();
  p.context.fetch = async (url) => {
    if (url.startsWith('/api/menu/')) throw new Error('offline');
    return response({ id: 5, name: 'Yesterday', dining_hall: 'Berkshire', menu_date: '2026-10-23', items: [{ id: 1, dish_name: 'Rice', servings: 2, nutrition: food() }] });
  };
  await p.loadPlate(5);
  assert.equal(p.state.date, '2026-10-23');
  assert.equal(p.metricDisplay(p.METRICS[0], p.aggregate()), '200 kcal');
  assert.equal(p.el.saveBtn.disabled, false);
  assert.equal(p.el.addFoodBtn.disabled, true);
});

test('clearing a meal resets the photo and its hidden state', async () => {
  const p = await page();
  p.setPhoto('data:image/png;base64,abc');
  assert.equal(p.el.photoPlaceholder.classList.contains('hidden'), true);
  assert.equal(p.el.photoPreview.classList.contains('hidden'), false);
  p.clearPlate();
  assert.equal(p.state.photo, null);
  assert.equal(p.el.photoInput.value, '');
  assert.equal(p.el.photoPlaceholder.classList.contains('hidden'), false);
  assert.equal(p.el.photoPreview.classList.contains('hidden'), true);
  assert.equal(p.el.photoPreview.src, undefined);
});

test('a late cover image cannot overwrite a different dining hall', async () => {
  const p = await page();
  p.applyHallTheme('Worcester');
  const old = p.images.at(-1);
  p.applyHallTheme('Franklin');
  const latest = p.images.at(-1);
  latest.onload();
  old.onload();
  assert.match(p.elements.get('hallPhoto').style.backgroundImage, /10J_0/);
  assert.equal(p.elements.get('hallTitle').textContent, 'Franklin Dining Commons');
  p.applyHallTheme('Hampshire');
  p.images.at(-1).onerror();
  assert.equal(p.elements.get('hallHero').classList.contains('has-photo'), false);
  assert.equal(p.elements.get('hallPhoto').style.backgroundImage, 'none');
});
