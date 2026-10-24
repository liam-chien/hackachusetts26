#!/usr/bin/env node
"use strict";

/**
 * U-Eat meal recommender (standalone, deterministic, no dependencies).
 *
 * Usage:
 *   node recommender.js <profile.json> <remaining.json> <menu.json>
 *                       [--tiers 3|all] [--similar 0.05] [--meal Lunch] [--verbose]
 *
 * Inputs
 *   profile.json    allergies, excluded_ingredients, dietary_restrictions { required, excluded },
 *                   daily_goals. Any field may be omitted or empty; it is then not evaluated.
 *                   daily_goals gives each goal's type (minimum / maximum / range), target and
 *                   enforcement (hard / soft, default soft).
 *   remaining.json  How much the user has LEFT today for minimum and range goals, e.g.
 *                     { "protein": 60, "fiber": "12g", "calories": { "amount": 900, "unit": "kcal" } }
 *                   (a { "remaining": {...} } wrapper is also accepted).
 *                   - minimum goal: amount still needed to reach the target (0 or less = reached).
 *                   - range goal:   amount left before the range max.
 *                   - maximum goal: not needed. Optional; if given (amount left before the limit,
 *                     negative = already over) it is only used for limit warnings.
 *                   Plain numbers use the unit written in the profile goal (or the default unit);
 *                   strings like "12g" / "800mg" are converted. Nutrient names accept the same
 *                   aliases as daily_goals (fiber, carbs, sat_fat, ...).
 *                   A missing minimum/range goal is treated as fully left, with a warning.
 *                   Entries with no matching goal in the profile are ignored, with a warning.
 *   menu.json       [item, ...] or { items: [item, ...] }. Item fields: dish_name, meal, station,
 *                   serving_size, allergens, ingredients, diets, calories, calories_from_fat,
 *                   total_fat, sat_fat, trans_fat, cholesterol, sodium, total_carb, dietary_fiber,
 *                   sugars, protein. Nutrient values may be numbers or strings with units
 *                   ("2.2g", "637.1mg", "222", "1,200mg").
 *
 * Output (default): JSON on stdout with only the tiers (top 3 by default):
 *   { "tiers": [ { "tier": 1, "dishes": [
 *       { "id": 105, "medium_warning": ["sodium"], "critical_warning": ["cholesterol"] } ] } ] }
 *   - Each tier holds every dish scoring within 5% (--similar) of the tier's best score, so
 *     the output can contain more than 3 dishes.
 *   - Dishes are identified by the menu item's "id" (its dish_name if it has no id).
 *   - medium_warning / critical_warning list the nutrients that set off each level (see
 *     "Limits" below); empty lists mean no warning.
 * Output (--verbose): the full result, with scores, per-goal breakdowns, detailed warnings,
 * excluded dishes with reasons, and general warnings. Useful for debugging.
 * Remaining amounts are read as given and are not recalculated or reported back.
 *
 * Scoring (only configured goals are evaluated; an omitted goal never counts as zero)
 *   - Minimum goal: priority = share of the target still left (0..1). The item earns
 *       priority x (amount it covers of what's left) / target.
 *     So nutrients the user is furthest behind on count the most, and nothing is earned past
 *     what's left.
 *   - Maximum goal (sodium, sugars, trans fat, cholesterol, ...): less is always better,
 *     whatever has been eaten. Penalty = amount / daily limit.
 *   - Range goal: the part below the range min works like a minimum goal (priority = share of
 *     the min still needed); going past the max is a penalty of (excess / max).
 *   - Limits never exclude an item; they add flags. The threshold is what's left under the
 *     limit (if given in remaining.json) or else the whole daily limit. Warning levels:
 *       "critical": the item reaches or goes over the threshold.
 *       "medium":   the item uses at least 50% (MEDIUM_SHARE) of it without reaching it.
 *     This applies to hard and soft goals alike, and even when the item ranks well because
 *     it's one of the lowest options. Flagged items keep their normal score and tier.
 *     A flagged item gets:
 *       warning_summary: { medium: [nutrient, ...], critical: [nutrient, ...] }
 *       warnings: [{ level, nutrient, amount, limit_left, unit, goal_enforcement, message }]
 *     Nutrient names are the goal names from the profile (e.g. "sodium", "saturated_fat").
 *   - Score = average over configured goals. Higher is better.
 *   - Only what's still needed counts. A goal already met adds nothing, and two items that
 *     both cover everything left for a goal score the same on it. So 40 g protein + 1 g fiber
 *     beats 40 g protein + 0 g fiber only while fiber is still needed.
 *   - Tiers: a tier starts at its best remaining item and takes every next item whose score is
 *     within --similar (default 0.05 = 5% of the best score's size) of it. --similar 0 groups
 *     exact ties only. Within a tier, items are sorted by score, then menu order.
 *   - With no goals configured, nothing tells items apart, so every eligible item is in tier 1,
 *     in menu order (meal: Breakfast, Lunch, Dinner, Late Night, other; station; dish name).
 *
 * Restrictions (each is skipped when its list is empty or missing)
 *   - allergies: matched against the item's allergens and ingredients (not the dish name).
 *     A term matches the start of a word, so "soy" also catches "soybean oil".
 *   - excluded_ingredients: whole-word match against ingredients only (not the dish name).
 *   - dietary_restrictions.required: every label must be on the item ("vegan" counts as
 *     vegetarian). excluded: none of the labels may be on the item.
 *   - Items missing data a configured check needs are excluded with a reason, since unknown
 *     allergen or nutrient data can't be treated as safe or as zero.
 */

const fs = require("fs");

// ---- Nutrient catalogue ---------------------------------------------------
const NUTRIENTS = {
  calories: { unit: "kcal" },
  calories_from_fat: { unit: "kcal" },
  total_fat: { unit: "g" },
  sat_fat: { unit: "g" },
  trans_fat: { unit: "g" },
  cholesterol: { unit: "mg" },
  sodium: { unit: "mg" },
  total_carb: { unit: "g" },
  dietary_fiber: { unit: "g" },
  sugars: { unit: "g" },
  protein: { unit: "g" },
};

// Goal / remaining names -> menu field.
const GOAL_ALIASES = {
  calories: "calories", energy: "calories",
  calories_from_fat: "calories_from_fat",
  fat: "total_fat", total_fat: "total_fat",
  saturated_fat: "sat_fat", sat_fat: "sat_fat",
  trans_fat: "trans_fat",
  cholesterol: "cholesterol",
  sodium: "sodium",
  carbs: "total_carb", carbohydrates: "total_carb", total_carbohydrates: "total_carb", total_carb: "total_carb",
  fiber: "dietary_fiber", dietary_fiber: "dietary_fiber",
  sugar: "sugars", sugars: "sugars",
  protein: "protein",
};

// Own-property lookup, so JSON keys like "constructor" or "__proto__" never hit Object.prototype.
const lookup = (table, key) => (Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined);

const UNIT_FACTORS = { g: { g: 1, mg: 1000 }, mg: { g: 0.001, mg: 1 }, kcal: { kcal: 1 } };
const UNIT_ALIASES = {
  g: "g", gram: "g", grams: "g", gm: "g",
  mg: "mg", milligram: "mg", milligrams: "mg",
  kcal: "kcal", cal: "kcal", cals: "kcal", calorie: "kcal", calories: "kcal", kilocalories: "kcal",
};
// Factor converting `from` units into `to` units, or null if incompatible.
function unitFactor(from, to) {
  const f = lookup(UNIT_FACTORS, from);
  return f ? lookup(f, to) ?? null : null;
}

const MEAL_ORDER = { breakfast: 1, lunch: 2, dinner: 3, "late night": 4 };
// Labels that also satisfy a required diet (vegan food is vegetarian).
const DIET_IMPLIED_BY = { vegetarian: ["vegan"] };

const PROFILE_KEYS = ["allergies", "excluded_ingredients", "dietary_restrictions", "daily_goals"];
const RESTRICTION_KEYS = ["required", "excluded"];
const GOAL_KEYS = ["unit", "type", "target", "min", "max", "enforcement"];

const EPS = 1e-9; // float tolerance, e.g. 0.1 + 0.2 vs 0.3
const SCORE_DECIMALS = 6; // scores are compared and shown at this precision
// An item using at least this share of what's left under a limit (without reaching it)
// gets a "medium" warning; reaching the limit gets a "critical" warning.
const MEDIUM_SHARE = 0.5;

class ValidationError extends Error {
  constructor(errors) {
    super("Invalid input:\n  - " + errors.join("\n  - "));
    this.name = "ValidationError";
    this.errors = errors;
  }
}

// ---- Generic helpers ------------------------------------------------------
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, " ");
const normKey = (s) => norm(s).replace(/[ -]/g, "_");
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const clamp01 = (n) => Math.min(1, Math.max(0, n));

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matcher for a normalized term, accepting singular/plural ("peanut" / "peanuts").
 * Whole-word by default. With prefix=true the term only has to start a word
 * ("soy" matches "soybean oil"); used for allergies, where over-matching is safer.
 */
function termMatcher(term, { prefix = false } = {}) {
  const forms = new Set([term]);
  if (term.endsWith("es")) forms.add(term.slice(0, -2));
  if (term.endsWith("s")) forms.add(term.slice(0, -1));
  else if (!prefix) forms.add(term + "s");
  const alt = [...forms].filter((f) => f.length > 1).map(escapeRe).join("|") || escapeRe(term);
  const end = prefix ? "" : "(?![a-z0-9])";
  return { term, re: new RegExp(`(?<![a-z0-9])(?:${alt})${end}`) };
}

// "a, b; c" or ["a", "b"] -> normalized array; null -> null (unknown).
function toList(value) {
  if (value == null) return null;
  const parts = Array.isArray(value) ? value : String(value).split(/[,;]/);
  return parts.map((p) => norm(p)).filter(Boolean);
}

/**
 * Parse an amount into `canonicalUnit`. Accepts numbers and strings like "222", "2.2g",
 * ".5 g", "1,200mg", "<1g" (taken as 1), "222 Calories". Unitless values are taken to be in
 * `plainUnit`. Returns null if missing or unreadable. Negatives only when allowNegative.
 */
function parseAmount(raw, canonicalUnit, { plainUnit = canonicalUnit, allowNegative = false } = {}) {
  if (raw == null || typeof raw === "boolean") return null;
  const plainFactor = unitFactor(plainUnit, canonicalUnit);
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || (raw < 0 && !allowNegative)) return null;
    return raw * plainFactor;
  }
  const s = String(raw).trim().toLowerCase().replace(/(\d),(?=\d{3}(?!\d))/g, "$1");
  const m = s.match(/^(<?)\s*(-?)(\d+(?:\.\d+)?|\.\d+)\s*([a-z]+)?$/);
  if (!m || (m[2] && (!allowNegative || m[1]))) return null;
  const value = parseFloat(m[2] + m[3]);
  if (!m[4]) return value * plainFactor;
  const f = unitFactor(lookup(UNIT_ALIASES, m[4]), canonicalUnit);
  return f == null ? null : value * f;
}

// Menu nutrient values: canonical units, never negative.
const parseNutrient = (raw, unit) => parseAmount(raw, unit);

// Warn about keys outside the schema (a typo like "alergies" would silently skip a check).
function unknownKeys(obj, allowed, path, warnings) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) warnings.push(`unknown field ${path ? path + "." : ""}${k} was ignored`);
  }
}

// ---- Profile loading (validation + precomputation, done once) -------------
function readStringList(value, path, errors) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array of strings`);
    return [];
  }
  const out = [];
  value.forEach((v, i) => {
    if (typeof v !== "string" || !v.trim()) errors.push(`${path}[${i}] must be a non-empty string`);
    else out.push(norm(v));
  });
  return [...new Set(out)];
}

function buildCriterion(name, goal, errors, warnings) {
  const path = `daily_goals.${name}`;
  const field = lookup(GOAL_ALIASES, normKey(name));
  if (!field) {
    errors.push(`${path}: unknown nutrient (supported: ${Object.keys(GOAL_ALIASES).join(", ")})`);
    return null;
  }
  if (!isObj(goal)) {
    errors.push(`${path} must be an object`);
    return null;
  }
  unknownKeys(goal, GOAL_KEYS, path, warnings);
  const canonical = NUTRIENTS[field].unit;
  if (goal.unit != null && typeof goal.unit !== "string") {
    errors.push(`${path}.unit must be a string`);
    return null;
  }
  const inputUnit = goal.unit == null ? canonical : lookup(UNIT_ALIASES, norm(goal.unit));
  const factor = inputUnit ? unitFactor(inputUnit, canonical) : null;
  if (factor == null) {
    errors.push(`${path}.unit "${goal.unit}" is not compatible with ${canonical}`);
    return null;
  }

  // inputUnit is reused to read plain numbers in remaining.json.
  const c = { name, field, unit: canonical, inputUnit, type: goal.type };
  const num = (key, { positive = false } = {}) => {
    const v = goal[key];
    if (!isNum(v)) errors.push(`${path}.${key} must be a number`);
    else if (v < 0 || (positive && v === 0)) errors.push(`${path}.${key} must be ${positive ? "> 0" : ">= 0"}`);
    else return v * factor;
    return null;
  };
  const enforcement = () => {
    if (goal.enforcement == null) return "soft";
    if (goal.enforcement !== "hard" && goal.enforcement !== "soft") {
      errors.push(`${path}.enforcement must be "hard" or "soft"`);
    }
    return goal.enforcement;
  };

  switch (goal.type) {
    case "minimum":
      c.target = num("target", { positive: true });
      if (goal.enforcement != null) errors.push(`${path}.enforcement only applies to maximum or range goals`);
      if (c.target == null) return null;
      break;
    case "maximum":
      c.target = num("target");
      c.enforcement = enforcement();
      if (c.target == null) return null;
      break;
    case "range":
      c.min = num("min");
      c.max = num("max", { positive: true });
      c.enforcement = enforcement();
      if (c.min == null || c.max == null) return null;
      if (c.min > c.max) {
        errors.push(`${path}: min (${goal.min}) must not exceed max (${goal.max})`);
        return null;
      }
      break;
    default:
      errors.push(`${path}.type must be "minimum", "maximum" or "range"`);
      return null;
  }
  return c;
}

function loadProfile(profile) {
  const errors = [];
  const warnings = [];
  if (!isObj(profile)) throw new ValidationError(["profile must be a JSON object"]);
  unknownKeys(profile, PROFILE_KEYS, "", warnings);

  const allergies = readStringList(profile.allergies, "allergies", errors);
  const excludedIngredients = readStringList(profile.excluded_ingredients, "excluded_ingredients", errors);

  let requiredDiets = [];
  let excludedDiets = [];
  const dr = profile.dietary_restrictions;
  if (dr != null) {
    if (!isObj(dr)) errors.push("dietary_restrictions must be an object");
    else {
      unknownKeys(dr, RESTRICTION_KEYS, "dietary_restrictions", warnings);
      requiredDiets = readStringList(dr.required, "dietary_restrictions.required", errors);
      excludedDiets = readStringList(dr.excluded, "dietary_restrictions.excluded", errors);
      const clash = requiredDiets.filter((d) => excludedDiets.includes(d));
      if (clash.length) errors.push(`dietary_restrictions: "${clash.join('", "')}" is both required and excluded`);
    }
  }

  // Active criteria are built once, from configured goals only.
  const criteria = [];
  const goals = profile.daily_goals;
  if (goals != null) {
    if (!isObj(goals)) errors.push("daily_goals must be an object");
    else {
      const seen = new Map();
      for (const [name, goal] of Object.entries(goals)) {
        const c = buildCriterion(name, goal, errors, warnings);
        if (!c) continue;
        if (seen.has(c.field)) {
          errors.push(`daily_goals.${name} duplicates daily_goals.${seen.get(c.field)} (both map to ${c.field})`);
          continue;
        }
        seen.set(c.field, name);
        criteria.push(c);
      }
    }
  }

  if (errors.length) throw new ValidationError(errors);

  // Restriction checks only exist for non-empty categories.
  const checks = [];
  if (allergies.length) checks.push(allergyCheck(allergies.map((a) => termMatcher(a, { prefix: true }))));
  if (excludedIngredients.length) checks.push(ingredientCheck(excludedIngredients.map((t) => termMatcher(t))));
  if (requiredDiets.length) checks.push(requiredDietCheck(requiredDiets));
  if (excludedDiets.length) checks.push(excludedDietCheck(excludedDiets));

  return { criteria, checks, warnings };
}

// ---- Remaining amounts ----------------------------------------------------
// Full amount left when nothing has been eaten for a goal.
function fullAmount(c) {
  return c.type === "range" ? c.max : c.target;
}

/** Returns { [field]: amount left in canonical units } for every active criterion. */
function loadRemaining(json, criteria, warnings) {
  if (json == null) json = {};
  if (!isObj(json)) throw new ValidationError(["remaining must be a JSON object like { \"protein\": 60, \"sodium\": 800 }"]);
  const src = isObj(json.remaining) ? json.remaining : json;
  if (src !== json) unknownKeys(json, ["remaining"], "", warnings);

  const byField = new Map(criteria.map((c) => [c.field, c]));
  const left = {};
  const from = {};
  const errors = [];

  for (const [key, raw] of Object.entries(src)) {
    const field = lookup(GOAL_ALIASES, normKey(key));
    if (!field) {
      warnings.push(`remaining.${key} is not a known nutrient and was ignored`);
      continue;
    }
    const c = byField.get(field);
    if (!c) {
      warnings.push(`remaining.${key} has no goal in the profile and was ignored`);
      continue;
    }
    if (from[field]) {
      errors.push(`remaining.${key} duplicates remaining.${from[field]} (both map to ${field})`);
      continue;
    }
    let value;
    if (isObj(raw)) {
      const unit = raw.unit == null ? c.inputUnit
        : typeof raw.unit === "string" ? lookup(UNIT_ALIASES, norm(raw.unit)) : undefined;
      if (!unit || unitFactor(unit, c.unit) == null) {
        errors.push(`remaining.${key}.unit "${raw.unit}" is not compatible with ${c.unit}`);
        continue;
      }
      value = parseAmount(raw.amount, c.unit, { plainUnit: unit, allowNegative: true });
    } else {
      value = parseAmount(raw, c.unit, { plainUnit: c.inputUnit, allowNegative: true });
    }
    if (value == null) {
      errors.push(`remaining.${key} must be a number, a string like "12g", or { "amount": n, "unit": "g" } (got ${JSON.stringify(raw)})`);
      continue;
    }
    from[field] = key;
    left[field] = value;
    if (value > fullAmount(c) + EPS) {
      warnings.push(`remaining ${c.name} (${round(value)} ${c.unit}) is more than the daily goal (${round(fullAmount(c))} ${c.unit})`);
    }
  }
  if (errors.length) throw new ValidationError(errors);

  for (const c of criteria) {
    // Maximum goals don't need a remaining amount: they are scored by "less is better".
    if (!(c.field in left) && c.type !== "maximum") {
      left[c.field] = fullAmount(c);
      warnings.push(`remaining has no ${c.name}; assuming the full goal is left`);
    }
  }
  return left;
}

// ---- Restriction checks (each returns a reason string or null) ------------
function allergyCheck(matchers) {
  return (item) => {
    if (item.allergenList == null && item.ingredientText == null) {
      return "allergen and ingredient information unavailable";
    }
    const hits = [];
    for (const m of matchers) {
      const inAllergens = item.allergenList?.some((a) => m.re.test(a));
      if (inAllergens || (item.ingredientText && m.re.test(item.ingredientText))) hits.push(m.term);
    }
    return hits.length ? `contains allergen: ${hits.join(", ")}` : null;
  };
}

function ingredientCheck(matchers) {
  return (item) => {
    // Only the ingredient list is checked; dish names can mislead (plant-based "chicken").
    if (item.ingredientText == null) return "ingredient information unavailable";
    const hits = matchers.filter((m) => m.re.test(item.ingredientText)).map((m) => m.term);
    return hits.length ? `contains excluded ingredient: ${hits.join(", ")}` : null;
  };
}

function requiredDietCheck(required) {
  return (item) => {
    const has = (d) =>
      item.dietList?.includes(d) || (lookup(DIET_IMPLIED_BY, d) || []).some((x) => item.dietList?.includes(x));
    const missing = required.filter((d) => !has(d));
    return missing.length ? `not labeled: ${missing.join(", ")}` : null;
  };
}

function excludedDietCheck(excluded) {
  return (item) => {
    const hits = excluded.filter((d) => item.dietList?.includes(d));
    return hits.length ? `has excluded dietary label: ${hits.join(", ")}` : null;
  };
}

// ---- Menu -----------------------------------------------------------------
function menuItems(menu) {
  const items = Array.isArray(menu) ? menu : isObj(menu) && Array.isArray(menu.items) ? menu.items : null;
  if (!items) throw new ValidationError(['menu must be an array of items or an object with an "items" array']);
  const errors = [];
  items.forEach((it, i) => {
    if (!isObj(it)) errors.push(`menu item ${i} must be an object`);
    else if (typeof it.dish_name !== "string" || !it.dish_name.trim()) errors.push(`menu item ${i} needs a dish_name`);
  });
  if (errors.length) throw new ValidationError(errors);
  return items;
}

// ---- Scoring --------------------------------------------------------------
// Amount still needed to reach a minimum (or the range min). 0 when reached.
// Capped at the goal itself, so a remaining value larger than the goal can't ask for more than
// the whole target, and a range with min 0 never needs anything.
function needLeft(c, left) {
  if (c.type === "minimum") return Math.min(c.target, Math.max(0, left));
  if (c.type === "range") return Math.min(c.min, Math.max(0, left - (c.max - c.min)));
  return 0;
}

// Share of the minimum still needed, 0..1. Higher = further behind = more important.
function priority(c, left) {
  const base = c.type === "minimum" ? c.target : c.type === "range" ? c.min : 0;
  return base > 0 ? clamp01(needLeft(c, left) / base) : 0;
}

// Amount left before a maximum (or the range max); negative when already over.
function limitLeft(c, left) {
  return c.type === "maximum" || c.type === "range" ? left : null;
}

// Threshold an item is flagged against, hard or soft: what's left under the limit when given,
// otherwise (maximum goals) the whole daily limit.
function flagThreshold(c, left) {
  if (c.type === "maximum" && left === undefined) return c.target;
  return limitLeft(c, left);
}

/** Effect of one serving (amount x) on goal c, given what's left. */
function effect(c, left, x) {
  // Maximum goals (sodium, sugars, trans fat, cholesterol, ...): less is always better,
  // regardless of what's been eaten. Penalty = share of the daily limit in this serving.
  if (c.type === "maximum") return -x / (c.target || 1); // zero limit scales by 1 unit

  let e = 0;
  const need = needLeft(c, left);
  if (need > 0) {
    const base = c.type === "minimum" ? c.target : c.min;
    e += priority(c, left) * Math.min(x, need) / base;
  }
  if (c.type === "range") {
    const excess = Math.max(0, x - Math.max(0, left));
    e -= excess / c.max;
  }
  return e;
}

function goalSummary(c, left) {
  const out = {
    name: c.name,
    field: c.field,
    unit: c.unit,
    type: c.type,
    ...(c.type === "range" ? { min: c.min, max: c.max } : { target: c.target }),
    ...(c.enforcement ? { enforcement: c.enforcement } : {}),
  };
  if (c.type === "maximum") out.scoring = "less is better";
  else out.priority = round(priority(c, left), 4);
  return out;
}

function compareMenuOrder(a, b) {
  return (
    a.mealRank - b.mealRank ||
    cmp(a.stationText, b.stationText) ||
    cmp(a.nameText, b.nameText) ||
    a.index - b.index
  );
}
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---- Main entry point -----------------------------------------------------
/**
 * @param {object} profileJson
 * @param {object} remainingJson  amounts left per goal
 * @param {any} menuJson
 * @param {{ tiers?: number, similar?: number, meal?: string, verbose?: boolean }} [options]
 *   verbose: return the full result (scores, breakdowns, excluded items, warnings) instead of
 *            the compact tiers-only result.
 *   tiers: how many score tiers to return (default 3; Infinity = all).
 *   similar: scores within this share of a tier's best score join that tier (default 0.05).
 */
function recommend(profileJson, remainingJson, menuJson, options = {}) {
  const full = recommendFull(profileJson, remainingJson, menuJson, options);
  return options.verbose ? full : compact(full);
}

/**
 * Default output: only the tiers, each dish identified by its id (dish_name if the menu item
 * has no id), with the nutrients that set off each warning level.
 *   { tiers: [ { tier: 1, dishes: [ { id, medium_warning: [...], critical_warning: [...] } ] } ] }
 */
function compact(full) {
  return {
    tiers: full.recommendations.map((t) => ({
      tier: t.tier,
      dishes: t.items.map((i) => ({
        ...(i.id != null ? { id: i.id } : { dish_name: i.dish_name }),
        medium_warning: i.warning_summary ? i.warning_summary.medium : [],
        critical_warning: i.warning_summary ? i.warning_summary.critical : [],
      })),
    })),
  };
}

function recommendFull(profileJson, remainingJson, menuJson, options = {}) {
  const { criteria, checks, warnings } = loadProfile(profileJson);
  const items = menuItems(menuJson);
  const left = criteria.length ? loadRemaining(remainingJson, criteria, warnings) : {};
  if (!criteria.length && isObj(remainingJson) && Object.keys(remainingJson).length) {
    warnings.push("remaining amounts were ignored because the profile has no daily_goals");
  }
  for (const c of criteria) {
    const room = flagThreshold(c, left[c.field]);
    if (room != null && room <= EPS) {
      warnings.push(`no ${c.name} left under the ${c.enforcement} limit; every item with ${c.field} is flagged`);
    }
  }
  const maxTiers = options.tiers === undefined ? 3 : options.tiers; // Infinity = all
  const similar = options.similar === undefined ? 0.05 : options.similar;
  if (!(maxTiers === Infinity || (Number.isInteger(maxTiers) && maxTiers > 0))) {
    throw new ValidationError(["tiers must be a positive integer or Infinity"]);
  }
  if (!(isNum(similar) && similar >= 0 && similar < 1)) {
    throw new ValidationError(["similar must be a number from 0 to less than 1"]);
  }

  const mealFilter = options.meal ? norm(options.meal) : null;
  const needsText = checks.length > 0;
  const eligible = [];
  const excluded = [];

  items.forEach((raw, index) => {
    if (mealFilter && norm(raw.meal ?? "") !== mealFilter) return;

    const item = {
      raw,
      index,
      nameText: norm(raw.dish_name),
      stationText: norm(raw.station ?? ""),
      mealRank: lookup(MEAL_ORDER, norm(raw.meal ?? "")) ?? 5,
    };
    // Text fields are only normalized when some restriction reads them.
    if (needsText) {
      item.allergenList = toList(raw.allergens);
      item.ingredientText = raw.ingredients == null || String(raw.ingredients).trim() === ""
        ? null : norm(raw.ingredients);
      item.dietList = toList(raw.diets);
    }

    const reasons = [];
    for (const check of checks) {
      const r = check(item);
      if (r) reasons.push(r);
    }

    // Parse only nutrients with configured goals, once per item.
    if (criteria.length) {
      item.values = {};
      for (const c of criteria) {
        const v = parseNutrient(raw[c.field], c.unit);
        if (v == null) {
          reasons.push(raw[c.field] == null || raw[c.field] === ""
            ? `missing ${c.field} value`
            : `unreadable ${c.field} value ${JSON.stringify(raw[c.field])}`);
        } else item.values[c.field] = v;
      }
      // Limits (hard or soft) flag the item instead of excluding it. An item is flagged when it
      // reaches or goes over the threshold, even if it ranks well because it is one of the lowest.
      if (!reasons.length) {
        item.flags = [];
        for (const c of criteria) {
          const room = flagThreshold(c, left[c.field]);
          const x = item.values[c.field];
          // An item adding none of the nutrient can't use up the limit.
          if (room == null || x <= 0) continue;
          const reaches = x >= room - EPS;
          // "medium": uses at least MEDIUM_SHARE of what's left without reaching it.
          // "critical": reaches or goes over it.
          if (!reaches && x < MEDIUM_SHARE * room - EPS) continue;
          const of = left[c.field] === undefined
            ? `${round(x)} of the ${round(room)} ${c.unit} daily limit`
            : `${round(x)} ${c.unit}, ${round(Math.max(0, room))} ${c.unit} left`;
          item.flags.push({
            level: reaches ? "critical" : "medium",
            nutrient: c.name,
            amount: round(x),
            limit_left: round(Math.max(0, room)),
            unit: c.unit,
            goal_enforcement: c.enforcement,
            message: reaches ? `reaches the ${c.name} limit (${of})` : `uses ${Math.round((x / room) * 100)}% of the ${c.name} limit (${of})`,
          });
        }
      }
    }

    if (reasons.length) excluded.push({ ...describe(raw), reasons });
    else eligible.push(item);
  });

  if (criteria.length) {
    for (const item of eligible) {
      let total = 0;
      item.breakdown = {};
      for (const c of criteria) {
        const x = item.values[c.field];
        const e = effect(c, left[c.field], x);
        total += e;
        item.breakdown[c.name] = { amount: round(x), unit: c.unit, effect: round(e, SCORE_DECIMALS) };
      }
      // Rounded so float noise can't split a real tie.
      item.score = round(total / criteria.length, SCORE_DECIMALS);
    }
    eligible.sort((a, b) => b.score - a.score || compareMenuOrder(a, b));
  } else {
    eligible.sort(compareMenuOrder);
  }

  // Group into tiers. A tier starts at its best item and takes every following item whose
  // score is within `similar` (share of the best score's size) of it. Without goals there is
  // nothing to tell items apart, so all eligible items form one tier.
  const tiers = [];
  for (const item of eligible) {
    const cur = tiers[tiers.length - 1];
    const fits = cur && (!criteria.length ||
      cur.best - item.score <= similar * Math.abs(cur.best) + EPS);
    if (fits) cur.items.push(item);
    else {
      if (tiers.length === maxTiers) break;
      tiers.push({ best: item.score, items: [item] });
    }
  }

  return {
    scoring: criteria.length ? "configured_goals" : "none (no goals configured; menu order)",
    active_goals: criteria.map((c) => goalSummary(c, left[c.field])),
    recommendations: tiers.map((t, i) => ({
      tier: i + 1,
      count: t.items.length,
      ...(criteria.length ? { best_score: t.best, lowest_score: t.items[t.items.length - 1].score } : {}),
      items: t.items.map((item) => ({
        ...describe(item.raw),
        ...(criteria.length ? { score: item.score, breakdown: item.breakdown } : {}),
        ...(item.flags?.length ? { warning_summary: summarizeFlags(item.flags), warnings: item.flags } : {}),
      })),
    })),
    recommended_count: tiers.reduce((n, t) => n + t.items.length, 0),
    eligible_count: eligible.length,
    excluded,
    warnings,
  };
}

// Which nutrients set off each warning level, e.g. { medium: ["sodium"], critical: ["cholesterol"] }.
function summarizeFlags(flags) {
  const out = { medium: [], critical: [] };
  for (const f of flags) out[f.level].push(f.nutrient);
  return out;
}

function describe(raw) {
  const out = { dish_name: raw.dish_name };
  for (const k of ["id", "dining_hall", "meal", "station", "serving_size"]) {
    if (raw[k] != null) out[k] = raw[k];
  }
  return out;
}

// ---- CLI ------------------------------------------------------------------
function readJson(path, label) {
  let text;
  try {
    text = fs.readFileSync(path, "utf8");
  } catch (err) {
    throw new ValidationError([`cannot read ${label} file "${path}": ${err.message}`]);
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, "")); // tolerate a UTF-8 byte-order mark
  } catch (err) {
    throw new ValidationError([`${label} file "${path}" is not valid JSON: ${err.message}`]);
  }
}

function main(argv) {
  const usage = (problem) => {
    if (problem) console.error(problem);
    console.error(
      "Usage: node recommender.js <profile.json> <remaining.json> <menu.json> " +
      "[--tiers N|all] [--similar 0.05] [--meal NAME] [--verbose]"
    );
    process.exit(2);
  };
  const files = [];
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--tiers" || arg === "--similar" || arg === "--meal") {
      const value = argv[++i];
      if (value == null || value.startsWith("--")) usage(`${arg} needs a value`);
      if (arg === "--tiers") {
        options.tiers = value === "all" ? Infinity : Number(value);
        if (options.tiers !== Infinity && (!Number.isInteger(options.tiers) || options.tiers <= 0)) {
          usage("--tiers must be a positive integer or 'all'");
        }
      } else if (arg === "--similar") {
        options.similar = Number(value);
        if (!Number.isFinite(options.similar) || options.similar < 0 || options.similar >= 1) {
          usage("--similar must be a number from 0 to less than 1 (e.g. 0.05 = within 5%)");
        }
      } else options.meal = value;
    } else if (arg === "--verbose") options.verbose = true;
    else if (arg.startsWith("--")) usage(`unknown option ${arg}`);
    else files.push(arg);
  }
  if (files.length !== 3) usage(`expected 3 JSON files, got ${files.length}`);
  try {
    const result = recommend(
      readJson(files[0], "profile"),
      readJson(files[1], "remaining"),
      readJson(files[2], "menu"),
      options
    );
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } catch (err) {
    if (err instanceof ValidationError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { recommend, loadProfile, parseNutrient, ValidationError };
