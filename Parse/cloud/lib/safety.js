// safety.js — Allergy & prescription safety (Task 5.3), on Parse.
//   GET  /safety/allergies                  the patient's allergies (from the Health History form) + drug families
//   GET  /safety/alerts                     re-check every medication and return the warnings
//   POST /safety/check                      {medication_name, brand_name?} -> warnings BEFORE adding (saves nothing)
//   POST /safety/alerts/:id/acknowledge     {acknowledged?: true|false, note?} "I've talked to my doctor"
// Classes: Allergy (kept in step with the form), SafetyAlert. Drug families, members,
// cross-reactions and interactions are in reference.js.
// This is a safety net built on a short list of common drugs, not a pharmacist's review.

const { M, isId, toRow, findAll, findOne, save, create, destroyAll, audit } = require("./db");
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
    const rec = await findOne("MedicalRecord", { user_id: userId });
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
    if (!old) {
      const o = await create("Allergy", { ...values, user_id: userId, allergen_key: key, source: "health_history_form" });
      await audit({ userId, event: "INSERT", targetClass: "Allergy", targetId: o.id, newData: { allergen: a.allergen, reaction: a.reaction } });
    } else if (old.get("allergen") !== a.allergen || (old.get("reaction") || null) !== a.reaction) {
      const before = { allergen: old.get("allergen"), reaction: old.get("reaction") || null };
      await save(old, values);
      await audit({ userId, event: "UPDATE", targetClass: "Allergy", targetId: old.id, oldData: before, newData: { allergen: a.allergen, reaction: a.reaction } });
    } else if (JSON.stringify(old.get("drug_classes") || []) !== JSON.stringify(values.drug_classes) || old.get("allergen_type") !== values.allergen_type) {
      await save(old, { drug_classes: values.drug_classes, allergen_type: values.allergen_type });
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
  const rec = await findOne("MedicalRecord", { user_id: userId });
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

// GET /safety/allergies
async function getAllergies(user) {
  await syncAllergiesFromRecord(user.user_id);
  const allergies = (await loadAllergies(user.user_id)).map((a) => ({ ...a, drug_class_names: (a.drug_classes || []).map((c) => className(ref, c)) }));
  return { status: 200, allergies, count: allergies.length };
}

// GET /safety/alerts — re-check, save (keeping acknowledgements), return open ones first
async function getAlerts(user) {
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
  const alerts = sortAlerts((await findAll("SafetyAlert", { user_id: user.user_id })).map(alertRow));
  const open = alerts.filter((a) => !a.acknowledged_at);
  return {
    status: 200, alerts, open_count: open.length, major_open_count: open.filter((a) => a.severity === "major").length,
    medications_checked: meds.length, allergies_checked: allergies.length,
    disclaimer: "These checks cover common medicines only and do not replace a pharmacist's review.",
  };
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
    recognized: info.drugs.size > 0, warnings, safe_to_add_without_warning: warnings.length === 0 };
}

// POST /safety/alerts/:id/acknowledge
async function acknowledge(id, body, user) {
  if (!isId(id)) return { status: 400, error: "Invalid alert ID" };
  const acknowledged = !body || body.acknowledged === undefined ? true : body.acknowledged;
  if (typeof acknowledged !== "boolean") return { status: 400, error: "acknowledged must be true or false" };
  const note = body && body.note != null ? String(body.note).trim() : "";
  if (note.length > 500) return { status: 400, error: "note is too long (max 500)" };
  const alert = await findOne("SafetyAlert", { objectId: id, user_id: user.user_id });
  if (!alert) return { status: 404, error: "Warning not found" };
  const before = alert.get("acknowledged_at") || null;
  await save(alert, { acknowledged_at: acknowledged ? new Date() : null, acknowledged_note: acknowledged ? note || null : null });
  await audit({ userId: user.user_id, event: acknowledged ? "ACKNOWLEDGE" : "UNACKNOWLEDGE", targetClass: "SafetyAlert", targetId: id,
    oldData: { acknowledged_at: before }, newData: { acknowledged_at: alert.get("acknowledged_at") || null, note: note || null } });
  return { status: 200, alert: alertRow(alert) };
}

module.exports = { syncAllergiesFromRecord, getAllergies, getAlerts, check, acknowledge };
