// medications.ts — the only browser file that reads and writes Medication, DoseLog and Refill, with the Parse SDK.
// Cloud Code triggers (Parse/cloud/lib/access.js) guard every request: own rows only, patients only, field and type
// checks, the pill count on a new DoseLog / Refill, and the audit log. This file reproduces what the old api routes
// (Parse/cloud/lib/medications.js) returned: the same order, row shape and warning texts.
//   - never send user_id (the server sets it; on DoseLog/Refill it is refused)
//   - send the owner ACL on create only (the server overwrites it); never on update (a changed ACL is refused)
//   - plain values only (no increment/add ops); numbers as numbers; clearing a field = unset
import Parse from "../parse";
import { run } from "./parseCall";
import { withInventoryInfo, summarize } from "./medicationMath";
import type { Med, MedRow, Dose, Refill, Summary } from "./medicationMath";

export type { Med, MedRow, Dose, Refill, Summary };

// The body the page builds for a new medication (Medications.tsx addMedication).
export type NewMedication = {
  medication_name: string;
  medication_type?: MedRow["medication_type"];
  dosage_form?: string;
  dose_amount?: number;
  dose_unit?: string;
  frequency?: string;
  quantity_on_hand?: number;
  start_date?: string;
  strength?: number;
  strength_unit?: string;
  refill_threshold?: number;
  refills_remaining?: number;
  pharmacy_name?: string;
  purpose?: string;
  instructions?: string;
};

export type MedicationChanges = { [K in keyof (NewMedication & { status: Med["status"] })]?: (NewMedication & { status: Med["status"] })[K] | null };

// same list and order as MED_FIELDS in medications.js
const MED_FIELDS = ["user_id", "medication_name", "medication_type", "brand_name", "rxnorm_code", "ndc_code",
  "strength", "strength_unit", "dosage_form", "route", "dose_amount", "dose_unit", "frequency", "schedule_times",
  "instructions", "purpose", "condition_id", "prescriber_name", "pharmacy_name", "status", "start_date", "end_date",
  "discontinued_reason", "quantity_on_hand", "refill_threshold", "refills_remaining", "last_refill_date", "source", "notes"] as const;

const DAY_MS = 86400000;
const MAX_ROWS = 10000;   // same cap as findAll() on the server
const RECENT_DOSES = 20;  // getById(): the 20 newest doses

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v === undefined || v === null ? null : (v as string));

// toRow() in db.js: every field (missing -> null, Date -> ISO text), plus the id and created/updated times
function medRow(o: Parse.Object): MedRow {
  const row: Record<string, unknown> = { medication_id: o.id };
  for (const f of MED_FIELDS) {
    const v = o.get(f);
    row[f] = v === undefined ? null : v instanceof Date ? v.toISOString() : v;
  }
  row.created_at = o.createdAt ? o.createdAt.toISOString() : null;
  row.updated_at = o.updatedAt ? o.updatedAt.toISOString() : null;
  return row as MedRow;
}

const toMed = (o: Parse.Object): Med => withInventoryInfo(medRow(o), new Date());

function doseRow(o: Parse.Object): Dose {
  return {
    dose_log_id: o.id, medication_id: o.get("medication_id"), taken_at: iso(o.get("taken_at")) ?? "",
    dose_status: o.get("dose_status"), quantity: Number(o.get("quantity") ?? 0),
  };
}

function refillRow(o: Parse.Object): Refill {
  return {
    refill_id: o.id, refill_date: o.get("refill_date"), quantity_added: Number(o.get("quantity_added")),
    pharmacy_name: o.get("pharmacy_name") ?? null,
  };
}

// owner read + write, nothing public (the server sets the same ACL anyway, D-019)
function ownerAcl(): Parse.ACL {
  const acl = new Parse.ACL();
  acl.setPublicReadAccess(false);
  acl.setPublicWriteAccess(false);
  const user = Parse.User.current();
  if (user) { acl.setReadAccess(user, true); acl.setWriteAccess(user, true); }
  return acl;
}

const getMedication = (id: string) => new Parse.Query("Medication").get(id);

// list(): active first, then by name
export function listMedications(): Promise<Med[]> {
  return run(async () => {
    const rows = (await new Parse.Query("Medication").limit(MAX_ROWS).find()).map(medRow);
    rows.sort((a, b) => (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1) || a.medication_name.localeCompare(b.medication_name));
    const now = new Date();
    return rows.map((r) => withInventoryInfo(r, now));
  });
}

// one medication by id (the notification bell has only the id; logDose needs the row)
export function getMedicationById(id: string): Promise<Med> {
  return run(async () => toMed(await getMedication(id)));
}

// summary(): counts, low stock, adherence from the last 30 days of doses
export function medicationSummary(meds: Med[]): Promise<Summary> {
  return run(async () => {
    const now = new Date();
    const since = new Date(now.getTime() - 30 * DAY_MS);
    const doses = (await new Parse.Query("DoseLog").greaterThanOrEqualTo("taken_at", since).limit(MAX_ROWS).find()).map(doseRow);
    return summarize(meds, doses, now);
  });
}

// getById(): the 20 newest doses and every refill, newest first
export function getHistory(id: string): Promise<{ doses: Dose[]; refills: Refill[] }> {
  return run(async () => {
    const [doses, refills] = await Promise.all([
      new Parse.Query("DoseLog").equalTo("medication_id", id).descending("taken_at").limit(RECENT_DOSES).find(),
      new Parse.Query("Refill").equalTo("medication_id", id).descending("refill_date").addDescending("createdAt").limit(MAX_ROWS).find(),
    ]);
    return { doses: doses.map(doseRow), refills: refills.map(refillRow) };
  });
}

// createMed(): the server fills in defaults and the end_date rule; returns the saved medication
export function addMedication(input: NewMedication): Promise<Med> {
  return run(async () => {
    const med = new Parse.Object("Medication");
    for (const [k, v] of Object.entries(input)) if (v !== undefined && v !== null) med.set(k, v);
    med.setACL(ownerAcl());
    await med.save();
    return toMed(await getMedication(med.id));   // re-read: the server filled in defaults
  });
}

// update(): partial; null or "" clears the field (unset); no ACL is sent
export function updateMedication(id: string, changes: MedicationChanges): Promise<Med> {
  return run(async () => {
    const med = await getMedication(id);
    for (const [k, v] of Object.entries(changes)) {
      if (v === undefined) continue;
      if (v === null || v === "") med.unset(k);
      else med.set(k, v);
    }
    await med.save();
    return toMed(await getMedication(id));   // re-read: the server may have set or cleared end_date
  });
}

// remove(): the server removes the doses, refills and safety alerts with it
export function deleteMedication(id: string): Promise<void> {
  return run(async () => {
    const med = new Parse.Object("Medication");
    med.id = id;
    await med.destroy();
  });
}

// logDose(): the server's afterSave lowers the count (never below 0), so re-read the medication afterwards
export function logDose(med: Med, status: "taken" | "skipped"): Promise<{ medication: Med; inventoryWarning?: string }> {
  return run(async () => {
    const onHand = Number(med.quantity_on_hand || 0);
    const dose = new Parse.Object("DoseLog");
    dose.set({ medication_id: med.medication_id, dose_status: status });   // taken_at: the server's clock (now)
    dose.setACL(ownerAcl());
    await dose.save();
    const quantity = Number(dose.get("quantity")) || 0;   // set by the server: dose_amount when taken, 0 when skipped
    const medication = toMed(await getMedication(med.medication_id));
    if (quantity > onHand) {
      return {
        medication,
        inventoryWarning: `Logged ${quantity} but only ${onHand} were on hand; count set to 0. Record a refill or correct quantity_on_hand.`,
      };
    }
    return { medication };
  });
}

// addRefill(): the server's afterSave adds to the count, moves last_refill_date and uses one refill
export function addRefill(med: Med, quantity: number): Promise<{ medication: Med; refillWarning?: string }> {
  return run(async () => {
    const refillsBefore = med.refills_remaining;
    const refill = new Parse.Object("Refill");
    refill.set({ medication_id: med.medication_id, quantity_added: quantity });
    refill.setACL(ownerAcl());
    await refill.save();
    const medication = toMed(await getMedication(med.medication_id));
    if (refillsBefore === 0) return { medication, refillWarning: "No refills were remaining on this prescription; check with the prescriber." };
    return { medication };
  });
}
