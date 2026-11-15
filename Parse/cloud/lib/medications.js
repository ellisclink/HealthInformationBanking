// medications.js — server-side helpers for Medication, DoseLog and Refill (Tasks 4.1 / 4.2), on Parse.
// There is NO /medications route any more (D-025): the website reads and writes these 3 classes with the
// Parse SDK (Vite/src/data/medications.ts) and the triggers in access.js guard them. This file stays for
// the server's own use: the triggers (validation, pill counts), seed.js, the reminders / disposal /
// emergency / shared-view modules and the allergy check. The comments above each function keep
// the old route shape only to say what the helper does.
// Classes: Medication, DoseLog, Refill

const { M, isId, isDateTime, today, toRow, findAll, getOwned, save, create, audit, param } = require("./db");

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

// helper (was GET /medications?status=&low_stock=true&search=)
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

// helper (was POST /medications)
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

// helper (was PUT /medications/:id)
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

// A taken dose lowers the count: atomic subtract, then, if that went below zero, atomically add back the part this
// dose could not take (at most its own quantity). Unlike "set 0", the add-back can't wipe out a refill saved at the
// same moment, and two doses at once on 1 pill still end at 0. Used by logDose() and by the DoseLog trigger so the
// two paths can't drift. Returns the count afterwards.
async function takePills(med, quantity) {
  med.increment("quantity_on_hand", -quantity);
  await med.save(null, M);
  const after = Number(med.get("quantity_on_hand"));
  if (!(after < 0)) return after;
  const fix = Parse.Object.extend("Medication").createWithoutData(med.id);
  fix.increment("quantity_on_hand", Math.min(quantity, -after));
  await fix.save(null, M);
  return Number(fix.get("quantity_on_hand"));
}

// helper (was POST /medications/:id/doses) {dose_status, taken_at?, quantity?, notes?}
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
    const left = await takePills(med, quantity);
    med.set("quantity_on_hand", left);   // the count after the add-back, for the response (not saved again)
  }
  const doseData = doseRow(dose);
  await audit({ userId: user.user_id, event: "INSERT", targetClass: "DoseLog", targetId: dose.id, newData: doseData });
  const response = { status: 201, message: "Dose logged", dose: doseData, medication: withInventoryInfo(medRow(med)) };
  if (shortBy > 0) response.inventory_warning = `Logged ${quantity} but only ${onHand} were on hand; count set to 0. Record a refill or correct quantity_on_hand.`;
  return response;
}

// helper (was POST /medications/:id/refills) {quantity_added, refill_date?, pharmacy_name?, notes?, uses_refill?}
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

module.exports = {
  list, create: createMed, update, logDose, takePills, addRefill, medRow, withInventoryInfo,
  // used by the Medication triggers (access.js)
  validateFields, validateLinks, columnValue, EDITABLE_FIELDS, DEFAULTS,
  doseRow, refillRow, VALID_DOSE_STATUSES,
};
