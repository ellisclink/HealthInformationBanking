// disposal.ts — the only browser file that reads and writes DisposalLog (the Safe Disposal page), with the Parse SDK.
// Cloud Code triggers (RULES.DisposalLog in Parse/cloud/lib/access.js) guard every request: own rows only, patients only,
// the old POST /disposal/logs rules (disposal.js: quantity, method, date, a medication_id that is your own, no more than
// is on hand), and the audit log. After a disposal the server takes the quantity off the medicine's count (atomic, never
// below 0) and marks a used-up active medicine completed. An entry is never edited; removing one keeps the count.
//   - never send user_id; send the owner ACL on create only (the server overwrites it)
//   - quantity as a number; dates as YYYY-MM-DD text
// The leftover list (the old GET /disposal/due) is built here from the caller's Medication rows; the methods and the
// guidance rules are in disposalGuide.ts.
import Parse from "../parse";
import { run } from "./parseCall";
import { GENERAL_NOTE, guidanceFor, type Guidance } from "./disposalGuide";
import { MAX_ROWS, ownerAcl, textOrNull, iso } from "./common";

export { methods as disposalMethods, guidance as disposalGuidance } from "./disposalGuide";

export type DisposalLogRow = {
  disposal_id: string; user_id: string | null; medication_id: string | null; medication_name: string; method: string;
  location: string | null; disposed_date: string; notes: string | null; quantity: number; created_at: string | null; updated_at: string | null;
};
export type DueMedication = {
  medication_id: string; medication_name: string; brand_name: string | null; dosage_form: string | null;
  quantity_on_hand: number; status: string; end_date: string | null; guidance: Guidance;
};
export type DisposalInput = Partial<{
  medication_id: string; medication_name: string; quantity: number; method: string; location: string; disposed_date: string; notes: string;
}>;

// the server's today (UTC), as db.today()
const todayUtc = () => new Date().toISOString().slice(0, 10);

// disposal.js logRow()
function toLog(o: Parse.Object): DisposalLogRow {
  return {
    disposal_id: o.id, user_id: textOrNull(o.get("user_id")), medication_id: textOrNull(o.get("medication_id")),
    medication_name: o.get("medication_name") || "", method: o.get("method") || "", location: textOrNull(o.get("location")),
    disposed_date: o.get("disposed_date") || "", notes: textOrNull(o.get("notes")), quantity: Number(o.get("quantity")),
    created_at: iso(o.createdAt), updated_at: iso(o.updatedAt),
  };
}

// GET /disposal/due: medicines still on hand that are stopped, completed or past their end date (flush list first)
export function disposalDue(): Promise<{ medications: DueMedication[]; note: string }> {
  return run(async () => {
    const t = todayUtc();
    const meds = await new Parse.Query("Medication").limit(MAX_ROWS).find();
    const rows = meds
      .map((m) => ({
        medication_id: m.id, medication_name: m.get("medication_name") ?? null, brand_name: m.get("brand_name") ?? null,
        dosage_form: m.get("dosage_form") ?? null, quantity_on_hand: m.get("quantity_on_hand"), status: m.get("status") ?? null,
        end_date: m.get("end_date") ?? null, route: m.get("route") ?? null,
      }))
      .filter((m) => Number(m.quantity_on_hand) > 0 &&
        (m.status === "completed" || m.status === "discontinued" || (m.end_date && m.end_date < t)))
      // the route (transdermal, inhalation, injection) picks the method too; it is not in the answer
      .map(({ route, ...m }) => ({ ...m, quantity_on_hand: Number(m.quantity_on_hand), guidance: guidanceFor({ ...m, route }) }));
    rows.sort((a, b) => Number(b.guidance.on_flush_list) - Number(a.guidance.on_flush_list) ||
      String(a.medication_name || "").localeCompare(String(b.medication_name || "")));
    return { medications: rows as DueMedication[], note: GENERAL_NOTE };
  });
}

// GET /disposal/logs: newest disposal date first
export function listDisposals(): Promise<{ logs: DisposalLogRow[] }> {
  return run(async () => ({ logs: (await new Parse.Query("DisposalLog").descending("disposed_date").limit(MAX_ROWS).find()).map(toLog) }));
}

// POST /disposal/logs {medication_id | medication_name, quantity, method, location?, disposed_date?, notes?}
export function recordDisposal(input: DisposalInput): Promise<{ message: string; log: DisposalLogRow }> {
  return run(async () => {
    const o = new Parse.Object("DisposalLog");
    for (const [k, v] of Object.entries(input)) if (v !== undefined && v !== null && v !== "") o.set(k, v);
    o.setACL(ownerAcl());
    await o.save();
    return { message: "Disposal recorded", log: toLog(o) };
  });
}

// DELETE /disposal/logs/:id: the history entry only; the count is not changed back
export function removeDisposal(id: string): Promise<{ message: string }> {
  return run(async () => {
    const o = new Parse.Object("DisposalLog");
    o.id = id;
    await o.destroy();
    return { message: "Disposal record removed" };
  });
}
