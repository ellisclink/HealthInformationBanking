// vitals.js — Vital signs (Tasks 3.1 / 3.2), on Parse. Class: VitalReading
//   The Vital Signs page reads and saves VitalReading with the Parse SDK (Vite/src/data/vitals.ts: list, one reading,
//   summary, trends, quick-look, add / edit / delete; the vital types are in Vite/src/data/vitalTypes.ts). The owner-only
//   rules in access.js (RULES.VitalReading) use validate/clean/row and the BMI hooks from here. There is no /vitals api
//   route any more.
//   Still used on the server (master key): create (autofill, the CCDA import, seed), list (the CCDA import), summary
//   (share codes), and the automatic BMI: a weight or height reading makes / updates / removes a calculated
//   BMI reading (source "calculated"), whoever saved it.

const { M, isId, isDate, isDateTime, toRow, findAll, oldestRow, getOwned, save, create, audit, param } = require("./db");
const { VITAL_TYPES } = require("./reference");

const FIELDS = ["user_id", "vital_type", "value_numeric", "value_secondary", "unit", "measured_at", "measurement_context",
  "body_position", "device_name", "source", "condition_id", "notes", "source_reading_ids"];
const VALID_CONTEXTS = ["resting", "post_exercise", "fasting", "post_meal", "bedtime", "symptomatic"];
const VALID_POSITIONS = ["sitting", "standing", "lying"];
const VALID_SOURCES = ["manual", "document_upload", "provider_entered"];
const PLAUSIBLE_BOUNDS = {
  blood_pressure: { min: 40, max: 300, secondaryMin: 20, secondaryMax: 200 }, heart_rate: { min: 20, max: 300 },
  temperature: { min: 80, max: 115 }, respiratory_rate: { min: 4, max: 80 }, oxygen_saturation: { min: 50, max: 100 },
  weight: { min: 1, max: 1500 }, height: { min: 10, max: 100 }, bmi: { min: 5, max: 100 }, blood_glucose: { min: 10, max: 1000 },
  hemoglobin_a1c: { min: 2, max: 20 }, pain_level: { min: 0, max: 10 },
};
const typeOf = (t) => VITAL_TYPES.find((v) => v.vital_type === t) || null;

// ---- automatic BMI (from the latest weight and height) ----------------------------------------
// BMI = kg / m^2, one decimal. Units are read as stored on each reading; an unknown unit means no BMI.
// Only readings with source "calculated" are ever created, changed or deleted automatically.
const LB_PER_KG = 2.20462;
const WEIGHT_TO_KG = { kg: 1, kgs: 1, kilogram: 1, kilograms: 1, lb: 1 / LB_PER_KG, lbs: 1 / LB_PER_KG, pound: 1 / LB_PER_KG, pounds: 1 / LB_PER_KG };
const HEIGHT_TO_M = { in: 0.0254, inch: 0.0254, inches: 0.0254, cm: 0.01, centimeter: 0.01, centimeters: 0.01, centimetre: 0.01, centimetres: 0.01,
  m: 1, meter: 1, meters: 1, metre: 1, metres: 1 };
const unitKey = (u) => (typeof u === "string" ? u.trim().toLowerCase().replace(/\.$/, "") : "");
const BMI_SOURCE = "calculated";
const CALCULATED_BMI_REMOVE_MESSAGE = "Calculated from weight and height. Remove the weight or height reading to change it.";
const BMI_NOTE = "Calculated from weight and height";
const BMI_WINDOW_DAYS = 365;
const NOTE_UNDER_20 = "For children and teens, ask your doctor to compare BMI with growth charts for your age and sex.";
const NOTE_NO_DOB = "Add your date of birth in your Health History to see a BMI category.";

function computeBmi(weight, weightUnit, height, heightUnit) {
  const w = Number(weight), h = Number(height);
  if (weight == null || height == null || !Number.isFinite(w) || !Number.isFinite(h)) return { reason: "Weight and height must be numbers." };
  if (w <= 0 || h <= 0) return { reason: "Weight and height must be greater than zero." };
  const wf = WEIGHT_TO_KG[unitKey(weightUnit)], hf = HEIGHT_TO_M[unitKey(heightUnit)];
  if (wf === undefined) return { reason: "The weight unit is missing or not recognised (use kg or lb), so BMI was not calculated." };
  if (hf === undefined) return { reason: "The height unit is missing or not recognised (use in, cm or m), so BMI was not calculated." };
  const kg = w * wf, metres = h * hf;
  const bmi = Math.round((kg / (metres * metres)) * 10) / 10;
  const b = PLAUSIBLE_BOUNDS.bmi;
  if (!Number.isFinite(bmi) || bmi < b.min || bmi > b.max) return { reason: `The calculated BMI (${bmi}) is outside the recordable range, so it was not saved. Check the weight and height.` };
  return { bmi };
}

// whole years on the reading's date (UTC date), from a YYYY-MM-DD date of birth; null when unknown
function ageOn(dob, measuredAt) {
  if (!isDate(dob) || !isDateTime(String(measuredAt))) return null;
  const on = new Date(measuredAt).toISOString().slice(0, 10);
  let age = Number(on.slice(0, 4)) - Number(dob.slice(0, 4));
  if (on.slice(5) < dob.slice(5)) age--;
  return age >= 0 && age < 150 ? age : null;
}

// Adult categories only (age 20 and up). Under 20, or no known age, gets a note and no category.
function bmiCategory(bmi, age) {
  if (!Number.isInteger(age)) return { category: null, note: NOTE_NO_DOB, age: null };
  if (age < 20) return { category: null, note: NOTE_UNDER_20, age };
  const v = Number(bmi);
  const category = v < 18.5 ? "Underweight" : v < 25 ? "Normal weight" : v < 30 ? "Overweight" : "Obesity";
  return { category, note: null, age };
}

async function dobOf(userId) {
  const rec = await oldestRow("MedicalRecord", userId);
  const data = rec && rec.get("data");
  if (!data || typeof data !== "object") return null;
  const dob = data.patient && typeof data.patient === "object" && data.patient.dob ? data.patient.dob : data.dob;
  return typeof dob === "string" ? dob : null;
}
const bmiInfoFor = (r, dob) => bmiCategory(r.value_numeric, ageOn(dob, r.measured_at));

// calculated BMI readings built from this weight/height reading
async function linkedBmis(userId, sourceId) {
  const all = await findAll("VitalReading", { user_id: userId, vital_type: "bmi", source: BMI_SOURCE });
  return all.filter((o) => Array.isArray(o.get("source_reading_ids")) && o.get("source_reading_ids").includes(sourceId));
}

async function latestOther(userId, otherType) {
  const since = new Date(Date.now() - BMI_WINDOW_DAYS * 86400000).toISOString();
  return (await readings(userId, otherType)).find((r) => r.measured_at >= since) || null;
}

const pair = (a, b) => (a.vital_type === "weight" ? { weight: a, height: b } : { weight: b, height: a });
const newerOf = (a, b) => (a.measured_at >= b.measured_at ? a.measured_at : b.measured_at);
const autoAudit = (user, event, id, oldData, newData, trigger) =>
  audit({ userId: user.user_id, event, targetClass: "VitalReading", targetId: id, oldData, newData, detail: { automatic: true, trigger_reading_id: trigger } });

async function createCalculatedBmi(user, a, b) {
  const { weight, height } = pair(a, b);
  const calc = computeBmi(weight.value_numeric, weight.unit, height.value_numeric, height.unit);
  if (calc.reason) return { action: "none", reason: calc.reason };
  const obj = await create("VitalReading", {
    user_id: user.user_id, vital_type: "bmi", value_numeric: calc.bmi, value_secondary: null, unit: typeOf("bmi").default_unit,
    measured_at: new Date(newerOf(weight, height)), source: BMI_SOURCE, notes: BMI_NOTE,
    source_reading_ids: [weight.vital_log_id, height.vital_log_id],
  });
  const data = row(obj);
  await autoAudit(user, "INSERT", obj.id, null, data, a.vital_log_id);
  return { action: "created", reading: data };
}

// A weight or height reading was just saved: refresh its linked BMI(s), or make one if there is none.
async function bmiAfterSave(user, source, { isNew }) {
  try {
    if (source.vital_type !== "weight" && source.vital_type !== "height") return undefined;
    const linked = isNew ? [] : await linkedBmis(user.user_id, source.vital_log_id);
    if (!linked.length) {
      const other = await latestOther(user.user_id, source.vital_type === "weight" ? "height" : "weight");
      if (!other) return { action: "none", reason: `A BMI needs both a weight and a height from the last ${BMI_WINDOW_DAYS} days.` };
      return await createCalculatedBmi(user, source, other);
    }
    let result = { action: "none", reason: "" };
    for (const obj of linked) {
      const oldData = row(obj);
      const otherId = obj.get("source_reading_ids").find((id) => id !== source.vital_log_id);
      const otherObj = otherId ? await getOwned("VitalReading", otherId, user.user_id) : null;
      const calc = otherObj ? (() => { const p = pair(source, row(otherObj)); return { p, ...computeBmi(p.weight.value_numeric, p.weight.unit, p.height.value_numeric, p.height.unit) }; })() : null;
      if (!calc || calc.reason) {
        await obj.destroy(M);
        await autoAudit(user, "DELETE", obj.id, oldData, null, source.vital_log_id);
        result = { action: "deleted", reason: calc ? calc.reason : "The other reading this BMI used no longer exists." };
        continue;
      }
      await save(obj, { value_numeric: calc.bmi, measured_at: new Date(newerOf(calc.p.weight, calc.p.height)) });
      const data = row(obj);
      await autoAudit(user, "UPDATE", obj.id, oldData, data, source.vital_log_id);
      result = { action: "updated", reading: data };
    }
    return result;
  } catch (err) {
    console.error("automatic BMI failed:", err.message);
    return { action: "none", reason: "BMI could not be calculated right now." };
  }
}

async function bmiAfterDelete(user, sourceId) {
  try {
    const linked = await linkedBmis(user.user_id, sourceId);
    for (const obj of linked) {
      const oldData = row(obj);
      await obj.destroy(M);
      await autoAudit(user, "DELETE", obj.id, oldData, null, sourceId);
    }
    return linked.length ? { action: "deleted" } : undefined;
  } catch (err) {
    console.error("automatic BMI cleanup failed:", err.message);
    return undefined;
  }
}
const row = (o) => {
  const r = toRow(o, "vital_log_id", FIELDS);
  r.logged_at = r.created_at;
  return r;
};

async function activeTarget(userId, vitalType) {
  const targets = await findAll("ConditionTarget", { user_id: userId, vital_type: vitalType, active: true });
  targets.sort((a, b) => b.createdAt - a.createdAt);
  const t = targets[0];
  return t ? { target_min: t.get("target_min") ?? null, target_max: t.get("target_max") ?? null, secondary_min: t.get("secondary_min") ?? null,
    secondary_max: t.get("secondary_max") ?? null, set_by: t.get("set_by") ?? null, condition_id: t.get("condition_id") } : null;
}

function evaluate(reading, type, target) {
  const pick = (t, k) => (target && target[t] != null ? Number(target[t]) : type[k] != null ? Number(type[k]) : null);
  const range = {
    min: pick("target_min", "normal_min"), max: pick("target_max", "normal_max"),
    secondaryMin: pick("secondary_min", "secondary_min"), secondaryMax: pick("secondary_max", "secondary_max"),
    source: target ? "condition_target" : "reference_range",
  };
  if (range.min == null && range.max == null && range.secondaryMin == null && range.secondaryMax == null) return { status: "no_range", range };
  const v = Number(reading.value_numeric);
  const s = reading.value_secondary != null ? Number(reading.value_secondary) : null;
  const below = (range.min != null && v < range.min) || (s != null && range.secondaryMin != null && s < range.secondaryMin);
  const above = (range.max != null && v > range.max) || (s != null && range.secondaryMax != null && s > range.secondaryMax);
  return { status: above ? "above_range" : below ? "below_range" : "in_range", range };
}

async function readings(userId, vitalType) {
  const rows = (await findAll("VitalReading", vitalType ? { user_id: userId, vital_type: vitalType } : { user_id: userId })).map(row);
  return rows.sort((a, b) => b.measured_at.localeCompare(a.measured_at));
}

// the caller's readings, newest first (the CCDA import uses it to skip readings it already has; the website has its
// own copy in Vite/src/data/vitals.ts)
async function list(query, user) {
  const vitalType = param(query, "type"), startDate = param(query, "startDate"), endDate = param(query, "endDate");
  const rawLimit = parseInt(param(query, "limit"), 10);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 100;
  if (startDate && !isDateTime(startDate)) return { status: 400, error: "startDate is not a valid date" };
  if (endDate && !isDateTime(endDate)) return { status: 400, error: "endDate is not a valid date" };
  let rows = await readings(user.user_id, vitalType);
  if (startDate) rows = rows.filter((r) => r.measured_at >= new Date(startDate).toISOString());
  if (endDate) rows = rows.filter((r) => r.measured_at < new Date(new Date(endDate.slice(0, 10)).getTime() + 86400000).toISOString());
  rows = rows.slice(0, limit);
  if (rows.some((r) => r.vital_type === "bmi")) {
    const dob = await dobOf(user.user_id);
    for (const r of rows) if (r.vital_type === "bmi") r.bmi_info = bmiInfoFor(r, dob);
  }
  return { status: 200, readings: rows, count: rows.length };
}

const TEXT_MAX = 1000;
const FUTURE_LIMIT_MS = 60 * 1000;   // a clock a little ahead is fine
const blank = (v) => v === undefined || v === null;

function checkOptional(body) {
  if (body.measurement_context && !VALID_CONTEXTS.includes(body.measurement_context)) return `Invalid measurement_context. Must be one of: ${VALID_CONTEXTS.join(", ")}`;
  if (body.body_position && !VALID_POSITIONS.includes(body.body_position)) return `Invalid body_position. Must be one of: ${VALID_POSITIONS.join(", ")}`;
  if (body.source && !VALID_SOURCES.includes(body.source)) return `Invalid source. Must be one of: ${VALID_SOURCES.join(", ")}`;
  for (const f of ["notes", "device_name", "unit"]) if (body[f] != null && String(body[f]).length > TEXT_MAX) return `${f} is too long`;
  return null;
}

// Field rules for a reading (the old POST /vitals and PUT /vitals/:id rules). body: the fields sent, already typed
// (numbers are numbers, measured_at is a Date, a removed field is null); original: the stored row on an edit, else null.
// An edit is checked against the reading as it will be stored. Returns an error message or null.
// Used by createVital() below and by access.js (RULES.VitalReading: the browser saves VitalReading directly).
function validate(body, original) {
  if (!original) {
    if (!body.vital_type || blank(body.value_numeric)) return "Missing required fields: vital_type, value_numeric";
  } else {
    if ("vital_type" in body) return "vital_type cannot be changed; delete this reading and log a new one";
    if (original.get("source") === BMI_SOURCE) return "A calculated BMI cannot be edited. Change the weight or height instead.";
    if ("source" in body) return "source cannot be changed";
    if ("value_numeric" in body && blank(body.value_numeric)) return "value_numeric can't be cleared";
    if ("measured_at" in body && blank(body.measured_at)) return "measured_at can't be cleared";
  }
  const vitalType = original ? original.get("vital_type") : body.vital_type;
  const type = typeOf(vitalType);
  if (!type) return `Unknown vital_type: ${vitalType}`;
  const merged = (k) => (k in body ? body[k] : original ? original.get(k) ?? null : null);
  const value = merged("value_numeric"), secondary = merged("value_secondary");
  if (typeof value !== "number" || !Number.isFinite(value)) return "value_numeric must be a number";
  if (!blank(secondary) && (typeof secondary !== "number" || !Number.isFinite(secondary))) return "value_secondary must be a number";
  if (type.is_dual_value) {
    if (blank(secondary)) return `${type.display_name} requires value_secondary (${type.secondary_label})`;
    if (secondary >= value) return `${type.secondary_label} must be lower than ${type.value_label}`;
  } else if (!blank(secondary)) return `${type.display_name} does not take a second value`;
  const b = PLAUSIBLE_BOUNDS[vitalType];
  if (b && (value < b.min || value > b.max)) {
    return `${type.display_name} reading of ${value} ${type.default_unit} is outside the recordable range (${b.min}–${b.max}). Check the value and try again.`;
  }
  if (!blank(secondary) && b && b.secondaryMin !== undefined && (secondary < b.secondaryMin || secondary > b.secondaryMax)) {
    return `${type.secondary_label} reading of ${secondary} is outside the recordable range (${b.secondaryMin}–${b.secondaryMax}).`;
  }
  const optErr = checkOptional(body);
  if (optErr) return optErr;
  const at = body.measured_at;
  if (!blank(at)) {
    if (!(at instanceof Date) || isNaN(at.getTime())) return "measured_at is not a valid date";
    if (at.getTime() > Date.now() + FUTURE_LIMIT_MS) return "measured_at cannot be in the future";
  }
  return null;
}

// The values to store (after validate): text trimmed (blank = cleared). The server fills in, never the browser:
// unit = the type's default unit when none is given (also when an edit clears it), measured_at = now and
// source = "manual" when not given. source "calculated" and source_reading_ids are only ever set by the BMI code here.
function clean(body, original) {
  const out = {};
  for (const [f, v] of Object.entries(body)) {
    if (v === undefined) continue;
    out[f] = typeof v === "string" ? v.trim() || null : v;
  }
  const type = typeOf(original ? original.get("vital_type") : body.vital_type);
  if (!original) {
    if (!type.is_dual_value) out.value_secondary = null;
    out.unit = out.unit || type.default_unit;
    out.measured_at = out.measured_at || new Date();
    out.source = out.source || "manual";
  } else if ("unit" in out && !out.unit) out.unit = type.default_unit;
  return out;
}

const CREATE_FIELDS = ["vital_type", "value_numeric", "value_secondary", "unit", "measured_at", "measurement_context", "body_position",
  "device_name", "source", "condition_id", "notes"];
const NUMBER_FIELDS = ["value_numeric", "value_secondary"];

// A reading made by the server (autofill, the CCDA import, seed; the website saves through the Parse SDK). The body is
// loose like the old POST /vitals: numbers may come as text and measured_at as an ISO string; "" counts as not sent.
async function createVital(body, user) {
  if (!body || !body.vital_type || body.value_numeric === undefined || body.value_numeric === null) {
    return { status: 400, error: "Missing required fields: vital_type, value_numeric" };
  }
  const values = {};
  for (const f of CREATE_FIELDS) if (body[f] !== undefined && body[f] !== null && body[f] !== "") values[f] = body[f];
  if (!typeOf(values.vital_type)) return { status: 400, error: `Unknown vital_type: ${values.vital_type}` };
  for (const f of CREATE_FIELDS) {
    if (values[f] === undefined) continue;
    if (NUMBER_FIELDS.includes(f)) {
      const n = Number(values[f]);
      if (!Number.isFinite(n)) return { status: 400, error: `${f} must be a number` };
      values[f] = n;
    } else if (f === "measured_at") values[f] = new Date(values[f]);
    else values[f] = String(values[f]);
  }
  const problem = validate(values, null);
  if (problem) return { status: 400, error: problem };
  if (values.condition_id !== undefined) {
    if (!isId(values.condition_id)) return { status: 400, error: "Invalid condition_id" };
    if (!(await getOwned("Condition", values.condition_id, user.user_id))) return { status: 404, error: "Condition not found" };
  }
  const reading = await create("VitalReading", { ...clean(values, null), user_id: user.user_id });
  const data = row(reading);
  await audit({ userId: user.user_id, event: "INSERT", targetClass: "VitalReading", targetId: reading.id, newData: data });
  const out = { status: 201, message: "Vital sign recorded", reading: data,
    evaluation: evaluate(data, typeOf(data.vital_type), await activeTarget(user.user_id, data.vital_type)) };
  const bmi = await bmiAfterSave(user, data, { isNew: true });
  if (bmi) out.bmi = bmi;
  return out;
}

// ---- the automatic BMI after a browser save / delete (access.js RULES.VitalReading; runs with the master key) ----
// A weight or height saved by the browser refreshes (or makes) its calculated BMI, as the old routes did.
async function afterBrowserSave(obj, { original }) {
  await bmiAfterSave({ user_id: obj.get("user_id") }, row(obj), { isNew: !original });
}
// a removed weight or height removes the BMI built from it
async function afterBrowserDelete(obj) {
  const vt = obj.get("vital_type");
  if (vt === "weight" || vt === "height") await bmiAfterDelete({ user_id: obj.get("user_id") }, obj.id);
}
// a calculated BMI is never removed from the browser (it goes with its weight or height)
const deleteProblem = (obj) => (obj.get("source") === BMI_SOURCE ? CALCULATED_BMI_REMOVE_MESSAGE : null);

// latest reading per type + in/out of range (share codes; the website has its own copy in
// Vite/src/data/vitals.ts)
async function summary(user) {
  const all = await readings(user.user_id);
  const latest = new Map();
  for (const r of all) if (!latest.has(r.vital_type)) latest.set(r.vital_type, r);
  const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
  const out = [];
  for (const [vt, r] of latest) {
    const type = typeOf(vt);
    if (!type) continue;
    const ofType = all.filter((x) => x.vital_type === vt);
    out.push({
      vital_type: vt, display_name: type.display_name, is_dual_value: type.is_dual_value, value_label: type.value_label,
      secondary_label: type.secondary_label, decimal_places: type.decimal_places,
      latest: { vital_log_id: r.vital_log_id, value_numeric: r.value_numeric, value_secondary: r.value_secondary, unit: r.unit,
        measured_at: r.measured_at, measurement_context: r.measurement_context, notes: r.notes },
      evaluation: evaluate(r, type, await activeTarget(user.user_id, vt)),
      total_readings: ofType.length, readings_last_30_days: ofType.filter((x) => x.measured_at >= since30).length,
      _sort: type.sort_order,
    });
  }
  out.sort((a, b) => a._sort - b._sort);
  out.forEach((s) => delete s._sort);
  const flagged = out.filter((s) => s.evaluation.status === "above_range" || s.evaluation.status === "below_range").length;
  return { status: 200, summary: out, tracked_types: out.length, flagged_count: flagged };
}

// validate, clean, row, FIELDS and the BMI hooks are also used by access.js (RULES.VitalReading)
module.exports = { list, create: createVital, summary, validate, clean, row, FIELDS, afterBrowserSave, afterBrowserDelete, deleteProblem };
