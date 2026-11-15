// safety.js — Allergy & prescription safety (Task 5.3), on Parse.
//   POST /safety/recheck                    re-check every medication and save the warnings (SafetyAlert rows; server only)
//   POST /safety/check                      {medication_name, brand_name?} -> warnings BEFORE adding (saves nothing)
// The website reads SafetyAlert rows and acknowledges them ("I've talked to my doctor") with the Parse SDK
// (Vite/src/data/safety.ts), guarded by RULES.SafetyAlert in access.js: never created or removed from the browser, and
// an edit may only set or clear acknowledged_at (the server's time) / acknowledged_note. Allergy rows may be read, and
// added / edited / removed by the browser (RULES.Allergy: allergyProblem / allergyValues below; the server computes
// allergen_key, allergen_type and drug_classes); the rows copied from the Health History form can only be changed there.
// getAlerts stays for the PDF auto-fill, the C-CDA import and the seed (the pre-visit summary is built by the website).
// Classes: Allergy (kept in step with the form), SafetyAlert. Drug families, members,
// cross-reactions and interactions are in reference.js.
// This is a safety net built on a short list of common drugs, not a pharmacist's review.

const { M, toRow, findAll, oldestRow, save, create, destroyAll, audit } = require("./db");
const R = require("./reference");

const SEVERITY_RANK = { major: 0, moderate: 1, minor: 2 };
const RISK_TO_SEVERITY = { high: "major", moderate: "moderate", low: "minor" };
const ALWAYS_ADVICE = "Don't stop or change a medicine on your own.";
const ALLERGY_FIELDS = ["user_id", "allergen", "allergen_key", "allergen_type", "drug_classes", "reaction", "severity", "status", "source"];
const ALERT_FIELDS = ["user_id", "alert_key", "alert_type", "severity", "medication_id", "medication_name", "related_medication_id",
  "related_medication_name", "allergy_id", "title", "message", "advice", "acknowledged_at", "acknowledged_note", "first_detected_at", "last_checked_at"];
const allergyRow = (o) => toRow(o, "allergy_id", ALLERGY_FIELDS);
const alertRow = (o) => toRow(o, "alert_id", ALERT_FIELDS);

const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// whole-word match, so "aspirin" doesn't match inside another word
const hasWord = (haystack, word) => new RegExp(`(^|[^a-z0-9])${escapeRe(word)}([^a-z0-9]|$)`).test(haystack);

// the reference data, shaped the way the checks use it
const ref = {
  classes: new Map(R.DRUG_CLASSES.map((c) => [c.class_code, c])),
  members: R.DRUG_CLASS_MEMBERS.map(([class_code, drug_name]) => ({ class_code, drug_name })),
  cross: R.CROSS_REACTIVITY,
  interactions: new Map(R.DRUG_INTERACTIONS.map((i) => [`${i.class_a}|${i.class_b}`, i])),
};

// Which drugs / families does a medication name mention?
function classifyMedication(ref, ...names) {
  const text = norm(names.filter(Boolean).join(" "));
  const classes = new Set();
  const drugs = new Set();
  for (const m of ref.members) {
    if (hasWord(text, m.drug_name)) { classes.add(m.class_code); drugs.add(m.drug_name); }
  }
  return { text, classes, drugs };
}

// Which families does an allergy cover? Only families where one allergy means "avoid the
// family" (penicillins, NSAIDs, ...) — an aspirin allergy says nothing about clopidogrel.
function classifyAllergen(ref, allergen) {
  const text = norm(allergen);
  const classes = new Set();
  const drugs = new Set();
  for (const m of ref.members) {
    if (!hasWord(text, m.drug_name)) continue;
    drugs.add(m.drug_name);
    if (ref.classes.get(m.class_code).allergy_group) classes.add(m.class_code);
  }
  for (const c of ref.classes.values()) {
    if (c.allergy_group && c.aliases.some((a) => hasWord(text, a))) classes.add(c.class_code);
  }
  return { text, classes, drugs };
}

const FOOD = /\b(peanuts?|tree nuts?|nuts?|shellfish|shrimp|fish|eggs?|milk|dairy|lactose|wheat|gluten|soy|sesame|strawberr(y|ies))\b/;
const ENVIRONMENT = /\b(pollen|dust|mold|mould|grass|ragweed|cats?|dogs?|dander|trees?)\b/;
const INSECT = /\b(bees?|wasps?|hornets?|insect|stings?|fire ants?)\b/;
function allergenType(ref, allergen) {
  const t = norm(allergen);
  const { classes, drugs } = classifyAllergen(ref, allergen);
  if (classes.size || drugs.size) return "drug";
  if (/\blatex\b/.test(t)) return "latex";
  if (FOOD.test(t)) return "food";
  if (INSECT.test(t)) return "insect";
  if (ENVIRONMENT.test(t)) return "environmental";
  return "unknown";
}

// Severity only when the reaction plainly says so; otherwise left blank for the patient/doctor.
function reactionSeverity(reaction) {
  const r = norm(reaction);
  if (!r) return null;
  if (/anaphyla|epipen|throat (closing|swelling)|can'?t breathe|stopped breathing/.test(r)) return "life_threatening";
  if (/swell|trouble breathing|difficulty breathing|short(ness)? of breath|wheez|hospital/.test(r)) return "severe";
  if (/hives|rash|itch|vomit|nausea|diarrh/.test(r)) return "moderate";
  return null;
}

// ---------- the checks ----------
const className = (ref, code) => (ref.classes.get(code) || { class_name: code }).class_name;
const pretty = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

// Warnings for one medication against the allergy list
function allergyAlerts(ref, med, allergies) {
  const info = classifyMedication(ref, med.name, med.brand);
  const medName = med.name;
  const out = [];
  for (const a of allergies) {
    const al = classifyAllergen(ref, a.allergen);
    const reaction = a.reaction ? ` (reaction: ${a.reaction})` : "";
    const key = `allergy:${med.key}:${a.allergen_key.slice(0, 100)}`;
    const base = { medication_id: med.medication_id, medication_name: medName, allergy_id: a.allergy_id };

    // 1. the same drug
    const sameDrug = [...al.drugs].find((d) => info.drugs.has(d));
    const nameMatch = a.allergen_key.length >= 4 && hasWord(info.text, a.allergen_key);
    if (sameDrug || nameMatch) {
      out.push({ ...base, alert_key: key, alert_type: "allergy", severity: "major",
        title: `${medName} matches your ${a.allergen} allergy`,
        message: `You listed an allergy to ${a.allergen}${reaction}. ${medName} ${sameDrug && norm(medName) !== sameDrug ? `contains ${pretty(sameDrug)}` : "is the same medicine"}.`,
        advice: `Contact your prescriber or pharmacist before taking it. ${ALWAYS_ADVICE}` });
      continue;
    }
    // 2. the same family (allergic to penicillin -> amoxicillin)
    const family = [...al.classes].find((c) => info.classes.has(c));
    if (family) {
      out.push({ ...base, alert_key: key, alert_type: "allergy", severity: "major",
        title: `${medName} is in the same family as ${a.allergen}`,
        message: `You listed an allergy to ${a.allergen}${reaction}. ${medName} is one of the ${className(ref, family)}, the same drug family, so it can cause the same reaction.`,
        advice: `Contact your prescriber or pharmacist before taking it. ${ALWAYS_ADVICE}` });
      continue;
    }
    // 3. a family that sometimes cross-reacts (penicillin -> cephalosporins)
    const cross = ref.cross.find((x) => al.classes.has(x.allergy_class) && info.classes.has(x.related_class));
    if (cross) {
      out.push({ ...base, alert_key: `cross:${med.key}:${a.allergen_key.slice(0, 100)}`, alert_type: "cross_reactivity",
        severity: RISK_TO_SEVERITY[cross.risk],
        title: `${medName} may cross-react with your ${a.allergen} allergy`,
        message: `${medName} is one of the ${className(ref, cross.related_class)}. ${cross.note}`,
        advice: `Make sure your prescriber knows about your ${a.allergen} allergy. ${ALWAYS_ADVICE}` });
    }
  }
  return out;
}

// Warnings for a pair of medications (interaction or doubling up)
function pairAlerts(ref, a, b) {
  const ia = classifyMedication(ref, a.name, a.brand);
  const ib = classifyMedication(ref, b.name, b.brand);
  const [first, second] = a.key < b.key ? [a, b] : [b, a];
  const pairKey = `${first.key}|${second.key}`.slice(0, 250);
  const base = { medication_id: first.medication_id, medication_name: first.name,
    related_medication_id: second.medication_id, related_medication_name: second.name };
  const out = [];

  // interactions: keep the most serious rule that applies to this pair
  let worst = null;
  for (const ca of ia.classes) {
    for (const cb of ib.classes) {
      if (ca === cb) continue;
      const rule = ref.interactions.get(ca < cb ? `${ca}|${cb}` : `${cb}|${ca}`);
      if (rule && (!worst || SEVERITY_RANK[rule.severity] < SEVERITY_RANK[worst.severity])) worst = rule;
    }
  }
  if (worst) {
    out.push({ ...base, alert_key: `interaction:${pairKey}`, alert_type: "interaction", severity: worst.severity,
      title: `${first.name} + ${second.name}`,
      message: worst.effect,
      advice: `${worst.advice} ${ALWAYS_ADVICE}` });
  }

  // doubling up on the same family (two NSAIDs, Advil + ibuprofen)
  const shared = [...ia.classes].filter((c) => ib.classes.has(c) && ref.classes.get(c).warn_duplicates);
  if (shared.length) {
    const same = [...ia.drugs].some((d) => ib.drugs.has(d));
    out.push({ ...base, alert_key: `duplicate:${pairKey}`, alert_type: "duplicate_therapy", severity: "moderate",
      title: same ? `${first.name} and ${second.name} may be the same medicine` : `Two ${className(ref, shared[0])}`,
      message: same
        ? `${first.name} and ${second.name} look like the same drug (a brand and generic, or listed twice). Taking both could double the dose.`
        : `${first.name} and ${second.name} are both ${className(ref, shared[0])}. Taking two from the same family adds up the side effects.`,
      advice: `Check with your doctor or pharmacist that you should take both. ${ALWAYS_ADVICE}` });
  }
  return out;
}

function runChecks(ref, meds, allergies) {
  const alerts = [];
  for (const m of meds) alerts.push(...allergyAlerts(ref, m, allergies));
  for (let i = 0; i < meds.length; i++) {
    for (let j = i + 1; j < meds.length; j++) alerts.push(...pairAlerts(ref, meds[i], meds[j]));
  }
  return alerts;
}

const sortAlerts = (list) => list.sort((x, y) =>
  (x.acknowledged_at ? 1 : 0) - (y.acknowledged_at ? 1 : 0) ||
  SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity] ||
  x.title.localeCompare(y.title));

// ---------- allergies (copied from the Health History form) ----------
async function syncAllergiesFromRecord(userId, recordData) {
  let data = recordData;
  if (data === undefined) {
    const rec = await oldestRow("MedicalRecord", userId);
    data = rec ? rec.get("data") || {} : {};
  }
  const listed = new Map();
  for (const a of data && Array.isArray(data.allergies) ? data.allergies : []) {
    if (!a || typeof a !== "object") continue;
    const allergen = String(a.allergen || "").trim().slice(0, 200);
    if (!allergen) continue;
    const key = norm(allergen);
    if (!listed.has(key)) listed.set(key, { allergen, reaction: String(a.reaction || "").trim().slice(0, 500) || null });
  }
  const existing = await findAll("Allergy", { user_id: userId });
  const byKey = new Map(existing.map((e) => [e.get("allergen_key"), e]));
  for (const [key, a] of listed) {
    const values = { allergen: a.allergen, reaction: a.reaction, severity: reactionSeverity(a.reaction),
      allergen_type: allergenType(ref, a.allergen), drug_classes: [...classifyAllergen(ref, a.allergen).classes].sort(), status: "active" };
    const old = byKey.get(key);
    // the form now lists an allergen that was added on its own (a browser row): the form takes it over, so removing it
    // from the form later removes the row, and it can then only be changed on the form
    const claim = old && old.get("source") !== FORM_SOURCE ? { source: FORM_SOURCE } : {};
    const sourceChange = claim.source ? { source: old.get("source") ?? null } : {};
    if (!old) {
      const o = await create("Allergy", { ...values, user_id: userId, allergen_key: key, source: FORM_SOURCE });
      await audit({ userId, event: "INSERT", targetClass: "Allergy", targetId: o.id, newData: { allergen: a.allergen, reaction: a.reaction } });
    } else if (old.get("allergen") !== a.allergen || (old.get("reaction") || null) !== a.reaction) {
      const before = { allergen: old.get("allergen"), reaction: old.get("reaction") || null, ...sourceChange };
      await save(old, { ...values, ...claim });
      await audit({ userId, event: "UPDATE", targetClass: "Allergy", targetId: old.id, oldData: before, newData: { allergen: a.allergen, reaction: a.reaction, ...claim } });
    } else if (JSON.stringify(old.get("drug_classes") || []) !== JSON.stringify(values.drug_classes) || old.get("allergen_type") !== values.allergen_type) {
      await save(old, { drug_classes: values.drug_classes, allergen_type: values.allergen_type, ...claim });
      if (claim.source) await audit({ userId, event: "UPDATE", targetClass: "Allergy", targetId: old.id, oldData: sourceChange, newData: claim });
    } else if (claim.source) {
      await save(old, claim);
      await audit({ userId, event: "UPDATE", targetClass: "Allergy", targetId: old.id, oldData: sourceChange, newData: claim });
    }
  }
  for (const old of existing) {
    if (old.get("source") === "health_history_form" && !listed.has(old.get("allergen_key"))) {
      await audit({ userId, event: "DELETE", targetClass: "Allergy", targetId: old.id, oldData: { allergen: old.get("allergen"), reaction: old.get("reaction") || null } });
      await old.destroy(M);
    }
  }
}

async function loadAllergies(userId) {
  return (await findAll("Allergy", { user_id: userId, status: "active" })).map(allergyRow).sort((a, b) => a.allergen.localeCompare(b.allergen));
}

// tracker meds (active/paused) + medicines typed into an older version of the form
async function loadMedications(userId) {
  const list = [], seen = new Set();
  for (const m of await findAll("Medication", { user_id: userId, status: ["active", "paused"] })) {
    list.push({ key: `m${m.id}`, medication_id: m.id, name: m.get("medication_name"), brand: m.get("brand_name") || null, source: "tracker" });
    seen.add(norm(m.get("medication_name")));
    if (m.get("brand_name")) seen.add(norm(m.get("brand_name")));
  }
  const rec = await oldestRow("MedicalRecord", userId);
  const data = rec ? rec.get("data") || {} : {};
  for (const field of ["prescriptions", "non_prescriptions"]) {
    for (const m of Array.isArray(data[field]) ? data[field] : []) {
      const name = m && typeof m === "object" ? String(m.name || "").trim().slice(0, 255) : "";
      if (!name || seen.has(norm(name))) continue;
      seen.add(norm(name));
      list.push({ key: `f:${norm(name).slice(0, 100)}`, medication_id: null, name, brand: null, source: "health_history_form" });
    }
  }
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

// POST /safety/recheck — re-check, save (keeping acknowledgements); the page then reads the SafetyAlert rows itself
async function recheck(user) {
  await syncAllergiesFromRecord(user.user_id);
  const allergies = await loadAllergies(user.user_id);
  const meds = await loadMedications(user.user_id);
  const found = runChecks(ref, meds, allergies);
  const existing = await findAll("SafetyAlert", { user_id: user.user_id });
  const byKey = new Map(existing.map((a) => [a.get("alert_key"), a]));
  const keep = new Set();
  for (const a of found) {
    keep.add(a.alert_key);
    const values = {
      alert_type: a.alert_type, severity: a.severity, medication_id: a.medication_id || null, medication_name: a.medication_name.slice(0, 255),
      related_medication_id: a.related_medication_id || null, related_medication_name: a.related_medication_name ? a.related_medication_name.slice(0, 255) : null,
      allergy_id: a.allergy_id || null, title: a.title.slice(0, 255), message: a.message, advice: a.advice, last_checked_at: new Date(),
    };
    const old = byKey.get(a.alert_key);
    if (old) await save(old, values);
    else await create("SafetyAlert", { ...values, user_id: user.user_id, alert_key: a.alert_key, first_detected_at: new Date() });
  }
  // problems that no longer apply (medication stopped, allergy removed) go away
  await destroyAll(existing.filter((a) => !keep.has(a.get("alert_key"))));
  return {
    status: 200, medications_checked: meds.length, allergies_checked: allergies.length,
    disclaimer: "These checks cover common medicines only and do not replace a pharmacist's review.",
    reference: { version: R.REFERENCE_VERSION, note: R.WARNING_LIST_NOTE },
  };
}

// re-check, then every warning, open ones first (the PDF auto-fill, the C-CDA import, the seed)
async function getAlerts(user) {
  const { status, ...info } = await recheck(user);
  const alerts = sortAlerts((await findAll("SafetyAlert", { user_id: user.user_id })).map(alertRow));
  const open = alerts.filter((a) => !a.acknowledged_at);
  return { status, alerts, open_count: open.length, major_open_count: open.filter((a) => a.severity === "major").length, ...info };
}

// POST /safety/check {medication_name, brand_name?} — nothing saved
async function check(body, user) {
  const name = body && typeof body.medication_name === "string" ? body.medication_name.trim() : "";
  if (!name) return { status: 400, error: "medication_name is required" };
  if (name.length > 255) return { status: 400, error: "medication_name is too long (max 255)" };
  const brand = body.brand_name == null ? null : String(body.brand_name).trim().slice(0, 255) || null;
  await syncAllergiesFromRecord(user.user_id);
  const allergies = await loadAllergies(user.user_id);
  const meds = (await loadMedications(user.user_id)).filter((m) => norm(m.name) !== norm(name) && (!brand || norm(m.name) !== norm(brand)));
  const candidate = { key: "new", medication_id: null, name, brand, source: "new" };
  const warnings = allergyAlerts(ref, candidate, allergies);
  for (const m of meds) warnings.push(...pairAlerts(ref, candidate, m));
  warnings.forEach((w) => { delete w.alert_key; });
  warnings.sort((x, y) => SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity]);
  const info = classifyMedication(ref, name, brand);
  return { status: 200, medication_name: name, drug_classes: [...info.classes].map((c) => className(ref, c)),
    recognized: info.drugs.size > 0, warnings, safe_to_add_without_warning: warnings.length === 0,
    reference: { version: R.REFERENCE_VERSION, note: R.WARNING_LIST_NOTE } };
}

// ---------- browser saves (access.js RULES.Allergy and RULES.SafetyAlert) ----------
const FORM_SOURCE = "health_history_form";
const BROWSER_SOURCE = "patient_entered";
const FROM_FORM = "This allergy comes from your Health History form. Change or remove it there.";
const SEVERITIES = ["mild", "moderate", "severe", "life_threatening"];
const ALLERGY_STATUSES = ["active", "inactive"];
const ALLERGY_BROWSER_FIELDS = ["allergen", "reaction", "severity", "status"];
// the allergen as stored (trimmed)
const allergenText = (v) => (typeof v === "string" ? v.trim() : "");

async function allergyProblem(body, { user, original }) {
  if (original && original.get("source") === FORM_SOURCE) return FROM_FORM;
  if (!original || "allergen" in body) {
    const allergen = allergenText(body.allergen);
    if (!allergen) return "Missing required field: allergen";
    if (allergen.length > 200) return "allergen is too long (max 200)";
    // one row per allergen (the form copy uses the same key), so the checks never warn twice
    const dup = (await findAll("Allergy", { user_id: user.id, allergen_key: norm(allergen) }, { limit: 2 })).find((o) => !original || o.id !== original.id);
    if (dup) return `You already listed an allergy to ${dup.get("allergen")}`;
  }
  if (body.reaction != null && body.reaction.trim().length > 500) return "reaction is too long (max 500)";
  if (body.severity != null && !SEVERITIES.includes(body.severity)) return `severity must be one of: ${SEVERITIES.join(", ")}`;
  if ("status" in body && !ALLERGY_STATUSES.includes(body.status)) return `status must be one of: ${ALLERGY_STATUSES.join(", ")}`;
  return null;
}
// the server's part: allergen_key, allergen_type and drug_classes from the allergen; severity from the reaction when
// none is given on a new row (as the form copy does)
function allergyValues(body, { original }) {
  const values = {};
  if (!original || "allergen" in body) {
    const allergen = allergenText(body.allergen);
    values.allergen = allergen;
    values.allergen_key = norm(allergen);
    values.allergen_type = allergenType(ref, allergen);
    values.drug_classes = [...classifyAllergen(ref, allergen).classes].sort();
  }
  if (!original || "reaction" in body) values.reaction = body.reaction == null ? null : body.reaction.trim() || null;
  if ("severity" in body) values.severity = body.severity;
  else if (!original) values.severity = reactionSeverity(values.reaction);
  if ("status" in body) values.status = body.status;
  return values;
}
const allergyDeleteProblem = (obj) => (obj.get("source") === FORM_SOURCE ? FROM_FORM : null);

// SafetyAlert: the browser only acknowledges ("I've talked to my doctor") or takes that back. Sending acknowledged_at
// (any date: the server stores its own time) acknowledges, with an optional acknowledged_note; clearing it takes the
// acknowledgement back (the note is cleared too). The old POST /safety/alerts/:id/acknowledge rules.
const ALERT_BROWSER_FIELDS = ["acknowledged_at", "acknowledged_note"];
function alertProblem(body) {
  if (!("acknowledged_at" in body)) return "acknowledged_note can only be saved with acknowledged_at";
  if (body.acknowledged_at !== null && body.acknowledged_note != null && body.acknowledged_note.trim().length > 500) return "note is too long (max 500)";
  return null;
}
function alertValues(body) {
  if (body.acknowledged_at === null) return { acknowledged_at: null, acknowledged_note: null };
  const note = body.acknowledged_note == null ? "" : body.acknowledged_note.trim();
  return { acknowledged_at: new Date(), acknowledged_note: note || null };
}
const ALERT_DELETE_REFUSED = "warnings can't be removed; they go away when the problem no longer applies";
const alertDeleteProblem = () => ALERT_DELETE_REFUSED;
const alertAuditEvent = (obj) => (obj.get("acknowledged_at") ? "ACKNOWLEDGE" : "UNACKNOWLEDGE");

module.exports = {
  syncAllergiesFromRecord, getAlerts, recheck, check,
  ALLERGY_BROWSER_FIELDS, allergyProblem, allergyValues, allergyDeleteProblem, allergyRow, BROWSER_SOURCE,
  ALERT_BROWSER_FIELDS, alertProblem, alertValues, alertDeleteProblem, alertAuditEvent, alertRow,
};
