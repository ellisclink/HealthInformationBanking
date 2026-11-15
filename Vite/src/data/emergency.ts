// emergency.ts — the only browser file that reads and saves EmergencyProfile (the Emergency Access settings), with the
// Parse SDK, and builds the "what a responder sees" preview from the patient's own rows. Cloud Code triggers
// (RULES.EmergencyProfile in Parse/cloud/lib/access.js) guard every request: own row only, patients only, one row per
// user, the old PUT /emergency/settings rules (emergency.js settingsValues), directive_updated_at set by the server, a
// directive document that must be one of your own documents, and the audit log.
//   - never send user_id or directive_updated_at (the server refuses them)
//   - send the owner ACL on create only (the server overwrites it); never on update
// The emergency code (GET / POST / DELETE /emergency/code), the access log and the responder page stay on the server.
import Parse from "../parse";
import { api, currentName } from "../api";
import { run } from "./parseCall";
import { DISCLAIMER, options, settingsOf, snapshot, type Options, type ProfileRow, type Settings } from "./emergencyRules";
import { MAX_ROWS, ownerAcl, isBlank } from "./common";

export type { Settings, Options };
export type { Contact } from "./emergencyRules";
export type Access = { has_code: boolean; code: string | null; created_at: string | null; last_opened_at: string | null; open_count: number };
export type SettingsReply = { settings: Settings; access: Access; options: Options; disclaimer: string };
// what the page saves (every field the form has)
export type SettingsInput = Omit<Settings, "directive_updated_at" | "updated_at">;

const PROFILE_EXISTS = "Your emergency settings are already saved";   // emergency.js PROFILE_EXISTS

// the row that counts: the oldest (one per user; see emergency.js profileAfterSave)
const profileRow = () => new Parse.Query("EmergencyProfile").ascending("createdAt").addAscending("objectId").first();
const plain = (o: Parse.Object | undefined): ProfileRow => (o ? { attrs: o.attributes as Record<string, unknown>, updatedAt: o.updatedAt ?? null } : null);

// the old GET /emergency/settings: the settings (the row, or the defaults; nothing is created by reading), the code
// info (from the server: the code itself is locked to it), the form's option lists and the disclaimer
export function getEmergency(): Promise<SettingsReply> {
  return run(async () => {
    const [row, code] = await Promise.all([profileRow(), api<{ access: Access }>("/emergency/code")]);
    return { settings: settingsOf(plain(row)), access: code.access, options: options(), disclaimer: DISCLAIMER };
  });
}

// the fields sent (as the old PUT body: all of them); null / "" clears a text field (unset on an edit, left out on create)
function fill(obj: Parse.Object, input: SettingsInput, isNew: boolean) {
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    if (isBlank(v)) { if (!isNew) obj.unset(k); } else obj.set(k, v);
  }
}
async function editProfile(id: string, input: SettingsInput): Promise<void> {
  const obj = new Parse.Object("EmergencyProfile");
  obj.id = id;
  fill(obj, input, false);
  await obj.save();
}

// the old PUT /emergency/settings: only the fields sent change; the first save creates the row
export function saveEmergency(input: SettingsInput): Promise<{ message: string; settings: Settings }> {
  return run(async () => {
    const row = await profileRow();
    if (row) await editProfile(row.id, input);
    else {
      const obj = new Parse.Object("EmergencyProfile");
      fill(obj, input, true);
      obj.setACL(ownerAcl());
      let created: Parse.Object | null = null;
      try { created = await obj.save(); }
      catch (err) { if (!(err instanceof Error && err.message === PROFILE_EXISTS)) throw err; }
      // another tab made the row at the same moment: ours was refused or removed again, so change the one that is kept
      const kept = await profileRow();
      if (kept && (!created || kept.id !== created.id)) await editProfile(kept.id, input);
    }
    return { message: "Emergency settings saved", settings: settingsOf(plain(await profileRow())) };
  });
}

// the old GET /emergency/preview: exactly what a responder would see now, from the saved settings and your own rows
export function emergencyPreview(): Promise<{ preview: Record<string, unknown>; disclaimer: string }> {
  return run(async () => {
    const all = (cls: string) => new Parse.Query(cls).limit(MAX_ROWS).find();
    const [row, record, allergies, medications, conditions, devices] = await Promise.all([
      profileRow(),
      new Parse.Query("MedicalRecord").ascending("createdAt").addAscending("objectId").first(),
      all("Allergy"), all("Medication"), all("Condition"), all("RespiratoryDevice"),
    ]);
    const attrs = (list: Parse.Object[]) => list.map((o) => o.attributes as Record<string, unknown>);
    const data = record && record.get("data");
    const preview = snapshot({
      settings: settingsOf(plain(row)), patientName: currentName() || null,
      record: data && typeof data === "object" && !Array.isArray(data) ? data : {},
      allergies: attrs(allergies), medications: attrs(medications), conditions: attrs(conditions), devices: attrs(devices),
    });
    return { preview, disclaimer: DISCLAIMER };
  });
}
