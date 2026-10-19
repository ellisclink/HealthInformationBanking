// previsit.js — Pre-visit summary (Task 7-3): one page a patient can bring to (or send ahead of) an appointment.
//
//   GET  /previsit/appointments?limit=      upcoming appointments to pick from
//   POST /previsit/summary                  {event_id?, reason?, questions?, concerns?, days?, sections?}
//
// It only READS the patient's own data (nothing is written except an audit entry) and returns the summary
// twice: as sections (for the screen) and as plain `text` (for printing, copying or pasting into a portal).
// Nothing here is advice; it lists what the patient has recorded and flags what may be worth raising.

const conditions = require("./conditions");
const medications = require("./medications");
const vitals = require("./vitals");
const labs = require("./labs");
const safety = require("./safety");
const diary = require("./diary");
const calendar = require("./calendar");
const records = require("./records");
const { isId, findAll, audit, fail, param } = require("./db");

const SECTION_NAMES = ["conditions", "medications", "allergies", "safety_alerts", "vitals", "labs", "diary", "devices"];
const DEFAULT_DAYS = 90;
const MIN_DAYS = 7, MAX_DAYS = 365;
const ADHERENCE_DAYS = 30;
const MAX_QUESTIONS = 20, MAX_TEXT = 500;
const DIARY_SHOWN = 15;
const DAY_MS = 86400000;
const VISIT_CATEGORIES = ["appointment", "procedure", "lab"];

const day = (d) => (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);
const textOf = (v, max, label) => {
  if (v === undefined || v === null || v === "") return { value: null };
  if (typeof v !== "string") return { error: `${label} must be text` };
  const s = v.trim();
  return s.length > max ? { error: `${label} must be ${max} characters or fewer` } : { value: s || null };
};

// GET /previsit/appointments
async function appointments(query, user) {
  const limit = Math.min(Math.max(parseInt(param(query, "limit") || "10", 10) || 10, 1), 50);
  const res = await calendar.upcoming({ limit: "50" }, user);
  if (res.status !== 200) return res;
  const rows = res.events.filter((e) => VISIT_CATEGORIES.includes(e.category)).slice(0, limit)
    .map((e) => ({ event_id: e.event_id, title: e.title, category: e.category, start_time: e.start_time, location: e.location ?? null, provider_name: e.provider_name ?? null }));
  return { status: 200, appointments: rows, count: rows.length };
}

// how well each active medicine was taken over the last 30 days, from the dose log
async function adherence(userId, activeMeds) {
  const since = new Date(Date.now() - ADHERENCE_DAYS * DAY_MS);
  const logs = (await findAll("DoseLog", { user_id: userId })).filter((l) => l.get("taken_at") && l.get("taken_at") >= since);
  const by = new Map();
  for (const l of logs) {
    const e = by.get(l.get("medication_id")) || { taken: 0, skipped: 0, missed: 0 };
    const s = l.get("dose_status");
    if (e[s] !== undefined) e[s] += 1;
    by.set(l.get("medication_id"), e);
  }
  return new Map(activeMeds.map((m) => {
    const e = by.get(m.medication_id) || { taken: 0, skipped: 0, missed: 0 };
    const logged = e.taken + e.skipped + e.missed;
    return [m.medication_id, { ...e, days: ADHERENCE_DAYS, percent_taken: logged ? Math.round((e.taken / logged) * 100) : null }];
  }));
}

function selectedSections(body) {
  if (body.sections === undefined) return { list: SECTION_NAMES };
  if (!Array.isArray(body.sections) || !body.sections.length || !body.sections.every((s) => SECTION_NAMES.includes(s))) {
    return { error: `sections must be a non-empty list from: ${SECTION_NAMES.join(", ")}` };
  }
  return { list: SECTION_NAMES.filter((s) => body.sections.includes(s)) };
}

// POST /previsit/summary
async function summary(body, user, ctx) {
  body = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  let days = DEFAULT_DAYS;
  if (body.days !== undefined) {
    days = Number(body.days);
    if (!Number.isInteger(days) || days < MIN_DAYS || days > MAX_DAYS) return fail(400, `days must be a whole number from ${MIN_DAYS} to ${MAX_DAYS}`);
  }
  const reason = textOf(body.reason, MAX_TEXT, "Reason for the visit"), concerns = textOf(body.concerns, 1000, "Concerns");
  if (reason.error || concerns.error) return fail(400, reason.error || concerns.error);
  let questions = [];
  if (body.questions !== undefined) {
    if (!Array.isArray(body.questions) || body.questions.length > MAX_QUESTIONS) return fail(400, `questions must be a list of at most ${MAX_QUESTIONS}`);
    for (const q of body.questions) {
      const t = textOf(q, MAX_TEXT, "A question");
      if (t.error) return fail(400, t.error);
      if (t.value) questions.push(t.value);
    }
  }
  const sel = selectedSections(body);
  if (sel.error) return fail(400, sel.error);
  const want = (s) => sel.list.includes(s);

  let visit = null;
  if (body.event_id !== undefined && body.event_id !== null && body.event_id !== "") {
    if (!isId(String(body.event_id))) return fail(400, "Invalid event ID");
    const ev = await calendar.getById(String(body.event_id), user);
    if (ev.status !== 200) return ev;
    const e = ev.event;
    visit = { event_id: e.event_id, title: e.title, start_time: e.start_time, location: e.location, provider_name: e.provider_name, category: e.category };
  }

  const sinceDate = day(new Date(Date.now() - days * DAY_MS));
  const out = { generated_at: new Date().toISOString(), period: { days, from: sinceDate, to: day(new Date()) }, visit,
    reason: reason.value, concerns: concerns.value, questions };

  // who
  const rec = await records.getRecord(user);
  const p = (rec.data && rec.data.patient) || {};
  out.patient = { name: user.user_name, date_of_birth: p.dob || null, sex: p.sex || null };

  const flags = [];   // "worth raising" — facts from the data, never diagnoses

  if (want("conditions")) {
    const c = await conditions.summary(user);
    out.conditions = (c.active_conditions || []).map((x) => ({ condition_name: x.condition_name, status: x.status, severity: x.severity,
      onset_date: x.onset_date, managing_provider: x.managing_provider }));
  }

  if (want("medications")) {
    const list = (await medications.list({ status: "active" }, user)).medications || [];
    const adh = await adherence(user.user_id, list);
    out.medications = list.map((m) => ({
      medication_name: m.medication_name, medication_type: m.medication_type, strength: m.strength, strength_unit: m.strength_unit,
      dose_amount: m.dose_amount, dose_unit: m.dose_unit, frequency: m.frequency, purpose: m.purpose, prescriber_name: m.prescriber_name,
      start_date: m.start_date, low_stock: !!m.low_stock, days_supply: m.days_supply, adherence: adh.get(m.medication_id),
    }));
    for (const m of out.medications) {
      if (m.adherence.percent_taken !== null && m.adherence.percent_taken < 80) flags.push(`${m.medication_name}: ${m.adherence.percent_taken}% of logged doses taken in the last ${ADHERENCE_DAYS} days`);
      if (m.low_stock) flags.push(`${m.medication_name}: running low (refill needed)`);
    }
    // changes inside the period: started, or stopped
    const all = (await medications.list({}, user)).medications || [];
    out.medication_changes = {
      started: all.filter((m) => m.status === "active" && m.start_date && m.start_date >= sinceDate).map((m) => ({ medication_name: m.medication_name, start_date: m.start_date })),
      stopped: all.filter((m) => ["discontinued", "completed"].includes(m.status) && m.end_date && m.end_date >= sinceDate)
        .map((m) => ({ medication_name: m.medication_name, end_date: m.end_date, reason: m.discontinued_reason })),
    };
    for (const m of out.medication_changes.started) flags.push(`New medicine since ${sinceDate}: ${m.medication_name}`);
  }

  if (want("allergies")) {
    const a = await safety.getAllergies(user);
    out.allergies = (a.allergies || []).map((x) => ({ allergen: x.allergen, reaction: x.reaction, severity: x.severity }));
    out.no_known_allergies = !out.allergies.length && !!(rec.data && rec.data.no_known_allergies);
  }

  if (want("safety_alerts")) {
    const a = await safety.getAlerts(user);
    out.safety_alerts = (a.alerts || []).filter((x) => !x.acknowledged_at).map((x) => ({ severity: x.severity, title: x.title, message: x.message }));
    for (const x of out.safety_alerts) if (x.severity === "major") flags.push(`Medication warning: ${x.title}`);
  }

  if (want("vitals")) {
    const v = await vitals.summary(user);
    out.vitals = (v.summary || []).map((x) => ({ vital_type: x.vital_type, display_name: x.display_name, value: x.latest.value_numeric,
      value_secondary: x.latest.value_secondary, unit: x.latest.unit, measured_at: x.latest.measured_at, status: x.evaluation && x.evaluation.status }));
    for (const x of out.vitals) if (x.status === "above_range" || x.status === "below_range") flags.push(`${x.display_name} last reading was ${x.status === "above_range" ? "above" : "below"} your target range`);
  }

  if (want("labs")) {
    const l = await labs.summary(user);
    out.labs = {
      needs_attention: (l.needs_attention || []).map((x) => ({ test_name: x.test_name, value: x.value_numeric ?? x.value_text, unit: x.unit, flag: x.flag,
        collected_date: x.collected_date, ref_low: x.ref_low, ref_high: x.ref_high, urgent: !!x.urgent })),
      recent: (l.latest || []).filter((x) => x.collected_date >= sinceDate).map((x) => ({ test_name: x.test_name, value: x.value_numeric ?? x.value_text,
        unit: x.unit, flag: x.flag, collected_date: x.collected_date })),
    };
    for (const x of out.labs.needs_attention) flags.push(`${x.test_name} was outside the normal range (${x.collected_date})`);
  }

  if (want("diary")) {
    const d = (await diary.list(user)).entries || [];
    const recent = d.filter((e) => e.entry_date >= sinceDate);
    out.diary = {
      entry_count: recent.length,
      follow_up_needed: recent.filter((e) => e.follow_up_needed).map((e) => ({ entry_date: e.entry_date, title: e.title })),
      entries: recent.slice().sort((a, b) => (b.follow_up_needed - a.follow_up_needed) || b.entry_date.localeCompare(a.entry_date)).slice(0, DIARY_SHOWN)
        .map((e) => ({ entry_date: e.entry_date, category: e.category, title: e.title, description: e.description, severity: e.severity, mood: e.mood, follow_up_needed: !!e.follow_up_needed })),
    };
    for (const e of out.diary.follow_up_needed) flags.push(`Diary note marked for follow-up: ${e.title} (${e.entry_date})`);
  }

  if (want("devices")) {
    const devs = await findAll("RespiratoryDevice", { user_id: user.user_id });
    out.devices = devs.filter((x) => x.get("is_active") !== false).map((x) => ({ device_type: x.get("device_type"), name: x.get("name") ?? null }));
  }

  out.worth_raising = flags;
  out.disclaimer = "This summary lists what you have recorded in Health Information Banking. It is not medical advice or a diagnosis.";
  out.text = renderText(out);
  await audit({ userId: user.user_id, event: "PREVISIT_SUMMARY", newData: { days, sections: sel.list, has_visit: !!visit, questions: questions.length }, ip: ctx && ctx.ip });
  return { status: 200, summary: out };
}

// ---------- plain text ----------
function renderText(s) {
  const L = [];
  const head = (t) => { L.push("", t.toUpperCase(), "-".repeat(t.length)); };
  L.push(`PRE-VISIT SUMMARY — ${s.patient.name}`);
  if (s.patient.date_of_birth) L.push(`Date of birth: ${s.patient.date_of_birth}`);
  if (s.visit) L.push(`Visit: ${s.visit.title}${s.visit.provider_name ? ` with ${s.visit.provider_name}` : ""} on ${s.visit.start_time.slice(0, 10)}`);
  L.push(`Covers the last ${s.period.days} days (${s.period.from} to ${s.period.to})`);
  if (s.reason) { head("Reason for visit"); L.push(s.reason); }
  if (s.concerns) { head("Concerns"); L.push(s.concerns); }
  if (s.questions.length) { head("Questions"); s.questions.forEach((q, i) => L.push(`${i + 1}. ${q}`)); }
  if (s.worth_raising.length) { head("Worth raising"); s.worth_raising.forEach((f) => L.push(`- ${f}`)); }
  if (s.allergies) { head("Allergies"); L.push(...(s.allergies.length ? s.allergies.map((a) => `- ${a.allergen}${a.reaction ? ` (${a.reaction})` : ""}`) : [s.no_known_allergies ? "No known allergies" : "None recorded"])); }
  if (s.conditions) { head("Conditions"); L.push(...(s.conditions.length ? s.conditions.map((c) => `- ${c.condition_name}${c.severity ? ` (${c.severity})` : ""}`) : ["None recorded"])); }
  if (s.medications) {
    head("Medications");
    L.push(...(s.medications.length ? s.medications.map((m) => `- ${m.medication_name}${m.strength ? ` ${m.strength} ${m.strength_unit || ""}` : ""}${m.frequency ? `, ${String(m.frequency).replace(/_/g, " ")}` : ""}`
      + (m.adherence.percent_taken !== null ? ` — ${m.adherence.percent_taken}% of logged doses taken` : "")) : ["None recorded"]));
    const ch = s.medication_changes;
    if (ch && ch.started.length) L.push("Started: " + ch.started.map((m) => `${m.medication_name} (${m.start_date})`).join(", "));
    if (ch && ch.stopped.length) L.push("Stopped: " + ch.stopped.map((m) => `${m.medication_name} (${m.end_date})`).join(", "));
  }
  if (s.safety_alerts && s.safety_alerts.length) { head("Medication warnings"); s.safety_alerts.forEach((a) => L.push(`- [${a.severity}] ${a.title}`)); }
  if (s.vitals && s.vitals.length) {
    head("Latest vital signs");
    s.vitals.forEach((v) => L.push(`- ${v.display_name}: ${v.value}${v.value_secondary != null ? `/${v.value_secondary}` : ""} ${v.unit || ""} (${String(v.measured_at).slice(0, 10)})`));
  }
  if (s.labs) {
    if (s.labs.needs_attention.length) { head("Lab results outside the normal range"); s.labs.needs_attention.forEach((l) => L.push(`- ${l.test_name}: ${l.value} ${l.unit || ""} (${l.collected_date})`)); }
    if (s.labs.recent.length) { head("Recent lab results"); s.labs.recent.forEach((l) => L.push(`- ${l.test_name}: ${l.value} ${l.unit || ""} (${l.collected_date})`)); }
  }
  if (s.diary && s.diary.entries.length) {
    head("Health diary");
    s.diary.entries.forEach((e) => L.push(`- ${e.entry_date}: ${e.title}${e.severity ? ` (severity ${e.severity}/10)` : ""}${e.follow_up_needed ? " [follow up]" : ""}`));
  }
  if (s.devices && s.devices.length) { head("Breathing devices"); s.devices.forEach((d) => L.push(`- ${d.name || d.device_type}`)); }
  L.push("", s.disclaimer);
  return L.join("\n");
}

module.exports = { summary, appointments, renderText, SECTION_NAMES };
