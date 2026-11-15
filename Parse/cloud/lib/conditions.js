// conditions.js — server-side helpers for Conditions. Classes: Condition, ConditionNote, ConditionTarget
//   The Conditions page reads and saves with the Parse SDK (Vite/src/data/conditions.ts); the owner-only rules in access.js
//   (RULES) use the validators and row shapes from here. There are no /conditions routes any more. Also used by seed,
//   autofill and ccda.

const { isId, isDateTime, today, toRow, findAll, getOwned, save, create, audit, param } = require("./db");
const { VITAL_TYPES } = require("./reference");

const FIELDS = ["user_id", "condition_name", "icd10_code", "category", "status", "severity", "onset_date", "diagnosed_date",
  "resolved_date", "diagnosing_provider", "managing_provider", "provider_facility", "is_primary", "source", "notes"];
const NOTE_FIELDS = ["condition_id", "user_id", "note_date", "note_type", "note_text"];
const TARGET_FIELDS = ["condition_id", "user_id", "vital_type", "target_min", "target_max", "secondary_min", "secondary_max", "set_by", "active"];
const CATEGORIES = ["chronic", "acute", "allergy", "mental_health", "injury", "surgical", "other"];
const STATUSES = ["active", "managed", "in_remission", "resolved", "inactive"];
const SEVERITIES = ["mild", "moderate", "severe"];
const SOURCES = ["patient_reported", "document_upload", "provider_entered"];
const NOTE_TYPES = ["general", "symptom_change", "treatment_change", "provider_visit", "flare_up", "improvement"];
const ICD10 = /^[A-TV-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$/i;

const row = (o) => toRow(o, "condition_id", FIELDS);
const noteRow = (o) => toRow(o, "note_id", NOTE_FIELDS);
const targetRow = (o) => toRow(o, "target_id", TARGET_FIELDS);
const text = (v) => (v === null || v === undefined || String(v).trim() === "" ? null : String(v).trim());
const dateOnly = (v) => (text(v) ? String(v).slice(0, 10) : null);
const notFound = (id) => ({ status: isId(id) ? 404 : 400, error: isId(id) ? "Condition not found" : "Invalid condition ID" });
const sortConditions = (rows) => rows.sort((a, b) => (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0)
  || (b.onset_date || "").localeCompare(a.onset_date || "") || a.condition_name.localeCompare(b.condition_name));

function validate(body) {
  if (body.category && !CATEGORIES.includes(body.category)) return `Invalid category. Must be one of: ${CATEGORIES.join(", ")}`;
  if (body.status && !STATUSES.includes(body.status)) return `Invalid status. Must be one of: ${STATUSES.join(", ")}`;
  if (body.severity && !SEVERITIES.includes(body.severity)) return `Invalid severity. Must be one of: ${SEVERITIES.join(", ")}`;
  if (body.source && !SOURCES.includes(body.source)) return `Invalid source. Must be one of: ${SOURCES.join(", ")}`;
  if (body.icd10_code && !ICD10.test(String(body.icd10_code).trim())) return "icd10_code is not a valid ICD-10 format (e.g. E11.9, I10)";
  for (const f of ["onset_date", "diagnosed_date", "resolved_date"]) if (body[f] && !isDateTime(body[f])) return `${f} is not a valid date`;
  if ("condition_name" in body && String(body.condition_name ?? "").trim().length > 255) return "condition_name is too long (max 255)";
  return null;
}

async function list(query, user) {
  const status = param(query, "status"), category = param(query, "category");
  if (status && !STATUSES.includes(status)) return { status: 400, error: `Invalid status. Must be one of: ${STATUSES.join(", ")}` };
  if (category && !CATEGORIES.includes(category)) return { status: 400, error: `Invalid category. Must be one of: ${CATEGORIES.join(", ")}` };
  let rows = (await findAll("Condition", { user_id: user.user_id })).map(row);
  if (status) rows = rows.filter((r) => r.status === status);
  if (category) rows = rows.filter((r) => r.category === category);
  return { status: 200, conditions: sortConditions(rows), count: rows.length };
}

async function createCondition(body, user) {
  if (!body || !body.condition_name) return { status: 400, error: "Missing required field: condition_name" };
  const name = String(body.condition_name).trim();
  if (!name) return { status: 400, error: "condition_name cannot be empty" };
  const err = validate(body);
  if (err) return { status: 400, error: err };
  const status = body.status || "active";
  if (status === "resolved" && !body.resolved_date) return { status: 400, error: "A resolved condition requires resolved_date" };
  if (status !== "resolved" && body.resolved_date) return { status: 400, error: "resolved_date can only be set when status is 'resolved'" };
  const c = await create("Condition", {
    user_id: user.user_id, condition_name: name, icd10_code: text(body.icd10_code) ? text(body.icd10_code).toUpperCase() : null,
    category: body.category || null, status, severity: body.severity || null, onset_date: dateOnly(body.onset_date),
    diagnosed_date: dateOnly(body.diagnosed_date), resolved_date: dateOnly(body.resolved_date),
    diagnosing_provider: text(body.diagnosing_provider), managing_provider: text(body.managing_provider),
    provider_facility: text(body.provider_facility), is_primary: body.is_primary === true, source: body.source || "patient_reported",
    notes: text(body.notes),
  });
  const data = row(c);
  await audit({ userId: user.user_id, event: "INSERT", targetClass: "Condition", targetId: c.id, newData: data });
  return { status: 201, message: "Condition added", condition: data };
}

async function addNote(id, body, user) {
  if (!body || !body.note_text || !String(body.note_text).trim()) return { status: 400, error: "Missing required field: note_text" };
  if (body.note_type && !NOTE_TYPES.includes(body.note_type)) return { status: 400, error: `Invalid note_type. Must be one of: ${NOTE_TYPES.join(", ")}` };
  if (body.note_date && !isDateTime(body.note_date)) return { status: 400, error: "note_date is not a valid date" };
  if (String(body.note_text).length > 5000) return { status: 400, error: "note_text is too long" };
  const c = await getOwned("Condition", id, user.user_id);
  if (!c) return notFound(id);
  const n = await create("ConditionNote", { condition_id: c.id, user_id: user.user_id, note_date: dateOnly(body.note_date) || today(),
    note_type: body.note_type || "general", note_text: String(body.note_text).trim() });
  const data = noteRow(n);
  await audit({ userId: user.user_id, event: "INSERT", targetClass: "ConditionNote", targetId: n.id, newData: data });
  return { status: 201, message: "Note added", note: data };
}

async function setTarget(id, body, user) {
  if (!body || !body.vital_type) return { status: 400, error: "Missing required field: vital_type" };
  const bounds = ["target_min", "target_max", "secondary_min", "secondary_max"];
  const provided = bounds.filter((b) => body[b] !== undefined && body[b] !== null);
  if (!provided.length) return { status: 400, error: `Provide at least one of: ${bounds.join(", ")}` };
  for (const b of provided) if (!Number.isFinite(Number(body[b]))) return { status: 400, error: `${b} must be a number` };
  if (body.target_min != null && body.target_max != null && Number(body.target_min) > Number(body.target_max)) {
    return { status: 400, error: "target_min cannot be greater than target_max" };
  }
  const c = await getOwned("Condition", id, user.user_id);
  if (!c) return notFound(id);
  if (!VITAL_TYPES.some((t) => t.vital_type === body.vital_type)) return { status: 400, error: `Unknown vital_type: ${body.vital_type}` };
  for (const old of await findAll("ConditionTarget", { user_id: user.user_id, vital_type: body.vital_type, active: true })) await save(old, { active: false });
  const num = (k) => (body[k] != null ? Number(body[k]) : null);
  const t = await create("ConditionTarget", {
    condition_id: c.id, user_id: user.user_id, vital_type: body.vital_type, target_min: num("target_min"), target_max: num("target_max"),
    secondary_min: num("secondary_min"), secondary_max: num("secondary_max"), set_by: text(body.set_by) || "self", active: true,
  });
  const data = targetRow(t);
  await audit({ userId: user.user_id, event: "INSERT", targetClass: "ConditionTarget", targetId: t.id, newData: data });
  return { status: 201, message: "Target set", target: data };
}

// the rules and row shapes below are also used by access.js (the browser saves these 3 classes directly with the same rules)
module.exports = { list, create: createCondition, addNote, setTarget,
  validate, row, noteRow, targetRow, text, dateOnly, FIELDS, NOTE_FIELDS, TARGET_FIELDS, NOTE_TYPES };
