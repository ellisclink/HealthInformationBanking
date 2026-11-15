// access.js — triggers that let the website use the owner classes directly (setup.js OWNER_CLASSES / OWNER_CLP: logged-in only).
//
// Parse's class permissions only say "logged in". These triggers decide WHOSE rows a request may touch:
//   - only patients, with a live session (the same 30-minute idle / 12-hour rule as the api function, auth.checkSession)
//   - finds are always limited to the caller's own rows (AND-ed onto whatever was asked, so count/get/containedIn/... can't escape)
//   - saves and deletes only on the caller's own rows; the server sets user_id and the owner-only ACL (D-019)
//   - the same field rules as the api routes in medications.js
// Rows saved before this change have NO ACL, so these checks (not the ACL) are what keep them private.
// Requests made with the master key (all of Cloud Code, D-027) skip every check here.
//
// DoseLog and Refill (dose and refill history): the browser may only add rows, for its own medications, with the same
// rules as logDose()/addRefill(); afterSave then moves the pill count on the Medication row (master key, atomic).
//
// DiaryEntry, Condition, ConditionNote and ConditionTarget have no special logic: each is one entry in RULES (bottom of
// this file) and gets the same generic triggers as Medication (owner find, owner save/delete, server-set owner + ACL,
// plain typed values, audit), with the field rules of the old routes in diary.js / conditions.js.
// ccda_object (the CCDA page's saved C-CDA files) is one more RULES entry: create, read and delete only (immutable).
// PersonalLink (My Links) is one more RULES entry with links.js's field rules, the 200-link cap and the duplicate check;
// "opened" is a browser update that sends only open_count; the server adds 1 to the stored count (atomic) and sets the time.
// NutritionLog (the Nutrition page's food log) is one more RULES entry with nutrition.js's field rules; source is set
// by the server. The USDA food search stays an api route (it needs the server's USDA key).
// VitalReading (the Vital Signs page) is one more RULES entry with vitals.js's field rules: the server fills in the unit,
// time and source, a calculated BMI can't be edited or removed from the browser, and saving or removing a weight or
// height still makes / updates / removes the calculated BMI (vitals.js, master key) after the save.
// RespiratoryDevice, DeviceSupply and RespiratoryLog (the Breathing Devices page) are three more RULES entries with
// respiratory.js's field rules: a part or entry must be on one of the caller's own devices (parent device_id), a new
// device gets its default parts list after the save, and removing a device removes its parts and entries (cascade).
// Reminder (the Reminders page) is one more RULES entry with reminders.js's rules: the server computes next_due_at,
// linked_name (from the caller's own linked row), last_fired_at and the cleared schedule fields; snooze is an update
// that sends only snooze_minutes. Notification (the bell) may be read and marked read / dismissed, never removed or
// created from the browser (browserCreate: false; only the job and emergency.js make them). NotificationPrefs (the
// alert switches) is one row per user (a second create is refused; parallel creates are removed again after the save).
// CalendarEvent (the Calendar page) is one more RULES entry with calendar.js's rules (prepareEvent): the server stores the
// cleaned times, zone and repeat fields; condition_id must be one of the caller's own; skipping an occurrence is an edit
// of exceptions. The subscribe feed and its tokens stay on the server (calendarFeed.js).
// LabResult (the Lab Results page) is one more RULES entry with labs.js's rules (buildResultRow): the server fills in the
// test name, panel, unit and range from the catalog and decides flag and range_source; a report_id must be one of the
// caller's own LabReports (optional parent). LabReport (the encrypted PDFs) stays on the server (labs/reports routes).
// Allergy, SafetyAlert and DisposalLog (Medications safety warnings, Safe Disposal) are three more RULES entries with the
// rules of safety.js / disposal.js: the server computes an allergy's key, type and drug families, and the rows copied
// from the Health History form can only be changed there; a SafetyAlert is never created or removed from the browser
// (only POST /safety/recheck makes them) and an edit may only acknowledge it; a DisposalLog is created or removed, never
// edited, its medication_id must be one of the caller's own, and after the save the quantity comes off the count.
// MedicalRecord (the Health History form) and EmergencyProfile (the emergency settings) are one row per user each (a
// second create is refused; parallel creates are removed again after the save, the oldest is kept) and can't be removed
// from the browser. MedicalRecord: only `data` (records.js rules); after every save the form's allergies are copied to
// the Allergy list. EmergencyProfile: emergency.js settingsValues (directive_updated_at is the server's; a directive
// document must be one of the caller's own). The emergency code, the responder view and both access logs stay on the server.

const { M, isDate, isDateTime, today, toRow, findAll, getOwned, destroyAll, audit } = require("./db");
const auth = require("./auth");
const meds = require("./medications");
const diary = require("./diary");
const cond = require("./conditions");
const links = require("./links");
const nutrition = require("./nutrition");
const vitals = require("./vitals");
const resp = require("./respiratory");
const reminders = require("./reminders");
const notifications = require("./notifications");
const calendar = require("./calendar");
const labs = require("./labs");
const safety = require("./safety");
const disposal = require("./disposal");
const records = require("./records");
const emergency = require("./emergency");
const { VITAL_TYPES } = require("./reference");
const { OWNER_CLASSES } = require("./setup");

const SESSION_ENDED = "your session has ended — please log in again";
const NOT_FOUND = "Object not found.";
const OWNER_FIXED = "the owner of a record cannot be changed";
const NUMBER_FIELDS = ["strength", "dose_amount", "quantity_on_hand", "refill_threshold", "refills_remaining"];
const ARRAY_FIELDS = ["schedule_times"];
const REQUIRED = ["medication_name", "dose_amount", "quantity_on_hand"];
// set by Parse itself, never by the request body
const PARSE_KEYS = ["objectId", "createdAt", "updatedAt"];
// query operators that run a second query (on any class); the page never uses them
const SUBQUERY_OPS = ["$inQuery", "$notInQuery", "$select", "$dontSelect", "$relatedTo"];

// owner read + write, nothing public
function ownerAcl(userId) {
  const acl = new Parse.ACL();
  acl.setPublicReadAccess(false);
  acl.setPublicWriteAccess(false);
  acl.setReadAccess(userId, true);
  acl.setWriteAccess(userId, true);
  return acl;
}

// true only when the ACL has no public access and exactly one entry: userId with read + write
function isOwnerOnly(acl, userId) {
  if (!acl || typeof acl.toJSON !== "function" || !userId) return false;
  const json = acl.toJSON();
  const keys = Object.keys(json);
  return keys.length === 1 && keys[0] === userId && json[userId].read === true && json[userId].write === true;
}

// Master-key saves (the server's own routes) skip every check, but a row with a user_id and no ACL gets the
// owner-only ACL, so rows the server makes are as private as rows the browser makes (D-019). Nothing else for master.
function masterSave(request) {
  const obj = request.object;
  const userId = obj.get("user_id");
  if (typeof userId === "string" && userId && !obj.getACL()) obj.setACL(ownerAcl(userId));
}

// The caller, if they are a patient with a live session. Otherwise throws.
async function requirePatient(request) {
  const parseUser = request.user;
  const token = parseUser && typeof parseUser.getSessionToken === "function" ? parseUser.getSessionToken() : null;
  const user = parseUser && token ? await auth.checkSession(parseUser, token) : null;
  if (!user) throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, SESSION_ENDED);
  if (user.role !== "patient") throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, "this is for patient accounts");
  return parseUser;
}

function hasSubquery(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasSubquery);
  return Object.keys(value).some((k) => SUBQUERY_OPS.includes(k) || hasSubquery(value[k]));
}

// beforeFind for an owner class: patients only, own rows only
function ownerFind(className) {
  return async (request) => {
    if (request.master) return;
    const user = await requirePatient(request);
    const where = request.query._where || {};
    if (hasSubquery(where)) throw new Parse.Error(Parse.Error.INVALID_QUERY, "this kind of query is not allowed");
    // AND: whatever the caller asked for, and only their rows
    request.query._where = Object.keys(where).length ? { $and: [where, { user_id: user.id }] } : { user_id: user.id };
  };
}

const aclKey = (acl) => {
  const json = acl ? acl.toJSON() : {};
  return JSON.stringify(Object.keys(json).sort().map((k) => [k, json[k]]));
};

// The request's values as the route functions would see them in a body (a removed field reads as null).
function requestBody(obj, keys) {
  const body = {};
  for (const k of keys) {
    const v = obj.get(k);
    body[k] = v === undefined ? null : v;
  }
  return body;
}

// Types first: the route rules in validateFields accept text that looks like a number, which a hand-made request
// could use to store "60" where 60 belongs (Review Focus 5).
function typeProblem(body) {
  for (const [k, v] of Object.entries(body)) {
    if (v === null) continue;
    if (NUMBER_FIELDS.includes(k)) { if (typeof v !== "number" || !Number.isFinite(v)) return `${k} must be a number`; }
    else if (ARRAY_FIELDS.includes(k)) { if (!Array.isArray(v)) return 'schedule_times must be an array like ["08:00", "20:00"]'; }
    else if (typeof v !== "string") return `${k} must be text`;
  }
  return null;
}

const refuse = (msg) => { throw new Parse.Error(Parse.Error.VALIDATION_ERROR, msg); };

// An op from the request (Increment, Add, AddUnique, Remove, Batch, AddRelation, RemoveRelation, or Delete unless
// allowDelete) instead of a plain value. An Increment would let two requests race past the number checks.
function refuseOps(obj, keys, allowDelete) {
  for (const k of keys) {
    const op = obj.op(k);
    const json = op && typeof op.toJSON === "function" ? op.toJSON() : null;
    const name = json && typeof json === "object" && !Array.isArray(json) && typeof json.__op === "string" ? json.__op : null;
    if (name && !(allowDelete && name === "Delete")) refuse(`${k} must be a plain value`);
  }
}

// Stores the converted value; leaves a field alone when it is already right (avoids a pointless write).
function store(obj, field, value) {
  if (value === null || value === undefined) { if (obj.get(field) !== undefined) obj.unset(field); return; }
  if (obj.get(field) !== value) obj.set(field, value);
}

async function medicationBeforeSave(request) {
  if (request.master) return masterSave(request);
  const user = await requirePatient(request);
  const obj = request.object;
  const original = request.original;
  const dirty = obj.dirtyKeys().filter((k) => !PARSE_KEYS.includes(k));

  if (original) {
    if (original.get("user_id") !== user.id) throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, NOT_FOUND);
    if (dirty.includes("user_id")) throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, OWNER_FIXED);
    if (dirty.includes("ACL") && aclKey(obj.getACL()) !== aclKey(original.getACL())) {
      throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, OWNER_FIXED);
    }
  }
  const allowed = original ? meds.EDITABLE_FIELDS : meds.EDITABLE_FIELDS.concat("user_id");   // user_id on create is replaced below
  for (const k of dirty) if (k !== "ACL" && !allowed.includes(k)) refuse(`unknown field: ${k}`);
  refuseOps(obj, dirty, true);   // an unset (Delete) is clearing a field, which the rules below handle

  const fields = dirty.filter((k) => meds.EDITABLE_FIELDS.includes(k));
  const body = requestBody(obj, fields);
  const problem = typeProblem(body) || meds.validateFields(body);
  if (problem) refuse(problem);
  if (!original && !body.medication_name) refuse("Missing required field: medication_name");
  const linkProblem = await meds.validateLinks(body, { user_id: user.id });
  if (linkProblem) refuse(linkProblem);

  const values = {};
  for (const f of fields) values[f] = meds.columnValue(f, body[f]);
  if (original) {
    if (REQUIRED.some((f) => f in values && values[f] === null)) refuse("medication_name, dose_amount and quantity_on_hand can't be cleared");
    // status rules from update()
    const oldStatus = original.get("status");
    if (values.status && values.status !== oldStatus) {
      if ((values.status === "discontinued" || values.status === "completed") && !("end_date" in values) && !original.get("end_date")) values.end_date = today();
      if (values.status === "active") {
        if (!("end_date" in values)) values.end_date = null;
        if (!("discontinued_reason" in values)) values.discontinued_reason = null;
      }
    }
  } else {
    // defaults and the end_date rule from createMed()
    for (const [f, v] of Object.entries(meds.DEFAULTS)) if (values[f] === undefined || values[f] === null) values[f] = v;
    if (!values.status) values.status = "active";
    if ((values.status === "discontinued" || values.status === "completed") && !values.end_date) values.end_date = today();
  }
  const pick = (f) => (f in values ? values[f] : original ? original.get(f) || null : null);
  const start = pick("start_date"), end = pick("end_date");
  if (start && end && new Date(end) < new Date(start)) refuse("end_date cannot be before start_date");

  for (const [f, v] of Object.entries(values)) store(obj, f, v);
  if (!original) obj.set("user_id", user.id);
  // a new row, or an old row saved before ACLs: give it the owner ACL (a changed ACL was refused above)
  if (!original || !original.getACL()) obj.setACL(ownerAcl(user.id));
}

async function medicationBeforeDelete(request) {
  if (request.master) return;
  const user = await requirePatient(request);
  if (request.object.get("user_id") !== user.id) throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, NOT_FOUND);
}

async function medicationAfterSave(request) {
  if (request.master) return;
  const userId = request.user && request.user.id;
  const row = meds.medRow(request.object);
  if (request.original) {
    await audit({ userId, event: "UPDATE", targetClass: "Medication", targetId: request.object.id, oldData: meds.medRow(request.original), newData: row, ip: request.ip });
  } else {
    await audit({ userId, event: "INSERT", targetClass: "Medication", targetId: request.object.id, newData: row, ip: request.ip });
  }
}

async function medicationAfterDelete(request) {
  if (request.master) return;
  const id = request.object.id;
  const owner = request.object.get("user_id");   // browser deletes are owner-checked, so it is always set
  try {
    // the medication's id AND its owner, the same as every other cascade
    if (typeof owner === "string" && owner) {
      for (const c of ["DoseLog", "Refill", "SafetyAlert"]) await destroyAll(await findAll(c, { medication_id: id, user_id: owner }));
    }
  } catch (err) {
    console.error("medication delete: removing doses/refills/alerts failed:", err && err.message ? err.message : "error");
  }
  await audit({ userId: request.user && request.user.id, event: "DELETE", targetClass: "Medication", targetId: id, oldData: meds.medRow(request.object), ip: request.ip });
}

// ---- DoseLog and Refill: history the browser may add to, never change ----

const DOSE_FIXED = "dose history cannot be changed";
const REFILL_FIXED = "refill history cannot be changed";
const DOSE_KEYS = ["medication_id", "dose_status", "taken_at", "quantity", "notes"];
const REFILL_KEYS = ["medication_id", "quantity_added", "refill_date", "pharmacy_name", "notes"];
const FUTURE_LIMIT_MS = 5 * 60 * 1000;   // as logDose(): a clock a little ahead is fine
const MAX_TEXT = 1000;

// Shared start of the DoseLog/Refill beforeSave: patient, create only, known keys, plain values.
async function historyCreate(request, fixedMsg, keys) {
  const user = await requirePatient(request);
  const original = request.original;
  if (original) {
    if (original.get("user_id") !== user.id) throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, NOT_FOUND);
    throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, fixedMsg);
  }
  const obj = request.object;
  const dirty = obj.dirtyKeys().filter((k) => !PARSE_KEYS.includes(k));
  for (const k of dirty) if (k !== "ACL" && !keys.includes(k)) refuse(`unknown field: ${k}`);
  refuseOps(obj, dirty, false);
  return { user, obj };
}

// The caller's medication for medication_id (master lookup with the owner condition), or 101 like any other row
// they can't see.
async function ownedMedication(obj, user) {
  const id = obj.get("medication_id");
  if (id === undefined || id === null || id === "") refuse("Missing required field: medication_id");
  if (typeof id !== "string") refuse("medication_id must be text");
  const med = await getOwned("Medication", id, user.id);
  if (!med) throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, NOT_FOUND);
  return med;
}

// Optional text: null when blank; refused when not text or too long.
function optionalText(obj, field) {
  const v = obj.get(field);
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") refuse(`${field} must be text`);
  if (v.length > MAX_TEXT) refuse(`${field} is too long`);
  return v.trim() ? v : null;
}

function finishHistory(obj, user, values) {
  for (const [f, v] of Object.entries(values)) store(obj, f, v);
  obj.set("user_id", user.id);
  obj.setACL(ownerAcl(user.id));
}

// The rules of logDose(), for a DoseLog the browser creates.
async function doseBeforeSave(request) {
  if (request.master) return masterSave(request);
  const { user, obj } = await historyCreate(request, DOSE_FIXED, DOSE_KEYS);

  let status = obj.get("dose_status");
  if (status === undefined || status === null) status = "taken";
  if (typeof status !== "string" || !meds.VALID_DOSE_STATUSES.includes(status)) {
    refuse(`Invalid dose_status. Must be one of: ${meds.VALID_DOSE_STATUSES.join(", ")}`);
  }
  let takenAt = obj.get("taken_at");
  if (takenAt === undefined || takenAt === null) takenAt = new Date();
  else if (typeof takenAt === "string" && isDateTime(takenAt)) takenAt = new Date(takenAt);
  if (!(takenAt instanceof Date) || isNaN(takenAt.getTime())) refuse("taken_at is not a valid date/time");
  if (takenAt.getTime() > Date.now() + FUTURE_LIMIT_MS) refuse("taken_at cannot be in the future");
  const given = obj.get("quantity");
  if (given !== undefined && given !== null) {
    if (typeof given !== "number") refuse("quantity must be a number");
    if (!Number.isFinite(given) || given <= 0) refuse("quantity must be a positive number");
    if (status !== "taken") refuse("quantity only applies to taken doses");
  }
  const notes = optionalText(obj, "notes");

  const med = await ownedMedication(obj, user);
  const medStatus = med.get("status");
  if (medStatus === "discontinued" || medStatus === "completed") refuse(`Cannot log a dose for a ${medStatus} medication`);
  // a medication with no usable dose_amount stores 0 (never NaN), which leaves the count alone
  const doseAmount = Number(med.get("dose_amount"));
  const quantity = status === "taken" ? (given !== undefined && given !== null ? given : Number.isFinite(doseAmount) ? doseAmount : 0) : 0;
  finishHistory(obj, user, { dose_status: status, taken_at: takenAt, quantity, notes });
}

// The rules of addRefill() (a refill always uses one of the prescription's refills), for a Refill the browser creates.
async function refillBeforeSave(request) {
  if (request.master) return masterSave(request);
  const { user, obj } = await historyCreate(request, REFILL_FIXED, REFILL_KEYS);

  const qty = obj.get("quantity_added");
  if (qty !== undefined && qty !== null && typeof qty !== "number") refuse("quantity_added must be a number");
  if (qty === undefined || qty === null || !Number.isFinite(qty) || qty <= 0) refuse("quantity_added must be a positive number");
  let refillDate = obj.get("refill_date");
  if (refillDate === undefined || refillDate === null || refillDate === "") refillDate = today();
  else if (typeof refillDate !== "string" || !isDateTime(refillDate) || !isDate(refillDate.slice(0, 10))) refuse("refill_date is not a valid date");
  else refillDate = refillDate.slice(0, 10);
  const pharmacy = optionalText(obj, "pharmacy_name");
  const notes = optionalText(obj, "notes");

  const med = await ownedMedication(obj, user);
  finishHistory(obj, user, { quantity_added: qty, refill_date: refillDate, pharmacy_name: pharmacy || med.get("pharmacy_name") || null, notes });
}

// History rows are never changed or removed from the browser (the server removes them with their medication).
function historyBeforeDelete(fixedMsg) {
  return async (request) => {
    if (request.master) return;
    const user = await requirePatient(request);
    if (request.object.get("user_id") !== user.id) throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, NOT_FOUND);
    throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, fixedMsg);
  };
}

const medRef = (id) => Parse.Object.extend("Medication").createWithoutData(id);

// A taken dose lowers the count (meds.takePills: atomic subtract, then an atomic add-back of what the dose could not
// take, so the count never stays below zero and a refill saved at the same moment is not wiped out; Review Focus 3).
async function doseAfterSave(request) {
  if (request.master || request.original) return;
  const dose = request.object;
  const quantity = Number(dose.get("quantity")) || 0;
  try {
    if (quantity > 0) await meds.takePills(medRef(dose.get("medication_id")), quantity);
  } catch (err) {
    console.error("dose: updating quantity_on_hand failed:", err && err.message ? err.message : "error");
  }
  await audit({ userId: request.user && request.user.id, event: "INSERT", targetClass: "DoseLog", targetId: dose.id, newData: meds.doseRow(dose), ip: request.ip });
}

// A refill adds to the count (atomic), moves last_refill_date forward and uses one of the refills left.
async function refillAfterSave(request) {
  if (request.master || request.original) return;
  const refill = request.object;
  try {
    const med = await new Parse.Query("Medication").get(refill.get("medication_id"), M);
    med.increment("quantity_on_hand", Number(refill.get("quantity_added")));
    const date = refill.get("refill_date");
    if (!med.get("last_refill_date") || date > med.get("last_refill_date")) med.set("last_refill_date", date);
    const left = med.get("refills_remaining");
    if (left !== undefined && left !== null) med.set("refills_remaining", Math.max(left - 1, 0));
    await med.save(null, M);
  } catch (err) {
    console.error("refill: updating the medication failed:", err && err.message ? err.message : "error");
  }
  await audit({ userId: request.user && request.user.id, event: "INSERT", targetClass: "Refill", targetId: refill.id, newData: meds.refillRow(refill), ip: request.ip });
}

// ---- RULES: the owner classes with no special logic (one generic set of triggers each) ----
//
// { fields: what the browser may send (user_id is also accepted on create and replaced),
//   types: { field: "number" | "boolean" | "object" | "date" | "array" } (every other field is text; "object" = a plain
//          JSON object, "date" = a Date, as the SDK sends one, "array" = an array; validate checks what is in it),
//   browserCreate: false: the browser may never create a row of this class (only the server makes them, 119;
//          createRefused: the message),
//   immutable: a message; when set, the browser may only create and delete (every update is refused with it, 119),
//   required: fields a new row must have and an edit can't clear (the rule's validate gives the route's own message first),
//   validate(body, { user, original }) -> message | null, or a promise of one (body = the sent fields; a removed field is null),
//   clean(body, { user, original }) -> the values to store (null clears a field), or a promise of them,
//   defaults: values for a new row when not sent; forced: values the server always sets when the field is saved,
//   parent: { field, className, optional, options }: the field must name one of the caller's own rows of className (else 101);
//          optional: the field may be left out (then nothing is checked); options: for the lookup (e.g. { exclude: [...] }),
//   cascade: classes whose rows (by their parent field) are removed with this row,
//   finish(object, { body, original }): last step of beforeSave, after the values are stored (e.g. an atomic increment),
//   afterSave(object, { original, ip }): extra work after a browser save (master key),
//   deleteProblem(object) -> message | null: a browser delete of this row is refused with it (142),
//   afterDelete(object): extra work after a browser delete (master key), row(object): the audit shape,
//   auditEvent(object, original) -> the audit event of a browser edit (default UPDATE) }

const without = (list, ...drop) => list.filter((f) => !drop.includes(f));
const BOUNDS = ["target_min", "target_max", "secondary_min", "secondary_max"];
const CONDITION_PARENT = { field: "condition_id", className: "Condition" };
const DEVICE_PARENT = { field: "device_id", className: "RespiratoryDevice" };
const numbers = (list) => Object.fromEntries(list.map((f) => [f, "number"]));

// Condition create/update rules: createCondition() and update() in conditions.js
// the status and resolved_date an edit will leave (update(): status is kept when not sent)
function conditionResolution(body, original) {
  const status = body.status || original.get("status") || null;
  const resolved = body.resolved_date !== undefined ? cond.dateOnly(body.resolved_date) : original.get("resolved_date") || null;
  return { status, resolved };
}
function conditionProblem(body, { original }) {
  if (!original) {
    if (!body.condition_name) return "Missing required field: condition_name";
    if (!String(body.condition_name).trim()) return "condition_name cannot be empty";
  }
  const err = cond.validate(body);
  if (err) return err;
  if (!original) {
    const status = body.status || "active";
    if (status === "resolved" && !body.resolved_date) return "A resolved condition requires resolved_date";
    if (status !== "resolved" && body.resolved_date) return "resolved_date can only be set when status is 'resolved'";
    return null;
  }
  if ("source" in body) return "source cannot be changed";   // update() never changes it
  const { status, resolved } = conditionResolution(body, original);
  if (status === "resolved" && !resolved) return "Set resolved_date when marking a condition resolved";
  if ("condition_name" in body && !String(body.condition_name ?? "").trim()) return "condition_name cannot be empty";
  return null;
}
function conditionValues(body, { original }) {
  const { text, dateOnly } = cond;
  const icd = (v) => (text(v) ? text(v).toUpperCase() : null);
  if (!original) {
    return {
      condition_name: String(body.condition_name).trim(), icd10_code: icd(body.icd10_code), category: body.category || null,
      status: body.status || "active", severity: body.severity || null, onset_date: dateOnly(body.onset_date),
      diagnosed_date: dateOnly(body.diagnosed_date), resolved_date: dateOnly(body.resolved_date),
      diagnosing_provider: text(body.diagnosing_provider), managing_provider: text(body.managing_provider),
      provider_facility: text(body.provider_facility), is_primary: body.is_primary === true, source: body.source || "patient_reported",
      notes: text(body.notes),
    };
  }
  const { status, resolved } = conditionResolution(body, original);
  const values = { status, resolved_date: status === "resolved" ? resolved : null };
  const map = {
    condition_name: (v) => String(v).trim(), icd10_code: icd, category: text, severity: text, onset_date: dateOnly, diagnosed_date: dateOnly,
    diagnosing_provider: text, managing_provider: text, provider_facility: text, is_primary: (v) => v === true, notes: text,
  };
  for (const [f, conv] of Object.entries(map)) if (f in body) values[f] = conv(body[f]);
  return values;
}

// ConditionNote rules: addNote() in conditions.js (an edit checks only what was sent)
function noteProblem(body, { original }) {
  if ((!original || "note_text" in body) && (!body.note_text || !String(body.note_text).trim())) return "Missing required field: note_text";
  if (body.note_type && !cond.NOTE_TYPES.includes(body.note_type)) return `Invalid note_type. Must be one of: ${cond.NOTE_TYPES.join(", ")}`;
  if (body.note_date && !isDateTime(body.note_date)) return "note_date is not a valid date";
  if (body.note_text && String(body.note_text).length > 5000) return "note_text is too long";
  return null;
}
function noteValues(body, { original }) {
  const has = (k) => !original || k in body;
  const values = {};
  if (has("condition_id")) values.condition_id = body.condition_id;
  if (has("note_date")) values.note_date = cond.dateOnly(body.note_date) || today();
  if (has("note_type")) values.note_type = body.note_type || "general";
  if (has("note_text")) values.note_text = String(body.note_text).trim();
  return values;
}

// ConditionTarget rules: setTarget() in conditions.js. An edit is checked against the row as it will be stored.
function targetProblem(body, { original }) {
  const merged = (k) => (k in body ? body[k] : original ? original.get(k) ?? null : null);
  if ((!original || "vital_type" in body) && !body.vital_type) return "Missing required field: vital_type";
  if (!BOUNDS.some((b) => merged(b) !== null && merged(b) !== undefined)) return `Provide at least one of: ${BOUNDS.join(", ")}`;
  const min = merged("target_min"), max = merged("target_max");
  if (min != null && max != null && min > max) return "target_min cannot be greater than target_max";
  if ("vital_type" in body && !VITAL_TYPES.some((t) => t.vital_type === body.vital_type)) return `Unknown vital_type: ${body.vital_type}`;
  if (original && "active" in body && body.active === null) return "active must be true or false";
  return null;
}
function targetValues(body, { original }) {
  const values = {};
  for (const k of ["condition_id", "vital_type", ...BOUNDS, "active"]) if (!original || k in body) values[k] = body[k] === undefined ? null : body[k];
  return values;
}
// The "upsert" of setTarget(): a patient has at most one active target per vital_type (across all their conditions).
// Every browser save that leaves a target active turns off the caller's other active targets for that vital_type; the
// old ones stay as history (active false). So the page sets a target by CREATING a new row (or by switching an old one
// back on with active: true), never by editing another row's vital_type in place.
async function oneActiveTarget(obj) {
  if (obj.get("active") !== true) return;
  const others = await new Parse.Query("ConditionTarget").equalTo("user_id", obj.get("user_id")).equalTo("vital_type", obj.get("vital_type"))
    .equalTo("active", true).notEqualTo("objectId", obj.id).limit(1000).find(M);
  for (const o of others) o.set("active", false);
  if (others.length) await Parse.Object.saveAll(others, M);
}

// ccda_object rules: the CCDA page (Vite/src/pages/CCDA.tsx) saves a parsed C-CDA file once and never edits it
// (immutable: browser updates are refused); parseApiObject is the whole parsed record, so the audit row leaves it out.
const CCDA_FIELDS = ["fileName", "patientName", "patientDob", "parseApiObject"];
const CCDA_TEXT_MAX = { fileName: 255, patientName: 255, patientDob: 32 };
const CCDA_RECORD_MAX = 2000000;   // characters of JSON.stringify(parseApiObject)
function ccdaProblem(body) {
  for (const [f, max] of Object.entries(CCDA_TEXT_MAX)) {
    if (typeof body[f] === "string" && body[f].length > max) return `${f} is too long (max ${max})`;
  }
  if (!isPlainObject(body.parseApiObject)) return "parseApiObject must be an object";
  if (JSON.stringify(body.parseApiObject).length > CCDA_RECORD_MAX) return "parseApiObject is too large";
  return null;
}
const ccdaRow = (o) => toRow(o, "record_id", ["user_id", "fileName", "patientName", "patientDob"]);

// PersonalLink rules: createLink() and the old update()/opened() routes in links.js.
// Opening a link (the old POST /links/:id/opened) is an update that sends ONLY open_count; the value sent is ignored:
// the server turns it into an atomic +1 on the stored count (finish below: two opens at once both count) and sets
// last_opened_at = now (last_opened_at itself is never accepted from the browser).
const LINK_OPENED = "open_count";
const isLinkOpen = (body, original) => !!original && Object.keys(body).length === 1 && LINK_OPENED in body;
async function linkProblem(body, { user, original }) {
  if (LINK_OPENED in body) {
    if (!original) return "open_count is set by the server";
    if (body[LINK_OPENED] === null) return "open_count can't be cleared";
    if (!isLinkOpen(body, original)) return "open_count can't be saved with other fields";
    return null;
  }
  const { values, error } = links.fields(body, !!original);
  if (error) return error;
  if (!original) {
    // the same cap and duplicate check as createLink() (master-key reads of the caller's own rows)
    const existing = await findAll("PersonalLink", { user_id: user.id }, { select: ["url", "title"] });
    if (existing.length >= links.MAX_LINKS) return "You can save up to " + links.MAX_LINKS + " links";
    const dup = existing.find((l) => l.get("url") === values.url);
    if (dup) return links.duplicateMessage(dup.get("title"));
  } else if (values.url && values.url !== original.get("url")) {
    const dup = (await findAll("PersonalLink", { user_id: user.id, url: values.url }, { limit: 2 })).find((l) => l.id !== original.id);
    if (dup) return links.duplicateMessage(dup.get("title"));
  }
  return null;
}
function linkValues(body, { original }) {
  if (isLinkOpen(body, original)) return { last_opened_at: new Date() };   // open_count: linkOpened() below
  return links.fields(body, !!original).values;
}
// after validation: drop the value the browser sent and add 1 to what is stored, in the database (an Increment op)
function linkOpened(obj, { body, original }) {
  if (!isLinkOpen(body, original)) return;
  obj.revert(LINK_OPENED);
  obj.increment(LINK_OPENED);
}

const RULES = {
  DiaryEntry: {
    fields: without(diary.FIELDS, "user_id"),
    types: { severity: "number", follow_up_needed: "boolean" },
    required: ["entry_date", "category", "title"],   // diary.validate needs all 3 on create (category too)
    validate: (body, { original }) => diary.validate(body, !!original),
    clean: (body) => diary.clean(body),
    defaults: { follow_up_needed: false },
    row: diary.row,
  },
  Condition: {
    fields: without(cond.FIELDS, "user_id"),
    types: { is_primary: "boolean" },
    required: ["condition_name"],
    validate: conditionProblem,
    clean: conditionValues,
    cascade: ["ConditionNote", "ConditionTarget"],
    row: cond.row,
  },
  ConditionNote: {
    fields: without(cond.NOTE_FIELDS, "user_id"),
    required: ["condition_id", "note_text"],
    parent: CONDITION_PARENT,
    validate: noteProblem,
    clean: noteValues,
    row: cond.noteRow,
  },
  ConditionTarget: {
    fields: without(cond.TARGET_FIELDS, "user_id"),
    types: { target_min: "number", target_max: "number", secondary_min: "number", secondary_max: "number", active: "boolean" },
    required: ["condition_id", "vital_type"],
    parent: CONDITION_PARENT,
    validate: targetProblem,
    clean: targetValues,
    defaults: { active: true },
    forced: { set_by: "patient" },
    afterSave: oneActiveTarget,
    row: cond.targetRow,
  },
  ccda_object: {
    fields: CCDA_FIELDS,
    types: { parseApiObject: "object" },
    required: ["fileName"],
    immutable: "saved records cannot be changed",
    validate: ccdaProblem,
    clean: (body) => ({ ...body }),
    row: ccdaRow,
  },
  PersonalLink: {
    fields: without(links.FIELDS, "user_id", "last_opened_at"),   // last_opened_at: only the server sets it (opened)
    types: { is_favorite: "boolean", open_count: "number" },
    required: ["title", "url"],
    validate: linkProblem,
    clean: linkValues,
    finish: linkOpened,
    defaults: { category: "other", is_favorite: false, open_count: 0 },
    row: links.row,
  },
  NutritionLog: {
    fields: without(nutrition.FIELDS, "user_id", "source"),   // source: set by the server on create (usda_api / manual)
    types: { ...Object.fromEntries(nutrition.NUMBERS.map((f) => [f, "number"])), logged_at: "date" },
    required: ["food_name", "serving_size", "serving_unit"],
    validate: (body, { original }) => nutrition.validate(body, !!original),
    clean: (body, { original }) => nutrition.clean(body, !!original),
    defaults: { confidence: 100 },
    row: nutrition.row,
  },
  VitalReading: {
    fields: without(vitals.FIELDS, "user_id", "source_reading_ids"),   // source_reading_ids: only the BMI code sets it
    types: { value_numeric: "number", value_secondary: "number", measured_at: "date" },
    required: ["vital_type", "value_numeric"],
    parent: { field: "condition_id", className: "Condition", optional: true },
    validate: (body, { original }) => vitals.validate(body, original),
    clean: (body, { original }) => vitals.clean(body, original),
    afterSave: vitals.afterBrowserSave,
    deleteProblem: vitals.deleteProblem,
    afterDelete: vitals.afterBrowserDelete,
    row: vitals.row,
  },
  RespiratoryDevice: {
    fields: without(resp.DEVICE_FIELDS, "user_id"),
    types: { ...numbers(Object.keys(resp.SETTING_RANGES)), is_active: "boolean" },
    required: ["device_type"],
    validate: (body, { original }) => resp.deviceProblem(body, original),
    clean: (body, { original }) => resp.deviceValues(body, original),
    cascade: ["DeviceSupply", "RespiratoryLog"],
    afterSave: resp.afterDeviceSave,
    row: resp.deviceRow,
  },
  DeviceSupply: {
    fields: without(resp.SUPPLY_FIELDS, "user_id"),
    types: { interval_days: "number" },
    required: ["device_id", "part_name", "interval_days"],
    parent: DEVICE_PARENT,
    validate: (body, { original }) => resp.supplyProblem(body, original),
    clean: (body, { original }) => resp.supplyValues(body, original),
    row: resp.supplyRow,
  },
  RespiratoryLog: {
    fields: without(resp.LOG_FIELDS, "user_id"),
    types: numbers([...Object.keys(resp.LOG_RANGES), "comfort"]),
    required: ["device_id", "log_date"],
    parent: DEVICE_PARENT,
    validate: resp.logProblem,
    clean: (body, { original }) => resp.logValues(body, original),
    row: resp.logRow,
  },
  Reminder: {
    fields: reminders.BROWSER_FIELDS,
    types: { times: "array", days_of_week: "array", remind_at: "date", email_me: "boolean", active: "boolean", snooze_minutes: "number" },
    validate: reminders.browserProblem,
    clean: reminders.browserValues,
    finish: reminders.browserFinish,
    defaults: { time_zone: "UTC", email_me: false, active: true },
    row: reminders.reminderRow,
  },
  Notification: {
    fields: notifications.NOTE_BROWSER_FIELDS,
    types: { read_at: "date", dismissed_at: "date" },
    browserCreate: false,
    createRefused: "notifications are made by the server",
    validate: notifications.noteProblem,
    clean: notifications.noteValues,
    deleteProblem: notifications.noteDeleteProblem,   // dismissed, never removed (the row keeps its dedupe_key)
    row: notifications.noteRow,
  },
  CalendarEvent: {
    fields: calendar.BROWSER_FIELDS,
    types: { start_time: "date", end_time: "date", all_day: "boolean", recurrence_interval: "number", recurrence_day: "number",
      end_count: "number", recurrence_weekdays: "array", exceptions: "array" },
    validate: calendar.browserProblem,
    clean: calendar.browserValues,
    row: calendar.row,
  },
  LabResult: {
    fields: labs.BROWSER_FIELDS,
    types: { value_numeric: "number", ref_low: "number", ref_high: "number" },
    // the PDF (file_data) is not read for the check
    parent: { field: "report_id", className: "LabReport", optional: true, options: { exclude: ["file_data"] } },
    validate: labs.browserProblem,
    clean: labs.browserValues,
    row: labs.resultRow,
  },
  Allergy: {
    fields: safety.ALLERGY_BROWSER_FIELDS,
    validate: safety.allergyProblem,
    clean: safety.allergyValues,
    defaults: { status: "active" },
    forced: { source: safety.BROWSER_SOURCE },   // on create only (source is not a browser field)
    deleteProblem: safety.allergyDeleteProblem,
    row: safety.allergyRow,
  },
  SafetyAlert: {
    fields: safety.ALERT_BROWSER_FIELDS,
    types: { acknowledged_at: "date" },
    browserCreate: false,
    createRefused: "warnings are made by the server's safety check",
    validate: safety.alertProblem,
    clean: safety.alertValues,
    deleteProblem: safety.alertDeleteProblem,
    auditEvent: safety.alertAuditEvent,
    row: safety.alertRow,
  },
  DisposalLog: {
    fields: disposal.LOG_BROWSER_FIELDS,
    types: { quantity: "number" },
    immutable: "disposal records can't be changed",
    parent: { field: "medication_id", className: "Medication", optional: true },
    validate: disposal.logProblem,
    clean: disposal.logValues,
    afterSave: disposal.afterLogSave,
    row: disposal.logRow,
  },
  NotificationPrefs: {
    fields: notifications.PREF_KEYS,
    types: Object.fromEntries(notifications.PREF_KEYS.map((k) => [k, "boolean"])),
    validate: notifications.prefsProblem,
    clean: (body) => ({ ...body }),
    defaults: notifications.DEFAULT_PREFS,
    afterSave: notifications.dedupePrefs,
    row: notifications.prefsAuditRow,
  },
  MedicalRecord: {
    fields: records.RECORD_BROWSER_FIELDS,   // only data: user_id and the legacy verified_* fields are never accepted
    types: { data: "object" },
    validate: records.recordProblem,
    clean: records.recordValues,
    afterSave: records.recordAfterSave,
    deleteProblem: records.recordDeleteProblem,
    auditEvent: records.recordAuditEvent,
    row: records.recordAuditRow,
  },
  EmergencyProfile: {
    fields: emergency.PROFILE_BROWSER_FIELDS,   // directive_updated_at: only the server sets it
    types: emergency.PROFILE_TYPES,
    validate: emergency.profileProblem,
    clean: emergency.profileValues,
    afterSave: emergency.profileAfterSave,
    deleteProblem: emergency.profileDeleteProblem,
    row: emergency.profileAuditRow,
  },
};

// a JSON object ({...}), not an array, null, Date or other class instance
function isPlainObject(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function ruleTypeProblem(body, types = {}) {
  for (const [k, v] of Object.entries(body)) {
    if (v === null) continue;
    const type = types[k] || "string";
    if (type === "number") { if (typeof v !== "number" || !Number.isFinite(v)) return `${k} must be a number`; }
    else if (type === "boolean") { if (typeof v !== "boolean") return `${k} must be true or false`; }
    else if (type === "object") { if (!isPlainObject(v)) return `${k} must be an object`; }
    else if (type === "date") { if (!(v instanceof Date) || isNaN(v.getTime())) return `${k} must be a date`; }
    else if (type === "array") { if (!Array.isArray(v)) return `${k} must be a list`; }
    else if (typeof v !== "string") return `${k} must be text`;
  }
  return null;
}

const blank = (v) => v === undefined || v === null || v === "";

// The same steps as medicationBeforeSave, driven by the class's rule.
function ruleBeforeSave(rule) {
  return async (request) => {
    if (request.master) return masterSave(request);
    const user = await requirePatient(request);
    const obj = request.object;
    const original = request.original;
    const dirty = obj.dirtyKeys().filter((k) => !PARSE_KEYS.includes(k));

    if (!original && rule.browserCreate === false) throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, rule.createRefused || "only the server can add these");
    if (original) {
      if (original.get("user_id") !== user.id) throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, NOT_FOUND);
      if (rule.immutable) throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, rule.immutable);
      if (dirty.includes("user_id")) throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, OWNER_FIXED);
      if (dirty.includes("ACL") && aclKey(obj.getACL()) !== aclKey(original.getACL())) {
        throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, OWNER_FIXED);
      }
    }
    const allowed = original ? rule.fields : rule.fields.concat("user_id");   // user_id on create is replaced below
    for (const k of dirty) if (k !== "ACL" && !allowed.includes(k)) refuse(`unknown field: ${k}`);
    // an unset (Delete) is clearing a field, which the rules below handle; an immutable class has nothing to clear
    refuseOps(obj, dirty, !rule.immutable);

    const fields = dirty.filter((k) => rule.fields.includes(k));
    const body = requestBody(obj, fields);
    const problem = ruleTypeProblem(body, rule.types) || (await rule.validate(body, { user, original }));
    if (problem) refuse(problem);
    for (const f of rule.required || []) {
      if (!original && blank(body[f])) refuse(`Missing required field: ${f}`);
      if (original && f in body && blank(body[f])) refuse(`${f} can't be cleared`);
    }
    const parent = rule.parent;
    if (parent && (!original || fields.includes(parent.field)) && !(parent.optional && blank(body[parent.field]))) {
      if (!(await getOwned(parent.className, body[parent.field], user.id, parent.options))) throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, NOT_FOUND);
    }

    const values = await rule.clean(body, { user, original });
    if (!original) for (const [f, v] of Object.entries(rule.defaults || {})) if (values[f] === undefined || values[f] === null) values[f] = v;
    for (const [f, v] of Object.entries(rule.forced || {})) if (!original || fields.includes(f)) values[f] = v;
    for (const [f, v] of Object.entries(values)) store(obj, f, v);
    if (rule.finish) rule.finish(obj, { body, original });
    if (!original) obj.set("user_id", user.id);
    // a new row, or an old row saved before ACLs: give it the owner ACL (a changed ACL was refused above)
    if (!original || !original.getACL()) obj.setACL(ownerAcl(user.id));
  };
}

function ruleAfterSave(className, rule) {
  return async (request) => {
    if (request.master) return;
    const obj = request.object;
    if (rule.afterSave) {
      try { await rule.afterSave(obj, { original: request.original, ip: request.ip }); }
      catch (err) { console.error(className + " after save failed:", err && err.message ? err.message : "error"); }
    }
    const userId = request.user && request.user.id;
    if (request.original) {
      const event = rule.auditEvent ? rule.auditEvent(obj, request.original) : "UPDATE";
      await audit({ userId, event, targetClass: className, targetId: obj.id, oldData: rule.row(request.original), newData: rule.row(obj), ip: request.ip });
    } else {
      await audit({ userId, event: "INSERT", targetClass: className, targetId: obj.id, newData: rule.row(obj), ip: request.ip });
    }
  };
}

// owner only (the same check as Medication), then the rule's own refusal, if any
function ruleBeforeDelete(rule) {
  return async (request) => {
    await medicationBeforeDelete(request);
    if (request.master || !rule.deleteProblem) return;
    const problem = rule.deleteProblem(request.object);
    if (problem) refuse(problem);
  };
}

function ruleAfterDelete(className, rule) {
  return async (request) => {
    if (request.master) return;
    const id = request.object.id;
    const owner = request.object.get("user_id");   // browser deletes are owner-checked, so it is always set
    for (const child of rule.cascade || []) {
      if (typeof owner !== "string" || !owner) break;
      try {
        // the deleted row's children: its id AND its owner, so another patient's stray row is never touched
        const rows = await findAll(child, { [RULES[child].parent.field]: id, user_id: owner });
        await destroyAll(rows);
        // each removed child is audited too (as the old device route did)
        for (const o of rows) {
          await audit({ userId: request.user && request.user.id, event: "DELETE", targetClass: child, targetId: o.id, oldData: RULES[child].row(o),
            ip: request.ip, detail: { removed_with: className, parent_id: id } });
        }
      } catch (err) {
        console.error(className + " delete: removing " + child + " rows failed:", err && err.message ? err.message : "error");
      }
    }
    if (rule.afterDelete) {
      try { await rule.afterDelete(request.object); }
      catch (err) { console.error(className + " after delete failed:", err && err.message ? err.message : "error"); }
    }
    await audit({ userId: request.user && request.user.id, event: "DELETE", targetClass: className, targetId: id, oldData: rule.row(request.object), ip: request.ip });
  };
}

// ---- backfill: owner-only ACL on every row of every owner class (setup.js OWNER_CLASSES) ----

const PAGE = 1000;

// Parse can't query "has no ACL", so every row is read (pages of 1000 by objectId) and saved when its ACL is not
// exactly owner-only. Returns how many rows were fixed per class. Rows without a user_id are left alone.
async function backfillOwnerAcls() {
  const fixed = {};
  for (const className of OWNER_CLASSES) {
    fixed[className] = 0;
    let last = null;
    for (;;) {
      const q = new Parse.Query(className).ascending("objectId").limit(PAGE);
      if (last) q.greaterThan("objectId", last);
      const page = await q.find(M);
      for (const row of page) {
        const userId = row.get("user_id");
        if (typeof userId !== "string" || !userId || isOwnerOnly(row.getACL(), userId)) continue;
        row.setACL(ownerAcl(userId));
        await row.save(null, M);
        fixed[className]++;
      }
      if (page.length < PAGE) break;
      last = page[page.length - 1].id;
    }
  }
  return fixed;
}

function register(P) {
  const Cloud = (P || Parse).Cloud;
  Cloud.beforeFind("Medication", ownerFind("Medication"));
  Cloud.beforeSave("Medication", medicationBeforeSave);
  Cloud.beforeDelete("Medication", medicationBeforeDelete);
  Cloud.afterSave("Medication", medicationAfterSave);
  Cloud.afterDelete("Medication", medicationAfterDelete);
  Cloud.beforeFind("DoseLog", ownerFind("DoseLog"));
  Cloud.beforeSave("DoseLog", doseBeforeSave);
  Cloud.beforeDelete("DoseLog", historyBeforeDelete(DOSE_FIXED));
  Cloud.afterSave("DoseLog", doseAfterSave);
  Cloud.beforeFind("Refill", ownerFind("Refill"));
  Cloud.beforeSave("Refill", refillBeforeSave);
  Cloud.beforeDelete("Refill", historyBeforeDelete(REFILL_FIXED));
  Cloud.afterSave("Refill", refillAfterSave);
  for (const [className, rule] of Object.entries(RULES)) {
    Cloud.beforeFind(className, ownerFind(className));
    Cloud.beforeSave(className, ruleBeforeSave(rule));
    Cloud.beforeDelete(className, ruleBeforeDelete(rule));
    Cloud.afterSave(className, ruleAfterSave(className, rule));
    Cloud.afterDelete(className, ruleAfterDelete(className, rule));
  }
}

module.exports = { register, ownerAcl, isOwnerOnly, backfillOwnerAcls };
