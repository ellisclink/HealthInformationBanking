// safety.ts — the browser side of the medication safety warnings and the allergy list, with the Parse SDK.
// The checks themselves stay on the server (they write SafetyAlert rows from the drug reference, which only the server
// may do): POST /safety/recheck re-checks every medication and saves the warnings, POST /safety/check checks a new one.
// Cloud Code triggers (RULES.SafetyAlert / RULES.Allergy in Parse/cloud/lib/access.js) guard the rest:
//   - SafetyAlert: own rows only; never created or removed here; an edit may only set acknowledged_at (the server
//     stores its own time) with an optional acknowledged_note, or clear it (takes the acknowledgement back)
//   - Allergy: own rows only; the website only lists them (allergies are entered on the Health History form, and the
//     server copies them here). The rules would also allow a browser add / edit / remove of its own rows, but no page
//     does that; the rows copied from the form can only be changed on that form
import Parse from "../parse";
import { api } from "../api";
import { run } from "./parseCall";
import { MAX_ROWS, textOrNull, iso } from "./common";

export type Severity = "major" | "moderate" | "minor";
export type AlertRow = {
  alert_id: string; user_id: string | null; alert_key: string; alert_type: "allergy" | "cross_reactivity" | "interaction" | "duplicate_therapy";
  severity: Severity; medication_id: string | null; medication_name: string | null; related_medication_id: string | null;
  related_medication_name: string | null; allergy_id: string | null; title: string; message: string; advice: string;
  acknowledged_at: string | null; acknowledged_note: string | null; first_detected_at: string | null; last_checked_at: string | null;
  created_at: string | null; updated_at: string | null;
};
export type AllergyRow = {
  allergy_id: string; user_id: string | null; allergen: string; allergen_key: string; allergen_type: string | null;
  drug_classes: string[]; reaction: string | null; severity: string | null; status: string | null; source: string | null;
  created_at: string | null; updated_at: string | null;
};
type RecheckInfo = { medications_checked: number; allergies_checked: number; disclaimer: string; reference: { version: string; note: string } };

const SEVERITY_RANK: Record<string, number> = { major: 0, moderate: 1, minor: 2 };

// safety.js alertRow()
function toAlert(o: Parse.Object): AlertRow {
  return {
    alert_id: o.id, user_id: textOrNull(o.get("user_id")), alert_key: o.get("alert_key") || "", alert_type: o.get("alert_type"),
    severity: o.get("severity"), medication_id: textOrNull(o.get("medication_id")), medication_name: textOrNull(o.get("medication_name")),
    related_medication_id: textOrNull(o.get("related_medication_id")), related_medication_name: textOrNull(o.get("related_medication_name")),
    allergy_id: textOrNull(o.get("allergy_id")), title: o.get("title") || "", message: o.get("message") || "", advice: o.get("advice") || "",
    acknowledged_at: iso(o.get("acknowledged_at")), acknowledged_note: textOrNull(o.get("acknowledged_note")),
    first_detected_at: iso(o.get("first_detected_at")), last_checked_at: iso(o.get("last_checked_at")),
    created_at: iso(o.createdAt), updated_at: iso(o.updatedAt),
  };
}
// safety.js allergyRow()
function toAllergy(o: Parse.Object): AllergyRow {
  const classes = o.get("drug_classes");
  return {
    allergy_id: o.id, user_id: textOrNull(o.get("user_id")), allergen: o.get("allergen") || "", allergen_key: o.get("allergen_key") || "",
    allergen_type: textOrNull(o.get("allergen_type")), drug_classes: Array.isArray(classes) ? classes : [], reaction: textOrNull(o.get("reaction")),
    severity: textOrNull(o.get("severity")), status: textOrNull(o.get("status")), source: textOrNull(o.get("source")),
    created_at: iso(o.createdAt), updated_at: iso(o.updatedAt),
  };
}

// open ones first, then the most serious, then by title (safety.js sortAlerts)
const sortAlerts = (list: AlertRow[]) => list.sort((x, y) =>
  (x.acknowledged_at ? 1 : 0) - (y.acknowledged_at ? 1 : 0) ||
  SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity] ||
  x.title.localeCompare(y.title));

// the old GET /safety/alerts: re-check on the server (saves the warnings, keeps acknowledgements), then read them
export function listAlerts(): Promise<RecheckInfo & { alerts: AlertRow[]; open_count: number; major_open_count: number }> {
  return run(async () => {
    const info = await api<RecheckInfo>("/safety/recheck", { method: "POST", body: "{}" });
    const alerts = sortAlerts((await new Parse.Query("SafetyAlert").limit(MAX_ROWS).find()).map(toAlert));
    const open = alerts.filter((a) => !a.acknowledged_at);
    return {
      alerts, open_count: open.length, major_open_count: open.filter((a) => a.severity === "major").length,
      medications_checked: info.medications_checked, allergies_checked: info.allergies_checked, disclaimer: info.disclaimer, reference: info.reference,
    };
  });
}

// the old POST /safety/alerts/:id/acknowledge {acknowledged, note?}
export function acknowledgeAlert(id: string, acknowledged = true, note?: string): Promise<{ alert: AlertRow }> {
  return run(async () => {
    const o = new Parse.Object("SafetyAlert");
    o.id = id;
    if (acknowledged) {
      o.set("acknowledged_at", new Date());   // a placeholder: the server stores its own time
      if (note && note.trim()) o.set("acknowledged_note", note);
    } else {
      o.unset("acknowledged_at");
    }
    await o.save();
    return { alert: toAlert(await new Parse.Query("SafetyAlert").get(id)) };
  });
}

// the caller's active allergies, by allergen (the old GET /safety/allergies, without the drug family names)
export function listAllergies(): Promise<{ allergies: AllergyRow[]; count: number }> {
  return run(async () => {
    const rows = (await new Parse.Query("Allergy").equalTo("status", "active").limit(MAX_ROWS).find()).map(toAllergy)
      .sort((a, b) => a.allergen.localeCompare(b.allergen));
    return { allergies: rows, count: rows.length };
  });
}
