// records.ts — the only browser file that reads and saves MedicalRecord (the Health History form), with the Parse SDK.
// Cloud Code triggers (RULES.MedicalRecord in Parse/cloud/lib/access.js) guard every request: own row only, patients only,
// one row per user, only `data` (an object, at most 500,000 characters as JSON) may be sent, and the audit log. After
// every save the server copies the form's allergies to the Allergy list (the medication safety checks use it).
//   - never send user_id or the legacy verified_* fields (the server refuses them)
//   - send the owner ACL on create only (the server overwrites it); never on update
// Share codes, the shared view and the access log stay on the server (api /share, /shared).
import Parse from "../parse";
import { run } from "./parseCall";
import { ownerAcl } from "./common";

export type RecordReply = { data: Record<string, unknown>; updated_at: string | null };

const RECORD_EXISTS = "Your health history is already saved";   // records.js RECORD_EXISTS

// the row that counts: the oldest (one per user; see records.js keepOldest)
const recordRow = () => new Parse.Query("MedicalRecord").ascending("createdAt").addAscending("objectId").first();
const view = (row: Parse.Object | undefined): RecordReply => {
  const data = row && row.get("data");
  return {
    data: data && typeof data === "object" && !Array.isArray(data) ? data : {},
    updated_at: row && row.updatedAt ? row.updatedAt.toISOString() : null,
  };
};

// the old GET /records. No row yet = the empty form (nothing is created by reading; every new account already has one)
export function getRecord(): Promise<RecordReply> {
  return run(async () => view(await recordRow()));
}

async function editRecord(id: string, data: Record<string, unknown>): Promise<void> {
  const obj = new Parse.Object("MedicalRecord");
  obj.id = id;
  obj.set("data", data);
  await obj.save();
}

// the old PUT /records {data}: the whole form is replaced. The first save creates the row.
export function putRecord(data: Record<string, unknown>): Promise<{ ok: true; updated_at: string | null }> {
  return run(async () => {
    const row = await recordRow();
    if (row) await editRecord(row.id, data);
    else {
      const obj = new Parse.Object("MedicalRecord");
      obj.set("data", data);
      obj.setACL(ownerAcl());
      let created: Parse.Object | null = null;
      try { created = await obj.save(); }
      catch (err) { if (!(err instanceof Error && err.message === RECORD_EXISTS)) throw err; }
      // another tab made the row at the same moment: ours was refused or removed again, so save to the one that is kept
      const kept = await recordRow();
      if (kept && (!created || kept.id !== created.id)) await editRecord(kept.id, data);
    }
    return { ok: true, updated_at: view(await recordRow()).updated_at };
  });
}
