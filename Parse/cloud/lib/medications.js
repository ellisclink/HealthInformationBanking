// medications.js — Medication inventory (Tasks 4.1 / 4.2), on Parse.
//   GET    /medications                    list (filter: status, low_stock=true, search)
//   GET    /medications/summary            counts, low-stock list, 7/30-day adherence
//   GET    /medications/:id                one medication with recent doses + refills
//   POST   /medications                    add
//   PUT    /medications/:id                update (partial; null clears)
//   DELETE /medications/:id                remove (doses/refills too)
//   POST   /medications/:id/doses          log a taken / skipped / missed dose
//   GET    /medications/:id/doses          dose history (startDate, endDate, limit)
//   POST   /medications/:id/refills        record a refill (adds to the count)
//   GET    /medications/:id/refills        refill history
// Classes: Medication, DoseLog, Refill

const { M, isId, isDate, isDateTime, today, toRow, findAll, getOwned, save, create, destroyAll, audit, param } = require("./db");

const MED_FIELDS = ["user_id", "medication_name", "medication_type", "brand_name", "rxnorm_code", "ndc_code",
  "strength", "strength_unit", "dosage_form", "route", "dose_amount", "dose_unit", "frequency", "schedule_times",
  "instructions", "purpose", "condition_id", "prescriber_name", "pharmacy_name", "status", "start_date", "end_date",
  "discontinued_reason", "quantity_on_hand", "refill_threshold", "refills_remaining", "last_refill_date", "source", "notes"];
const DOSE_FIELDS = ["medication_id", "user_id", "taken_at", "dose_status", "quantity", "notes"];
const REFILL_FIELDS = ["medication_id", "user_id", "refill_date", "quantity_added", "pharmacy_name", "notes"];

const VALID_FORMS = ["tablet", "capsule", "liquid", "injection", "inhaler", "patch", "cream", "drops", "spray", "powder", "other"];
const VALID_ROUTES = ["oral", "topical", "injection", "inhalation", "nasal", "ophthalmic", "otic", "rectal", "transdermal", "sublingual", "other"];
const VALID_FREQUENCIES = ["once_daily", "twice_daily", "three_times_daily", "four_times_daily", "every_other_day", "weekly", "as_needed", "other"];
const VALID_STATUSES = ["active", "paused", "completed", "discontinued"];
const VALID_SOURCES = ["patient_reported", "document_upload", "provider_entered"];
const VALID_TYPES = ["prescription", "non_prescription"];
const VALID_DOSE_STATUSES = ["taken", "skipped", "missed"];
const DOSES_PER_DAY = { once_daily: 1, twice_daily: 2, three_times_daily: 3, four_times_daily: 4, every_other_day: 0.5, weekly: 1 / 7, as_needed: null, other: null };
const TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/;
const DEFAULTS = { medication_type: "prescription", dose_amount: 1, dose_unit: "tablet", frequency: "once_daily", quantity_on_hand: 0, source: "patient_reported" };
const EDITABLE_FIELDS = MED_FIELDS.filter((f) => !["user_id", "last_refill_date", "status"].includes(f)).concat("status");

const medRow = (o) => toRow(o, "medication_id", MED_FIELDS);
const doseRow = (o) => toRow(o, "dose_log_id", DOSE_FIELDS);
const refillRow = (o) => toRow(o, "refill_id", REFILL_FIELDS);

// estimates the page needs, so the frontend doesn't do dose math
function withInventoryInfo(med) {
  const perDay = DOSES_PER_DAY[med.frequency];
  const onHand = Number(med.quantity_on_hand);
  const dose = Number(med.dose_amount);
  const threshold = med.refill_threshold != null ? Number(med.refill_threshold) : null;
  let daysSupply = null, runOut = null;
  if (perDay && dose > 0) {
    daysSupply = Math.floor(onHand / (dose * perDay));
    const d = new Date();
    d.setDate(d.getDate() + daysSupply);
    runOut = d.toISOString().slice(0, 10);
  }
  return {
    ...med, doses_per_day: perDay,
    days_supply: med.status === "active" ? daysSupply : null,
    estimated_run_out_date: med.status === "active" ? runOut : null,
    low_stock: med.status === "active" && threshold !== null && onHand <= threshold,
  };
}

function validateFields(body) {
  if ("medication_name" in body) {
    const name = body.medication_name == null ? "" : String(body.medication_name).trim();
    if (!name) return "medication_name cannot be empty";
    if (name.length > 255) return "medication_name is too long (max 255)";
  }
  if (body.dosage_form != null && !VALID_FORMS.includes(body.dosage_form)) return `Invalid dosage_form. Must be one of: ${VALID_FORMS.join(", ")}`;
  if (body.route != null && !VALID_ROUTES.includes(body.route)) return `Invalid route. Must be one of: ${VALID_ROUTES.join(", ")}`;
  if ("frequency" in body && !VALID_FREQUENCIES.includes(body.frequency)) return `Invalid frequency. Must be one of: ${VALID_FREQUENCIES.join(", ")}`;
  if ("status" in body && !VALID_STATUSES.includes(body.status)) return `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`;
  if ("source" in body && !VALID_SOURCES.includes(body.source)) return `Invalid source. Must be one of: ${VALID_SOURCES.join(", ")}`;
  if ("medication_type" in body && !VALID_TYPES.includes(body.medication_type)) return `Invalid medication_type. Must be one of: ${VALID_TYPES.join(", ")}`;
  if ("dose_amount" in body) {
    const n = Number(body.dose_amount);
    if (body.dose_amount === null || !Number.isFinite(n) || n <= 0) return "dose_amount must be a positive number";
  }
  if ("dose_unit" in body && (body.dose_unit == null || !String(body.dose_unit).trim())) return "dose_unit cannot be empty";
  if ("quantity_on_hand" in body) {
    const n = Number(body.quantity_on_hand);
    if (body.quantity_on_hand === null || !Number.isFinite(n) || n < 0) return "quantity_on_hand must be a number of 0 or more";
  }
  if (body.strength != null && !(Number(body.strength) > 0)) return "strength must be a positive number";
  if (body.refill_threshold != null && !(Number(body.refill_threshold) >= 0)) return "refill_threshold must be a number of 0 or more";
  if (body.refills_remaining != null && !(Number.isInteger(Number(body.refills_remaining)) && Number(body.refills_remaining) >= 0)) {
    return "refills_remaining must be a whole number of 0 or more";
  }
  for (const f of ["start_date", "end_date"]) if (body[f] != null && !isDateTime(body[f])) return `${f} is not a valid date`;
  if (body.schedule_times != null) {
    if (!Array.isArray(body.schedule_times)) return 'schedule_times must be an array like ["08:00", "20:00"]';
    for (const t of body.schedule_times) if (typeof t !== "string" || !TIME_PATTERN.test(t)) return `schedule_times entry "${t}" is not a valid HH:MM time`;
  }
  if (body.condition_id != null && !isId(String(body.condition_id))) return "condition_id must be a valid id";
  for (const f of ["brand_name", "instructions", "purpose", "prescriber_name", "pharmacy_name", "notes", "discontinued_reason", "strength_unit"]) {
    if (body[f] != null && String(body[f]).length > 1000) return `${f} is too long`;
  }
  return null;
}

async function validateLinks(body, user) {
  if (body.condition_id != null && !(await getOwned("Condition", String(body.condition_id), user.user_id))) {
    return "condition_id does not match one of your conditions";
  }
  return null;
}

function columnValue(field, value) {
  if (value === null || value === undefined) return null;
  if (["strength", "dose_amount", "quantity_on_hand", "refill_threshold"].includes(field)) return Number(value);
  if (field === "refills_remaining") return parseInt(value, 10);
  if (field === "schedule_times") return value;
  if (["start_date", "end_date"].includes(field)) return String(value).slice(0, 10);
  const s = String(value).trim();
  return s === "" ? null : s;
}

// GET /medications?status=&low_stock=true&search=
async function list(query, user) {
  const status = param(query, "status"), lowStock = param(query, "low_stock"), search = param(query, "search");
  if (status && !VALID_STATUSES.includes(status)) return { status: 400, error: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}` };
  let meds = (await findAll("Medication", { user_id: user.user_id })).map(medRow);
  if (status) meds = meds.filter((m) => m.status === status);
  if (search) {
    const s = String(search).trim().toLowerCase();
    meds = meds.filter((m) => m.medication_name.toLowerCase().includes(s) || (m.brand_name || "").toLowerCase().includes(s));
  }
  meds.sort((a, b) => (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1) || a.medication_name.localeCompare(b.medication_name));
  let medications = meds.map(withInventoryInfo);
  if (lowStock === "true") medications = medications.filter((m) => m.low_stock);
  return { status: 200, medications, count: medications.length };
}

// GET /medications/:id
async function getById(id, user) {
  const med = await getOwned("Medication", id, user.user_id);
  if (!med) return { status: isId(id) ? 404 : 400, error: isId(id) ? "Medication not found" : "Invalid medication ID" };
  const doses = (await findAll("DoseLog", { medication_id: med.id, user_id: user.user_id })).map(doseRow)
    .sort((a, b) => b.taken_at.localeCompare(a.taken_at)).slice(0, 20);
  const refills = (await findAll("Refill", { medication_id: med.id, user_id: user.user_id })).map(refillRow)
    .sort((a, b) => b.refill_date.localeCompare(a.refill_date) || b.created_at.localeCompare(a.created_at));
  return { status: 200, medication: withInventoryInfo(medRow(med)), recent_doses: doses, refills };
}

// POST /medications
async function createMed(body, user) {
  if (!body || !body.medication_name) return { status: 400, error: "Missing required field: medication_name" };
  const fieldError = validateFields(body);
  if (fieldError) return { status: 400, error: fieldError };
  if (body.start_date && body.end_date && new Date(body.end_date) < new Date(body.start_date)) return { status: 400, error: "end_date cannot be before start_date" };
  const linkError = await validateLinks(body, user);
  if (linkError) return { status: 400, error: linkError };

  const status = body.status || "active";
  const values = { ...DEFAULTS, user_id: user.user_id, status };
  for (const f of EDITABLE_FIELDS) if (body[f] != null && f !== "status") values[f] = columnValue(f, body[f]);
  if ((status === "discontinued" || status === "completed") && !body.end_date) values.end_date = today();
  const med = await create("Medication", values);
  const row = medRow(med);
  await audit({ userId: user.user_id, event: "INSERT", targetClass: "Medication", targetId: med.id, newData: row });
  return { status: 201, message: "Medication added", medication: withInventoryInfo(row) };
}

// PUT /medications/:id
async function update(id, body, user) {
  if (!body || typeof body !== "object") return { status: 400, error: "No fields to update" };
  const fields = EDITABLE_FIELDS.filter((f) => body[f] !== undefined);
  if (fields.length === 0) return { status: 400, error: "No fields to update" };
  const fieldError = validateFields(body);
  if (fieldError) return { status: 400, error: fieldError };
  const med = await getOwned("Medication", id, user.user_id);
  if (!med) return { status: isId(id) ? 404 : 400, error: isId(id) ? "Medication not found" : "Invalid medication ID" };
  const oldData = medRow(med);
  const linkError = await validateLinks(body, user);
  if (linkError) return { status: 400, error: linkError };

  const updates = {};
  for (const f of fields) updates[f] = columnValue(f, body[f]);
  if (updates.dose_amount === null || updates.quantity_on_hand === null || updates.medication_name === null) {
    return { status: 400, error: "medication_name, dose_amount and quantity_on_hand can't be cleared" };
  }
  if (updates.status && updates.status !== oldData.status) {
    if ((updates.status === "discontinued" || updates.status === "completed") && body.end_date === undefined && !oldData.end_date) updates.end_date = today();
    if (updates.status === "active") {
      if (body.end_date === undefined) updates.end_date = null;
      if (body.discontinued_reason === undefined) updates.discontinued_reason = null;
    }
  }
  const nextStart = "start_date" in updates ? updates.start_date : oldData.start_date;
  const nextEnd = "end_date" in updates ? updates.end_date : oldData.end_date;
  if (nextStart && nextEnd && new Date(nextEnd) < new Date(nextStart)) return { status: 400, error: "end_date cannot be before start_date" };

  await save(med, updates);
  const row = medRow(med);
  await audit({ userId: user.user_id, event: "UPDATE", targetClass: "Medication", targetId: med.id, oldData, newData: row });
  return { status: 200, message: "Medication updated", medication: withInventoryInfo(row) };
}

// DELETE /medications/:id
async function remove(id, user) {
  const med = await getOwned("Medication", id, user.user_id);
  if (!med) return { status: isId(id) ? 404 : 400, error: isId(id) ? "Medication not found" : "Invalid medication ID" };
  const oldData = medRow(med);
  await destroyAll(await findAll("DoseLog", { medication_id: med.id }));
  await destroyAll(await findAll("Refill", { medication_id: med.id }));
  await destroyAll(await findAll("SafetyAlert", { medication_id: med.id }));
  await med.destroy(M);
  await audit({ userId: user.user_id, event: "DELETE", targetClass: "Medication", targetId: id, oldData });
  return { status: 200, message: "Medication deleted" };
}

// POST /medications/:id/doses {dose_status, taken_at?, quantity?, notes?}
async function logDose(id, body, user) {
  body = body || {};
  const doseStatus = body.dose_status || "taken";
  if (!VALID_DOSE_STATUSES.includes(doseStatus)) return { status: 400, error: `Invalid dose_status. Must be one of: ${VALID_DOSE_STATUSES.join(", ")}` };
  if (body.taken_at != null) {
    if (!isDateTime(body.taken_at)) return { status: 400, error: "taken_at is not a valid date/time" };
    if (new Date(body.taken_at).getTime() > Date.now() + 5 * 60 * 1000) return { status: 400, error: "taken_at cannot be in the future" };
  }
  if (body.quantity != null) {
    const n = Number(body.quantity);
    if (!Number.isFinite(n) || n <= 0) return { status: 400, error: "quantity must be a positive number" };
    if (doseStatus !== "taken") return { status: 400, error: "quantity only applies to taken doses" };
  }
  const med = await getOwned("Medication", id, user.user_id);
  if (!med) return { status: isId(id) ? 404 : 400, error: isId(id) ? "Medication not found" : "Invalid medication ID" };
  if (["discontinued", "completed"].includes(med.get("status"))) return { status: 409, error: `Cannot log a dose for a ${med.get("status")} medication` };

  const quantity = doseStatus === "taken" ? (body.quantity != null ? Number(body.quantity) : Number(med.get("dose_amount"))) : 0;
  const onHand = Number(med.get("quantity_on_hand") || 0);
  const shortBy = quantity > onHand ? quantity - onHand : 0;
  const dose = await create("DoseLog", {
    medication_id: med.id, user_id: user.user_id, taken_at: body.taken_at ? new Date(body.taken_at) : new Date(),
    dose_status: doseStatus, quantity, notes: body.notes ? String(body.notes).slice(0, 1000) : null,
  });
  if (quantity > 0) {
    // atomic subtract, then clamp at zero
    med.increment("quantity_on_hand", -quantity);
    await med.save(null, M);
    if (med.get("quantity_on_hand") < 0) await save(med, { quantity_on_hand: 0 });
  }
  const doseData = doseRow(dose);
  await audit({ userId: user.user_id, event: "INSERT", targetClass: "DoseLog", targetId: dose.id, newData: doseData });
  const response = { status: 201, message: "Dose logged", dose: doseData, medication: withInventoryInfo(medRow(med)) };
  if (shortBy > 0) response.inventory_warning = `Logged ${quantity} but only ${onHand} were on hand; count set to 0. Record a refill or correct quantity_on_hand.`;
  return response;
}

// GET /medications/:id/doses?startDate&endDate&limit
async function getDoses(id, query, user) {
  const startDate = param(query, "startDate"), endDate = param(query, "endDate"), limitRaw = param(query, "limit");
  if (startDate && !isDateTime(startDate)) return { status: 400, error: "startDate is not a valid date" };
  if (endDate && !isDateTime(endDate)) return { status: 400, error: "endDate is not a valid date" };
  let limit = 100;
  if (limitRaw != null) {
    limit = parseInt(limitRaw, 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return { status: 400, error: "limit must be between 1 and 1000" };
  }
  const med = await getOwned("Medication", id, user.user_id);
  if (!med) return { status: isId(id) ? 404 : 400, error: isId(id) ? "Medication not found" : "Invalid medication ID" };
  let doses = (await findAll("DoseLog", { medication_id: med.id, user_id: user.user_id })).map(doseRow);
  if (startDate) doses = doses.filter((d) => d.taken_at >= new Date(startDate.slice(0, 10)).toISOString());
  if (endDate) doses = doses.filter((d) => d.taken_at < new Date(new Date(endDate.slice(0, 10)).getTime() + 86400000).toISOString());
  doses.sort((a, b) => b.taken_at.localeCompare(a.taken_at));
  doses = doses.slice(0, limit);
  return { status: 200, doses, count: doses.length };
}

// POST /medications/:id/refills {quantity_added, refill_date?, pharmacy_name?, notes?, uses_refill?}
async function addRefill(id, body, user) {
  body = body || {};
  const qty = Number(body.quantity_added);
  if (body.quantity_added == null || !Number.isFinite(qty) || qty <= 0) return { status: 400, error: "quantity_added must be a positive number" };
  if (body.refill_date != null && !isDateTime(body.refill_date)) return { status: 400, error: "refill_date is not a valid date" };
  const usesRefill = body.uses_refill !== false;
  const med = await getOwned("Medication", id, user.user_id);
  if (!med) return { status: isId(id) ? 404 : 400, error: isId(id) ? "Medication not found" : "Invalid medication ID" };
  const before = medRow(med);
  const refillDate = body.refill_date ? String(body.refill_date).slice(0, 10) : today();
  const refill = await create("Refill", {
    medication_id: med.id, user_id: user.user_id, refill_date: refillDate, quantity_added: qty,
    pharmacy_name: body.pharmacy_name || med.get("pharmacy_name") || null, notes: body.notes || null,
  });
  med.increment("quantity_on_hand", qty);
  if (!med.get("last_refill_date") || refillDate > med.get("last_refill_date")) med.set("last_refill_date", refillDate);
  if (usesRefill && med.get("refills_remaining") != null) med.set("refills_remaining", Math.max(med.get("refills_remaining") - 1, 0));
  await med.save(null, M);
  const refillData = refillRow(refill);
  await audit({ userId: user.user_id, event: "INSERT", targetClass: "Refill", targetId: refill.id, newData: refillData });
  const response = { status: 201, message: "Refill recorded", refill: refillData, medication: withInventoryInfo(medRow(med)) };
  if (usesRefill && before.refills_remaining === 0) response.refill_warning = "No refills were remaining on this prescription; check with the prescriber.";
  return response;
}

// GET /medications/:id/refills
async function getRefills(id, user) {
  const med = await getOwned("Medication", id, user.user_id);
  if (!med) return { status: isId(id) ? 404 : 400, error: isId(id) ? "Medication not found" : "Invalid medication ID" };
  const refills = (await findAll("Refill", { medication_id: med.id, user_id: user.user_id })).map(refillRow)
    .sort((a, b) => b.refill_date.localeCompare(a.refill_date) || b.created_at.localeCompare(a.created_at));
  return { status: 200, refills, count: refills.length };
}

// GET /medications/summary
async function summary(user) {
  const all = (await findAll("Medication", { user_id: user.user_id })).map(medRow);
  const active = all.filter((m) => m.status === "active").sort((a, b) => a.medication_name.localeCompare(b.medication_name)).map(withInventoryInfo);
  const since30 = Date.now() - 30 * 86400000, since7 = Date.now() - 7 * 86400000;
  const doses = (await findAll("DoseLog", { user_id: user.user_id })).map(doseRow).filter((d) => new Date(d.taken_at).getTime() >= since30);
  const counts = new Map();
  for (const d of doses) {
    const c = counts.get(d.medication_id) || { taken_7: 0, taken_30: 0, not_taken_30: 0, last_taken_at: null };
    const t = new Date(d.taken_at).getTime();
    if (d.dose_status === "taken") {
      c.taken_30++;
      if (t >= since7) c.taken_7++;
      if (!c.last_taken_at || d.taken_at > c.last_taken_at) c.last_taken_at = d.taken_at;
    } else c.not_taken_30++;
    counts.set(d.medication_id, c);
  }
  const expected = (med, days) => {
    if (!med.doses_per_day) return null;
    const began = new Date(med.start_date || med.created_at);
    if (began.getTime() > Date.now()) return null;            // hasn't started yet
    const windowStart = new Date(Date.now() - days * 86400000);
    const from = began > windowStart ? began : windowStart;
    const activeDays = Math.max(0, (Date.now() - from.getTime()) / 86400000);
    return Math.max(1, Math.round(activeDays * med.doses_per_day));
  };
  const pct = (taken, exp) => (exp ? Math.min(100, Math.round((taken / exp) * 100)) : null);
  let taken7 = 0, exp7 = 0, taken30 = 0, exp30 = 0;
  const adherence = active.map((med) => {
    const c = counts.get(med.medication_id) || { taken_7: 0, taken_30: 0, not_taken_30: 0, last_taken_at: null };
    const e7 = expected(med, 7), e30 = expected(med, 30);
    if (e7) { taken7 += Math.min(c.taken_7, e7); exp7 += e7; }
    if (e30) { taken30 += Math.min(c.taken_30, e30); exp30 += e30; }
    return {
      medication_id: med.medication_id, medication_name: med.medication_name, frequency: med.frequency,
      taken_last_7_days: c.taken_7, expected_last_7_days: e7, adherence_7_day_pct: pct(c.taken_7, e7),
      taken_last_30_days: c.taken_30, expected_last_30_days: e30, adherence_30_day_pct: pct(c.taken_30, e30),
      skipped_or_missed_last_30_days: c.not_taken_30, last_taken_at: c.last_taken_at,
    };
  });
  const needsRefill = active.filter((m) => m.low_stock || (m.days_supply !== null && m.days_supply <= 7)).map((m) => ({
    medication_id: m.medication_id, medication_name: m.medication_name, quantity_on_hand: m.quantity_on_hand,
    dose_unit: m.dose_unit, days_supply: m.days_supply, estimated_run_out_date: m.estimated_run_out_date,
    refills_remaining: m.refills_remaining, pharmacy_name: m.pharmacy_name, low_stock: m.low_stock,
  }));
  const byStatus = VALID_STATUSES.map((s) => ({ status: s, count: all.filter((m) => m.status === s).length })).filter((r) => r.count);
  return {
    status: 200, total_medications: all.length, active_count: active.length, by_status: byStatus, needs_refill: needsRefill,
    overall_adherence_7_day_pct: pct(taken7, exp7), overall_adherence_30_day_pct: pct(taken30, exp30), adherence,
  };
}

module.exports = { list, getById, create: createMed, update, remove, logDose, getDoses, addRefill, getRefills, summary, medRow, withInventoryInfo, isDate };
