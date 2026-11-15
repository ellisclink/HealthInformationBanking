// nutrition.js — Nutrition logging (Tasks 1–4), on Parse. Class: NutritionLog
//   POST /nutrition/search {query}   USDA FoodData Central search (set USDA_API_KEY; DEMO_KEY otherwise). Stays on the
//                                    server: the USDA key must never reach the browser.
//   The Nutrition page reads and saves its log with the Parse SDK (Vite/src/data/nutrition.ts: logs, the daily summary,
//   add / edit / delete); the owner-only rules in access.js (RULES.NutritionLog) use validate/clean/row from here.
//   There are no /nutrition/log, /nutrition/logs or /nutrition/summary routes any more. log() is used by seed.

const { isDateTime, toRow, create, audit } = require("./db");

const FIELDS = ["user_id", "food_name", "usda_fdc_id", "serving_size", "serving_unit", "logged_at", "calories", "protein_g", "carbs_g",
  "fat_g", "fiber_g", "sugar_g", "sodium_mg", "source", "confidence", "notes"];
const NUMBERS = ["serving_size", "calories", "protein_g", "carbs_g", "fat_g", "fiber_g", "sugar_g", "sodium_mg", "confidence"];
const TEXT_MAX = { food_name: 255, usda_fdc_id: 255, serving_unit: 255, notes: 2000 };
const REQUIRED = ["food_name", "serving_size", "serving_unit"];
// seed's log() takes camelCase (as the old route did) and stores snake_case
const CAMEL = { foodName: "food_name", usdaFdcId: "usda_fdc_id", servingSize: "serving_size", servingUnit: "serving_unit", calories: "calories",
  proteinG: "protein_g", carbsG: "carbs_g", fatG: "fat_g", fiberG: "fiber_g", sugarG: "sugar_g", sodiumMg: "sodium_mg", confidence: "confidence",
  notes: "notes", loggedAt: "logged_at" };
const row = (o) => toRow(o, "log_id", FIELDS);
const USDA = "https://api.nal.usda.gov/fdc/v1";
const NUTRIENTS = { 1008: "calories", 1003: "proteinG", 1005: "carbsG", 1004: "fatG", 1079: "fiberG", 2000: "sugarG", 1093: "sodiumMg" };

// a missing, null or all-spaces value
const blank = (v) => v === undefined || v === null || (typeof v === "string" && !v.trim());

// Field rules for a NutritionLog the browser saves (snake_case names, values already type-checked by access.js: numbers
// are numbers, logged_at is a Date). Create checks all; update checks only what was sent. Returns an error or null.
// The old route's rules (numbers 0 or more, a valid logged_at, required food/serving), plus: a serving size above 0,
// a food name that is not only spaces, and text that is too long is refused (the route cut it short).
function validate(body, partial) {
  for (const f of REQUIRED) {
    if (!partial && blank(body[f])) return "Missing required fields: food_name, serving_size, serving_unit";
    if (partial && f in body && blank(body[f])) return "food_name, serving_size and serving_unit can't be cleared";
  }
  // every entry has a time (the log and the daily summary go by logged_at): an edit may move it, never clear it
  if (partial && "logged_at" in body && body.logged_at === null) return "logged_at can't be cleared";
  for (const f of NUMBERS) {
    const v = body[f];
    if (v !== undefined && v !== null && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) return `${f} must be a number of 0 or more`;
  }
  if (typeof body.serving_size === "number" && body.serving_size <= 0) return "serving_size must be more than 0";
  for (const [f, max] of Object.entries(TEXT_MAX)) {
    if (typeof body[f] === "string" && body[f].trim().length > max) return `${f} is too long (max ${max})`;
  }
  const at = body.logged_at;
  if (at !== undefined && at !== null && !(at instanceof Date && !isNaN(at.getTime()))) return "logged_at is not a valid date/time";
  return null;
}

// The values to store: text trimmed (blank = cleared). A new entry is logged now unless logged_at was sent, and its
// source is set by the server (usda_api when it came from a USDA search, manual otherwise), as log() did.
function clean(body, partial) {
  const out = {};
  for (const [f, v] of Object.entries(body)) {
    if (v === undefined) continue;
    out[f] = v === null ? null : typeof v === "string" ? v.trim() || null : v;
  }
  if (!partial) {
    if (!out.logged_at) out.logged_at = new Date();
    out.source = out.usda_fdc_id ? "usda_api" : "manual";
  }
  return out;
}

function fromBody(body) {
  const out = {};
  for (const [camel, col] of Object.entries(CAMEL)) {
    const v = body[camel] !== undefined ? body[camel] : body[col];
    if (v === undefined) continue;
    if (v === null || v === "") { out[col] = null; continue; }
    if (NUMBERS.includes(col)) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) return { error: `${camel} must be a number of 0 or more` };
      out[col] = n;
    } else if (col === "logged_at") {
      if (!isDateTime(v)) return { error: "loggedAt is not a valid date/time" };
      out[col] = new Date(v);
    } else {
      out[col] = String(v).trim().slice(0, col === "notes" ? 2000 : 255);
    }
  }
  return { values: out };
}

async function search(body) {
  const q = body && typeof body.query === "string" ? body.query.trim() : "";
  if (!q) return { status: 400, error: "Missing search query" };
  try {
    const res = await fetch(`${USDA}/foods/search?query=${encodeURIComponent(q)}&pageSize=10&api_key=${process.env.USDA_API_KEY || "DEMO_KEY"}`);
    if (!res.ok) return { status: 502, error: `USDA search failed (${res.status})` };
    const data = await res.json();
    const foods = (data.foods || []).map((f) => {
      const n = {};
      for (const x of f.foodNutrients || []) if (NUTRIENTS[x.nutrientId]) n[NUTRIENTS[x.nutrientId]] = x.value;
      return { fdcId: String(f.fdcId), description: f.description, brandOwner: f.brandOwner || null,
        servingSize: f.servingSize || 100, servingUnit: f.servingSizeUnit || "g", ...n };
    });
    return { status: 200, foods, count: foods.length };
  } catch (err) {
    return { status: 502, error: "USDA search is unavailable right now" };
  }
}

// a food entry made by the server (seed and the tests; the website saves through the Parse SDK)
async function log(body, user) {
  if (!body || !(body.foodName || body.food_name) || !(body.servingSize || body.serving_size) || !(body.servingUnit || body.serving_unit)) {
    return { status: 400, error: "Missing required fields: foodName, servingSize, servingUnit" };
  }
  const { values, error } = fromBody(body);
  if (error) return { status: 400, error };
  const o = await create("NutritionLog", { logged_at: new Date(), confidence: 100, ...values, user_id: user.user_id,
    source: values.usda_fdc_id ? "usda_api" : "manual" });
  const data = row(o);
  await audit({ userId: user.user_id, event: "INSERT", targetClass: "NutritionLog", targetId: o.id, newData: data });
  return { status: 201, message: "Nutrition log entry created", logId: o.id, createdAt: data.created_at };
}

// validate, clean, row and FIELDS are also used by access.js (RULES.NutritionLog: the browser saves NutritionLog directly)
module.exports = { search, log, validate, clean, row, FIELDS, NUMBERS };
