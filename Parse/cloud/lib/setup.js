// setup.js — the database schema: every class, its fields, and its permissions.
//
// Runs automatically the first time the api is called after Cloud Code starts (it only
// adds what's missing). It can also be run by hand from the Back4app dashboard:
// API Console > Cloud Code > run "setup" with the Master Key.
//
// Every class is locked to the master key: browsers never read or write these classes
// directly. All requests go through the `api` Cloud Function, which checks the session and
// only touches that user's data. (This replaces the old SQL schema files.)

const S = "String", N = "Number", B = "Boolean", D = "Date", A = "Array", O = "Object";
const str = (...names) => Object.fromEntries(names.map((n) => [n, S]));

const SCHEMA = {
  // the Health History form (one per patient); the verified_* fields are legacy (D-015) — kept so old data stays readable, never written
  MedicalRecord: { user_id: S, data: O, verified_by_physician: B, verified_by: S, verified_npi: S, verified_at: D },
  // sharing
  ShareCode: { share_code: S, user_id: S, expires_at: D, revoked: B, audience: S, sections: A, label: S },
  // emergency opens (audience "emergency") also use viewer_agency and reason; viewer_npi then holds the responder's badge/license number
  AccessLog: { ...str("patient_user_id", "share_code", "audience", "action", "viewer_user_id", "viewer_name", "viewer_npi", "viewer_agency", "reason", "ip_address", "user_agent"),
    sections: A, accessed_at: D },
  // security
  AuditLog: { ...str("user_id", "event", "target_class", "target_id", "ip_address"), old_data: O, new_data: O, detail: O },
  LoginChallenge: { user_id: S, code_hash: S, attempts: N, expires_at: D, verified_at: D },
  PasswordReset: { user_id: S, token_hash: S, expires_at: D },
  RateLimit: { key: S, count: N, reset_at: D },
  SessionActivity: { token_hash: S, user_id: S, started_at: D, last_seen: D },
  // medications
  Medication: {
    ...str("user_id", "medication_name", "medication_type", "brand_name", "rxnorm_code", "ndc_code", "strength_unit", "dosage_form", "route",
      "dose_unit", "frequency", "instructions", "purpose", "condition_id", "prescriber_name", "pharmacy_name", "status", "start_date", "end_date",
      "discontinued_reason", "last_refill_date", "source", "notes"),
    strength: N, dose_amount: N, quantity_on_hand: N, refill_threshold: N, refills_remaining: N, schedule_times: A,
  },
  DoseLog: { medication_id: S, user_id: S, taken_at: D, dose_status: S, quantity: N, notes: S },
  Refill: { ...str("medication_id", "user_id", "refill_date", "pharmacy_name", "notes"), quantity_added: N },
  // vitals, diary, conditions, calendar, nutrition
  VitalReading: { ...str("user_id", "vital_type", "unit", "measurement_context", "body_position", "device_name", "source", "condition_id", "notes"),
    value_numeric: N, value_secondary: N, measured_at: D,
    // a calculated BMI: the ids of the weight and height readings it was built from
    source_reading_ids: A },
  DiaryEntry: { ...str("user_id", "entry_date", "category", "title", "description", "mood"), severity: N, follow_up_needed: B },
  Condition: { ...str("user_id", "condition_name", "icd10_code", "category", "status", "severity", "onset_date", "diagnosed_date", "resolved_date",
    "diagnosing_provider", "managing_provider", "provider_facility", "source", "notes"), is_primary: B },
  ConditionNote: str("condition_id", "user_id", "note_date", "note_type", "note_text"),
  ConditionTarget: { ...str("condition_id", "user_id", "vital_type", "set_by"), target_min: N, target_max: N, secondary_min: N, secondary_max: N, active: B },
  // recurrence: recurrence_type none|daily|every_n_days|weekly|monthly; end_type never|date|count;
  // end_date and exceptions are YYYY-MM-DD; recurrence_weekdays are 0-6; recurrence_day is 1-31
  CalendarEvent: { ...str("user_id", "title", "description", "category", "location", "provider_name", "status", "condition_id",
    "recurrence_type", "end_type", "end_date", "time_zone"),
    start_time: D, end_time: D, all_day: B,
    recurrence_interval: N, recurrence_weekdays: A, recurrence_day: N, end_count: N, exceptions: A },
  // calendar subscribe links (D-016): only the SHA-256 of the token is stored; the token itself is shown once
  FeedToken: { ...str("user_id", "label", "token_hash"), expires_at: D, revoked_at: D, created_at: D, last_fetched_at: D, fetch_count: N },
  // every hash ever registered, kept forever (never purged), so a purged link's hash can't be registered again
  UsedFeedHash: { token_hash: S, created_at: D },
  NutritionLog: { ...str("user_id", "food_name", "usda_fdc_id", "serving_unit", "source", "notes"), logged_at: D,
    serving_size: N, calories: N, protein_g: N, carbs_g: N, fat_g: N, fiber_g: N, sugar_g: N, sodium_mg: N, confidence: N },
  // lab results (the PDF is stored inside LabReport.file_data, encrypted when ENCRYPTION_KEY is set)
  LabReport: { ...str("user_id", "title", "report_date", "lab_name", "ordered_by", "notes", "file_name", "content_type", "file_sha256", "file_data"),
    file_size: N, is_encrypted: B },
  LabResult: { ...str("user_id", "report_id", "test_code", "test_name", "panel", "value_text", "unit", "ref_text", "range_source", "flag",
    "collected_date", "notes", "source"), value_numeric: N, ref_low: N, ref_high: N },
  // allergy & prescription safety
  Allergy: { ...str("user_id", "allergen", "allergen_key", "allergen_type", "reaction", "severity", "status", "source"), drug_classes: A },
  SafetyAlert: { ...str("user_id", "alert_key", "alert_type", "severity", "medication_id", "medication_name", "related_medication_id",
    "related_medication_name", "allergy_id", "title", "message", "advice", "acknowledged_note"),
    acknowledged_at: D, first_detected_at: D, last_checked_at: D },
  // personal link repository
  PersonalLink: { ...str("user_id", "title", "url", "category", "organization", "phone", "member_id_hint", "notes"),
    is_favorite: B, open_count: N, last_opened_at: D },
  // safe medication disposal (the count is taken off the Medication)
  DisposalLog: { ...str("user_id", "medication_id", "medication_name", "method", "location", "disposed_date", "notes"), quantity: N },
  // health documents (the file is in file_data, encrypted when ENCRYPTION_KEY is set)
  HealthDocument: { ...str("user_id", "title", "category", "provider", "document_date", "notes", "file_name", "content_type", "file_sha256", "file_data"),
    file_size: N, is_encrypted: B, tags: A },
  // breathing devices: settings, replaceable parts and daily/nightly logs
  RespiratoryDevice: { ...str("user_id", "device_type", "name", "serial_last4", "mask_type", "start_date", "notes"),
    pressure_min: N, pressure_max: N, epap: N, ipap: N, flow_lpm: N, personal_best: N, is_active: B },
  DeviceSupply: { ...str("user_id", "device_id", "part_name", "last_replaced", "notes"), interval_days: N },
  RespiratoryLog: { ...str("user_id", "device_id", "log_date", "notes"), hours_used: N, ahi: N, leak_lpm: N, spo2_avg: N, spo2_min: N,
    flow_lpm_avg: N, comfort: N, peak_flow: N },
  // reminders, automatic alerts and the notification inbox
  Reminder: { ...str("user_id", "reminder_type", "title", "linked_id", "linked_name", "schedule_type", "time_zone", "start_date", "end_date"),
    times: A, days_of_week: A, remind_at: D, next_due_at: D, last_fired_at: D, snoozed_until: D, email_me: B, active: B },
  Notification: { ...str("user_id", "kind", "title", "message", "link", "action", "dedupe_key", "reminder_id"), dismissed_at: D, read_at: D },
  NotificationPrefs: { user_id: S, low_stock: B, appointments: B, supplies: B, disposal: B, email: B },
};
// emergency responder access (7-1): what a responder may see, the DNR / declined-measures wishes, and the code
const EXTRA = {
  EmergencyProfile: { ...str("user_id", "blood_type", "medical_notes", "code_status", "directive_notes", "directive_document_id"),
    enabled: B, sections: A, contacts: A, declined_measures: A, polst_on_file: B, share_directive_document: B, directive_updated_at: D },
  EmergencyAccess: { ...str("user_id", "code"), revoked: B, open_count: N, last_opened_at: D },
  // PDF auto-fill (7-2): proposals waiting for the patient's confirmation; erased on confirm, cancel or after 24 hours
  AutofillDraft: { ...str("user_id", "status", "file_name", "file_sha256", "file_data"), file_size: N, is_encrypted: B, proposals: A, expires_at: D },
  // account deletion (7-4): a data-free record of the request (user_id becomes a one-way hash once it is carried out)
  DeletionRequest: { ...str("user_id", "status"), immediate: B, requested_at: D, scheduled_for: D, completed_at: D, cancelled_at: D },
};
Object.assign(SCHEMA, EXTRA);
const USER_FIELDS = { name: S, role: S, npi: S };

// Indexes (name -> {field: 1}). Parse's schema API can only make ordinary indexes, NOT unique ones (Parse Server keeps
// unique indexes to its own _User fields), so FeedToken.token_hash is indexed for the feed lookup and kept unique by
// calendarFeed.createToken checking for an existing hash before it saves.
const INDEXES = {
  FeedToken: { token_hash_1: { token_hash: 1 } },
  UsedFeedHash: { token_hash_1: { token_hash: 1 } },
};

const LOCKED = { find: {}, count: {}, get: {}, create: {}, update: {}, delete: {}, addField: {}, protectedFields: {} };
const CLASSES = Object.keys(SCHEMA);
const ADD = { String: "addString", Number: "addNumber", Boolean: "addBoolean", Date: "addDate", Array: "addArray", Object: "addObject" };

let done = false;

async function ensureClass(className, fields, clp, indexes = {}) {
  let existing = null;
  try { existing = await new Parse.Schema(className).get(); } catch { existing = null; }
  const schema = new Parse.Schema(className);
  const have = existing ? existing.fields || {} : {};
  let changed = false;
  for (const [name, type] of Object.entries(fields)) {
    if (!have[name]) { schema[ADD[type]](name); changed = true; }
  }
  // only indexes the class doesn't have yet: Parse refuses to add one that already exists
  const haveIndexes = existing ? existing.indexes || {} : {};
  for (const [name, spec] of Object.entries(indexes)) {
    if (!haveIndexes[name]) { schema.addIndex(name, spec); changed = true; }
  }
  const clpChanged = !existing || JSON.stringify(existing.classLevelPermissions || {}) !== JSON.stringify(clp);
  if (clpChanged) schema.setCLP(clp);
  if (!existing) { await schema.save(); return "created"; }
  if (changed || clpChanged) { await schema.update(); return "updated"; }
  return "ok";
}

// One-time data fix: give every FeedToken hash saved before UsedFeedHash existed its tombstone (calendarFeed.js).
// It runs in the BACKGROUND: a request never waits for it and never fails because of it. Only one run at a time;
// after a failure it is tried again at most once every BACKFILL_RETRY_MS; after one success, never again (per process).
const BACKFILL_RETRY_MS = 5 * 60 * 1000;
let backfilled = false, backfillRun = null, backfillFailedAt = null;
let clock = Date.now;
function startBackfill() {
  if (backfilled || backfillRun) return;
  if (backfillFailedAt !== null && clock() - backfillFailedAt < BACKFILL_RETRY_MS) return;
  backfillRun = Promise.resolve()
    .then(() => require("./calendarFeed").backfillUsedFeedHashes())
    .then(() => { backfilled = true; backfillFailedAt = null; },
      (err) => {
        backfillFailedAt = clock();
        console.error("UsedFeedHash backfill failed (will retry later):", err && err.message ? err.message : "error");
      })
    .finally(() => { backfillRun = null; });
}

async function ensureSetup(force = false) {
  if (done && !force) { startBackfill(); return { ok: true, cached: true }; }
  const result = {};
  for (const [c, fields] of Object.entries(SCHEMA)) result[c] = await ensureClass(c, fields, LOCKED, INDEXES[c]);
  result._User = await ensureClass("_User", USER_FIELDS, LOCKED);
  done = true;
  startBackfill();
  return { ok: true, classes: result };
}

module.exports = {
  ensureSetup, ensureClass, CLASSES, SCHEMA, INDEXES,
  // for tests
  _backfillInFlight: () => backfillRun,
  _resetBackfill: () => { backfilled = false; backfillRun = null; backfillFailedAt = null; },
  _setClock: (fn) => { clock = fn; },
};
