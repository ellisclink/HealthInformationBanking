// emergencyRules.ts — pure helpers for the Emergency Access page (no Parse, so Node can load them): the option lists and
// the disclaimer copied from Parse/cloud/lib/emergency.js, its settingsOf(), and the responder view (snapshot) built from
// plain rows. Keep these the same as emergency.js: the responder page (/emergency-access) is still built by the server.

export type Contact = { name: string; phone: string; relationship: string | null };
export type Settings = {
  enabled: boolean; sections: string[]; blood_type: string | null; medical_notes: string | null; contacts: Contact[];
  code_status: string; declined_measures: string[]; directive_notes: string | null; polst_on_file: boolean;
  directive_document_id: string | null; share_directive_document: boolean; directive_updated_at: string | null; updated_at: string | null;
};
export type Options = {
  code_statuses: { value: string; label: string }[]; measures: { value: string; label: string }[];
  implied_by_status: Record<string, string[]>; sections: string[]; blood_types: string[]; max_contacts: number;
};

export const CODE_STATUSES = ["not_set", "full_code", "dnr", "dnr_dni", "comfort_measures_only"];
export const CODE_STATUS_LABELS: Record<string, string> = {
  not_set: "No directive recorded",
  full_code: "Full code — wants all life-saving treatment",
  dnr: "DNR — do not attempt CPR",
  dnr_dni: "DNR / DNI — no CPR and no intubation",
  comfort_measures_only: "Comfort measures only — no life-prolonging treatment",
};
export const MEASURES: Record<string, string> = {
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
export const IMPLIED: Record<string, string[]> = {
  not_set: [], full_code: [],
  dnr: ["cpr"],
  dnr_dni: ["cpr", "intubation_ventilation"],
  comfort_measures_only: ["cpr", "defibrillation", "intubation_ventilation", "vasopressors", "icu_admission"],
};
export const SECTIONS = ["allergies", "medications", "conditions", "contacts", "devices"];
export const BLOOD_TYPES = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-", "unknown"];
export const MAX_CONTACTS = 5;
export const DISCLAIMER = "These are the patient's own stated wishes, entered in the Health Information Banking app. They are not a medical order. "
  + "If a signed POLST/MOLST/DNR form is available, follow that form.";

// the old GET /emergency/settings "options"
export function options(): Options {
  return {
    code_statuses: CODE_STATUSES.map((value) => ({ value, label: CODE_STATUS_LABELS[value] })),
    measures: Object.entries(MEASURES).map(([value, label]) => ({ value, label })),
    implied_by_status: IMPLIED, sections: SECTIONS, blood_types: BLOOD_TYPES, max_contacts: MAX_CONTACTS,
  };
}

const DEFAULTS: Record<string, unknown> = {
  enabled: false, sections: [...SECTIONS], blood_type: null, medical_notes: null, contacts: [],
  code_status: "not_set", declined_measures: [], directive_notes: null, polst_on_file: false,
  directive_document_id: null, share_directive_document: false,
};
const iso = (d: unknown): string | null => (d instanceof Date ? d.toISOString() : typeof d === "string" ? d : null);

// A stored row as its plain attributes (or null for none). emergency.js settingsOf()
export type ProfileRow = { attrs: Record<string, unknown>; updatedAt: Date | null } | null;
export function settingsOf(row: ProfileRow): Settings {
  const get = (k: string) => {
    const v = row ? row.attrs[k] : undefined;
    return v !== undefined && v !== null ? v : DEFAULTS[k];
  };
  return {
    enabled: !!get("enabled"), sections: get("sections") as string[], blood_type: get("blood_type") as string | null,
    medical_notes: get("medical_notes") as string | null, contacts: get("contacts") as Contact[], code_status: get("code_status") as string,
    declined_measures: get("declined_measures") as string[], directive_notes: get("directive_notes") as string | null,
    polst_on_file: !!get("polst_on_file"), directive_document_id: get("directive_document_id") as string | null,
    share_directive_document: !!get("share_directive_document"),
    directive_updated_at: iso(row && row.attrs.directive_updated_at),
    updated_at: iso(row && row.updatedAt),
  };
}

// the patient's age today (UTC), from a YYYY-MM-DD date of birth (emergency.js ageOn)
function ageOn(dob: unknown, now = new Date()): number | null {
  if (typeof dob !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(dob)) return null;
  const b = new Date(dob.slice(0, 10) + "T00:00:00Z");
  if (isNaN(b.getTime())) return null;
  let age = now.getUTCFullYear() - b.getUTCFullYear();
  if (now.getUTCMonth() < b.getUTCMonth() || (now.getUTCMonth() === b.getUTCMonth() && now.getUTCDate() < b.getUTCDate())) age--;
  return age >= 0 && age < 150 ? age : null;
}

function directivesView(s: Settings) {
  if (s.code_status === "not_set" && !s.declined_measures.length && !s.directive_notes) return null;
  const declined = s.declined_measures.map((m) => ({ measure: m, label: MEASURES[m] }));
  const headline = s.code_status !== "not_set" ? CODE_STATUS_LABELS[s.code_status]
    : declined.length ? `Declines: ${declined.map((d) => d.label).join("; ")}` : "See notes";
  return {
    alert: headline, code_status: s.code_status, code_status_label: CODE_STATUS_LABELS[s.code_status],
    declined_measures: declined,
    wants_all_treatment: s.code_status === "full_code" && !declined.length,
    notes: s.directive_notes, signed_order_on_file: s.polst_on_file,
    document_available: !!(s.directive_document_id && s.share_directive_document),
    last_updated: s.directive_updated_at, disclaimer: DISCLAIMER,
  };
}

type Attrs = Record<string, unknown>;
const n = (v: unknown) => (v === undefined ? null : v);
export type SnapshotInput = {
  settings: Settings; patientName: string | null; record: Attrs;
  allergies: Attrs[]; medications: Attrs[]; conditions: Attrs[]; devices: Attrs[];
};
// What a responder sees with these settings (emergency.js snapshot(); the same keys in the same order)
export function snapshot({ settings: s, patientName, record, allergies, medications, conditions, devices }: SnapshotInput, now = new Date()) {
  const data = record || {};
  const p = (data.patient && typeof data.patient === "object" ? data.patient : {}) as Attrs;
  const out: Record<string, unknown> = {
    patient: { name: patientName ?? undefined, date_of_birth: p.dob || null, age: ageOn(p.dob, now), sex: p.sex || null, blood_type: s.blood_type },
    directives: directivesView(s),
    medical_notes: s.medical_notes,
  };
  if (s.sections.includes("allergies")) {
    const list = allergies.filter((a) => (a.status || "active") === "active")
      .map((a) => ({ allergen: a.allergen, reaction: n(a.reaction), severity: n(a.severity) }));
    out.allergies = list;
    out.no_known_allergies = !list.length && !!data.no_known_allergies;
  }
  if (s.sections.includes("medications")) {
    out.medications = medications.filter((m) => m.status === "active")
      .sort((a, b) => String(a.medication_name).localeCompare(String(b.medication_name)))
      .map((m) => ({ medication_name: m.medication_name, strength: n(m.strength), strength_unit: n(m.strength_unit),
        dose_amount: n(m.dose_amount), dose_unit: n(m.dose_unit), frequency: n(m.frequency) }));
  }
  if (s.sections.includes("conditions")) {
    out.conditions = conditions.filter((c) => ["active", "managed"].includes(String(c.status)))
      .map((c) => ({ condition_name: c.condition_name, severity: n(c.severity) }));
  }
  if (s.sections.includes("contacts")) {
    out.contacts = [...(p.emergency_contact ? [{ name: String(p.emergency_contact).slice(0, 200), phone: null, relationship: null }] : []), ...s.contacts];
  }
  if (s.sections.includes("devices")) {
    out.devices = devices.filter((d) => d.is_active !== false).map((d) => ({
      device_type: d.device_type, name: n(d.name), flow_lpm: n(d.flow_lpm),
      pressure_min: n(d.pressure_min), pressure_max: n(d.pressure_max), epap: n(d.epap), ipap: n(d.ipap),
    }));
  }
  out.sections = s.sections;
  return out;
}
