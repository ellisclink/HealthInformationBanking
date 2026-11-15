// Health History form: one definition shared by the editable form (Medical Records
// page) and the read-only view (what doctors and family see through a share code).
// It's saved as the patient's record (MedicalRecord, with the Parse SDK: data/records.ts).
//
// Medications are NOT typed into this form any more: the form shows the patient's
// Medications tracker (listMedications() in data/medications.ts), split into prescription and
// non-prescription. `prescriptions` / `non_prescriptions` below only hold lines typed
// into older versions of the form, so they can be shown and moved to the tracker.

export const HEALTH_HISTORY_FORM = "health_history_v1";

export const RACE_OPTIONS = [
  "American Indian or Alaska Native", "Asian", "Black or African American", "Hispanic or Latino",
  "Native Hawaiian or Pacific Islander", "White", "Multiracial", "Other", "Prefer not to say",
];
export const SEX_OPTIONS = ["Male", "Female", "Intersex", "Prefer not to say"];
export const MARITAL_OPTIONS = ["Single", "Married", "Divorced", "Widowed", "Separated", "Domestic partner"];

// "None" is handled separately: checking it clears the others and vice versa.
export const CONDITIONS = [
  "Heart Disease", "High Blood Pressure", "Stroke/TIA", "Obstructive Sleep Apnea",
  "Coronary Artery Disease", "Depression", "Anxiety", "Bleeding Disorder",
  "Hepatitis A, B or C", "HIV", "Diabetes – Diet Controlled", "Diabetes – Oral Meds",
  "Diabetes – On Insulin", "High Cholesterol", "Loss of Consciousness", "Arthritis",
  "Asthma", "Emphysema/COPD", "Osteoporosis", "Kidney Disease", "Seizures",
  "Allergy: Food", "Allergy: Seasonal", "Tuberculosis (TB)", "Hypothyroid", "Hyperthyroid",
];

export const TOBACCO_OPTIONS = ["Never", "Former", "Current", "Vape/e-cigarette"];
export const ALCOHOL_OPTIONS = ["None", "Occasionally", "Weekly", "Daily"];

export const ROWS = 6; // numbered lines per list, like the paper form

export type Surgery = { type: string; year: string };
export type Medication = { name: string; dose: string };
export type Allergy = { allergen: string; reaction: string };
export type Immunization = { vaccine: string; date: string };

export type HealthHistory = {
  form: typeof HEALTH_HISTORY_FORM;
  patient: {
    name: string; dob: string; race: string[]; sex: string; marital_status: string;
    children: string; phone: string; email: string; address: string; emergency_contact: string;
    previous_physician: string; referring_physician: string;
  };
  conditions: string[];          // may include "None"
  arthritis_type: string;
  cancer: string;                // type / treatment
  other_conditions: string;
  surgeries: Surgery[];
  prescriptions: Medication[];      // older forms only (see top of file)
  non_prescriptions: Medication[];  // older forms only
  allergies: Allergy[];
  no_known_allergies: boolean;
  immunizations: Immunization[];
  family_history: string;
  social: { tobacco: string; alcohol: string; notes: string };
};

const rows = <T,>(make: () => T): T[] => Array.from({ length: ROWS }, make);

export function emptyHealthHistory(name = ""): HealthHistory {
  return {
    form: HEALTH_HISTORY_FORM,
    patient: {
      name, dob: "", race: [], sex: "", marital_status: "", children: "", phone: "", email: "", address: "",
      emergency_contact: "", previous_physician: "", referring_physician: "",
    },
    conditions: [], arthritis_type: "", cancer: "", other_conditions: "",
    surgeries: rows(() => ({ type: "", year: "" })),
    prescriptions: [],
    non_prescriptions: [],
    allergies: rows(() => ({ allergen: "", reaction: "" })),
    no_known_allergies: false,
    immunizations: rows(() => ({ vaccine: "", date: "" })),
    family_history: "",
    social: { tobacco: "", alcohol: "", notes: "" },
  };
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const strList = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
function padRows<T>(list: unknown, make: () => T, pick: (x: Record<string, unknown>) => T): T[] {
  const given = Array.isArray(list) ? list.filter((x) => x && typeof x === "object").map((x) => pick(x as Record<string, unknown>)) : [];
  while (given.length < ROWS) given.push(make());
  return given;
}

// Medication lines typed into an older version of the form (no blank padding rows)
const legacyMeds = (list: unknown): Medication[] =>
  (Array.isArray(list) ? list : [])
    .filter((x) => x && typeof x === "object")
    .map((x) => ({ name: str((x as Record<string, unknown>).name), dose: str((x as Record<string, unknown>).dose) }))
    .filter((m) => m.name.trim() || m.dose.trim());

// Turn whatever is saved (possibly nothing, or an older shape) into a complete form.
export function normalizeHealthHistory(data: unknown, fallbackName = ""): HealthHistory {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const p = (d.patient && typeof d.patient === "object" ? d.patient : {}) as Record<string, unknown>;
  const s = (d.social && typeof d.social === "object" ? d.social : {}) as Record<string, unknown>;
  return {
    form: HEALTH_HISTORY_FORM,
    patient: {
      name: str(p.name) || fallbackName, dob: str(p.dob), race: strList(p.race), sex: str(p.sex),
      marital_status: str(p.marital_status), children: str(p.children), phone: str(p.phone),
      email: str(p.email), address: str(p.address), emergency_contact: str(p.emergency_contact), previous_physician: str(p.previous_physician),
      referring_physician: str(p.referring_physician),
    },
    conditions: strList(d.conditions), arthritis_type: str(d.arthritis_type), cancer: str(d.cancer),
    other_conditions: str(d.other_conditions),
    surgeries: padRows(d.surgeries, () => ({ type: "", year: "" }), (x) => ({ type: str(x.type), year: str(x.year) })),
    prescriptions: legacyMeds(d.prescriptions),
    non_prescriptions: legacyMeds(d.non_prescriptions),
    allergies: padRows(d.allergies, () => ({ allergen: "", reaction: "" }), (x) => ({ allergen: str(x.allergen), reaction: str(x.reaction) })),
    no_known_allergies: d.no_known_allergies === true,
    immunizations: padRows(d.immunizations, () => ({ vaccine: "", date: "" }), (x) => ({ vaccine: str(x.vaccine), date: str(x.date) })),
    family_history: str(d.family_history),
    social: { tobacco: str(s.tobacco), alcohol: str(s.alcohol), notes: str(s.notes) },
  };
}

// Strip empty numbered lines before saving, so the stored record stays tidy.
export function compactHealthHistory(h: HealthHistory): HealthHistory {
  return {
    ...h,
    surgeries: h.surgeries.filter((r) => r.type.trim() || r.year.trim()),
    prescriptions: h.prescriptions.filter((r) => r.name.trim() || r.dose.trim()),
    non_prescriptions: h.non_prescriptions.filter((r) => r.name.trim() || r.dose.trim()),
    allergies: h.allergies.filter((r) => r.allergen.trim() || r.reaction.trim()),
    immunizations: h.immunizations.filter((r) => r.vaccine.trim() || r.date.trim()),
  };
}

export function ageFrom(dob: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return "";
  const b = new Date(`${dob}T00:00:00`);
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  if (now.getMonth() < b.getMonth() || (now.getMonth() === b.getMonth() && now.getDate() < b.getDate())) age--;
  return age >= 0 && age < 150 ? String(age) : "";
}

export const isHealthHistory = (data: unknown) =>
  !!data && typeof data === "object" && (data as { form?: unknown }).form === HEALTH_HISTORY_FORM;

// ---- medications from the Medications tracker, shown on the form ----
export type FormMedication = {
  medication_name: string; medication_type?: "prescription" | "non_prescription" | null;
  // numbers from the Medications tracker (data/medications.ts); text in older saved records
  strength: number | string | null; strength_unit: string | null;
  dose_amount: number | string | null; dose_unit: string | null; frequency: string | null;
};
const FREQ: Record<string, string> = {
  once_daily: "once a day", twice_daily: "twice a day", three_times_daily: "3 times a day",
  four_times_daily: "4 times a day", every_other_day: "every other day", weekly: "once a week", as_needed: "as needed",
};
const n = (v: number | string | null) => (v == null || v === "" ? "" : String(Number(v)));
// "Metformin 500 mg — 1 tablet, twice a day"
export function medicationLine(m: FormMedication) {
  const strength = m.strength ? ` ${n(m.strength)}${m.strength_unit ? ` ${m.strength_unit}` : ""}` : "";
  const amount = m.dose_amount ? `${n(m.dose_amount)} ${m.dose_unit ?? ""}`.trim() : "";
  const freq = m.frequency && FREQ[m.frequency] ? FREQ[m.frequency] : "";
  const dose = [amount, freq].filter(Boolean).join(", ");
  return `${m.medication_name}${strength}${dose ? ` — ${dose}` : ""}`;
}
export const isNonPrescription = (m: FormMedication) => m.medication_type === "non_prescription";
