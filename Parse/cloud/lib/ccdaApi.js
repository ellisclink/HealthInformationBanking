// Parse/cloud/lib/ccdaApi.js
// POST /ccda/preview  -> parses the file, saves nothing, returns what was found
// POST /ccda/import   -> parses the same file again and saves ONLY the rows the patient ticked
//
// Stateless on purpose: the browser never sends parsed data back, only row numbers, so it
// can't add rows that aren't in the file. Everything goes through the existing create()
// functions, so their validation still applies. Never log the file, the parsed result or any row.

const { parseCcda } = require("./ccda");
const medications = require("./medications");
const conditions = require("./conditions");
const vitals = require("./vitals");
const documents = require("./documents");
const records = require("./records");
const safety = require("./safety");
const { audit, fail, isDate } = require("./db");

const MAX_ROWS = 500;
const MAX_B64 = Math.ceil((8 * 1024 * 1024 * 4) / 3) + 16;
const IMPORTABLE = ["allergies", "medications", "problems", "vitals"];   // the rest are preview-only for now

// ---------- helpers ----------
function readFile(body) {
  const b64 = typeof body.file_base64 === "string" ? body.file_base64.replace(/\s+/g, "") : "";
  if (!b64) return { error: "Choose a C-CDA (.xml) file to upload" };
  if (b64.length > MAX_B64) return { error: "That file is too large (8 MB max)" };
  const buf = Buffer.from(b64, "base64");
  return buf.length ? { buf } : { error: "Choose a C-CDA (.xml) file to upload" };
}

// first non-empty cell whose column header contains one of the words (headers differ between EHRs)
const pick = (row, words) => {
  for (const w of words) for (const k of Object.keys(row)) if (k.includes(w) && row[k]) return row[k];
  return null;
};
const norm = (s) => String(s || "").trim().toLowerCase();
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// "20150701", "2015-07-01T10:00", "Jul 1, 2015" -> "2015-07-01" (or null)
function toIsoDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})(\d{2})(\d{2})/) || s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) { const d = `${m[1]}-${m[2]}-${m[3]}`; return isDate(d) ? d : null; }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : ymd(new Date(t));
}
const dateOf = (r) => toIsoDate(pick(r, ["date", "effective", "start", "time"]));

// ---------- medications ----------
const medName = (r) => (pick(r, ["description", "medication", "name"]) || "").slice(0, 255) || null;

function medBody(r) {
  const s = norm(pick(r, ["status"]));
  const status = /complet/.test(s) ? "completed" : /stop|discontinu/.test(s) ? "discontinued" : /hold|suspend|pause/.test(s) ? "paused" : "active";
  return {
    medication_name: medName(r), status, source: "document_upload",
    rxnorm_code: pick(r, ["rxnorm", "code"]) || undefined, start_date: dateOf(r) || undefined,
    // C-CDA tables rarely carry a usable dose or schedule; "other" avoids fake adherence math
    frequency: "other", dose_amount: 1, dose_unit: "dose", quantity_on_hand: 0,
    notes: "Imported from a C-CDA health record. Dose, schedule and pill count were not imported; please edit them.",
  };
}

// ---------- allergies -> the Health History form's allergy list ----------
// The form keeps allergies as data.allergies = [{ allergen, reaction }]; safety.js reads that list.
const allergenName = (r) => (pick(r, ["allergen", "substance", "name", "description"]) || "").slice(0, 200) || null;
const NO_ALLERGY = /\b(no known|nka|nkda|none)\b/i;
const CLOSED_ALLERGY = /inactive|resolved|entered in error|refuted/i;

// ---------- problems -> conditions ----------
const probName = (r) => (pick(r, ["problem", "condition", "name", "description"]) || "").slice(0, 255) || null;

function condBody(r) {
  const s = norm(pick(r, ["status"]));
  // "resolved" needs a resolved_date we don't have, so closed problems become "inactive"
  const status = /resolv|inactive|complet|ended/.test(s) ? "inactive" : "active";
  return { condition_name: probName(r), status, onset_date: dateOf(r) || undefined, source: "document_upload", notes: "Imported from a C-CDA health record" };
}

// ---------- vitals ----------
const KINDS = [
  ["bmi", /body mass|\bbmi\b/],                                   // skipped: vitals.js calculates BMI itself
  ["oxygen_saturation", /oxygen|spo2|o2 sat|oximetry/],
  ["blood_glucose", /glucose/],
  ["hemoglobin_a1c", /a1c/],
  ["heart_rate", /heart rate|pulse/],
  ["respiratory_rate", /respirat|breath/],
  ["temperature", /temp/],
  ["weight", /weight/],
  ["height", /height|length/],
  ["blood_pressure", /blood pressure|\bbp\b|systolic|diastolic/],
];
const unitOf = (raw) => {
  const u = norm(raw).replace(/[°\s]/g, "");
  if (["[lb_av]", "lb", "lbs", "pound", "pounds"].includes(u)) return "lb";
  if (["kg", "kgs", "kilogram", "kilograms"].includes(u)) return "kg";
  if (["[in_i]", "in", "inch", "inches"].includes(u)) return "in";
  if (["cm", "centimeter", "centimeters"].includes(u)) return "cm";
  if (["cel", "c", "degc"].includes(u)) return "C";
  if (["[degf]", "f", "degf"].includes(u)) return "F";
  return null;
};
const vitalText = (r) => `${pick(r, ["vital", "name"]) || ""} ${pick(r, ["description"]) || ""}`.toLowerCase();
const vitalValue = (r) => String(pick(r, ["value", "result"]) || "");
const vitalLabel = (r) => [pick(r, ["description", "vital", "name"]), vitalValue(r), pick(r, ["unit"])].filter(Boolean).join(" ");

// one reading per selected row; systolic and diastolic rows from the same date are paired
function vitalBodies(rows) {
  const out = [], fails = [], bp = new Map();
  for (const r of rows) {
    const text = vitalText(r);
    const kind = (KINDS.find(([, re]) => re.test(text)) || [])[0];
    const date = dateOf(r);
    const label = vitalLabel(r) || "(no name)";
    if (!kind || kind === "bmi") { fails.push({ label, reason: kind === "bmi" ? "BMI is calculated from weight and height" : "Unrecognised vital sign" }); continue; }
    if (!date) { fails.push({ label, reason: "No date" }); continue; }
    let measured = new Date(`${date}T12:00:00.000Z`);
    if (measured.getTime() > Date.now()) measured = new Date();
    const when = measured.toISOString();
    const raw = vitalValue(r);
    const unit = unitOf(pick(r, ["unit"]) || raw.replace(/^[\d.,/\s-]+/, ""));
    const sl = raw.match(/^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
    let n = parseFloat(raw.replace(/,/g, ""));

    if (kind === "blood_pressure") {
      if (sl) { out.push({ vital_type: kind, value_numeric: +sl[1], value_secondary: +sl[2], measured_at: when, source: "document_upload", label }); continue; }
      if (!Number.isFinite(n)) { fails.push({ label, reason: "No numeric value" }); continue; }
      const e = bp.get(date) || { when, label };
      if (/diastolic/.test(text)) e.dia = n; else e.sys = n;
      bp.set(date, e);
      continue;
    }
    if (!Number.isFinite(n)) { fails.push({ label, reason: "No numeric value" }); continue; }
    const b = { vital_type: kind, value_numeric: n, measured_at: when, source: "document_upload", label };
    if (kind === "weight") {
      if (unit !== "lb" && unit !== "kg") { fails.push({ label, reason: "Weight unit missing or not kg/lb" }); continue; }
      b.unit = unit;
    } else if (kind === "height") {           // vitals.js bounds are in inches
      if (unit === "cm") n = n / 2.54; else if (unit !== "in") { fails.push({ label, reason: "Height unit missing or not in/cm" }); continue; }
      b.value_numeric = Math.round(n * 10) / 10; b.unit = "in";
    } else if (kind === "temperature") {      // vitals.js bounds are in Fahrenheit
      if (unit === "C") b.value_numeric = Math.round((n * 9 / 5 + 32) * 10) / 10;
      else if (unit !== "F" && !(n >= 80 && n <= 115)) { fails.push({ label, reason: "Temperature unit unclear" }); continue; }
    }
    out.push(b);
  }
  for (const e of bp.values()) {
    if (e.sys != null && e.dia != null) out.push({ vital_type: "blood_pressure", value_numeric: e.sys, value_secondary: e.dia, measured_at: e.when, source: "document_upload", label: e.label });
    else fails.push({ label: e.label, reason: "Blood pressure needs both systolic and diastolic" });
  }
  return { out, fails };
}
const vitalKey = (v) => `${v.vital_type}|${String(v.measured_at).slice(0, 10)}|${Number(v.value_numeric)}|${v.value_secondary ?? ""}`;

// ---------- routes ----------
const LABELS = {
  medications: medName, problems: probName, vitals: vitalLabel,
  allergies: (r) => pick(r, ["allergen", "substance", "name", "description"]),
  immunizations: (r) => pick(r, ["vaccine", "immunization", "name", "description"]),
  procedures: (r) => pick(r, ["procedure", "name", "description"]),
  social_history: (r) => pick(r, ["social", "name", "description"]),
};

async function preview(body, user, ctx) {
  const f = readFile(body);
  if (f.error) return fail(400, f.error);
  let parsed;
  try { parsed = await parseCcda(f.buf); } catch (e) { return fail(400, e.message); }

  const sections = {};
  for (const [key, label] of Object.entries(LABELS)) {
    sections[key] = {
      importable: IMPORTABLE.includes(key),
      items: (parsed[key] || []).slice(0, MAX_ROWS).map((r, index) => ({ index, label: label(r) || "(no name)", date: dateOf(r) })),
    };
  }
  await audit({ userId: user.user_id, event: "CCDA_PREVIEW", ip: ctx.ip });   // no content in the log
  return { status: 200, patient: { name: parsed.patient.name, birth_date: parsed.patient.birth_date }, sections };
}

const tally = () => ({ added: 0, skipped: 0, failed: 0 });
const rowsAt = (rows, picks) => (Array.isArray(picks) ? picks : []).slice(0, MAX_ROWS).map((i) => (rows || [])[i]).filter(Boolean);

async function importSelected(body, user, ctx) {
  const f = readFile(body);
  if (f.error) return fail(400, f.error);
  let parsed;
  try { parsed = await parseCcda(f.buf); } catch (e) { return fail(400, e.message); }
  const sel = body.selected && typeof body.selected === "object" ? body.selected : {};

  const result = { allergies: tally(), medications: tally(), problems: tally(), vitals: tally() };
  const problems = [];   // shown to the owner only; counts (not these) go to the audit log
  const note = (section, label, reason) => { if (problems.length < 25) problems.push({ section, label, reason }); };
  const run = async (section, label, make) => {
    const res = await make();
    if (res && res.status >= 400) { result[section].failed++; note(section, label, res.error || "Not saved"); } else result[section].added++;
  };

  // allergies (added to the Health History record; the same save the form does, so safety.js stays in step)
  const als = rowsAt(parsed.allergies, sel.allergies);
  if (als.length) {
    const rec = await records.getRecord(user);
    const data = rec.data && typeof rec.data === "object" ? { ...rec.data } : {};
    const list = Array.isArray(data.allergies) ? [...data.allergies] : [];
    const have = new Set(list.map((a) => norm(a && a.allergen)));
    let added = 0;
    for (const r of als) {
      const name = allergenName(r);
      if (!name) { result.allergies.failed++; note("allergies", "(no name)", "No allergen name"); continue; }
      if (NO_ALLERGY.test(name)) { result.allergies.skipped++; continue; }
      if (CLOSED_ALLERGY.test(pick(r, ["status"]) || "")) { result.allergies.skipped++; continue; }
      if (have.has(norm(name))) { result.allergies.skipped++; continue; }
      list.push({ allergen: name, reaction: (pick(r, ["reaction", "manifestation"]) || "").slice(0, 500) });
      have.add(norm(name)); added++;
    }
    if (added) {
      const saved = await records.putRecord({ data: { ...data, allergies: list, no_known_allergies: false } }, user, ctx,
        { afterRecordSaved: (uid, d) => safety.syncAllergiesFromRecord(uid, d) });
      if (saved.status >= 400) { result.allergies.failed += added; note("allergies", `${added} allergies`, saved.error || "Not saved"); }
      else result.allergies.added += added;
    }
  }

  // medications (skip a name the patient already has)
  const meds = rowsAt(parsed.medications, sel.medications);
  if (meds.length) {
    const have = new Set(((await medications.list({}, user)).medications || []).map((m) => norm(m.medication_name)));
    for (const r of meds) {
      const name = medName(r);
      if (!name) { result.medications.failed++; note("medications", "(no name)", "No medication name"); continue; }
      if (have.has(norm(name))) { result.medications.skipped++; continue; }
      await run("medications", name, () => medications.create(medBody(r), user));
      have.add(norm(name));
    }
  }

  // problems -> conditions
  const probs = rowsAt(parsed.problems, sel.problems);
  if (probs.length) {
    const have = new Set(((await conditions.list({}, user)).conditions || []).map((c) => norm(c.condition_name)));
    for (const r of probs) {
      const name = probName(r);
      if (!name) { result.problems.failed++; note("problems", "(no name)", "No problem name"); continue; }
      if (have.has(norm(name))) { result.problems.skipped++; continue; }
      await run("problems", name, () => conditions.create(condBody(r), user));
      have.add(norm(name));
    }
  }

  // vitals (skip a reading with the same type, day and value)
  const vrows = rowsAt(parsed.vitals, sel.vitals);
  if (vrows.length) {
    const { out, fails } = vitalBodies(vrows);
    for (const x of fails) { result.vitals.failed++; note("vitals", x.label, x.reason); }
    const have = new Set(((await vitals.list({ limit: "500" }, user)).readings || []).map(vitalKey));
    for (const v of out) {
      if (have.has(vitalKey(v))) { result.vitals.skipped++; continue; }
      const { label, ...b } = v;
      await run("vitals", label, () => vitals.create(b, user));
      have.add(vitalKey(v));
    }
  }

  // keep the original file with the patient's documents (needs the XML change in documents.js)
  let original = "not kept";
  if (body.keep_original !== false) {
    try {
      const up = await documents.upload({ file_base64: body.file_base64, title: "C-CDA health record", category: "health_record",
        file_name: typeof body.file_name === "string" ? body.file_name : "health-record.xml" }, user, ctx);
      original = up.status === 201 ? "saved" : up.status === 409 ? "already saved" : `not saved: ${up.error}`;
    } catch { original = "not saved"; }
  }

  // imported medicines skip the "check before adding" step, so re-check everything now (allergies + interactions)
  let safetyInfo = null;
  if (result.medications.added || result.allergies.added) {
    try {
      const a = await safety.getAlerts(user);
      if (a.status === 200) safetyInfo = { open_count: a.open_count, major_open_count: a.major_open_count };
    } catch { /* the warnings page will still show them */ }
  }

  await audit({ userId: user.user_id, event: "CCDA_IMPORT", newData: { result, original, safety: safetyInfo }, ip: ctx.ip });   // counts only
  return { status: 200, message: "Import finished", result, problems, original, safety: safetyInfo };
}

module.exports = { preview, importSelected };
