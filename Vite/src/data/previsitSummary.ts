// previsitSummary.ts — the pre-visit summary, ported 1:1 from the old Parse/cloud/lib/previsit.js summary() (no Parse
// here, so Node can load it): the checks of the request, the summary built from the patient's own rows (read by
// previsit.ts), the "worth raising" facts and the plain text. Nothing here is advice; it lists what the patient recorded.

export const SECTION_NAMES = ["conditions", "medications", "allergies", "safety_alerts", "vitals", "labs", "diary", "devices"];
const DEFAULT_DAYS = 90;
const MIN_DAYS = 7, MAX_DAYS = 365;
export const ADHERENCE_DAYS = 30;
const MAX_QUESTIONS = 20, MAX_TEXT = 500;
const DIARY_SHOWN = 15;
export const DAY_MS = 86400000;
const DISCLAIMER = "This summary lists what you have recorded in Health Information Banking. It is not medical advice or a diagnosis.";

export type SummaryRequest = { event_id?: unknown; reason?: unknown; questions?: unknown; concerns?: unknown; days?: unknown; sections?: unknown };
export type Checked = { days: number; reason: string | null; concerns: string | null; questions: string[]; sections: string[]; eventId: string | null };

const day = (d: Date | string) => (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);
const isId = (v: string) => /^[A-Za-z0-9]{1,32}$/.test(v);
function textOf(v: unknown, max: number, label: string): { value?: string | null; error?: string } {
  if (v === undefined || v === null || v === "") return { value: null };
  if (typeof v !== "string") return { error: `${label} must be text` };
  const s = v.trim();
  return s.length > max ? { error: `${label} must be ${max} characters or fewer` } : { value: s || null };
}

// the old route's checks (the same messages); throws an Error with the message
export function checkRequest(body: SummaryRequest): Checked {
  body = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  let days = DEFAULT_DAYS;
  if (body.days !== undefined) {
    days = Number(body.days);
    if (!Number.isInteger(days) || days < MIN_DAYS || days > MAX_DAYS) throw new Error(`days must be a whole number from ${MIN_DAYS} to ${MAX_DAYS}`);
  }
  const reason = textOf(body.reason, MAX_TEXT, "Reason for the visit"), concerns = textOf(body.concerns, 1000, "Concerns");
  if (reason.error || concerns.error) throw new Error(reason.error || concerns.error);
  const questions: string[] = [];
  if (body.questions !== undefined) {
    if (!Array.isArray(body.questions) || body.questions.length > MAX_QUESTIONS) throw new Error(`questions must be a list of at most ${MAX_QUESTIONS}`);
    for (const q of body.questions) {
      const t = textOf(q, MAX_TEXT, "A question");
      if (t.error) throw new Error(t.error);
      if (t.value) questions.push(t.value);
    }
  }
  let sections = SECTION_NAMES;
  if (body.sections !== undefined) {
    const list = body.sections;
    if (!Array.isArray(list) || !list.length || !list.every((s) => SECTION_NAMES.includes(s))) {
      throw new Error(`sections must be a non-empty list from: ${SECTION_NAMES.join(", ")}`);
    }
    sections = SECTION_NAMES.filter((s) => list.includes(s));
  }
  let eventId: string | null = null;
  if (body.event_id !== undefined && body.event_id !== null && body.event_id !== "") {
    if (!isId(String(body.event_id))) throw new Error("Invalid event ID");
    eventId = String(body.event_id);
  }
  return { days, reason: reason.value ?? null, concerns: concerns.value ?? null, questions, sections, eventId };
}

// ---- the rows the summary is built from (the shapes the data files already return) ----
export type VisitEvent = { event_id: string; title: string; start_time: string; location: string | null; provider_name: string | null; category: string };
export type ConditionIn = { condition_name: string; status: string; severity: string | null; onset_date: string | null; managing_provider: string | null };
export type MedIn = {
  medication_id: string; medication_name: string; medication_type: string | null; strength: number | null; strength_unit: string | null;
  dose_amount: number | null; dose_unit: string | null; frequency: string | null; purpose: string | null; prescriber_name: string | null;
  start_date: string | null; end_date: string | null; status: string; discontinued_reason: string | null; low_stock?: boolean; days_supply?: number | null;
};
export type DoseIn = { medication_id: string; dose_status: string; taken_at: Date | null };
export type AllergyIn = { allergen: string; reaction: string | null; severity: string | null };
export type AlertIn = { severity: string; title: string; message: string; acknowledged_at: string | null };
export type VitalIn = {
  vital_type: string; display_name: string;
  latest: { value_numeric: number; value_secondary: number | null; unit: string | null; measured_at: string };
  evaluation: { status: string } | null;
};
export type LabIn = { test_name: string; value_numeric: number | null; value_text: string | null; unit: string | null; flag: string | null;
  collected_date: string; ref_low?: number | null; ref_high?: number | null; urgent?: boolean };
export type DiaryIn = { entry_date: string; category: string; title: string; description: string | null; severity: number | null; mood: string | null; follow_up_needed: boolean | null };
export type DeviceIn = { device_type: string; name: string | null; is_active: boolean | null | undefined };
export type SummaryData = {
  patientName: string; record: Record<string, unknown>; visit: VisitEvent | null;
  conditions?: ConditionIn[];          // the active / managed conditions, in the Conditions page's order
  medications?: MedIn[];               // every medicine, in the list's order (active first, then by name)
  doses?: DoseIn[];                    // the dose log (at least the last ADHERENCE_DAYS)
  allergies?: AllergyIn[];             // active allergies by allergen
  alerts?: AlertIn[];                  // the warnings, sorted (open first)
  vitals?: VitalIn[];                  // the vitals summary
  labs?: { needs_attention: LabIn[]; latest: LabIn[] };
  diary?: DiaryIn[];                   // newest entry_date first, then newest created
  devices?: DeviceIn[];
};

// how well each active medicine was taken over the last 30 days, from the dose log
function adherence(doses: DoseIn[], activeMeds: MedIn[], now: Date) {
  const since = new Date(now.getTime() - ADHERENCE_DAYS * DAY_MS);
  const by = new Map<string, Record<string, number>>();
  for (const l of doses.filter((x) => x.taken_at && x.taken_at >= since)) {
    const e = by.get(l.medication_id) || { taken: 0, skipped: 0, missed: 0 };
    if (e[l.dose_status] !== undefined) e[l.dose_status] += 1;
    by.set(l.medication_id, e);
  }
  return new Map(activeMeds.map((m) => {
    const e = by.get(m.medication_id) || { taken: 0, skipped: 0, missed: 0 };
    const logged = e.taken + e.skipped + e.missed;
    return [m.medication_id, { taken: e.taken, skipped: e.skipped, missed: e.missed, days: ADHERENCE_DAYS, percent_taken: logged ? Math.round((e.taken / logged) * 100) : null }];
  }));
}

export type Summary = ReturnType<typeof buildSummary>;

// the summary, the same keys and order as the old route's
export function buildSummary(req: Checked, d: SummaryData, now = new Date()) {
  const want = (s: string) => req.sections.includes(s);
  const sinceDate = day(new Date(now.getTime() - req.days * DAY_MS));
  const v = d.visit;
  const out: Record<string, unknown> = {
    generated_at: now.toISOString(), period: { days: req.days, from: sinceDate, to: day(now) },
    visit: v ? { event_id: v.event_id, title: v.title, start_time: v.start_time, location: v.location, provider_name: v.provider_name, category: v.category } : null,
    reason: req.reason, concerns: req.concerns, questions: req.questions,
  };
  const rec = d.record || {};
  const p = (rec.patient && typeof rec.patient === "object" ? rec.patient : {}) as Record<string, unknown>;
  out.patient = { name: d.patientName, date_of_birth: p.dob || null, sex: p.sex || null };

  const flags: string[] = [];   // "worth raising": facts from the data, never diagnoses

  if (want("conditions")) {
    out.conditions = (d.conditions || []).map((x) => ({ condition_name: x.condition_name, status: x.status, severity: x.severity,
      onset_date: x.onset_date, managing_provider: x.managing_provider }));
  }

  if (want("medications")) {
    const all = d.medications || [];
    const list = all.filter((m) => m.status === "active");
    const adh = adherence(d.doses || [], list, now);
    const meds = list.map((m) => ({
      medication_name: m.medication_name, medication_type: m.medication_type, strength: m.strength, strength_unit: m.strength_unit,
      dose_amount: m.dose_amount, dose_unit: m.dose_unit, frequency: m.frequency, purpose: m.purpose, prescriber_name: m.prescriber_name,
      start_date: m.start_date, low_stock: !!m.low_stock, days_supply: m.days_supply, adherence: adh.get(m.medication_id)!,
    }));
    out.medications = meds;
    for (const m of meds) {
      if (m.adherence.percent_taken !== null && m.adherence.percent_taken < 80) flags.push(`${m.medication_name}: ${m.adherence.percent_taken}% of logged doses taken in the last ${ADHERENCE_DAYS} days`);
      if (m.low_stock) flags.push(`${m.medication_name}: running low (refill needed)`);
    }
    // changes inside the period: started, or stopped
    const changes = {
      started: all.filter((m) => m.status === "active" && m.start_date && m.start_date >= sinceDate).map((m) => ({ medication_name: m.medication_name, start_date: m.start_date })),
      stopped: all.filter((m) => ["discontinued", "completed"].includes(m.status) && m.end_date && m.end_date >= sinceDate)
        .map((m) => ({ medication_name: m.medication_name, end_date: m.end_date, reason: m.discontinued_reason })),
    };
    out.medication_changes = changes;
    for (const m of changes.started) flags.push(`New medicine since ${sinceDate}: ${m.medication_name}`);
  }

  if (want("allergies")) {
    const list = (d.allergies || []).map((x) => ({ allergen: x.allergen, reaction: x.reaction, severity: x.severity }));
    out.allergies = list;
    out.no_known_allergies = !list.length && !!rec.no_known_allergies;
  }

  if (want("safety_alerts")) {
    const list = (d.alerts || []).filter((x) => !x.acknowledged_at).map((x) => ({ severity: x.severity, title: x.title, message: x.message }));
    out.safety_alerts = list;
    for (const x of list) if (x.severity === "major") flags.push(`Medication warning: ${x.title}`);
  }

  if (want("vitals")) {
    const list = (d.vitals || []).map((x) => ({ vital_type: x.vital_type, display_name: x.display_name, value: x.latest.value_numeric,
      value_secondary: x.latest.value_secondary, unit: x.latest.unit, measured_at: x.latest.measured_at, status: x.evaluation && x.evaluation.status }));
    out.vitals = list;
    for (const x of list) if (x.status === "above_range" || x.status === "below_range") flags.push(`${x.display_name} last reading was ${x.status === "above_range" ? "above" : "below"} your target range`);
  }

  if (want("labs")) {
    const l = d.labs || { needs_attention: [], latest: [] };
    const labs = {
      needs_attention: l.needs_attention.map((x) => ({ test_name: x.test_name, value: x.value_numeric ?? x.value_text, unit: x.unit, flag: x.flag,
        collected_date: x.collected_date, ref_low: x.ref_low, ref_high: x.ref_high, urgent: !!x.urgent })),
      recent: l.latest.filter((x) => x.collected_date >= sinceDate).map((x) => ({ test_name: x.test_name, value: x.value_numeric ?? x.value_text,
        unit: x.unit, flag: x.flag, collected_date: x.collected_date })),
    };
    out.labs = labs;
    for (const x of labs.needs_attention) flags.push(`${x.test_name} was outside the normal range (${x.collected_date})`);
  }

  if (want("diary")) {
    const recent = (d.diary || []).filter((e) => e.entry_date >= sinceDate);
    const diary = {
      entry_count: recent.length,
      follow_up_needed: recent.filter((e) => e.follow_up_needed).map((e) => ({ entry_date: e.entry_date, title: e.title })),
      entries: recent.slice().sort((a, b) => (Number(b.follow_up_needed) - Number(a.follow_up_needed)) || b.entry_date.localeCompare(a.entry_date)).slice(0, DIARY_SHOWN)
        .map((e) => ({ entry_date: e.entry_date, category: e.category, title: e.title, description: e.description, severity: e.severity, mood: e.mood, follow_up_needed: !!e.follow_up_needed })),
    };
    out.diary = diary;
    for (const e of diary.follow_up_needed) flags.push(`Diary note marked for follow-up: ${e.title} (${e.entry_date})`);
  }

  if (want("devices")) {
    out.devices = (d.devices || []).filter((x) => x.is_active !== false).map((x) => ({ device_type: x.device_type, name: x.name ?? null }));
  }

  out.worth_raising = flags;
  out.disclaimer = DISCLAIMER;
  out.text = renderText(out as unknown as TextInput);
  return out as Record<string, unknown> & { worth_raising: string[]; text: string; period: { days: number; from: string; to: string } };
}

// ---------- plain text ----------
type TextInput = {
  patient: { name: string; date_of_birth: string | null };
  visit: { title: string; provider_name: string | null; start_time: string } | null;
  period: { days: number; from: string; to: string };
  reason: string | null; concerns: string | null; questions: string[]; worth_raising: string[];
  allergies?: { allergen: string; reaction: string | null }[]; no_known_allergies?: boolean;
  conditions?: { condition_name: string; severity: string | null }[];
  medications?: { medication_name: string; strength: number | null; strength_unit: string | null; frequency: string | null; adherence: { percent_taken: number | null } }[];
  medication_changes?: { started: { medication_name: string; start_date: string | null }[]; stopped: { medication_name: string; end_date: string | null }[] };
  safety_alerts?: { severity: string; title: string }[];
  vitals?: { display_name: string; value: number; value_secondary: number | null; unit: string | null; measured_at: string }[];
  labs?: { needs_attention: { test_name: string; value: unknown; unit: string | null; collected_date: string }[]; recent: { test_name: string; value: unknown; unit: string | null; collected_date: string }[] };
  diary?: { entries: { entry_date: string; title: string; severity: number | null; follow_up_needed: boolean }[] };
  devices?: { device_type: string; name: string | null }[];
  disclaimer: string;
};
export function renderText(s: TextInput): string {
  const L: string[] = [];
  const head = (t: string) => { L.push("", t.toUpperCase(), "-".repeat(t.length)); };
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
