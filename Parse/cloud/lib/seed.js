// seed.js — the demo patient and demo doctor, full of MADE-UP data, for demos and testing.
//
// Run it from the Back4app dashboard: API Console > Cloud Code Functions > "seedDemo"
// (tick "Use Master Key"), or locally:  node Parse/local/seed-demo.js
//
// Everything here is fictional. Re-running it deletes the two demo accounts (and all their
// data) and builds them again. Every item goes through the same route() code the website
// calls, so pill counts, charts, lab flags and safety warnings are calculated exactly as
// they would be for a real patient.
//
// Logins it creates:
//   patient   demo.patient@example.com  /  DemoPatient123
//   doctor    demo.doctor@example.com   /  DemoDoctor123   (physician; NPI shown in the result)

const { route } = require("./router");
const auth = require("./auth");
const legal = require("./legal");
const { M, findAll, findOne, destroyAll, save } = require("./db");
const { SCHEMA } = require("./setup");
const sec = require("./security");

const PATIENT = { email: "demo.patient@example.com", name: "Maria Delgado", password: "DemoPatient123" };
// The patient's made-up birth date, typed once: the Health History form uses PATIENT_DOB, the sample PDFs print PATIENT_DOB_TEXT
const PATIENT_DOB = "1968-03-14";
const PATIENT_DOB_TEXT = `${PATIENT_DOB.slice(5, 7)}/${PATIENT_DOB.slice(8, 10)}/${PATIENT_DOB.slice(0, 4)}`;
const DOCTOR = { email: "demo.doctor@example.com", name: "Dr. Samuel Okafor", password: "DemoDoctor123", npi: "1234567893" };

// ---------- date helpers ----------
const DAY = 24 * 60 * 60 * 1000;
let now = new Date();
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysAgo = (n, hour = 8, minute = 0) => {
  const d = new Date(now.getTime() - n * DAY);
  d.setHours(hour, minute, 0, 0);
  return d;
};
const daysAhead = (n, hour = 9, minute = 0) => daysAgo(-n, hour, minute);
// repeatable "random" numbers so every run gives the same charts
let seed = 42;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const jitter = (spread) => (rand() - 0.5) * 2 * spread;
const round = (v, places = 0) => Number(v.toFixed(places));

// ---------- a tiny PDF writer (for the sample lab report) ----------
function makePdf(lines) {
  const esc = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  let y = 750;
  const content = lines.map(([text, size = 10, bold = false]) => {
    const line = `BT /${bold ? "F2" : "F1"} ${size} Tf 60 ${y} Td (${esc(text)}) Tj ET`;
    y -= size + 7;
    return line;
  }).join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((obj, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((o) => { pdf += `${String(o).padStart(10, "0")} 00000 n \n`; });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

// ---------- demo data for the newer features (plain tables; seedDemo sends each row through route()) ----------
// Dates are written as "days ago" / "days ahead" so every run is dated from today.

// A small card-sized PNG (a blue band and grey lines): the front of a made-up insurance card
const CARD_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAIAAAABQCAIAAABeYuqzAAAAsklEQVR42u3coRHAIAxAUSZhMHQ141Sju1pdZRVT0JTLu/sT5IlcTEptQ4EVIwAAQAAACAAAAQAgAAAEAIAAANAHAPfzKjAAAAAIAAABACAAAAQAgAAA0A8A2tGzBQAAAAAABACAAAAQAAACkBbgHNeOAQAAwA4QAAACAEAAACjXHbDXhQEAAABZwgAEAIAAABCA4Ba9pQEAAAAAAAAAAAAAAAAAAAAEAIAAAAAgAAAU1AQjddaywmBy2wAAAABJRU5ErkJggg==";

const DEMO_DOCUMENTS = [
  {
    title: "Example Health Plan member card (front)", category: "insurance", provider: "Example Health Plan", ago: 300,
    notes: "Photo of my insurance card. Member ID is on the front.", tags: ["insurance", "card"],
    file_name: "insurance-card-front.png", file_base64: CARD_PNG_BASE64,
  },
  {
    title: "Visit summary - Dr. Okafor", category: "visit_summary", provider: "Dr. Samuel Okafor", ago: 84,
    notes: "Check-up after changing the blood pressure plan.", tags: ["check-up", "blood pressure"],
    file_name: "visit-summary-okafor.pdf",
    file_base64: makePdf([
      ["SAMPLE VISIT SUMMARY - FICTIONAL DATA FOR DEMO ONLY", 9, true],
      ["Boca Family Health (fictional)", 16, true],
      [`Patient: ${PATIENT.name}     DOB: ${PATIENT_DOB_TEXT}`, 10],
      ["Provider: Dr. Samuel Okafor", 10],
      ["", 6],
      ["REASON FOR VISIT", 11, true],
      ["Routine check-up: blood pressure, diabetes and cholesterol.", 10],
      ["", 6],
      ["NOTES", 11, true],
      ["Blood pressure 134/82. Weight down 4 lb since the last visit.", 10],
      ["Keep metformin and lisinopril the same. Continue evening walks.", 10],
      ["Ask about dizziness when standing up quickly at the next visit.", 10],
      ["", 6],
      ["PLAN", 11, true],
      ["Fasting blood work in 3 months. Eye exam this year (diabetic).", 10],
    ]).toString("base64"),
  },
  {
    title: "Vaccination record", category: "vaccination", provider: "Sunshine Pharmacy - Glades Rd", ago: 25,
    notes: "Printed from the pharmacy after my flu shot.", tags: ["vaccines", "flu"],
    file_name: "vaccination-record.pdf",
    file_base64: makePdf([
      ["SAMPLE VACCINATION RECORD - FICTIONAL DATA FOR DEMO ONLY", 9, true],
      ["Sunshine Pharmacy (fictional)", 16, true],
      [`Patient: ${PATIENT.name}     DOB: ${PATIENT_DOB_TEXT}`, 10],
      ["", 6],
      ["VACCINE                          DATE", 11, true],
      ["Influenza (flu), this season     recent", 10],
      ["COVID-19 booster                 2025-10", 10],
      ["Pneumococcal (PCV20)             2024", 10],
      ["Shingles (Shingrix), 2 doses     2023", 10],
      ["Tdap                             2021", 10],
    ]).toString("base64"),
  },
];

// 44 nights of APAP use, night 44 days ago to last night. Slowly improving: longer use, lower AHI and leak.
// Uses its own little number generator so the shared one (and every other chart) stays the same.
const APAP_NIGHTS = (() => {
  let s = 11;
  const next = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const wiggle = (spread) => (next() - 0.5) * 2 * spread;
  const SHORT_NIGHTS = { 31: 2.6, 17: 3.4, 6: 4.1 };      // a few nights the mask came off early
  const NOTES = { 31: "Took the mask off at 2am, too warm", 12: "Tried the new mask cushion", 3: "Slept great" };
  return Array.from({ length: 44 }, (_, i) => {
    const ago = i + 1;
    const progress = (44 - ago) / 43;                      // 0 a month and a half ago, 1 last night
    const night = {
      ago,
      hours_used: SHORT_NIGHTS[ago] || round(Math.min(9.5, 5.9 + 1.6 * progress + wiggle(0.8)), 1),
      ahi: round(Math.max(0.8, 6.4 - 3.6 * progress + wiggle(0.7)), 1),
      leak_lpm: round(Math.max(2, 19 - 7 * progress + wiggle(4)), 1),
      comfort: Math.max(1, Math.min(5, Math.round(3 + 1.2 * progress + wiggle(0.9)))),
    };
    if (NOTES[ago]) night.notes = NOTES[ago];
    return night;
  });
})();

const APAP_DEVICE = {
  device_type: "apap", name: "Bedroom APAP machine", serial_last4: "7K29QX", mask_type: "nasal", start_ago: 120,
  pressure_min: 6, pressure_max: 14, notes: "Auto-adjusting machine. Humidifier on 3.",
  // parts replaced this many days ago: with the default schedule the first two are overdue, the third is due soon
  supplies_due: [
    { part_name: "Mask cushion", days_since: 18 },
    { part_name: "Disposable filter", days_since: 16 },
    { part_name: "Tubing", days_since: 85 },
  ],
};

const PEAK_FLOW_DEVICE = {
  device_type: "peak_flow_meter", name: "Peak flow meter", personal_best: 480, start_ago: 90,
  notes: "Checked in the morning during pollen season.",
};
// personal best 480: green is 384 or more, yellow 240 to 383, red under 240
const PEAK_FLOW_READINGS = [
  { ago: 2, peak_flow: 430 }, { ago: 4, peak_flow: 415 }, { ago: 6, peak_flow: 455 }, { ago: 9, peak_flow: 390 },
  { ago: 12, peak_flow: 340, notes: "Chest felt tight after yard work" }, { ago: 15, peak_flow: 375 },
  { ago: 18, peak_flow: 420 }, { ago: 22, peak_flow: 300, notes: "High pollen day" }, { ago: 26, peak_flow: 410 },
  { ago: 30, peak_flow: 445 },
];

// Leftover medicines: stopped or finished, still in the cabinet. Percocet is on the FDA flush list.
const LEFTOVER_MEDS = [
  { medication_name: "Percocet", medication_type: "prescription", strength: 5, strength_unit: "mg", dosage_form: "tablet",
    dose_amount: 1, dose_unit: "tablet", frequency: "as_needed", instructions: "Only for severe pain, no more than every 6 hours",
    purpose: "Pain after a dental procedure", prescriber_name: "Dr. Daniel Whitaker", pharmacy_name: "Sunshine Pharmacy - Glades Rd",
    status: "completed", quantity_on_hand: 8, start_ago: 75, end_ago: 68 },
  { medication_name: "Zestril", medication_type: "prescription", strength: 20, strength_unit: "mg", dosage_form: "tablet",
    dose_amount: 1, dose_unit: "tablet", frequency: "once_daily", purpose: "Blood pressure", prescriber_name: "Dr. Samuel Okafor",
    status: "discontinued", discontinued_reason: "Dose lowered to lisinopril 10 mg; leftover 20 mg tablets", quantity_on_hand: 18, end_ago: 150 },
];

// A disposal already done: the whole bottle of a stopped muscle relaxant, three weeks ago
const PAST_DISPOSAL = {
  medication: { medication_name: "Cyclobenzaprine", medication_type: "prescription", strength: 10, strength_unit: "mg", dosage_form: "tablet",
    dose_amount: 1, dose_unit: "tablet", frequency: "as_needed", purpose: "Muscle spasm", prescriber_name: "Dr. Samuel Okafor",
    status: "discontinued", discontinued_reason: "No longer needed", quantity_on_hand: 12, start_ago: 120, end_ago: 60 },
  ago: 21, quantity: 12, method: "trash", location: "Home",
  notes: "Mixed with used coffee grounds and sealed in a bag.",
};

const DEMO_TIME_ZONE = "America/New_York";
// Six reminders. `link` names the item to link ({kind: medication | supply | event}); `ahead` is a once reminder's time.
const DEMO_REMINDERS = [
  { reminder_type: "medication", title: "Metformin with breakfast and dinner", schedule_type: "daily", times: ["08:00", "20:00"],
    link: { kind: "medication", name: "Metformin" } },
  { reminder_type: "medication", title: "Atorvastatin at bedtime", schedule_type: "daily", times: ["21:00"],
    link: { kind: "medication", name: "Atorvastatin" } },
  { reminder_type: "refill", title: "Order lisinopril refill", schedule_type: "once", ahead: { days: 1, hour: 8, minute: 0 },
    link: { kind: "medication", name: "Lisinopril" }, email_me: true },
  { reminder_type: "appointment", title: "Start fasting for blood work", schedule_type: "once", ahead: { days: 1, hour: 21, minute: 0 },
    link: { kind: "event", name: "Fasting blood work" } },
  { reminder_type: "device_supply", title: "Replace APAP mask cushion", schedule_type: "weekly", days_of_week: [0], times: ["19:00"],
    link: { kind: "supply", name: "Mask cushion" } },
  { reminder_type: "custom", title: "Weekly weigh-in", schedule_type: "weekly", days_of_week: [1], times: ["07:00"] },
];

// Notifications already waiting (unread). `reminder` is the title of the reminder it came from;
// `link_medication` adds that medicine's id to the link, as a fired medication reminder does.
// The automatic alerts (low stock, parts due, leftover medicine) are added by a real sweep at the end of seedDemo.
const DEMO_NOTIFICATIONS = [
  { kind: "reminder", title: "Metformin with breakfast and dinner", message: "Time to take your medicine",
    link: "/medications", link_medication: "Metformin", action: "log_dose", reminder: "Metformin with breakfast and dinner" },
  { kind: "reminder", title: "Atorvastatin at bedtime", message: "Time to take your medicine",
    link: "/medications", link_medication: "Atorvastatin", action: "log_dose", reminder: "Atorvastatin at bedtime" },
  { kind: "reminder", title: "Weekly weigh-in", message: "Reminder", link: "/reminders", reminder: "Weekly weigh-in" },
];

// An every-other-day event, added to the calendar events the seed already has
const REPEATING_EVENT = {
  title: "Knee exercises (home routine)", category: "personal", description: "Quad sets and straight-leg raises from PT, 15 minutes.",
  start: { days: 1, hour: 18, minute: 0 }, duration_minutes: 20,
  recurrence_type: "every_n_days", recurrence_interval: 2, end_type: "count", end_count: 30,
};

// ---------- accounts ----------
async function deleteAccount(email) {
  const u = await auth.userByEmail(email);
  if (!u) return;
  for (const [cls, fields] of Object.entries(SCHEMA)) {
    if (cls === "_User") continue;
    const key = fields.user_id ? "user_id" : fields.patient_user_id ? "patient_user_id" : null;
    if (!key) continue;
    let batch;
    do { batch = await findAll(cls, { [key]: u.id }, { limit: 1000 }); await destroyAll(batch); } while (batch.length === 1000);
  }
  await auth.endAllSessions(u.id);
  await u.destroy(M);
}

async function newAccount({ email, name, password }, extra = {}) {
  const u = new Parse.User();
  u.set({ username: email, email, password, name, role: "patient", ...legal.acceptanceFields(), ...extra });
  await u.signUp(null, M);
  u.setACL(new Parse.ACL(u));
  await u.save(null, M);
  await auth.endAllSessions(u.id);   // no session until they log in with the email code
  return u;
}

async function seedDemo() {
  now = new Date(); seed = 42;
  const results = [];
  const section = async (name, work) => {
    try {
      const detail = await work();
      results.push(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
    } catch (err) {
      results.push(`✗ ${name} — ${err.message}`);
      console.error("seedDemo", name, err);
    }
  };

  await deleteAccount(PATIENT.email);
  await deleteAccount(DOCTOR.email);
  const p = await newAccount(PATIENT);
  const user = auth.asUser(p);
  const ctx = { user, sessionToken: null, ip: "seed", userAgent: "seedDemo" };
  // call the same routes the website uses; anything 400+ is an error
  const call = async (method, path, body, query) => {
    const r = await route({ method, path, body: body || {}, query: query || {} }, ctx);
    if (!r || r.status >= 400) throw new Error(`${method} ${path}: ${r && r.error}`);
    return r;
  };
  await save(new Parse.Object("MedicalRecord"), { user_id: user.user_id, data: {} });

  // Each NPI can only be on one account: use the standard test NPI if it's free.
  let npi = DOCTOR.npi;
  for (let n = 1234567890; (await findOne("_User", { npi })) || !sec.isValidNpi(npi); n++) npi = String(n);
  await newAccount(DOCTOR, { role: "physician", npi });
  results.push(`✓ Accounts — patient + doctor (physician, NPI ${npi})`);

  // ---------- Health History form ----------
  const form = {
    form: "health_history_v1",
    patient: {
      name: PATIENT.name, dob: PATIENT_DOB, race: ["Hispanic or Latino", "White"], sex: "Female",
      marital_status: "Married", children: "2", phone: "(561) 555-0142", email: PATIENT.email,
      address: "742 Palm Grove Lane, Boca Raton, FL 33431",
      emergency_contact: "Carlos Delgado (husband) – (561) 555-0187",
      previous_physician: "Dr. Linda Park, Coastal Family Medicine",
      referring_physician: "Dr. Samuel Okafor",
    },
    conditions: ["High Blood Pressure", "Diabetes – Oral Meds", "High Cholesterol", "Arthritis", "Allergy: Seasonal"],
    arthritis_type: "Osteoarthritis, right knee",
    cancer: "",
    other_conditions: "Mild sleep trouble",
    surgeries: [
      { type: "Appendectomy", year: "1994" },
      { type: "Cesarean section", year: "2001" },
      { type: "Right knee arthroscopy", year: "2019" },
    ],
    prescriptions: [],
    non_prescriptions: [],
    allergies: [
      { allergen: "Penicillin", reaction: "Hives and itching" },
      { allergen: "Sulfa", reaction: "Rash" },
      { allergen: "Shellfish", reaction: "Throat swelling – carries an EpiPen" },
    ],
    no_known_allergies: false,
    immunizations: [
      { vaccine: "Influenza (flu)", date: ymd(daysAgo(25)) },
      { vaccine: "COVID-19 booster", date: "2025-10" },
      { vaccine: "Tdap", date: "2021" },
      { vaccine: "Shingles (Shingrix), 2 doses", date: "2023" },
      { vaccine: "Pneumococcal (PCV20)", date: "2024" },
    ],
    family_history: "Father – heart attack at 62, type 2 diabetes\nMother – high blood pressure, osteoporosis\nBrother – high cholesterol",
    social: { tobacco: "Former", alcohol: "Occasionally", notes: "Quit smoking in 2010. Walks 30 minutes 4 days a week. Works as an elementary school librarian." },
  };
  await section("Health History form", async () => {
    await call("PUT", "/records", { data: form });
    return "patient info, 5 conditions, 3 surgeries, 3 allergies, 5 vaccines";
  });

  // ---------- conditions ----------
  const conditionIds = {};
  await section("Conditions", async () => {
    const list = [
      { key: "diabetes", condition_name: "Type 2 diabetes", icd10_code: "E11.9", category: "chronic", status: "managed", severity: "moderate", onset_date: "2016-05-01", diagnosed_date: "2016-06-15", managing_provider: "Dr. Samuel Okafor" },
      { key: "bp", condition_name: "Hypertension", icd10_code: "I10", category: "chronic", status: "managed", severity: "mild", diagnosed_date: "2014-02-10", managing_provider: "Dr. Samuel Okafor" },
      { key: "chol", condition_name: "High cholesterol (hyperlipidemia)", icd10_code: "E78.5", category: "chronic", status: "active", severity: "mild", diagnosed_date: "2018-09-01" },
      { key: "oa", condition_name: "Osteoarthritis, right knee", icd10_code: "M17.11", category: "chronic", status: "active", severity: "moderate", diagnosed_date: "2019-01-20" },
      { key: "allergy", condition_name: "Seasonal allergies", category: "allergy", status: "active", severity: "mild" },
    ];
    for (const { key, ...body } of list) {
      const r = await call("POST", "/conditions", body);
      conditionIds[key] = (r.condition || r).condition_id;
    }
    if (conditionIds.diabetes) {
      await call("POST", `/conditions/${conditionIds.diabetes}/notes`, { note_text: "A1C down to 7.1 after adding evening walks. Keep metformin the same.", note_type: "improvement" });
      await call("POST", `/conditions/${conditionIds.diabetes}/targets`, { vital_type: "blood_glucose", target_min: 80, target_max: 130, set_by: "provider" });
    }
    if (conditionIds.bp) {
      await call("POST", `/conditions/${conditionIds.bp}/targets`, { vital_type: "blood_pressure", target_max: 130, secondary_max: 80, set_by: "provider" });
    }
    return `${Object.keys(conditionIds).length} conditions with notes and targets`;
  });

  // ---------- medications, doses and refills ----------
  await section("Medications", async () => {
    const meds = [
      { medication_name: "Metformin", medication_type: "prescription", strength: 500, strength_unit: "mg", dosage_form: "tablet", dose_amount: 1, dose_unit: "tablet", frequency: "twice_daily", schedule_times: ["08:00", "20:00"], instructions: "Take with breakfast and dinner", purpose: "Blood sugar", prescriber_name: "Dr. Samuel Okafor", pharmacy_name: "Sunshine Pharmacy – Glades Rd", start_date: "2016-06-15", quantity_on_hand: 46, refill_threshold: 14, refills_remaining: 3, cond: "diabetes", perDay: 2 },
      { medication_name: "Lisinopril", medication_type: "prescription", strength: 10, strength_unit: "mg", dosage_form: "tablet", dose_amount: 1, dose_unit: "tablet", frequency: "once_daily", schedule_times: ["08:00"], purpose: "Blood pressure", prescriber_name: "Dr. Samuel Okafor", pharmacy_name: "Sunshine Pharmacy – Glades Rd", start_date: "2014-02-10", quantity_on_hand: 9, refill_threshold: 10, refills_remaining: 1, cond: "bp", perDay: 1 },
      { medication_name: "Atorvastatin", medication_type: "prescription", strength: 20, strength_unit: "mg", dosage_form: "tablet", dose_amount: 1, dose_unit: "tablet", frequency: "once_daily", schedule_times: ["21:00"], instructions: "Take at bedtime", purpose: "Cholesterol", prescriber_name: "Dr. Samuel Okafor", pharmacy_name: "Sunshine Pharmacy – Glades Rd", start_date: "2018-09-01", quantity_on_hand: 62, refill_threshold: 10, refills_remaining: 5, cond: "chol", perDay: 1 },
      { medication_name: "Loratadine", brand_name: "Claritin", medication_type: "non_prescription", strength: 10, strength_unit: "mg", dosage_form: "tablet", dose_amount: 1, dose_unit: "tablet", frequency: "once_daily", purpose: "Seasonal allergies", quantity_on_hand: 24, refill_threshold: 5, cond: "allergy", perDay: 1 },
      { medication_name: "Vitamin D3", medication_type: "non_prescription", strength: 2000, strength_unit: "units", dosage_form: "capsule", dose_amount: 1, dose_unit: "capsule", frequency: "once_daily", purpose: "Bone health", quantity_on_hand: 80, refill_threshold: 10, perDay: 1 },
      { medication_name: "Ibuprofen", brand_name: "Advil", medication_type: "non_prescription", strength: 200, strength_unit: "mg", dosage_form: "tablet", dose_amount: 2, dose_unit: "tablet", frequency: "as_needed", purpose: "Knee pain", instructions: "With food; no more than 3 times a day", quantity_on_hand: 38, cond: "oa", perDay: 0 },
      { medication_name: "Glipizide", medication_type: "prescription", strength: 5, strength_unit: "mg", dosage_form: "tablet", dose_amount: 1, dose_unit: "tablet", frequency: "once_daily", purpose: "Blood sugar", start_date: "2017-01-10", end_date: "2020-03-01", status: "discontinued", discontinued_reason: "Low blood sugar episodes; switched to diet + metformin", quantity_on_hand: 0, perDay: 0 },
    ];
    let doses = 0;
    for (const { cond, perDay, ...body } of meds) {
      if (cond && conditionIds[cond]) body.condition_id = conditionIds[cond];
      const r = await call("POST", "/medications", body);
      const id = r.medication.medication_id;
      // a refill a few weeks ago
      if (body.status !== "discontinued" && body.medication_type === "prescription") {
        await call("POST", `/medications/${id}/refills`, { quantity_added: 30, refill_date: ymd(daysAgo(18)), pharmacy_name: body.pharmacy_name });
        // the refill added 30; set the count so it matches the list above after this week's doses
        const med = await findOne("Medication", { objectId: id });
        await save(med, { quantity_on_hand: body.quantity_on_hand + 7 * perDay });
      }
      // the last 7 days of doses: mostly taken, a couple skipped
      for (let day = 6; day >= 0; day--) {
        const hours = perDay === 2 ? [8, 20] : perDay === 1 ? [body.schedule_times?.[0] === "21:00" ? 21 : 8] : [];
        for (const h of hours) {
          const when = daysAgo(day, h, 5 + Math.floor(rand() * 40));
          if (when > now) continue;
          const skipped = (day === 3 && h === 20) || (day === 5 && body.medication_name === "Atorvastatin");
          await call("POST", `/medications/${id}/doses`, { dose_status: skipped ? "skipped" : "taken", taken_at: when.toISOString() });
          doses++;
        }
      }
      if (body.medication_name === "Ibuprofen") {
        for (const day of [1, 4, 6]) {
          await call("POST", `/medications/${id}/doses`, { dose_status: "taken", taken_at: daysAgo(day, 18, 30).toISOString() });
          doses++;
        }
      }
    }
    return `${meds.length} medications (prescription + non-prescription, 1 stopped), ${doses} doses logged, refills`;
  });

  // ---------- vital signs: ~4 months (saved in parallel batches to keep it quick) ----------
  await section("Vital signs", async () => {
    const pending = [];
    const add = (vital_type, value_numeric, when, extra = {}) =>
      pending.push({ vital_type, value_numeric, measured_at: when.toISOString(), ...extra });
    for (let day = 120; day >= 0; day--) {
      const progress = (120 - day) / 120;               // slowly improving over the 4 months
      if (day % 2 === 0 || day < 14) {
        const sys = round(142 - 16 * progress + jitter(5));
        add("blood_pressure", sys, daysAgo(day, 7, 30), { value_secondary: round(Math.min(sys - 30, 90 - 9 * progress + jitter(4))) });
        add("heart_rate", round(78 - 6 * progress + jitter(5)), daysAgo(day, 7, 32));
      }
      if (day % 3 === 0 || day < 10) add("blood_glucose", round(148 - 32 * progress + jitter(12)), daysAgo(day, 6, 45));
      if (day % 7 === 0) add("weight", round(184 - 8 * progress + jitter(1), 1), daysAgo(day, 6, 30));
      if (day % 10 === 0) add("oxygen_saturation", round(97 + jitter(1.4)), daysAgo(day, 7, 35));
      if (day % 15 === 0) add("temperature", round(98.4 + jitter(0.4), 1), daysAgo(day, 7, 40));
      if (day % 5 === 0) add("pain_level", Math.max(1, round(6 - 3 * progress + jitter(1.5))), daysAgo(day, 19, 0));
    }
    add("height", 64, daysAgo(120, 9, 0));
    add("hemoglobin_a1c", 7.8, daysAgo(200, 9, 0));
    add("hemoglobin_a1c", 7.4, daysAgo(110, 9, 0));
    add("hemoglobin_a1c", 7.1, daysAgo(4, 9, 0));
    let count = 0;
    for (let i = 0; i < pending.length; i += 20) {
      const done = await Promise.all(pending.slice(i, i + 20).map((b) => route({ method: "POST", path: "/vitals", body: b, query: {} }, ctx)));
      count += done.filter((r) => r.status < 400).length;
    }
    return `${count} readings over 4 months (blood pressure, heart rate, glucose, weight, O2, temperature, pain, A1C)`;
  });

  // ---------- health diary ----------
  await section("Health diary", async () => {
    const entries = [
      [2, "symptom", "Right knee stiff in the morning", "Stiff for about 20 minutes after waking. Better after walking around. Took 2 Advil in the evening.", 4, "Okay", false],
      [5, "medication", "Forgot evening metformin", "Fell asleep early and missed the 8pm dose. Took the morning dose as normal.", null, "Tired", false],
      [8, "general", "Started walking after dinner", "Walked 30 minutes around the neighborhood with Carlos. Felt good.", null, "Good", false],
      [12, "symptom", "Headache in the afternoon", "Dull headache behind the eyes, went away after drinking water and resting. BP was 128/80.", 3, "Okay", false],
      [16, "symptom", "Sneezing and itchy eyes", "Allergies acting up with the pollen. Claritin helped by mid-morning.", 3, "Okay", false],
      [21, "general", "Cut back on soda", "Switched to sparkling water. Fasting sugars a little lower this week.", null, "Great", false],
      [27, "symptom", "Dizzy when standing up quickly", "Happened twice this week, only for a few seconds. Want to ask the doctor if the BP medicine is too strong.", 5, "Worried", true],
      [33, "medication", "Picked up refills", "Picked up metformin, lisinopril and atorvastatin at Sunshine Pharmacy.", null, "Good", false],
      [41, "symptom", "Knee swelling after gardening", "Knelt in the garden for an hour; knee was swollen that night. Iced it and used a pillow.", 6, "Frustrated", true],
      [55, "general", "Flu shot", "Got the flu shot at the pharmacy. Arm sore for a day.", 2, "Good", false],
    ];
    for (const [ago, category, title, description, severity, mood, follow] of entries) {
      await call("POST", "/diary-entries", { entry_date: ymd(daysAgo(ago)), category, title, description,
        ...(severity ? { severity } : {}), mood, follow_up_needed: follow });
    }
    return `${entries.length} entries`;
  });

  // ---------- calendar ----------
  await section("Calendar", async () => {
    const ev = [
      { title: "Check-up with Dr. Okafor", category: "appointment", start_time: daysAhead(9, 10, 30).toISOString(), end_time: daysAhead(9, 11, 0).toISOString(), location: "Boca Family Health, Suite 210", provider_name: "Dr. Samuel Okafor", description: "Bring BP log. Ask about dizziness when standing.", condition_id: conditionIds.bp },
      { title: "Fasting blood work", category: "lab", start_time: daysAhead(2, 7, 30).toISOString(), location: "Quest Diagnostics – Federal Hwy", description: "No food after midnight.", condition_id: conditionIds.diabetes },
      { title: "Physical therapy – knee", category: "appointment", start_time: daysAhead(5, 15, 0).toISOString(), end_time: daysAhead(5, 16, 0).toISOString(), location: "MotionWorks PT", condition_id: conditionIds.oa },
      { title: "Eye exam (diabetic)", category: "appointment", start_time: daysAhead(30, 13, 0).toISOString(), location: "Clear View Eye Care" },
      { title: "Refill lisinopril", category: "medication", start_time: daysAhead(1, 9, 0).toISOString(), all_day: true },
      { title: "Check-up with Dr. Okafor", category: "appointment", start_time: daysAgo(84, 10, 0).toISOString(), location: "Boca Family Health, Suite 210", status: "completed" },
    ];
    for (const body of ev) {
      if (body.condition_id == null) delete body.condition_id;
      await call("POST", "/calendar/events", body);
    }
    // one repeating event: every other day, 30 times
    const { start, duration_minutes, ...repeating } = REPEATING_EVENT;
    const startAt = daysAhead(start.days, start.hour, start.minute);
    await call("POST", "/calendar/events", { ...repeating, start_time: startAt.toISOString(),
      end_time: new Date(startAt.getTime() + duration_minutes * 60 * 1000).toISOString() });
    return `${ev.length + 1} events (5 upcoming, 1 past, 1 repeating every other day)`;
  });

  // ---------- nutrition ----------
  await section("Nutrition log", async () => {
    const meals = [
      ["Oatmeal with blueberries", 1, "cup", 220, 7, 40, 4, 6, 9, 120],
      ["Grilled chicken salad", 1, "plate", 410, 36, 18, 22, 6, 7, 640],
      ["Brown rice and black beans", 1.5, "cup", 380, 14, 70, 4, 12, 2, 420],
      ["Greek yogurt", 170, "g", 100, 17, 6, 0, 0, 5, 60],
      ["Baked salmon with broccoli", 1, "plate", 520, 42, 14, 30, 5, 3, 380],
      ["Apple", 1, "medium", 95, 0.5, 25, 0.3, 4, 19, 2],
    ];
    let n = 0;
    for (let day = 0; day < 3; day++) {
      for (const [foodName, servingSize, servingUnit, calories, proteinG, carbsG, fatG, fiberG, sugarG, sodiumMg] of meals) {
        const r = await call("POST", "/nutrition/log", { foodName, servingSize, servingUnit, calories, proteinG, carbsG, fatG, fiberG, sugarG, sodiumMg });
        n++;
        // spread the meals over the day (and back over 3 days)
        const row = await findOne("NutritionLog", { objectId: r.logId });
        await save(row, { logged_at: daysAgo(day, 8 + (n % 6) * 2) });
      }
    }
    return `${n} food entries over 3 days`;
  });

  // ---------- lab results + a sample PDF ----------
  await section("Lab results", async () => {
    const oldDate = ymd(daysAgo(180)), newDate = ymd(daysAgo(4));
    const pdf = makePdf([
      ["SAMPLE LAB REPORT - FICTIONAL DATA FOR DEMO ONLY", 9, true],
      ["Sunrise Diagnostic Laboratory (fictional)", 16, true],
      [`Patient: ${PATIENT.name}     DOB: ${PATIENT_DOB_TEXT}     Collected: ${newDate}`, 10],
      ["Ordering physician: Dr. Samuel Okafor", 10],
      ["", 6],
      ["LIPID PANEL                    Result      Reference      Flag", 11, true],
      ["Total Cholesterol              212 mg/dL   < 200          H", 10],
      ["LDL Cholesterol                131 mg/dL   < 100          H", 10],
      ["HDL Cholesterol                 46 mg/dL   >= 40", 10],
      ["Triglycerides                  168 mg/dL   < 150          H", 10],
      ["", 6],
      ["DIABETES                       Result      Reference      Flag", 11, true],
      ["Glucose, fasting               118 mg/dL   70 - 99        H", 10],
      ["Hemoglobin A1C                 7.1 %       < 5.7          H", 10],
      ["", 6],
      ["METABOLIC PANEL                Result      Reference      Flag", 11, true],
      ["Sodium                         139 mmol/L  135 - 145", 10],
      ["Potassium                      4.6 mmol/L  3.5 - 5.0", 10],
      ["Creatinine                    1.02 mg/dL   0.6 - 1.3", 10],
      ["eGFR                            68         >= 60", 10],
      ["ALT                             31 U/L     7 - 56", 10],
      ["", 6],
      ["OTHER                          Result      Reference      Flag", 11, true],
      ["Vitamin D, 25-hydroxy           24 ng/mL   30 - 100       L", 10],
      ["TSH                           2.10 mIU/L   0.4 - 4.0", 10],
    ]);
    const up = await call("POST", "/labs/reports", {
      file_base64: pdf.toString("base64"), title: "Annual blood work", report_date: newDate,
      lab_name: "Sunrise Diagnostic Laboratory", ordered_by: "Dr. Samuel Okafor", file_name: "annual-bloodwork.pdf",
    });
    const reportId = up.report.report_id;
    // six months ago (worse) and this week (better), so trends show "improving"
    await call("POST", "/labs/results", { collected_date: oldDate, results: [
      { test_code: "total_cholesterol", value: 238 }, { test_code: "ldl", value: 158 }, { test_code: "hdl", value: 42 },
      { test_code: "triglycerides", value: 196 }, { test_code: "glucose", value: 142 }, { test_code: "a1c", value: 7.8 },
      { test_code: "potassium", value: 4.4 }, { test_code: "creatinine", value: 0.98 }, { test_code: "vitamin_d", value: 19 },
    ] });
    await call("POST", "/labs/results", { collected_date: newDate, report_id: reportId, results: [
      { test_code: "total_cholesterol", value: 212 }, { test_code: "ldl", value: 131 }, { test_code: "hdl", value: 46 },
      { test_code: "triglycerides", value: 168 }, { test_code: "glucose", value: 118 }, { test_code: "a1c", value: 7.1 },
      { test_code: "sodium", value: 139 }, { test_code: "potassium", value: 4.6 }, { test_code: "creatinine", value: 1.02 },
      { test_code: "egfr", value: 68 }, { test_code: "alt", value: 31 }, { test_code: "vitamin_d", value: 24 },
      { test_code: "tsh", value: 2.1 },
    ] });
    return "1 PDF report + 22 results from 2 dates (6 out of range, most improving)";
  });

  // ---------- links ----------
  await section("My Links", async () => {
    const list = [
      { title: "Example Health Plan member portal", url: "https://example.com", category: "insurance", organization: "Example Health Plan", phone: "(800) 555-0100", member_id_hint: "4821", is_favorite: true },
      { title: "Sunshine Pharmacy refills", url: "https://www.example.com/sunshine-pharmacy", category: "pharmacy", organization: "Sunshine Pharmacy – Glades Rd", phone: "(561) 555-0133", notes: "Open until 9pm; drive-through", is_favorite: true },
      { title: "Boca Family Health patient portal", url: "https://www.example.com/boca-family-health", category: "patient_portal", organization: "Dr. Samuel Okafor's office", phone: "(561) 555-0170" },
      { title: "Quest lab results", url: "https://www.questdiagnostics.com", category: "lab_results" },
      { title: "Glucose meter app", url: "https://www.example.com/glucose-app", category: "device_app", notes: "Syncs my meter readings" },
      { title: "MotionWorks PT exercises", url: "https://www.example.com/motionworks", category: "provider", notes: "Home knee exercises" },
    ];
    for (const body of list) await call("POST", "/links", body);
    return `${list.length} links`;
  });

  // ---------- health documents (2 PDFs + 1 PNG card, through the same upload checks as the website) ----------
  await section("Health documents", async () => {
    for (const d of DEMO_DOCUMENTS) {
      await call("POST", "/documents", { title: d.title, category: d.category, provider: d.provider, document_date: ymd(daysAgo(d.ago)),
        notes: d.notes, tags: d.tags, file_name: d.file_name, file_base64: d.file_base64 });
    }
    return `${DEMO_DOCUMENTS.length} files (2 PDFs, 1 PNG card)`;
  });

  // ---------- breathing devices ----------
  await section("Breathing devices", async () => {
    // APAP machine: 44 nights, and parts that are due or overdue
    const { start_ago, supplies_due, ...apap } = APAP_DEVICE;
    const made = await call("POST", "/respiratory/devices", { ...apap, start_date: ymd(daysAgo(start_ago)) });
    const apapId = made.device.device_id;
    for (let i = 0; i < APAP_NIGHTS.length; i += 11) {
      await Promise.all(APAP_NIGHTS.slice(i, i + 11).map(({ ago, ...night }) =>
        call("POST", "/respiratory/logs", { device_id: apapId, log_date: ymd(daysAgo(ago)), ...night })));
    }
    for (const due of supplies_due) {
      const part = made.supplies.find((s) => s.part_name === due.part_name);
      if (!part) throw new Error(`no "${due.part_name}" on the default parts list`);
      await call("PUT", `/respiratory/supplies/${part.supply_id}`, { last_replaced: ymd(daysAgo(due.days_since)) });
    }
    // peak flow meter with readings
    const { start_ago: pfStart, ...pf } = PEAK_FLOW_DEVICE;
    const meter = await call("POST", "/respiratory/devices", { ...pf, start_date: ymd(daysAgo(pfStart)) });
    for (const { ago, ...reading } of PEAK_FLOW_READINGS) {
      await call("POST", "/respiratory/logs", { device_id: meter.device.device_id, log_date: ymd(daysAgo(ago)), ...reading });
    }
    return `APAP with ${APAP_NIGHTS.length} nights and ${supplies_due.length} parts due, peak flow meter with ${PEAK_FLOW_READINGS.length} readings`;
  });

  // ---------- leftover medicines and a disposal already done ----------
  const medBody = ({ start_ago, end_ago, ...m }) => ({
    ...m,
    ...(start_ago != null ? { start_date: ymd(daysAgo(start_ago)) } : {}),
    ...(end_ago != null ? { end_date: ymd(daysAgo(end_ago)) } : {}),
  });
  await section("Leftover medicines", async () => {
    for (const m of LEFTOVER_MEDS) await call("POST", "/medications", medBody(m));
    const d = await call("GET", "/disposal/due");
    return `${LEFTOVER_MEDS.length} stopped medicines still on hand (${d.medications.filter((x) => x.guidance.on_flush_list).length} on the flush list)`;
  });
  await section("Past disposal", async () => {
    const r = await call("POST", "/medications", medBody(PAST_DISPOSAL.medication));
    await call("POST", "/disposal/logs", {
      medication_id: r.medication.medication_id, quantity: PAST_DISPOSAL.quantity, method: PAST_DISPOSAL.method,
      location: PAST_DISPOSAL.location, notes: PAST_DISPOSAL.notes, disposed_date: ymd(daysAgo(PAST_DISPOSAL.ago)),
    });
    return `${PAST_DISPOSAL.medication.medication_name} disposed ${PAST_DISPOSAL.ago} days ago`;
  });

  // ---------- reminders and waiting notifications ----------
  const reminderIds = {};
  const medIdByName = {};
  await section("Reminders", async () => {
    const LINK_CLASS = { medication: ["Medication", "medication_name"], supply: ["DeviceSupply", "part_name"], event: ["CalendarEvent", "title"] };
    const linkedId = async ({ kind, name }) => {
      const [cls, field] = LINK_CLASS[kind];
      const row = await findOne(cls, { user_id: user.user_id, [field]: name });
      if (!row) throw new Error(`nothing named "${name}" to link a reminder to`);
      return row.id;
    };
    for (const { link, ahead, ...r } of DEMO_REMINDERS) {
      const body = { time_zone: DEMO_TIME_ZONE, ...r };
      if (link) {
        body.linked_id = await linkedId(link);
        if (link.kind === "medication") medIdByName[link.name] = body.linked_id;
      }
      if (ahead) body.remind_at = daysAhead(ahead.days, ahead.hour, ahead.minute).toISOString();
      const res = await call("POST", "/reminders", body);
      reminderIds[r.title] = res.reminder.reminder_id;
    }
    const kinds = new Set(DEMO_REMINDERS.map((r) => r.reminder_type));
    return `${DEMO_REMINDERS.length} reminders (${kinds.size} types, daily, weekly and one-time)`;
  });
  await section("Notifications", async () => {
    let n = 0;
    for (const note of DEMO_NOTIFICATIONS) {
      const { link_medication, reminder, ...values } = note;
      if (link_medication) {
        const id = medIdByName[link_medication];
        if (!id) throw new Error(`no linked medicine "${link_medication}" for a notification`);
        values.link = `${values.link}?medication_id=${encodeURIComponent(id)}`;
      }
      await save(new Parse.Object("Notification"), {
        user_id: user.user_id, ...values, reminder_id: reminderIds[reminder] || null, dedupe_key: `seed:${n}:${values.title}`,
      });
      n++;
    }
    // a real sweep adds the automatic alerts for what is above: low stock, parts due, leftover medicines
    const inbox = await call("GET", "/notifications");
    return `${n} reminder notifications + automatic alerts; ${inbox.unread} unread`;
  });

  // ---------- safety check (allergies x medications) ----------
  await section("Medication safety check", async () => {
    const r = await call("GET", "/safety/alerts");
    return `${r.alerts.length} warning(s) found`;
  });

  // ---------- share codes ----------
  const codes = {};
  await section("Share codes", async () => {
    const sections = ["record", "medications", "vitals", "diary"];
    codes.provider = (await call("POST", "/share", { audience: "provider", sections, label: "Dr. Okafor – check-up", expiresHours: 168 })).shareCode;
    codes.family = (await call("POST", "/share", { audience: "family", sections, label: "Carlos", expiresHours: 168 })).shareCode;
    return "1 provider code + 1 family code (7 days)";
  });

  return {
    results,
    logins: {
      patient: `${PATIENT.email} / ${PATIENT.password}`,
      doctor: `${DOCTOR.email} / ${DOCTOR.password} (NPI ${npi})`,
    },
    shareCodes: codes,
  };
}

module.exports = {
  seedDemo,
  // the data tables, exported so a test can check their counts without a server
  DEMO_DOCUMENTS, APAP_DEVICE, APAP_NIGHTS, PEAK_FLOW_DEVICE, PEAK_FLOW_READINGS,
  LEFTOVER_MEDS, PAST_DISPOSAL, DEMO_REMINDERS, DEMO_NOTIFICATIONS, REPEATING_EVENT,
  PATIENT_DOB, PATIENT_DOB_TEXT,
};
