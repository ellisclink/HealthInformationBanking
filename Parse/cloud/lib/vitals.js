// vitals.js — Vital signs logging & charts (Tasks 3.1 / 3.2), on Parse.
//   GET    /vitals/types        supported types + reference ranges
//   GET    /vitals              list readings (type, startDate, endDate, limit)
//   GET    /vitals/:id          one reading
//   POST   /vitals              log a reading
//   PUT    /vitals/:id          correct a reading
//   DELETE /vitals/:id          delete a reading
//   GET    /vitals/summary      latest reading per type + in/out of range
//   GET    /vitals/trends       min/max/avg per day|week|month over a window
//   GET    /vitals/quick-look   week|month|year|all chart series + today's value (dashboard)
// Class: VitalReading. The chart buckets used to be a rollup table; they're now computed
// from the readings on request (a patient has hundreds, not millions).

const { M, isId, isDate, isDateTime, toRow, findAll, findOne, getOwned, save, create, audit, param } = require("./db");
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
  const rec = await findOne("MedicalRecord", { user_id: userId });
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

function describeAge(seconds) {
  if (seconds < 90) return "just now";
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo} month${mo === 1 ? "" : "s"} ago`;
  const y = (d / 365).toFixed(1);
  return `${y} year${y === "1.0" ? "" : "s"} ago`;
}

const types = () => ({ status: 200, types: VITAL_TYPES.map(({ sort_order, ...t }) => t) });

async function readings(userId, vitalType) {
  const rows = (await findAll("VitalReading", vitalType ? { user_id: userId, vital_type: vitalType } : { user_id: userId })).map(row);
  return rows.sort((a, b) => b.measured_at.localeCompare(a.measured_at));
}

// GET /vitals
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

async function getById(id, user) {
  if (!isId(id)) return { status: 400, error: "Invalid vital log ID" };
  const r = await getOwned("VitalReading", id, user.user_id);
  if (!r) return { status: 404, error: "Reading not found" };
  const data = row(r);
  if (data.vital_type === "bmi") data.bmi_info = bmiInfoFor(data, await dobOf(user.user_id));
  return { status: 200, reading: data };
}

function checkOptional(body) {
  if (body.measurement_context && !VALID_CONTEXTS.includes(body.measurement_context)) return `Invalid measurement_context. Must be one of: ${VALID_CONTEXTS.join(", ")}`;
  if (body.body_position && !VALID_POSITIONS.includes(body.body_position)) return `Invalid body_position. Must be one of: ${VALID_POSITIONS.join(", ")}`;
  if (body.source && !VALID_SOURCES.includes(body.source)) return `Invalid source. Must be one of: ${VALID_SOURCES.join(", ")}`;
  for (const f of ["notes", "device_name", "unit"]) if (body[f] != null && String(body[f]).length > 1000) return `${f} is too long`;
  return null;
}
function checkWhen(value) {
  if (!value) return { at: null };
  const parsed = new Date(value);
  if (isNaN(parsed.getTime())) return { error: "measured_at is not a valid date" };
  if (parsed.getTime() > Date.now() + 60 * 1000) return { error: "measured_at cannot be in the future" };
  return { at: parsed };
}

// POST /vitals
async function createVital(body, user) {
  if (!body || !body.vital_type || body.value_numeric === undefined || body.value_numeric === null) {
    return { status: 400, error: "Missing required fields: vital_type, value_numeric" };
  }
  const type = typeOf(body.vital_type);
  if (!type) return { status: 400, error: `Unknown vital_type: ${body.vital_type}` };
  const value = Number(body.value_numeric);
  if (!Number.isFinite(value)) return { status: 400, error: "value_numeric must be a number" };
  let secondary = null;
  if (type.is_dual_value) {
    if (body.value_secondary === undefined || body.value_secondary === null) return { status: 400, error: `${type.display_name} requires value_secondary (${type.secondary_label})` };
    secondary = Number(body.value_secondary);
    if (!Number.isFinite(secondary)) return { status: 400, error: "value_secondary must be a number" };
    if (secondary >= value) return { status: 400, error: `${type.secondary_label} must be lower than ${type.value_label}` };
  } else if (body.value_secondary !== undefined && body.value_secondary !== null) {
    return { status: 400, error: `${type.display_name} does not take a second value` };
  }
  const b = PLAUSIBLE_BOUNDS[body.vital_type];
  if (b && (value < b.min || value > b.max)) {
    return { status: 400, error: `${type.display_name} reading of ${value} ${type.default_unit} is outside the recordable range (${b.min}–${b.max}). Check the value and try again.` };
  }
  if (secondary !== null && b && b.secondaryMin !== undefined && (secondary < b.secondaryMin || secondary > b.secondaryMax)) {
    return { status: 400, error: `${type.secondary_label} reading of ${secondary} is outside the recordable range (${b.secondaryMin}–${b.secondaryMax}).` };
  }
  const optErr = checkOptional(body);
  if (optErr) return { status: 400, error: optErr };
  const when = checkWhen(body.measured_at);
  if (when.error) return { status: 400, error: when.error };
  if (body.condition_id != null) {
    if (!isId(String(body.condition_id))) return { status: 400, error: "Invalid condition_id" };
    if (!(await getOwned("Condition", String(body.condition_id), user.user_id))) return { status: 404, error: "Condition not found" };
  }
  const reading = await create("VitalReading", {
    user_id: user.user_id, vital_type: body.vital_type, value_numeric: value, value_secondary: secondary,
    unit: body.unit || type.default_unit, measured_at: when.at || new Date(),
    measurement_context: body.measurement_context || null, body_position: body.body_position || null,
    device_name: body.device_name || null, source: body.source || "manual",
    condition_id: body.condition_id != null ? String(body.condition_id) : null, notes: body.notes || null,
  });
  const data = row(reading);
  await audit({ userId: user.user_id, event: "INSERT", targetClass: "VitalReading", targetId: reading.id, newData: data });
  const out = { status: 201, message: "Vital sign recorded", reading: data, evaluation: evaluate(data, type, await activeTarget(user.user_id, body.vital_type)) };
  const bmi = await bmiAfterSave(user, data, { isNew: true });
  if (bmi) out.bmi = bmi;
  return out;
}

// PUT /vitals/:id
async function update(id, body, user) {
  if (!isId(id)) return { status: 400, error: "Invalid vital log ID" };
  if (!body || Object.keys(body).length === 0) return { status: 400, error: "No fields to update" };
  if (body.vital_type) return { status: 400, error: "vital_type cannot be changed; delete this reading and log a new one" };
  const optErr = checkOptional(body);
  if (optErr) return { status: 400, error: optErr };
  const r = await getOwned("VitalReading", id, user.user_id);
  if (!r) return { status: 404, error: "Reading not found" };
  if (r.get("source") === BMI_SOURCE) return { status: 400, error: "A calculated BMI cannot be edited. Change the weight or height instead." };
  const oldData = row(r);
  const type = typeOf(oldData.vital_type);
  const value = body.value_numeric != null ? Number(body.value_numeric) : Number(oldData.value_numeric);
  if (!Number.isFinite(value)) return { status: 400, error: "value_numeric must be a number" };
  const secondary = body.value_secondary !== undefined ? (body.value_secondary === null ? null : Number(body.value_secondary)) : oldData.value_secondary;
  if (type.is_dual_value) {
    if (secondary === null || !Number.isFinite(secondary)) return { status: 400, error: `${type.display_name} requires value_secondary` };
    if (secondary >= value) return { status: 400, error: `${type.secondary_label} must be lower than ${type.value_label}` };
  } else if (secondary !== null) return { status: 400, error: `${type.display_name} does not take a second value` };
  const b = PLAUSIBLE_BOUNDS[oldData.vital_type];
  if (b && (value < b.min || value > b.max)) return { status: 400, error: `${type.display_name} reading of ${value} is outside the recordable range (${b.min}–${b.max}).` };
  const when = checkWhen(body.measured_at);
  if (when.error) return { status: 400, error: when.error };
  await save(r, {
    value_numeric: value, value_secondary: secondary, unit: body.unit || undefined, measured_at: when.at || undefined,
    measurement_context: body.measurement_context || undefined, body_position: body.body_position || undefined,
    device_name: body.device_name || undefined, notes: body.notes || undefined,
  });
  const data = row(r);
  await audit({ userId: user.user_id, event: "UPDATE", targetClass: "VitalReading", targetId: r.id, oldData, newData: data });
  const out = { status: 200, message: "Vital sign updated", reading: data, evaluation: evaluate(data, type, await activeTarget(user.user_id, oldData.vital_type)) };
  const bmi = await bmiAfterSave(user, data, { isNew: false });
  if (bmi) out.bmi = bmi;
  return out;
}

async function remove(id, user) {
  if (!isId(id)) return { status: 400, error: "Invalid vital log ID" };
  const r = await getOwned("VitalReading", id, user.user_id);
  if (!r) return { status: 404, error: "Reading not found" };
  if (r.get("source") === BMI_SOURCE) return { status: 400, error: CALCULATED_BMI_REMOVE_MESSAGE };
  const oldData = row(r);
  await r.destroy(M);
  await audit({ userId: user.user_id, event: "DELETE", targetClass: "VitalReading", targetId: id, oldData });
  if (oldData.vital_type === "weight" || oldData.vital_type === "height") await bmiAfterDelete(user, id);
  return { status: 200, message: "Vital sign deleted" };
}

// GET /vitals/summary (also used by share codes)
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

// bucket start (UTC) for a timestamp
function bucketStart(iso, size) {
  const d = new Date(iso);
  if (size === "day") return d.toISOString().slice(0, 10);
  if (size === "month") return `${d.toISOString().slice(0, 7)}-01`;
  // week: Monday (like Postgres date_trunc('week'))
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
}
const round2 = (n) => Number(n.toFixed(2));
function buckets(rows, size) {
  const map = new Map();
  for (const r of [...rows].sort((a, b) => a.measured_at.localeCompare(b.measured_at))) {
    const k = bucketStart(r.measured_at, size);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([start, list]) => {
    const vals = list.map((r) => Number(r.value_numeric));
    const secs = list.filter((r) => r.value_secondary != null).map((r) => Number(r.value_secondary));
    const avg = (a) => (a.length ? round2(a.reduce((s, x) => s + x, 0) / a.length) : null);
    return {
      bucket_start: start, reading_count: list.length, avg_value: avg(vals), min_value: Math.min(...vals), max_value: Math.max(...vals),
      avg_secondary: avg(secs), min_secondary: secs.length ? Math.min(...secs) : null, max_secondary: secs.length ? Math.max(...secs) : null,
    };
  });
}

// GET /vitals/trends?type=&days=&bucket=
async function trends(query, user) {
  const vitalType = param(query, "type");
  if (!vitalType) return { status: 400, error: "Missing required parameter: type" };
  const rawDays = parseInt(param(query, "days"), 10);
  const days = Number.isInteger(rawDays) && rawDays > 0 ? Math.min(rawDays, 365) : 30;
  const bucket = String(param(query, "bucket") || "day").toLowerCase();
  if (!["day", "week", "month"].includes(bucket)) return { status: 400, error: "bucket must be one of: day, week, month" };
  const type = typeOf(vitalType);
  if (!type) return { status: 400, error: `Unknown vital_type: ${vitalType}` };
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const raw = (await readings(user.user_id, vitalType)).filter((r) => r.measured_at >= since).reverse();
  const target = await activeTarget(user.user_id, vitalType);
  const range = evaluate({ value_numeric: 0 }, type, target).range;
  const outOfRange = raw.filter((r) => ["above_range", "below_range"].includes(evaluate(r, type, target).status)).length;
  let direction = "insufficient_data", change = null;
  if (raw.length >= 4) {
    const mid = Math.floor(raw.length / 2);
    const mean = (rows) => rows.reduce((s, r) => s + Number(r.value_numeric), 0) / rows.length;
    const first = mean(raw.slice(0, mid)), second = mean(raw.slice(mid));
    change = round2(second - first);
    direction = Math.abs(change) < Math.abs(first) * 0.05 ? "stable" : change > 0 ? "rising" : "falling";
  }
  return {
    status: 200, vital_type: vitalType, display_name: type.display_name, unit: type.default_unit, is_dual_value: type.is_dual_value,
    window_days: days, bucket, range, buckets: buckets(raw, bucket), total_readings: raw.length, out_of_range_count: outOfRange,
    trend: { direction, change },
  };
}

const RANGE_SPEC = {
  week: { bucket: "day", days: 7, label: "Past week" }, month: { bucket: "day", days: 30, label: "Past month" },
  year: { bucket: "month", days: 365, label: "Past year" }, all: { bucket: "month", days: null, label: "All time" },
};

// GET /vitals/quick-look?range=week|month|year|all&type=
async function quickLook(query, user) {
  const range = String(param(query, "range") || "month").toLowerCase();
  const spec = RANGE_SPEC[range];
  if (!spec) return { status: 400, error: `Invalid range. Must be one of: ${Object.keys(RANGE_SPEC).join(", ")}` };
  const onlyType = param(query, "type");
  if (onlyType && !typeOf(onlyType)) return { status: 400, error: `Unknown vital_type: ${onlyType}` };
  const all = await readings(user.user_id, onlyType);
  const present = VITAL_TYPES.filter((t) => all.some((r) => r.vital_type === t.vital_type));
  const todayUtc = new Date().toISOString().slice(0, 10);
  const windowStart = spec.days ? new Date(Date.parse(`${todayUtc}T00:00:00Z`) - spec.days * 86400000).toISOString().slice(0, 10) : null;
  const cards = [];
  const bmiDob = present.some((t) => t.vital_type === "bmi") ? await dobOf(user.user_id) : null;
  for (const type of present) {
    const ofType = all.filter((r) => r.vital_type === type.vital_type);
    const series = buckets(ofType, spec.bucket).filter((b) => !windowStart || b.bucket_start >= windowStart);
    const latestRow = ofType[0];
    let change = null;
    if (series.length >= 2) {
      const first = series[0].avg_value, last = series[series.length - 1].avg_value;
      const delta = round2(last - first);
      change = { from: first, to: last, delta, percent: first !== 0 ? Number(((delta / first) * 100).toFixed(1)) : null,
        direction: Math.abs(delta) < Math.abs(first) * 0.03 ? "steady" : delta > 0 ? "up" : "down" };
      if (type.is_dual_value && series[0].avg_secondary != null) {
        const fs = series[0].avg_secondary, ls = series[series.length - 1].avg_secondary;
        change.secondary = { from: fs, to: ls, delta: round2(ls - fs) };
      }
    }
    const target = await activeTarget(user.user_id, type.vital_type);
    const evaluation = latestRow ? evaluate(latestRow, type, target) : null;
    let bucketsOut = 0;
    if (evaluation && evaluation.status !== "no_range") {
      for (const bk of series) {
        const e = evaluate({ value_numeric: bk.avg_value, value_secondary: bk.avg_secondary }, type, target);
        if (e.status === "above_range" || e.status === "below_range") bucketsOut++;
      }
    }
    cards.push({
      vital_type: type.vital_type, display_name: type.display_name, unit: type.default_unit, is_dual_value: type.is_dual_value,
      value_label: type.value_label, secondary_label: type.secondary_label, decimal_places: type.decimal_places,
      today: latestRow ? {
        value: Number(latestRow.value_numeric), secondary: latestRow.value_secondary != null ? Number(latestRow.value_secondary) : null,
        unit: latestRow.unit, measured_at: latestRow.measured_at, is_today: latestRow.measured_at.slice(0, 10) === todayUtc,
        age_label: describeAge(Math.max(0, (Date.now() - Date.parse(latestRow.measured_at)) / 1000)),
        context: latestRow.measurement_context, evaluation, source: latestRow.source,
        ...(type.vital_type === "bmi" ? { bmi_info: bmiInfoFor(latestRow, bmiDob) } : {}),
      } : null,
      series: series.map((bk) => ({ bucket_start: bk.bucket_start, value: bk.avg_value, secondary: bk.avg_secondary,
        min: bk.min_value, max: bk.max_value, reading_count: bk.reading_count })),
      change, buckets_out_of_range: bucketsOut, range: evaluation ? evaluation.range : null,
    });
  }
  return { status: 200, range, range_label: spec.label, bucket_size: spec.bucket, source: "readings", cards };
}

module.exports = { types, list, getById, create: createVital, update, remove, summary, trends, quickLook, typeOf, findOne, computeBmi, ageOn, bmiCategory };
