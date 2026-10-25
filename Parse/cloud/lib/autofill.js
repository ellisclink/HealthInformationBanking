// autofill.js — Document upload auto-fill (Task 7-2), PDF files only.
//
// The patient uploads a PDF (lab report, visit summary, medication list...). We read its text and PROPOSE
// entries for the lab results, medications, conditions, allergies and vital signs it mentions. Nothing is
// saved to the patient's data until the patient reviews the proposals and confirms them:
//
//   POST   /documents/autofill                       {file_base64, file_name?}  -> reads the PDF, saves a short-lived DRAFT, returns proposals
//   GET    /documents/autofill/:draftId              the draft again (for the review screen)
//   POST   /documents/autofill/:draftId/confirm      {confirmed: true, items: [{proposal_id, accept, fields?}]}  -> saves ONLY accepted items
//   DELETE /documents/autofill/:draftId              cancel; the draft and its copy of the file are erased
//
// Rules that make "the patient confirms" real:
//   * extract saves nothing except the draft (24 hours, then erased)
//   * confirm needs `confirmed: true` AND each item listed with `accept: true`; anything not listed is NOT saved
//   * the patient may correct a value (`fields`); the corrected value is what is validated and saved
//   * every save goes through the same create() functions as manual entry, so the same validation applies
//   * the PDF itself is kept in Documents only if the patient accepts the "document" proposal
// Reading a PDF is a best guess from text: each proposal carries the line it came from and a confidence.
// Scanned (image-only) PDFs have no text to read; the patient is told to enter the information by hand.
// The text, the proposals and the file are never written to logs; the audit log gets counts only.
// Class: AutofillDraft.

const crypto = require("crypto");
const sec = require("./security");
const documents = require("./documents");
const labs = require("./labs");
const medications = require("./medications");
const conditions = require("./conditions");
const vitals = require("./vitals");
const records = require("./records");
const safety = require("./safety");
const { LAB_TESTS } = require("./reference");
const { isKnownDrug, isSupplement, unitKind, compareMedicines } = require("./drugnames");
const { isId, isDate, findAll, getOwned, save, create, destroy, destroyAll, audit, fail } = require("./db");

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_B64 = Math.ceil((MAX_FILE_BYTES * 4) / 3) + 16;
const MAX_TEXT_CHARS = 300000;
const MAX_PROPOSALS = 200;
const MAX_PENDING_DRAFTS = 5;
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_TEXT_CHARS = 20;

const SECTIONS = ["document", "lab_result", "medication", "condition", "allergy", "vital"];
// the fields a patient may correct on each kind of proposal (anything else they send is ignored)
const EDITABLE = {
  document: ["title", "category", "provider", "document_date", "notes"],
  lab_result: ["test_code", "test_name", "value", "unit", "collected_date", "ref_low", "ref_high"],
  medication: ["medication_name", "strength", "strength_unit", "dosage_form", "frequency", "route", "instructions", "purpose", "start_date"],
  condition: ["condition_name", "icd10_code", "status", "onset_date"],
  allergy: ["allergen", "reaction"],
  vital: ["vital_type", "value_numeric", "value_secondary", "unit", "measured_at"],
};

// ---------- reading the PDF ----------
// Replaceable so tests (and a future OCR service) can supply their own reader: async (Buffer) -> string
let extractor = async (buf) => {
  const pdfParse = require("pdf-parse/lib/pdf-parse.js");   // not the package index, which runs a debug routine
  // pass a plain Uint8Array: on newer Node versions pdf.js rejects a Buffer with "bad XRef entry"
  const out = await pdfParse(new Uint8Array(buf));
  return out.text || "";
};
const setExtractor = (fn) => { extractor = fn; };

const clean = (s) => String(s || "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/[ \t ]+/g, " ").trim();
const linesOf = (text) => text.split(/\r?\n/).map(clean).filter(Boolean);
const num = (s) => { const n = parseFloat(String(s).replace(/,/g, "")); return Number.isFinite(n) ? n : null; };
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// "07/01/2024", "2024-07-01", "July 1, 2024", "1 Jul 2024" -> "2024-07-01" (or null)
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function toIsoDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  let y, mo, d;
  if (m) [y, mo, d] = [m[1], m[2], m[3]];
  else if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/))) {          // US order: month/day/year
    [mo, d] = [m[1], m[2]]; y = m[3].length === 2 ? `20${m[3]}` : m[3];
  } else if ((m = s.match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})$/))) { mo = MONTHS.indexOf(m[1].toLowerCase()) + 1; d = m[2]; y = m[3]; }
  else if ((m = s.match(/^(\d{1,2}) ([A-Za-z]{3})[a-z]*\.?,? (\d{4})$/))) { mo = MONTHS.indexOf(m[2].toLowerCase()) + 1; d = m[1]; y = m[3]; }
  else return null;
  if (!mo) return null;
  const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return isDate(iso) && iso <= new Date(Date.now() + 86400000).toISOString().slice(0, 10) ? iso : null;
}
const DATE_RE = "(\\d{4}-\\d{2}-\\d{2}|\\d{1,2}/\\d{1,2}/\\d{2,4}|[A-Za-z]{3,9}\\.? \\d{1,2},? \\d{4}|\\d{1,2} [A-Za-z]{3,9}\\.?,? \\d{4})";

// ---------- section headings ----------
const HEADINGS = [
  ["medications", /^(current |home |active |discharge )?(medications?|meds|prescriptions?|medication list)\b\s*:?/i],
  // vitamins and supplements are medicines too (saved as non-prescription); never lab results
  ["supplements", /^(vitamins?( (and|&) (supplements?|minerals?))?|supplements?|over[- ]the[- ]counter( medications?| meds)?|otc( medications?| meds)?|herbal( products?| supplements?)?|nutritional supplements?)\b\s*:?/i, true],
  ["allergies", /^(drug |known )?allergies( and (reactions|intolerances))?\b\s*:?/i],
  ["conditions", /^(diagnos[ie]s|problem list|active problems|assessment|impression|medical history|past medical history|conditions)\b\s*:?/i],
  ["vitals", /^(vital signs?|vitals)\b\s*:?/i],
  ["labs", /^(lab(oratory)? (results?|tests?)|results?|chemistry|metabolic panel|lipid panel|complete blood count|cbc)\b\s*:?/i],
  ["other", /^(plan|instructions|follow[- ]?up|history of present illness|hpi|chief complaint|review of systems|physical exam|social history|family history|signature|notes?)\b\s*:?/i],
];
const headingOf = (line) => {
  if (line.length > 80) return null;
  for (const [name, re, strict] of HEADINGS) {
    const m = line.match(re);
    if (!m) continue;
    // a "strict" heading must stand alone or end in a colon: "Vitamin D3 2000 IU" is a medicine line, not the heading "Vitamins"
    if (strict && /\S/.test(line.slice(m[0].length)) && !m[0].includes(":")) continue;
    return { name, rest: clean(line.slice(m[0].length)) };
  }
  return null;
};
// lines grouped by the heading above them ("allergies: penicillin" keeps the text after the colon as the first line)
function sectionLines(lines) {
  const out = { medications: [], supplements: [], allergies: [], conditions: [], vitals: [], labs: [], other: [], none: [] };
  for (const { line, section } of taggedLines(lines)) out[section].push(line);
  return out;
}
// every line with the heading it sits under: [{ line, section }] (the heading lines themselves are left out)
function taggedLines(lines) {
  const out = [];
  let current = "none";
  for (const line of lines) {
    const h = headingOf(line);
    if (h) { current = h.name; if (h.rest) out.push({ line: h.rest, section: current }); continue; }
    out.push({ line, section: current });
  }
  return out;
}
const bullet = (line) => clean(line.replace(/^([-•*·▪]|\d{1,2}[.)])\s*/, ""));

// ---------- the proposals ----------
let seq = 0;
function proposal(section, label, fields, source, confidence, warnings = []) {
  seq += 1;
  return { proposal_id: `p${seq}`, section, label, confidence, fields, source_text: source.slice(0, 200), warnings };
}

// document details
function documentDetails(lines, fileName, labCount) {
  const text = lines.join("\n");
  const dateLabel = text.match(new RegExp(`(?:date of service|collected|collection date|report date|service date|visit date|date)\\s*[:\\-]?\\s*${DATE_RE}`, "i"));
  const providerLabel = text.match(/(?:ordering (?:provider|physician)|provider|physician|doctor|attending|referring physician)\s*[:\-]\s*([^\n|]{3,80})/i);
  const labName = text.match(/(?:laboratory|lab name|performing lab|facility)\s*[:\-]\s*([^\n|]{3,80})/i);
  let category = "other";
  if (labCount >= 3) category = "lab_report";
  else if (/discharge summary/i.test(text)) category = "hospital_discharge";
  else if (/immunization|vaccin/i.test(text)) category = "vaccination";
  else if (/radiolog|\bmri\b|\bct scan\b|x-ray|ultrasound|imaging/i.test(text)) category = "imaging";
  else if (/visit summary|progress note|after visit|office visit|clinical summary/i.test(text)) category = "visit_summary";
  else if (/prescription|rx\b/i.test(text)) category = "prescription";
  else if (/insurance|policy number|member id/i.test(text)) category = "insurance";
  const date = dateLabel ? toIsoDate(dateLabel[1]) : null;
  const title = clean(fileName).replace(/\.pdf$/i, "").slice(0, 120) || "Uploaded document";
  return {
    date, provider: providerLabel ? clean(providerLabel[1]).slice(0, 200) : (labName ? clean(labName[1]).slice(0, 200) : null),
    category, title,
  };
}

// lab catalogue lookup: longest name first, so "LDL cholesterol" wins over "cholesterol"
const labTerms = (() => {
  const terms = [];
  for (const t of LAB_TESTS) {
    const names = new Set([t.display_name.replace(/\s*\(.*?\)\s*/g, " ").trim(), t.display_name, t.test_code.replace(/_/g, " "), ...(t.aliases || [])]);
    for (const n of names) if (n && n.length >= 3) terms.push({ test: t, term: n.toLowerCase(), re: new RegExp(`(^|[^a-z0-9])${escapeRe(n.toLowerCase()).replace(/\s+/g, "\\s+")}(?![a-z0-9])`, "i") });
  }
  return terms.sort((a, b) => b.term.length - a.term.length);
})();
const UNIT_RE = "([A-Za-z%µμ][A-Za-z0-9%µμ/^.*]{0,14}(?:/[A-Za-z0-9µμ.]{1,8})?)";

// "Glucose 105 mg/dL 70 - 99 H"  ->  proposal, or null when the line isn't a result
// A lab result is a concentration ("32 ng/mL"); a medicine or supplement is a dose ("2000 IU", "500 mg"). Several names are both
// ("vitamin d", "calcium", "iron", "potassium", "b12"), so the UNIT and the heading decide which one a line is (Task 8-2).
function labFromLine(line, fallbackDate, section = "none") {
  // under a medicine / supplement / allergy / condition heading a line is never a lab result
  if (["medications", "supplements", "allergies", "conditions"].includes(section)) return null;
  const lower = line.toLowerCase();
  for (const { test, re } of labTerms) {
    const m = re.exec(lower);
    if (!m || m.index > 40) continue;
    const rest = line.slice(m.index + m[0].length);
    // between the name and the number a report may add a qualifier: "Vitamin D, 25-OH 32 ng/mL", "Cholesterol, total 190 mg/dL"
    const v = rest.match(new RegExp(`^[\\s:.\\-=,]*(?:\\(?(?:25[\\s-]?(?:oh|hydroxy)(?:[\\s-]?vitamin d)?|total|serum|plasma|whole blood|fasting|calculated)\\)?[\\s:.\\-=,]*)?([<>]?\\s*-?\\d{1,5}(?:[.,]\\d{1,4})?)\\s*${UNIT_RE}?`, "i"));
    if (!v) continue;
    const value = num(v[1].replace(/[<>\s]/g, ""));
    if (value === null) continue;
    let unit = v[2] && !/^(h|l|hh|ll|high|low|normal|abnormal|flag)$/i.test(v[2]) ? v[2] : null;
    const tail = rest.slice(v[0].length);
    const range = tail.match(/(-?\d{1,5}(?:\.\d+)?)\s*(?:-|–|to)\s*(-?\d{1,5}(?:\.\d+)?)/);
    const kind = unitKind(unit);
    if (kind === "dose") continue;                                   // "Vitamin D3 2000 IU", "Calcium 600 mg": a dose, not a result
    const flagged = /(^|\s)(H|L|HH|LL|high|low|abnormal|critical)(\s|$)/i.test(tail);
    // outside a results section, a result needs a lab-style unit (mg/dL, ng/mL...) or a reference range or flag next to it
    if (section !== "labs" && kind !== "lab" && !(kind === "none" && (range || flagged))) continue;
    const warnings = [];
    if (/^[<>]/.test(v[1].trim())) warnings.push("The report shows a limit (< or >), not an exact number");
    if (!unit) { unit = test.default_unit; warnings.push(`No unit found; assumed ${test.default_unit}`); }
    const fields = { test_code: test.test_code, test_name: test.display_name, value, unit, collected_date: fallbackDate };
    if (range) {
      const lo = num(range[1]), hi = num(range[2]);
      if (lo !== null && hi !== null && lo <= hi) { fields.ref_low = lo; fields.ref_high = hi; }
    }
    return proposal("lab_result", `${test.display_name}: ${value} ${unit}`, fields, line, warnings.length ? "medium" : "high", warnings);
  }
  return null;
}

const FREQ = [
  [/\b(twice (a |per )?day|twice daily|b\.?i\.?d\.?|two times)\b/i, "twice_daily"],
  [/\b(three times (a |per )?day|t\.?i\.?d\.?)\b/i, "three_times_daily"],
  [/\b(four times (a |per )?day|q\.?i\.?d\.?)\b/i, "four_times_daily"],
  [/\b(every other day|q\.?o\.?d\.?)\b/i, "every_other_day"],
  [/\b(weekly|once a week|every week)\b/i, "weekly"],
  [/\b(as needed|p\.?r\.?n\.?)\b/i, "as_needed"],
  [/\b(once (a |per )?day|once daily|daily|every day|q\.?d\.?|every morning|nightly|at bedtime|at night)\b/i, "once_daily"],
];
const FORMS = [["tablet", /\btab(let)?s?\b/i], ["capsule", /\bcap(sule)?s?\b/i], ["liquid", /\b(solution|syrup|liquid|suspension)\b/i],
  ["injection", /\b(inject\w*|pen|syringe)\b/i], ["inhaler", /\binhal\w*\b/i], ["patch", /\bpatch\b/i], ["cream", /\b(cream|ointment)\b/i],
  ["drops", /\bdrops?\b/i], ["spray", /\bspray\b/i]];
const ROUTES = [["oral", /\b(by mouth|oral|po)\b/i], ["topical", /\btopical\b/i], ["inhalation", /\binhal\w*\b/i], ["nasal", /\bnasal\b/i],
  ["sublingual", /\bsublingual\b/i], ["transdermal", /\btransdermal\b/i]];

// "Lisinopril 10 mg tablet once daily"  ->  proposal, or null
// opts.section: the heading the line sits under ("medications", "supplements", or "none"/"other" for a line found elsewhere).
// Outside a medicine heading a line only counts when the name is a medicine or supplement we recognise (drugnames.js).
const UNIT_NAMES = { iu: "IU", meq: "mEq", "µg": "mcg", "μg": "mcg", ug: "mcg" };
function medFromLine(raw, opts = {}) {
  const inList = opts.section === "medications" || opts.section === "supplements";
  const line = bullet(raw);
  if (line.length > 200 || /^(none|no medications|n\/a|nka)\b/i.test(line)) return null;
  // the name may contain digits ("Vitamin D3", "B12"); the first word may not start with one
  const m = line.match(/^([A-Za-z][A-Za-z0-9\-']*(?: [A-Za-z0-9][A-Za-z0-9\-']*){0,3}?)\s*(?:\((.*?)\))?\s+(\d+(?:[.,]\d+)?)\s*(mg|mcg|µg|μg|ug|g|ml|iu|units?|meq|%)\b(.*)$/i);
  const noStrength = line.match(/^([A-Z][A-Za-z\-']{3,30})\b(.*)$/);
  let name, strength = null, unit = null, tail, paren = null;
  if (m) {
    name = m[1]; paren = m[2] || null; strength = num(m[3]);
    const u = m[4].toLowerCase();
    unit = UNIT_NAMES[u] || u;
    tail = `${m[2] || ""} ${m[5]}`;
  } else if (noStrength && FREQ.some(([re]) => re.test(noStrength[2]))) { name = noStrength[1]; tail = noStrength[2]; }
  else return null;
  if (/^(take|the|patient|follow|see|call|no|none|continue|stop|start)$/i.test(name.split(" ")[0])) return null;
  if (!inList && !isKnownDrug(name, paren)) return null;
  const freq = (FREQ.find(([re]) => re.test(tail)) || [])[1];
  const form = (FORMS.find(([, re]) => re.test(tail)) || [])[0];
  const route = (ROUTES.find(([, re]) => re.test(tail)) || [])[0];
  const supplement = opts.section === "supplements" || isSupplement(name, paren);
  const fields = { medication_name: name.trim(), strength, strength_unit: unit, dosage_form: form || null, route: route || null,
    frequency: freq || "other", instructions: clean(tail).slice(0, 300) || null,
    medication_type: supplement ? "non_prescription" : "prescription",
    brand_name: paren && !/\d/.test(paren) && paren.length <= 60 ? paren.trim() : null };
  const warnings = ["Dose amount, schedule and pill count were not read; please check them after saving"];
  if (!freq) warnings.push("No frequency found");
  if (!inList) warnings.push("Found outside a medication list; check that this is a medicine you take");
  const sure = strength && freq && inList;
  return proposal("medication", `${fields.medication_name}${strength ? ` ${strength} ${unit}` : ""}${supplement ? " (supplement)" : ""}`, fields, raw, sure ? "high" : "medium", warnings);
}

function conditionFromLine(raw) {
  let line = bullet(raw);
  if (line.length < 3 || line.length > 200 || /^(none|n\/a|no (acute )?(diagnos|problem)|see (above|below))/i.test(line)) return null;
  const icd = line.match(/\b([A-TV-Z]\d{2}(?:\.\d{1,4})?)\b/);
  line = clean(line.replace(/\(?\b[A-TV-Z]\d{2}(?:\.\d{1,4})?\b\)?/g, "").replace(/[-–:,;]\s*$/, "").replace(/^[-–:,;]\s*/, ""));
  if (line.length < 3 || /^(the|patient|follow|continue|return|discuss)\b/i.test(line)) return null;
  const resolved = /\b(resolved|history of)\b/i.test(raw);
  return proposal("condition", line.slice(0, 120), { condition_name: line.slice(0, 255), icd10_code: icd ? icd[1] : null, status: resolved ? "inactive" : "active" },
    raw, icd ? "high" : "medium");
}

const NO_ALLERGY = /\b(nkda|nka|no known( drug)? allerg\w*|no allerg\w*|none)\b/i;
function allergiesFromLines(lines) {
  const out = [];
  for (const raw of lines) {
    const line = bullet(raw);
    if (!line) continue;
    if (NO_ALLERGY.test(line)) { out.push(proposal("allergy", "No known allergies", { no_known_allergies: true }, raw, "high")); continue; }
    for (const part of line.split(/[;,](?![^()]*\))/)) {
      const [allergen, ...rest] = part.split(/\s+[-–:]\s+|\s*\(|\)\s*/).map(clean).filter(Boolean);
      if (!allergen || allergen.length > 100 || allergen.length < 3 || /^(reaction|allergen|severity)s?$/i.test(allergen)) continue;
      out.push(proposal("allergy", allergen, { allergen, reaction: rest.join("; ").slice(0, 300) || null }, raw, rest.length ? "high" : "medium"));
    }
  }
  return out;
}

function vitalsFromText(lines, fallbackWhen) {
  const out = [];
  const text = lines.join("\n");
  const push = (label, fields, src, conf = "high", warnings = []) => out.push(proposal("vital", label, { measured_at: fallbackWhen, ...fields }, src, conf, warnings));
  let m;
  if ((m = text.match(/(?:\bBP\b|blood pressure)\D{0,8}(\d{2,3})\s*\/\s*(\d{2,3})/i))) push(`Blood pressure ${m[1]}/${m[2]}`, { vital_type: "blood_pressure", value_numeric: +m[1], value_secondary: +m[2] }, m[0]);
  if ((m = text.match(/(?:heart rate|pulse|\bHR\b)\D{0,8}(\d{2,3})(?!\d)/i))) push(`Heart rate ${m[1]}`, { vital_type: "heart_rate", value_numeric: +m[1] }, m[0]);
  if ((m = text.match(/(?:spo2|o2 sat\w*|oxygen sat\w*)\D{0,8}(\d{2,3})\s*%?/i))) push(`Oxygen saturation ${m[1]}%`, { vital_type: "oxygen_saturation", value_numeric: +m[1] }, m[0]);
  if ((m = text.match(/(?:resp\w* rate|\bRR\b)\D{0,8}(\d{1,2})(?!\d)/i))) push(`Respiratory rate ${m[1]}`, { vital_type: "respiratory_rate", value_numeric: +m[1] }, m[0]);
  if ((m = text.match(/\btemp\w*\D{0,8}(\d{2,3}(?:\.\d)?)\s*°?\s*([CF])?\b/i))) {
    let v = +m[1];
    const celsius = (m[2] || "").toUpperCase() === "C" || (!m[2] && v < 50);
    if (celsius) v = Math.round((v * 9 / 5 + 32) * 10) / 10;
    push(`Temperature ${v}°F`, { vital_type: "temperature", value_numeric: v }, m[0], m[2] ? "high" : "medium", m[2] ? [] : ["No unit found"]);
  }
  if ((m = text.match(/\bweight\D{0,8}(\d{2,3}(?:\.\d)?)\s*(lbs?|pounds?|kg)\b/i))) {
    const unit = /kg/i.test(m[2]) ? "kg" : "lb";
    push(`Weight ${m[1]} ${unit}`, { vital_type: "weight", value_numeric: +m[1], unit }, m[0]);
  }
  return out;
}

// all proposals for the text of one PDF
function proposalsFromText(text, fileName) {
  seq = 0;
  const lines = linesOf(text);
  const sections = sectionLines(lines);
  const meta = documentDetails(lines, fileName, 0);
  const fallbackDate = meta.date || new Date().toISOString().slice(0, 10);
  const items = [];

  // Each line is decided ONCE, using the heading it sits under: medicine headings give medicines, allergy/condition headings are
  // handled below, anything else may be a lab result, or a medicine we recognise by name (Task 8-2: "Vitamin D3 2000 IU" is a medicine).
  const seen = new Set();
  for (const { line, section } of taggedLines(lines)) {
    if (section === "medications" || section === "supplements") { const p = medFromLine(line, { section }); if (p) items.push(p); continue; }
    if (section === "allergies" || section === "conditions") continue;
    const lab = labFromLine(line, fallbackDate, section);
    if (lab) { if (!seen.has(lab.fields.test_code)) { seen.add(lab.fields.test_code); items.push(lab); } continue; }
    if (section === "none" || section === "other") { const p = medFromLine(line, { section }); if (p) items.push(p); }
  }
  for (const raw of sections.conditions) { const p = conditionFromLine(raw); if (p) items.push(p); }
  items.push(...allergiesFromLines(sections.allergies));
  const when = new Date(`${fallbackDate}T12:00:00.000Z`);
  items.push(...vitalsFromText(lines, (when.getTime() > Date.now() ? new Date() : when).toISOString()));

  const doc = documentDetails(lines, fileName, items.filter((i) => i.section === "lab_result").length);
  const docProposal = proposal("document", `Keep this PDF in my documents as "${doc.title}"`,
    { title: doc.title, category: doc.category, provider: doc.provider, document_date: doc.date, notes: null }, doc.title, "high");
  return [docProposal, ...items].slice(0, MAX_PROPOSALS);
}

// ---------- duplicates (Task 8-2) ----------
// Every proposal is compared with what the patient already has. The comparison only WARNS and stops an exact repeat: it never hides
// anything. A different dose of the same medicine ("dose_change") is always shown, because it may be a real change.
//   level: exact | dose_change | possible | conflict | previously_stopped | in_file       existing: the record it matched
const CURRENT_MED = ["active", "paused"];
const CURRENT_CONDITION = ["active", "managed", "in_remission"];
const norm = (v) => clean(v).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const sameNumber = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 1e-6;
const strengthText = (v, u) => (v !== null && v !== undefined && v !== "" ? `${v}${u ? ` ${u}` : ""}` : "no strength recorded");
const dupe = (level, existing, message) => ({ level, existing, message });

async function medicationDuplicate(f, user) {
  const cand = { name: f.medication_name, brand: f.brand_name, strength: f.strength, unit: f.strength_unit };
  let best = null, stopped = null;
  const rank = { exact: 0, dose_change: 1, possible: 2 };
  for (const m of await findAll("Medication", { user_id: user.user_id })) {
    const have = { name: m.get("medication_name"), brand: m.get("brand_name"), strength: m.get("strength"), unit: m.get("strength_unit") };
    const cmp = compareMedicines(cand, have);
    if (cmp.level === "none") continue;
    const existing = { id: m.id, label: have.name, strength: have.strength ?? null, strength_unit: have.unit ?? null, status: m.get("status"), end_date: m.get("end_date") ?? null };
    if (!CURRENT_MED.includes(m.get("status"))) { stopped = stopped || { cmp, existing }; continue; }
    if (!best || rank[cmp.level] < rank[best.cmp.level]) best = { cmp, existing };
  }
  if (best) {
    const { cmp, existing } = best, now = strengthText(f.strength, f.strength_unit), had = strengthText(existing.strength, existing.strength_unit);
    if (cmp.level === "exact") return dupe("exact", existing, `Already in your medicines: ${existing.label} (${had}).`);
    if (cmp.level === "dose_change") return { ...dupe("dose_change", existing, `You already have ${existing.label} at ${had}. This PDF says ${now}. That could be a dose change.`), can_update: true };
    const why = cmp.reason === "combination" ? "a medicine with some of the same ingredients" : "the same medicine, but the strength is missing or in a different unit";
    return { ...dupe("possible", existing, `Possible match with ${existing.label} (${had}): ${why}.`), can_update: cmp.reason !== "combination" && f.strength !== null && f.strength !== undefined };
  }
  if (stopped) return dupe("previously_stopped", stopped.existing, `You stopped ${stopped.existing.label}${stopped.existing.end_date ? ` on ${stopped.existing.end_date}` : ""}. Saving this adds it again as a new entry.`);
  return null;
}

async function labDuplicate(f, user) {
  const day = blank(f.collected_date);
  if (!day) return null;
  const code = blank(f.test_code), name = norm(f.test_name);
  const value = Number(f.value);
  for (const r of await findAll("LabResult", { user_id: user.user_id })) {
    if (r.get("collected_date") !== day) continue;
    if (!((code && r.get("test_code") === code) || (name && norm(r.get("test_name")) === name))) continue;
    const existing = { id: r.id, label: r.get("test_name"), value: r.get("value_numeric") ?? r.get("value_text") ?? null, unit: r.get("unit") ?? null };
    if (sameNumber(value, r.get("value_numeric"))) return dupe("exact", existing, `Already saved: ${existing.label} ${existing.value} ${existing.unit || ""} on ${day}.`);
    return dupe("conflict", existing, `You already have a different ${existing.label} result for ${day} (${existing.value} ${existing.unit || ""}). Check which one is right.`);
  }
  return null;
}

async function conditionDuplicate(f, user) {
  const name = norm(f.condition_name), icd = blank(f.icd10_code) ? String(f.icd10_code).trim().toUpperCase() : null;
  let found = null;
  for (const c of await findAll("Condition", { user_id: user.user_id })) {
    const other = norm(c.get("condition_name"));
    const existing = { id: c.id, label: c.get("condition_name"), status: c.get("status") };
    let level = null;
    if ((icd && String(c.get("icd10_code") || "").toUpperCase() === icd) || (name && name === other)) level = "exact";
    else if (name && other && Math.min(name.length, other.length) >= 5 && (` ${other} `.includes(` ${name} `) || ` ${name} `.includes(` ${other} `))) level = "possible";
    if (!level) continue;
    if (!CURRENT_CONDITION.includes(c.get("status"))) { found = found || dupe("previously_stopped", existing, `You have ${existing.label} marked ${existing.status}. Saving this adds it again.`); continue; }
    if (level === "exact") return dupe("exact", existing, `Already in your conditions: ${existing.label}.`);
    found = dupe("possible", existing, `Possible match with ${existing.label}.`);
  }
  return found;
}

async function vitalDuplicate(f, user) {
  const day = String(f.measured_at || "").slice(0, 10);
  if (!day || !f.vital_type) return null;
  for (const v of await findAll("VitalReading", { user_id: user.user_id, vital_type: f.vital_type })) {
    if (!v.get("measured_at") || v.get("measured_at").toISOString().slice(0, 10) !== day) continue;
    const existing = { id: v.id, label: f.vital_type.replace(/_/g, " "), value: v.get("value_numeric"), value_secondary: v.get("value_secondary") ?? null };
    const same = sameNumber(Number(f.value_numeric), v.get("value_numeric")) && (f.value_secondary == null || sameNumber(Number(f.value_secondary), v.get("value_secondary")));
    const shown = `${existing.value}${existing.value_secondary ? `/${existing.value_secondary}` : ""}`;
    return same ? dupe("exact", existing, `Already saved: ${existing.label} ${shown} on ${day}.`)
      : dupe("conflict", existing, `You already have a different ${existing.label} reading for ${day} (${shown}).`);
  }
  return null;
}

async function allergyDuplicate(f, user) {
  if (f.no_known_allergies) return null;
  const rec = await records.getRecord(user);
  const have = (rec.data && Array.isArray(rec.data.allergies) ? rec.data.allergies : []).find((a) => a && norm(a.allergen) === norm(f.allergen));
  return have ? dupe("exact", { label: have.allergen }, `Already in your allergies: ${have.allergen}.`) : null;
}

// one place that answers "does the patient already have this?" for any kind of proposal
async function findDuplicate(section, f, user) {
  try {
    if (section === "medication") return await medicationDuplicate(f, user);
    if (section === "lab_result") return await labDuplicate(f, user);
    if (section === "condition") return await conditionDuplicate(f, user);
    if (section === "vital") return await vitalDuplicate(f, user);
    if (section === "allergy") return await allergyDuplicate(f, user);
  } catch (err) { console.error("duplicate check failed:", section, err && err.message ? err.message : "error"); }
  return null;   // a failed check never blocks saving; the patient still reviews everything
}

// marks each proposal with .duplicate; a medicine listed twice in the same PDF is marked on the second one
async function markDuplicates(proposals, user, fileSha) {
  const meds = [];
  for (const p of proposals) {
    if (p.section === "document") {
      const saved = (await findAll("HealthDocument", { user_id: user.user_id }, { select: ["title", "file_sha256"] })).find((d) => d.get("file_sha256") === fileSha);
      if (saved) p.duplicate = dupe("exact", { label: saved.get("title") }, `This PDF is already in your documents as "${saved.get("title")}".`);
      continue;
    }
    let d = await findDuplicate(p.section, p.fields, user);
    if (p.section === "medication") {
      if (!d || d.level === "previously_stopped") {
        const twin = meds.find((m) => {
          const c = compareMedicines({ name: p.fields.medication_name, brand: p.fields.brand_name, strength: p.fields.strength, unit: p.fields.strength_unit },
            { name: m.fields.medication_name, brand: m.fields.brand_name, strength: m.fields.strength, unit: m.fields.strength_unit });
          return c.level === "exact" || c.level === "dose_change";
        });
        if (twin) d = dupe("in_file", { label: twin.fields.medication_name }, `Also listed as "${twin.label}" in this PDF.`);
      }
      meds.push(p);
    }
    if (d) p.duplicate = d;
  }
  return proposals;
}

// ---------- the draft ----------
const viewOf = (draft) => ({
  draft_id: draft.id, draft_status: draft.get("status"), file_name: draft.get("file_name"), expires_at: draft.get("expires_at").toISOString(),
  requires_confirmation: true, proposals: draft.get("proposals") || [],
  message: "Nothing has been saved yet. Review each item, fix anything that's wrong, and confirm the ones you want.",
});
const live = (d) => d && d.get("status") === "pending" && d.get("expires_at") > new Date();

async function purgeOldDrafts(userId) {
  const all = await findAll("AutofillDraft", { user_id: userId });
  const stale = all.filter((d) => !live(d));
  await destroyAll(stale);
  return all.filter(live).sort((a, b) => a.createdAt - b.createdAt);
}

// POST /documents/autofill
async function extract(body, user, ctx) {
  if (sec.keyIsInvalid()) return fail(503, sec.KEY_INVALID);
  const b64 = typeof body.file_base64 === "string" ? body.file_base64.replace(/\s+/g, "") : "";
  if (!b64) return fail(400, "Choose a PDF file to auto-fill from");
  if (b64.length > MAX_B64) return fail(413, "That file is too large (8 MB max)");
  const file = Buffer.from(b64, "base64");
  if (!file.length) return fail(400, "Choose a PDF file to auto-fill from");
  if (file.length > MAX_FILE_BYTES) return fail(413, "That file is too large (8 MB max)");
  const kind = documents.kindOf(file);
  if (!kind || kind.ext !== "pdf") return fail(400, "Auto-fill reads PDF files only. Other files can still be uploaded as documents.");

  let text;
  try { text = await extractor(file); }
  catch { return fail(422, "That PDF couldn't be read. It may be damaged or password-protected."); }
  text = String(text || "").slice(0, MAX_TEXT_CHARS);
  if (clean(text).length < MIN_TEXT_CHARS) {
    return fail(422, "This PDF has no readable text (it may be a scan or photo). Please enter the information yourself.");
  }

  const sha256 = crypto.createHash("sha256").update(file).digest("hex");
  // compared with what the patient already has (Task 8-2): each proposal carries .duplicate when it matches something
  const proposals = await markDuplicates(proposalsFromText(text, typeof body.file_name === "string" ? body.file_name : ""), user, sha256);
  const pending = await purgeOldDrafts(user.user_id);
  if (pending.length >= MAX_PENDING_DRAFTS) await destroyAll(pending.slice(0, pending.length - MAX_PENDING_DRAFTS + 1));

  const key = sec.fileKey();
  const draft = await create("AutofillDraft", {
    user_id: user.user_id, status: "pending", file_name: documents.fileNameFor(body.file_name, "pdf"), file_sha256: sha256,
    file_size: file.length, file_data: (key ? sec.encrypt(key, file) : file).toString("base64"), is_encrypted: !!key,
    proposals, expires_at: new Date(Date.now() + DRAFT_TTL_MS),
  });
  const saved = (await findAll("HealthDocument", { user_id: user.user_id }, { select: ["title", "file_sha256"] })).find((d) => d.get("file_sha256") === sha256);
  await audit({ userId: user.user_id, event: "AUTOFILL_EXTRACT", targetClass: "AutofillDraft", targetId: draft.id, newData: { proposals: proposals.length }, ip: ctx.ip });
  return { status: 201, ...viewOf(draft), ...(saved ? { already_saved_as: saved.get("title") } : {}) };
}

async function ownDraft(id, user) {
  if (!isId(id)) return null;
  const d = await getOwned("AutofillDraft", id, user.user_id);
  return live(d) ? d : null;
}

// GET /documents/autofill/:id
async function getDraft(id, user) {
  const d = await ownDraft(id, user);
  return d ? { status: 200, ...viewOf(d) } : fail(404, "That auto-fill review has expired or was cancelled. Upload the PDF again.");
}

// DELETE /documents/autofill/:id
async function cancel(id, user, ctx) {
  const d = isId(id) ? await getOwned("AutofillDraft", id, user.user_id) : null;
  if (!d) return fail(404, "That auto-fill review wasn't found");
  await destroy(d);
  await audit({ userId: user.user_id, event: "AUTOFILL_CANCEL", targetClass: "AutofillDraft", targetId: id, ip: ctx.ip });
  return { status: 200, message: "Auto-fill cancelled. Nothing was saved." };
}

// only the editable fields the patient may change; an unknown one is ignored
function applyEdits(p, edits) {
  const fields = { ...p.fields };
  if (edits && typeof edits === "object" && !Array.isArray(edits)) {
    for (const k of EDITABLE[p.section]) if (Object.prototype.hasOwnProperty.call(edits, k)) fields[k] = edits[k];
  }
  return fields;
}
const blank = (v) => (v === "" || v === undefined ? null : v);

// turns one confirmed proposal into a real save; returns the result of the existing create function
async function save1(p, f, user, ctx, draft, state) {
  switch (p.section) {
    case "lab_result": {
      const body = { test_code: blank(f.test_code), test_name: blank(f.test_name), value: f.value, unit: blank(f.unit),
        collected_date: blank(f.collected_date), source: "document_upload" };
      if (blank(f.ref_low) !== null) body.ref_low = f.ref_low;
      if (blank(f.ref_high) !== null) body.ref_high = f.ref_high;
      Object.keys(body).forEach((k) => body[k] === null && delete body[k]);
      return labs.createResults(body, user);
    }
    case "medication": {
      const body = { medication_name: f.medication_name, status: "active", source: "document_upload", frequency: blank(f.frequency) || "other",
        dose_amount: 1, dose_unit: "dose", quantity_on_hand: 0,
        notes: "Added from an uploaded PDF. Dose, schedule and pill count were not read; please edit them." };
      for (const k of ["strength", "strength_unit", "dosage_form", "route", "instructions", "purpose", "start_date", "medication_type", "brand_name"]) if (blank(f[k]) !== null) body[k] = f[k];
      state.medsChanged = true;
      return medications.create(body, user);
    }
    case "condition": {
      const body = { condition_name: f.condition_name, status: blank(f.status) || "active", source: "document_upload", notes: "Added from an uploaded PDF" };
      if (blank(f.icd10_code) !== null) body.icd10_code = f.icd10_code;
      if (blank(f.onset_date) !== null) body.onset_date = f.onset_date;
      return conditions.create(body, user);
    }
    case "allergy":
      state.allergies.push(f);
      return { status: 200, deferred: true };
    case "vital": {
      const body = { vital_type: f.vital_type, value_numeric: f.value_numeric, source: "document_upload" };
      for (const k of ["value_secondary", "unit", "measured_at"]) if (blank(f[k]) !== null) body[k] = f[k];
      return vitals.create(body, user);
    }
    case "document": {
      const body = { file_base64: await draftFileBase64(draft), file_name: draft.get("file_name"), title: f.title, category: blank(f.category) || "other",
        provider: blank(f.provider), document_date: blank(f.document_date), notes: blank(f.notes) };
      return documents.upload(body, user, ctx);
    }
    default:
      return fail(400, "Unknown item type");
  }
}

async function draftFileBase64(draft) {
  let file = Buffer.from(draft.get("file_data") || "", "base64");
  if (draft.get("is_encrypted")) file = sec.decrypt(sec.fileKey(), file);
  return file.toString("base64");
}

// the allergy list lives in the Health History form: same save as the form, so medication safety checks stay in step
async function saveAllergies(list, user, ctx) {
  const rec = await records.getRecord(user);
  const data = rec.data && typeof rec.data === "object" ? { ...rec.data } : {};
  const have = new Set((Array.isArray(data.allergies) ? data.allergies : []).map((a) => clean(a && a.allergen).toLowerCase()));
  const next = Array.isArray(data.allergies) ? [...data.allergies] : [];
  let added = 0, skipped = 0, noKnown = false;
  for (const f of list) {
    if (f.no_known_allergies) { noKnown = true; continue; }
    const name = clean(f.allergen);
    if (!name || name.length > 200) { skipped++; continue; }
    if (have.has(name.toLowerCase())) { skipped++; continue; }
    next.push({ allergen: name, reaction: clean(f.reaction).slice(0, 500) });
    have.add(name.toLowerCase()); added++;
  }
  // "no known allergies" only counts if the form has no allergy on it
  const setNoKnown = noKnown && !next.some((a) => clean(a && a.allergen));
  if (!added && !setNoKnown) return { added: 0, skipped: skipped + (noKnown ? 1 : 0), failed: 0 };
  const res = await records.putRecord({ data: { ...data, allergies: next, no_known_allergies: setNoKnown } }, user, ctx,
    { afterRecordSaved: (uid, d) => safety.syncAllergiesFromRecord(uid, d) });
  return res.status >= 400 ? { added: 0, skipped, failed: added || 1, error: res.error } : { added: added + (setNoKnown ? 1 : 0), skipped, failed: 0 };
}

// POST /documents/autofill/:id/confirm {confirmed: true, items: [{proposal_id, accept, fields?}]}
async function confirm(id, body, user, ctx) {
  const draft = await ownDraft(id, user);
  if (!draft) return fail(404, "That auto-fill review has expired or was cancelled. Upload the PDF again.");
  if (!body || body.confirmed !== true) return fail(400, "Please confirm that you have reviewed the items (confirmed: true). Nothing was saved.");
  if (!Array.isArray(body.items) || !body.items.length) return fail(400, "Choose at least one item to save. Nothing was saved.");

  const byId = new Map((draft.get("proposals") || []).map((p) => [p.proposal_id, p]));
  const picked = [], seen = new Set();
  for (const it of body.items) {
    if (!it || typeof it !== "object" || typeof it.proposal_id !== "string" || !byId.has(it.proposal_id)) return fail(400, "One of the items isn't part of this review. Nothing was saved.");
    if (seen.has(it.proposal_id)) return fail(400, "An item was listed twice. Nothing was saved.");
    seen.add(it.proposal_id);
    if (it.accept === true) picked.push(it);
    else if (it.accept !== false) return fail(400, "Every item needs accept: true or accept: false. Nothing was saved.");
  }
  if (!picked.length) return fail(400, "You didn't accept any items. Nothing was saved.");
  if (picked.some((it) => byId.get(it.proposal_id).section === "document") && sec.keyIsInvalid()) return fail(503, sec.KEY_INVALID);

  const results = [], counts = {};
  const state = { allergies: [], medsChanged: false };
  const allergyItems = [];
  // documents last: the file is the least important part and may be a duplicate
  const order = (it) => (byId.get(it.proposal_id).section === "document" ? 1 : 0);
  for (const it of [...picked].sort((a, b) => order(a) - order(b))) {
    const p = byId.get(it.proposal_id);
    const fields = applyEdits(p, it.fields);
    counts[p.section] = counts[p.section] || { saved: 0, failed: 0, duplicate: 0, updated: 0 };
    // Duplicates are checked again NOW, against what is saved at this moment (the first item of this very request may have just
    // created the match), using the patient's corrected values. Allergies and documents have their own duplicate checks below.
    const dup = p.section === "allergy" || p.section === "document" ? null : await findDuplicate(p.section, fields, user);
    const stop = (error, isDuplicate = true) => {
      counts[p.section][isDuplicate ? "duplicate" : "failed"]++;
      results.push({ proposal_id: p.proposal_id, section: p.section, label: p.label, saved: false, error, duplicate: dup || null });
    };
    if (dup && dup.level === "exact" && it.allow_duplicate !== true) { stop(`${dup.message} Not saved again. If you really want a second copy, choose "save anyway".`); continue; }
    if (p.section === "medication" && it.action !== undefined && it.action !== "add" && it.action !== "update") { stop('action must be "add" or "update"', false); continue; }
    if (p.section === "medication" && it.action === "update") {
      // a changed dose: update the medicine the patient already has, instead of adding a second one
      if (!dup || !dup.can_update || !dup.existing || !dup.existing.id) { stop("There is no existing medicine to update for this item. Use add instead.", false); continue; }
      const res = await medications.update(dup.existing.id, { strength: fields.strength, strength_unit: fields.strength_unit }, user);
      state.medsChanged = true;
      if (res.status >= 400) counts[p.section].failed++; else counts[p.section].updated++;
      results.push({ proposal_id: p.proposal_id, section: p.section, label: p.label, saved: res.status < 400, updated: res.status < 400,
        ...(res.status >= 400 ? { error: res.error || "Not saved" } : { message: `Updated ${dup.existing.label} to ${strengthText(fields.strength, fields.strength_unit)}` }) });
      continue;
    }
    // a different dose of a medicine already on the list needs a deliberate choice: update it, or add this as a separate medicine
    if (p.section === "medication" && dup && dup.level === "dose_change" && it.action !== "add") {
      stop(`${dup.message} Choose "update my existing medicine" or "add as a separate medicine".`, false); continue;
    }
    let res;
    try { res = await save1(p, fields, user, ctx, draft, state); }
    catch (err) { res = fail(500, "Not saved"); console.error("autofill save failed:", p.section, err && err.message ? err.message : "error"); }
    if (res.deferred) { allergyItems.push({ p, fields }); continue; }
    const isDup = res.status === 409;
    if (res.status >= 400) counts[p.section][isDup ? "duplicate" : "failed"]++; else counts[p.section].saved++;
    results.push({ proposal_id: p.proposal_id, section: p.section, label: p.label, saved: res.status < 400,
      ...(dup && res.status < 400 ? { duplicate: dup } : {}), ...(res.status >= 400 ? { error: res.error || "Not saved" } : {}) });
  }
  if (allergyItems.length) {
    const r = await saveAllergies(allergyItems.map((a) => a.fields), user, ctx);
    counts.allergy = { saved: r.added, failed: r.failed, duplicate: r.skipped };
    for (const a of allergyItems) results.push({ proposal_id: a.p.proposal_id, section: "allergy", label: a.p.label, saved: !r.failed, ...(r.failed ? { error: r.error || "Not saved" } : {}) });
  }

  // new medicines and allergies skip the "check before adding" step, so re-check everything now
  let safetyInfo = null;
  if (state.medsChanged || counts.allergy) {
    try {
      const a = await safety.getAlerts(user);
      if (a.status === 200) safetyInfo = { open_count: a.open_count, major_open_count: a.major_open_count };
    } catch { /* the warnings page will still show them */ }
  }

  // the draft (with its copy of the file and everything read from it) is erased once confirmed
  await destroy(draft);
  await audit({ userId: user.user_id, event: "AUTOFILL_CONFIRM", targetClass: "AutofillDraft", targetId: id, newData: { counts, rejected: byId.size - picked.length }, ip: ctx.ip });
  const failed = results.filter((r) => !r.saved).length;
  return { status: 200, message: failed ? `Saved ${results.length - failed} of ${results.length} items` : "Saved the items you confirmed",
    results, counts, safety: safetyInfo };
}

// removes drafts past their time (also called by the reminders job, if wired)
async function purgeExpired() {
  const rows = (await findAll("AutofillDraft", {})).filter((d) => !live(d));
  await destroyAll(rows);
  return rows.length;
}

module.exports = { extract, getDraft, cancel, confirm, purgeExpired, setExtractor, proposalsFromText, toIsoDate, EDITABLE, SECTIONS, DRAFT_TTL_MS };
