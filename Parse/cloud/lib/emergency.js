// emergency.js — Emergency responder access (Task 7-1), including DNR and declined life-saving measures.
//
// The patient decides what an emergency responder (paramedic, ER nurse/doctor) may see and
// gets an emergency code for a wallet card / phone lock screen. A responder needs NO account:
// they enter the code plus their name and agency. Every open is logged and the patient is notified.
//
//   Patient routes (patient accounts only):
//   GET    /emergency/settings      settings + code info + the lists the form needs
//   PUT    /emergency/settings      change settings (only the fields sent change)
//   GET    /emergency/preview       exactly what a responder would see right now
//   POST   /emergency/code          create the emergency code, or replace the old one
//   DELETE /emergency/code          turn the code off (access stops immediately)
//   GET    /emergency/access-log    who opened it, newest first
//
//   Responder routes (no login):
//   POST   /emergency-access/:code            {responder_name, agency, badge_id?, reason?}
//   POST   /emergency-access/:code/document   same body; returns the attached directive document (DNR/POLST) if shared
//
// Classes: EmergencyProfile (one per patient), EmergencyAccess (the code). Opens go to AccessLog (audience "emergency").
//
// Directives are the PATIENT'S STATED WISHES. They are not a medical order. The responder view always
// says so and says whether a signed order (POLST/MOLST/DNR form) is on file.

const sec = require("./security");
const { M, isId, findAll, findOne, getOwned, create, save, audit, optText, fail } = require("./db");

// ---------- options ----------
// code_status is the headline; declined_measures is the detail (a patient can be "full code" except for one thing)
const CODE_STATUSES = ["not_set", "full_code", "dnr", "dnr_dni", "comfort_measures_only"];
const CODE_STATUS_LABELS = {
  not_set: "No directive recorded",
  full_code: "Full code — wants all life-saving treatment",
  dnr: "DNR — do not attempt CPR",
  dnr_dni: "DNR / DNI — no CPR and no intubation",
  comfort_measures_only: "Comfort measures only — no life-prolonging treatment",
};
const MEASURES = {
  cpr: "CPR (chest compressions)",
  defibrillation: "Defibrillation / shocks",
  intubation_ventilation: "Intubation and mechanical ventilator",
  noninvasive_ventilation: "BiPAP / CPAP breathing support",
  vasopressors: "Medicines to keep blood pressure up",
  feeding_tube: "Feeding tube",
  artificial_hydration: "IV fluids / artificial hydration",
  dialysis: "Dialysis",
  blood_transfusion: "Blood transfusion",
  icu_admission: "Intensive care (ICU)",
  hospital_transfer: "Transfer to hospital",
};
// what each headline status already means, so the patient doesn't have to tick the same thing twice
const IMPLIED = {
  not_set: [], full_code: [],
  dnr: ["cpr"],
  dnr_dni: ["cpr", "intubation_ventilation"],
  comfort_measures_only: ["cpr", "defibrillation", "intubation_ventilation", "vasopressors", "icu_admission"],
};
const SECTIONS = ["allergies", "medications", "conditions", "contacts", "devices"];
const MAX_CONTACTS = 5;
const LOOKUP_LIMIT = 20;                    // failed code lookups per device per 15 minutes
const MIN15 = 15 * 60 * 1000;
const LOG_LIMIT = 200;
const DISCLAIMER = "These are the patient's own stated wishes, entered in the Health Information Banking app. They are not a medical order. "
  + "If a signed POLST/MOLST/DNR form is available, follow that form.";
const BAD_CODE = fail(404, "invalid or turned-off emergency code");
const TOO_MANY = fail(429, "too many invalid codes from this device — try again in 15 minutes");

const iso = (d) => (d instanceof Date ? d.toISOString() : d ?? null);
const lookupKey = (ctx) => `emergency-lookup:${ctx.ip}`;

// ---------- settings ----------
const DEFAULTS = {
  enabled: false, sections: [...SECTIONS], blood_type: null, medical_notes: null, contacts: [],
  code_status: "not_set", declined_measures: [], directive_notes: null, polst_on_file: false,
  directive_document_id: null, share_directive_document: false,
};

async function profileObject(userId) {
  return findOne("EmergencyProfile", { user_id: userId });
}
function settingsOf(obj) {
  const get = (k) => (obj && obj.get(k) !== undefined && obj.get(k) !== null ? obj.get(k) : DEFAULTS[k]);
  return {
    enabled: !!get("enabled"), sections: get("sections"), blood_type: get("blood_type"), medical_notes: get("medical_notes"),
    contacts: get("contacts"), code_status: get("code_status"), declined_measures: get("declined_measures"),
    directive_notes: get("directive_notes"), polst_on_file: !!get("polst_on_file"),
    directive_document_id: get("directive_document_id"), share_directive_document: !!get("share_directive_document"),
    directive_updated_at: iso(obj && obj.get("directive_updated_at")),
    updated_at: iso(obj && obj.updatedAt),
  };
}

const BLOOD_TYPES = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-", "unknown"];

// Checks the fields that were sent. Returns { values } or { error }.
async function settingsValues(body, userId, current) {
  const v = {};
  const has = (k) => body[k] !== undefined;
  for (const k of ["enabled", "polst_on_file", "share_directive_document"]) {
    if (has(k)) {
      if (typeof body[k] !== "boolean") return { error: `${k} must be true or false` };
      v[k] = body[k];
    }
  }
  if (has("sections")) {
    if (!Array.isArray(body.sections) || !body.sections.every((s) => SECTIONS.includes(s))) {
      return { error: `sections must be a list from: ${SECTIONS.join(", ")}` };
    }
    v.sections = SECTIONS.filter((s) => body.sections.includes(s));
  }
  if (has("blood_type")) {
    if (body.blood_type === null || body.blood_type === "") v.blood_type = null;
    else if (!BLOOD_TYPES.includes(body.blood_type)) return { error: `blood_type must be one of: ${BLOOD_TYPES.join(", ")}` };
    else v.blood_type = body.blood_type;
  }
  for (const [key, label, max] of [["medical_notes", "Medical notes", 500], ["directive_notes", "Directive notes", 1000]]) {
    if (has(key)) {
      const r = optText(body[key], max, label);
      if (r.error) return r;
      v[key] = r.value;
    }
  }
  if (has("contacts")) {
    if (!Array.isArray(body.contacts) || body.contacts.length > MAX_CONTACTS) return { error: `contacts must be a list of at most ${MAX_CONTACTS}` };
    const out = [];
    for (const c of body.contacts) {
      if (!c || typeof c !== "object" || Array.isArray(c)) return { error: "each contact needs a name and phone" };
      const name = optText(c.name, 100, "Contact name"), phone = optText(c.phone, 40, "Contact phone"), rel = optText(c.relationship, 60, "Relationship");
      if (name.error || phone.error || rel.error) return { error: name.error || phone.error || rel.error };
      if (!name.value || !phone.value) return { error: "each contact needs a name and phone" };
      out.push({ name: name.value, phone: phone.value, relationship: rel.value });
    }
    v.contacts = out;
  }
  if (has("code_status") && !CODE_STATUSES.includes(body.code_status)) return { error: `code_status must be one of: ${CODE_STATUSES.join(", ")}` };
  if (has("declined_measures")) {
    if (!Array.isArray(body.declined_measures) || !body.declined_measures.every((m) => Object.prototype.hasOwnProperty.call(MEASURES, m))) {
      return { error: `declined_measures must be a list from: ${Object.keys(MEASURES).join(", ")}` };
    }
  }

  // directive: the status and the declined list must agree
  if (has("code_status") || has("declined_measures")) {
    const status = has("code_status") ? body.code_status : current.code_status;
    const sent = has("declined_measures") ? body.declined_measures : current.declined_measures;
    if (status === "full_code" && sent.includes("cpr")) {
      return { error: "Full code means CPR is wanted — remove CPR from the declined list, or choose DNR" };
    }
    // a headline status adds what it implies, so a DNR always lists CPR as declined
    const merged = new Set([...sent, ...IMPLIED[status]]);
    v.code_status = status;
    v.declined_measures = Object.keys(MEASURES).filter((m) => merged.has(m));
    v.directive_updated_at = new Date();
  }

  if (has("directive_document_id")) {
    if (body.directive_document_id === null || body.directive_document_id === "") v.directive_document_id = null;
    else {
      if (!isId(body.directive_document_id)) return { error: "Invalid document ID" };
      const doc = await getOwned("HealthDocument", body.directive_document_id, userId, { exclude: ["file_data"] });
      if (!doc) return { error: "That document wasn't found in your documents" };
      v.directive_document_id = doc.id;
    }
    v.directive_updated_at = v.directive_updated_at || new Date();
  }
  // a document can't be shared if none is attached
  const finalDoc = v.directive_document_id !== undefined ? v.directive_document_id : current.directive_document_id;
  if (!finalDoc && (v.share_directive_document ?? current.share_directive_document)) v.share_directive_document = false;
  return { values: v };
}

// ---------- the code ----------
function codeInfo(access) {
  if (!access || access.get("revoked")) return { has_code: false, code: null, created_at: null, last_opened_at: null, open_count: 0 };
  return {
    has_code: true, code: access.get("code"), created_at: iso(access.createdAt),
    last_opened_at: iso(access.get("last_opened_at")), open_count: access.get("open_count") || 0,
  };
}
const liveAccess = async (userId) => {
  const rows = await findAll("EmergencyAccess", { user_id: userId });
  return rows.find((r) => !r.get("revoked")) || null;
};

// GET /emergency/settings
async function getSettings(user) {
  const profile = await profileObject(user.user_id);
  return {
    status: 200, settings: settingsOf(profile), access: codeInfo(await liveAccess(user.user_id)),
    options: { code_statuses: CODE_STATUSES.map((value) => ({ value, label: CODE_STATUS_LABELS[value] })),
      measures: Object.entries(MEASURES).map(([value, label]) => ({ value, label })),
      implied_by_status: IMPLIED, sections: SECTIONS, blood_types: BLOOD_TYPES, max_contacts: MAX_CONTACTS },
    disclaimer: DISCLAIMER,
  };
}

// PUT /emergency/settings
async function putSettings(body, user, ctx) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail(400, "Missing settings");
  const profile = await profileObject(user.user_id);
  const current = settingsOf(profile);
  const r = await settingsValues(body, user.user_id, current);
  if (r.error) return fail(400, r.error);
  if (!Object.keys(r.values).length) return fail(400, "Nothing to change");
  const saved = profile ? await save(profile, r.values) : await create("EmergencyProfile", { user_id: user.user_id, ...r.values });
  const settings = settingsOf(saved);
  await audit({ userId: user.user_id, event: profile ? "UPDATE" : "INSERT", targetClass: "EmergencyProfile", targetId: saved.id,
    oldData: profile ? current : null, newData: settings, ip: ctx.ip });
  return { status: 200, message: "Emergency settings saved", settings };
}

// POST /emergency/code — makes (or replaces) the code. The old code stops working at once.
async function createCode(user, ctx) {
  const old = await findAll("EmergencyAccess", { user_id: user.user_id });
  for (const o of old) if (!o.get("revoked")) await save(o, { revoked: true });
  let code;
  do { code = `E-${sec.newShareCode()}`; } while (await findOne("EmergencyAccess", { code }));
  const access = await create("EmergencyAccess", { user_id: user.user_id, code, revoked: false, open_count: 0 });
  await audit({ userId: user.user_id, event: "emergency_code_created", targetClass: "EmergencyAccess", targetId: access.id, ip: ctx.ip });
  return { status: 201, message: "Emergency code created", access: codeInfo(access) };
}

// DELETE /emergency/code
async function revokeCode(user, ctx) {
  const access = await liveAccess(user.user_id);
  if (!access) return fail(404, "You don't have an emergency code");
  await save(access, { revoked: true });
  await audit({ userId: user.user_id, event: "emergency_code_revoked", targetClass: "EmergencyAccess", targetId: access.id, ip: ctx.ip });
  return { status: 200, message: "Emergency code turned off" };
}

// ---------- what the responder sees ----------
function ageOn(dob) {
  if (typeof dob !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(dob)) return null;
  const b = new Date(dob.slice(0, 10) + "T00:00:00Z");
  if (isNaN(b.getTime())) return null;
  const n = new Date();
  let age = n.getUTCFullYear() - b.getUTCFullYear();
  if (n.getUTCMonth() < b.getUTCMonth() || (n.getUTCMonth() === b.getUTCMonth() && n.getUTCDate() < b.getUTCDate())) age--;
  return age >= 0 && age < 150 ? age : null;
}

async function directivesView(s) {
  if (s.code_status === "not_set" && !s.declined_measures.length && !s.directive_notes) return null;
  const declined = s.declined_measures.map((m) => ({ measure: m, label: MEASURES[m] }));
  const headline = s.code_status !== "not_set" ? CODE_STATUS_LABELS[s.code_status]
    : declined.length ? `Declines: ${declined.map((d) => d.label).join("; ")}` : "See notes";
  return {
    alert: headline, code_status: s.code_status, code_status_label: CODE_STATUS_LABELS[s.code_status],
    declined_measures: declined,
    // everything not declined and not mentioned is "no stated preference" — never "wants it" unless full_code
    wants_all_treatment: s.code_status === "full_code" && !declined.length,
    notes: s.directive_notes, signed_order_on_file: s.polst_on_file,
    document_available: !!(s.directive_document_id && s.share_directive_document),
    last_updated: s.directive_updated_at, disclaimer: DISCLAIMER,
  };
}

async function snapshot(userId) {
  const profile = await profileObject(userId);
  const s = settingsOf(profile);
  const patient = await new Parse.Query(Parse.User).get(userId, M);
  const rec = await findOne("MedicalRecord", { user_id: userId });
  const data = (rec && rec.get("data")) || {};
  const p = data.patient || {};

  const out = {
    patient: { name: patient.get("name"), date_of_birth: p.dob || null, age: ageOn(p.dob), sex: p.sex || null, blood_type: s.blood_type },
    directives: await directivesView(s),
    medical_notes: s.medical_notes,
  };
  // directives are NEVER hidden by the section list — that is the point of the page
  if (s.sections.includes("allergies")) {
    const rows = await findAll("Allergy", { user_id: userId });
    out.allergies = rows.filter((a) => (a.get("status") || "active") === "active")
      .map((a) => ({ allergen: a.get("allergen"), reaction: a.get("reaction") ?? null, severity: a.get("severity") ?? null }));
    out.no_known_allergies = !out.allergies.length && !!data.no_known_allergies;
  }
  if (s.sections.includes("medications")) {
    const rows = await findAll("Medication", { user_id: userId });
    out.medications = rows.filter((m) => m.get("status") === "active")
      .sort((a, b) => String(a.get("medication_name")).localeCompare(String(b.get("medication_name"))))
      .map((m) => ({ medication_name: m.get("medication_name"), strength: m.get("strength") ?? null, strength_unit: m.get("strength_unit") ?? null,
        dose_amount: m.get("dose_amount") ?? null, dose_unit: m.get("dose_unit") ?? null, frequency: m.get("frequency") ?? null }));
  }
  if (s.sections.includes("conditions")) {
    const rows = await findAll("Condition", { user_id: userId });
    out.conditions = rows.filter((c) => ["active", "managed"].includes(c.get("status")))
      .map((c) => ({ condition_name: c.get("condition_name"), severity: c.get("severity") ?? null }));
  }
  if (s.sections.includes("contacts")) {
    out.contacts = [...(p.emergency_contact ? [{ name: String(p.emergency_contact).slice(0, 200), phone: null, relationship: null }] : []), ...s.contacts];
  }
  if (s.sections.includes("devices")) {
    const rows = await findAll("RespiratoryDevice", { user_id: userId });
    out.devices = rows.filter((d) => d.get("is_active") !== false).map((d) => ({
      device_type: d.get("device_type"), name: d.get("name") ?? null, flow_lpm: d.get("flow_lpm") ?? null,
      pressure_min: d.get("pressure_min") ?? null, pressure_max: d.get("pressure_max") ?? null,
      epap: d.get("epap") ?? null, ipap: d.get("ipap") ?? null,
    }));
  }
  out.sections = s.sections;
  return { out, settings: s };
}

// GET /emergency/preview
async function preview(user) {
  const { out } = await snapshot(user.user_id);
  return { status: 200, preview: out, disclaimer: DISCLAIMER };
}

// ---------- responder routes ----------
function responderFrom(body) {
  body = body && typeof body === "object" ? body : {};
  const name = optText(body.responder_name, 100, "Your name"), agency = optText(body.agency, 150, "Agency");
  const badge = optText(body.badge_id, 50, "Badge or license number"), reason = optText(body.reason, 300, "Reason");
  const err = name.error || agency.error || badge.error || reason.error;
  if (err) return { error: err };
  if (!name.value || !agency.value) return { error: "enter your name and your agency (for example, a hospital or EMS service)" };
  return { responder: { name: name.value, agency: agency.value, badge_id: badge.value, reason: reason.value } };
}

async function openAccess(code, ctx) {
  // Counted BEFORE the lookup (LOOKUP_LIMIT tries per device in 15 minutes), so many guesses sent at once can't all get
  // through; a real code gives its count back below.
  if ((await sec.take(lookupKey(ctx), MIN15)) > LOOKUP_LIMIT) return { error: TOO_MANY };
  const access = await findOne("EmergencyAccess", { code: String(code || "").trim().toUpperCase() });
  const profile = access && !access.get("revoked") ? await profileObject(access.get("user_id")) : null;
  if (!access || access.get("revoked") || !profile || !profile.get("enabled")) {
    await audit({ event: "emergency_code_invalid", ip: ctx.ip });
    return { error: BAD_CODE };
  }
  await sec.refund(lookupKey(ctx));
  return { access };
}

async function logOpen(ctx, access, action, r) {
  const sections = ["directives", ...settingsOf(await profileObject(access.get("user_id"))).sections];
  await create("AccessLog", {
    patient_user_id: access.get("user_id"), share_code: access.get("code"), audience: "emergency", action,
    viewer_name: r.name, viewer_npi: r.badge_id || null, viewer_agency: r.agency, reason: r.reason || null,
    ip_address: String(ctx.ip || "").slice(0, 64), user_agent: String(ctx.userAgent || "").slice(0, 500),
    sections, accessed_at: new Date(),
  });
}

// the patient hears about it straight away (inbox; the email never contains health details)
async function notifyPatient(access, r) {
  const userId = access.get("user_id");
  try {
    await create("Notification", {
      user_id: userId, kind: "emergency_access", title: "Your emergency information was opened",
      message: `${r.name} (${r.agency}) opened your emergency information.`, link: "/settings",
      dedupe_key: `emergency:${access.id}:${Date.now()}`,
    });
    const user = await new Parse.Query(Parse.User).get(userId, M);
    const email = user.get("email") || user.get("username");
    if (email) {
      await sec.sendEmail(email, "Your Health Information Banking emergency information was opened",
        "Someone used your emergency code to open your emergency information. Log in to Health Information Banking to see who and when.\n"
        + "If this was not expected, turn the code off under Emergency settings.", "emergency access notice");
    }
  } catch (err) {
    console.error("emergency notification failed:", err && err.message ? err.message : "error");   // never block a responder
  }
}

// POST /emergency-access/:code
async function respond(code, body, ctx) {
  const r = responderFrom(body);
  if (r.error) return fail(400, r.error);
  const opened = await openAccess(code, ctx);
  if (opened.error) return opened.error;
  const { access } = opened;
  const { out } = await snapshot(access.get("user_id"));
  await save(access, { last_opened_at: new Date(), open_count: (access.get("open_count") || 0) + 1 });
  await logOpen(ctx, access, "emergency_view", r.responder);
  await notifyPatient(access, r.responder);
  return { status: 200, ...out, disclaimer: DISCLAIMER, accessed_at: new Date().toISOString() };
}

// POST /emergency-access/:code/document — the signed DNR/POLST the patient attached, if they chose to share it
async function respondDocument(code, body, ctx) {
  const r = responderFrom(body);
  if (r.error) return fail(400, r.error);
  const opened = await openAccess(code, ctx);
  if (opened.error) return opened.error;
  const { access } = opened;
  const s = settingsOf(await profileObject(access.get("user_id")));
  if (!s.directive_document_id || !s.share_directive_document) return fail(404, "No directive document is shared");
  const doc = await getOwned("HealthDocument", s.directive_document_id, access.get("user_id"));
  if (!doc) return fail(404, "No directive document is shared");
  let file = Buffer.from(doc.get("file_data") || "", "base64");
  if (doc.get("is_encrypted")) {
    const key = sec.fileKey();
    if (!key) return fail(503, "The document can't be opened right now");
    try { file = sec.decrypt(key, file); } catch { return fail(503, "The document can't be opened right now"); }
  }
  await logOpen(ctx, access, "emergency_view_document", r.responder);
  return { status: 200, file_base64: file.toString("base64"), file_name: doc.get("file_name"),
    content_type: doc.get("content_type") || "application/octet-stream", disclaimer: DISCLAIMER };
}

// GET /emergency/access-log
async function accessLog(user) {
  const entries = (await findAll("AccessLog", { patient_user_id: user.user_id, audience: "emergency" }))
    .sort((a, b) => b.get("accessed_at") - a.get("accessed_at")).slice(0, LOG_LIMIT)
    .map((l) => ({ accessed_at: iso(l.get("accessed_at")), action: l.get("action"), responder_name: l.get("viewer_name"),
      agency: l.get("viewer_agency") ?? null, badge_id: l.get("viewer_npi") ?? null, reason: l.get("reason") ?? null }));
  return { status: 200, entries };
}

module.exports = {
  getSettings, putSettings, createCode, revokeCode, preview, respond, respondDocument, accessLog,
  CODE_STATUSES, MEASURES, IMPLIED, SECTIONS, DISCLAIMER, settingsValues,
};
