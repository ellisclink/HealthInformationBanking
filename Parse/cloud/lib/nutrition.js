// nutrition.js — Nutrition logging (Tasks 1–4), on Parse. Class: NutritionLog
//   POST /nutrition/search {query}   USDA FoodData Central search (set USDA_API_KEY; DEMO_KEY otherwise)
//   POST /nutrition/log              add a food entry
//   GET  /nutrition/logs             entries between startDate and endDate (default: last 30 days)
//   GET  /nutrition/summary?date=    totals for one day
//   logs and summary take tz (IANA zone, UTC when missing): a log's day, and the dates asked for, are local days in tz
//   PUT  /nutrition/log/:id, DELETE /nutrition/log/:id

const { M, isId, isDate, isDateTime, toRow, findAll, getOwned, save, create, audit, param } = require("./db");
const { localDate, addDays, validZone } = require("./reminders");   // the local-day helpers calendar and reminders use

const FIELDS = ["user_id", "food_name", "usda_fdc_id", "serving_size", "serving_unit", "logged_at", "calories", "protein_g", "carbs_g",
  "fat_g", "fiber_g", "sugar_g", "sodium_mg", "source", "confidence", "notes"];
const NUMBERS = ["serving_size", "calories", "protein_g", "carbs_g", "fat_g", "fiber_g", "sugar_g", "sodium_mg", "confidence"];
// the API takes camelCase (as before) and stores snake_case
const CAMEL = { foodName: "food_name", usdaFdcId: "usda_fdc_id", servingSize: "serving_size", servingUnit: "serving_unit", calories: "calories",
  proteinG: "protein_g", carbsG: "carbs_g", fatG: "fat_g", fiberG: "fiber_g", sugarG: "sugar_g", sodiumMg: "sodium_mg", confidence: "confidence",
  notes: "notes", loggedAt: "logged_at" };
const row = (o) => toRow(o, "log_id", FIELDS);
const USDA = "https://api.nal.usda.gov/fdc/v1";
const NUTRIENTS = { 1008: "calories", 1003: "proteinG", 1005: "carbsG", 1004: "fatG", 1079: "fiberG", 2000: "sugarG", 1093: "sodiumMg" };

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

const DATE_FORMAT_ERROR = "Use the date format YYYY-MM-DD";

// The patient's zone from the `tz` query parameter: an IANA name, UTC when missing.
function zoneOf(query) {
  const tz = param(query, "tz") || "UTC";
  return validZone(tz) ? { tz } : { error: "Unknown time zone" };
}

// A log's calendar day in the patient's zone (logged_at is stored as a UTC instant and left as is).
const dayOf = (r, tz) => localDate(new Date(r.logged_at), tz);

async function logs(query, user) {
  const { tz, error } = zoneOf(query);
  if (error) return { status: 400, error };
  const today = localDate(new Date(), tz);
  const startDate = param(query, "startDate") || addDays(today, -30);
  const endDate = param(query, "endDate") || today;
  // startDate and endDate are local days in tz, so only YYYY-MM-DD is accepted (a date-time would be read as a UTC day)
  if (!isDate(startDate) || !isDate(endDate)) return { status: 400, error: DATE_FORMAT_ERROR };
  const first = startDate, last = endDate;
  const rows = (await findAll("NutritionLog", { user_id: user.user_id })).map(row)
    .filter((r) => r.logged_at && dayOf(r, tz) >= first && dayOf(r, tz) <= last)
    .sort((a, b) => b.logged_at.localeCompare(a.logged_at));
  return { status: 200, logs: rows };
}

async function summary(query, user) {
  const { tz, error } = zoneOf(query);
  if (error) return { status: 400, error };
  const day = param(query, "date") || localDate(new Date(), tz);
  if (!isDate(day)) return { status: 400, error: DATE_FORMAT_ERROR };
  const rows = (await findAll("NutritionLog", { user_id: user.user_id })).map(row).filter((r) => r.logged_at && dayOf(r, tz) === day);
  const sum = (k) => Number(rows.reduce((s, r) => s + (Number(r[k]) || 0), 0).toFixed(2));
  return { status: 200, summary: { date: day, meal_count: rows.length, total_calories: sum("calories"), total_protein: sum("protein_g"),
    total_carbs: sum("carbs_g"), total_fat: sum("fat_g"), total_fiber: sum("fiber_g"), total_sugar: sum("sugar_g"), total_sodium: sum("sodium_mg") } };
}

async function update(id, body, user) {
  if (!isId(id)) return { status: 400, error: "Invalid log ID" };
  const o = await getOwned("NutritionLog", id, user.user_id);
  if (!o) return { status: 404, error: "Log entry not found" };
  const { values, error } = fromBody(body || {});
  if (error) return { status: 400, error };
  if (!Object.keys(values).length) return { status: 400, error: "No fields to update" };
  if (values.food_name === null || values.serving_size === null || values.serving_unit === null) return { status: 400, error: "foodName, servingSize and servingUnit can't be cleared" };
  const old = row(o);
  await save(o, values);
  const data = row(o);
  await audit({ userId: user.user_id, event: "UPDATE", targetClass: "NutritionLog", targetId: o.id, oldData: old, newData: data });
  return { status: 200, message: "Nutrition log updated", log: data };
}

async function remove(id, user) {
  if (!isId(id)) return { status: 400, error: "Invalid log ID" };
  const o = await getOwned("NutritionLog", id, user.user_id);
  if (!o) return { status: 404, error: "Log entry not found" };
  const old = row(o);
  await o.destroy(M);
  await audit({ userId: user.user_id, event: "DELETE", targetClass: "NutritionLog", targetId: id, oldData: old });
  return { status: 200, message: "Nutrition log deleted" };
}

module.exports = { search, log, logs, summary, update, remove };
