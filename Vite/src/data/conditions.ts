// conditions.ts — the only browser file that reads and writes Condition, ConditionNote and ConditionTarget, with the
// Parse SDK (William Murray's queryConditions, moved here from Conditions.tsx). Cloud Code triggers (RULES in
// Parse/cloud/lib/access.js) guard every request: own rows only, patients only, the field rules of conditions.js,
// a note/target only on your own condition, deleting a condition removes its notes and targets, and the audit log.
//   - never send user_id (the server sets it); never send set_by (the server stores "patient")
//   - send the owner ACL on create only (the server overwrites it); never on update (a changed ACL is refused)
//   - never send source on an update (the server refuses "source cannot be changed")
//   - plain values only; numbers as numbers, booleans as booleans; clearing a field = unset
import Parse from "../parse";
import { run } from "./parseCall";
import { summarize, sortConditions } from "./conditionSummary";
import type { Condition, Note, Target, Summary, ActiveCondition } from "./conditionSummary";
import { MAX_ROWS, ownerAcl, isBlank, textOrNull } from "./common";

export type { Condition, Note, Target, Summary, ActiveCondition };
export { setByText } from "./conditionSummary";

// what the page sends for a condition (null or "" = not set)
export type ConditionInput = {
  condition_name: string; icd10_code: string | null; category: string | null; status: string; severity: string | null;
  onset_date: string | null; diagnosed_date: string | null; resolved_date: string | null;
  diagnosing_provider: string | null; managing_provider: string | null; provider_facility: string | null;
  is_primary: boolean; notes: string | null;
};
export type NoteInput = { note_date: string; note_type: string; note_text: string };
export type TargetInput = {
  vital_type: string; target_min: number | null; target_max: number | null; secondary_min?: number | null; secondary_max?: number | null;
};


const dateText = (v: unknown): string | null => {
  const s = v instanceof Date ? v.toISOString() : typeof v === "string" ? v : "";
  return s ? s.slice(0, 10) : null;
};
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const created = (o: Parse.Object) => (o.createdAt ? o.createdAt.toISOString() : "");

// result.id, not result.get("objectId") (undefined: the id is not an attribute)
function toCondition(o: Parse.Object): Condition {
  return {
    condition_id: o.id, condition_name: o.get("condition_name") || "", icd10_code: textOrNull(o.get("icd10_code")),
    category: textOrNull(o.get("category")), status: o.get("status") || "active", severity: textOrNull(o.get("severity")),
    onset_date: dateText(o.get("onset_date")), diagnosed_date: dateText(o.get("diagnosed_date")), resolved_date: dateText(o.get("resolved_date")),
    diagnosing_provider: textOrNull(o.get("diagnosing_provider")), managing_provider: textOrNull(o.get("managing_provider")),
    provider_facility: textOrNull(o.get("provider_facility")), is_primary: o.get("is_primary") === true,
    source: textOrNull(o.get("source")), notes: textOrNull(o.get("notes")),
  };
}
function toNote(o: Parse.Object): Note {
  return { note_id: o.id, condition_id: o.get("condition_id"), note_date: dateText(o.get("note_date")) || "",
    note_type: o.get("note_type") || "general", note_text: o.get("note_text") || "", created_at: created(o) };
}
function toTarget(o: Parse.Object): Target {
  return { target_id: o.id, condition_id: o.get("condition_id"), vital_type: o.get("vital_type"),
    target_min: numOrNull(o.get("target_min")), target_max: numOrNull(o.get("target_max")),
    secondary_min: numOrNull(o.get("secondary_min")), secondary_max: numOrNull(o.get("secondary_max")),
    set_by: textOrNull(o.get("set_by")), active: o.get("active") === true, created_at: created(o) };
}

// a new row: blank fields are not sent; the owner ACL is
async function createRow(className: string, fields: Record<string, unknown>) {
  const obj = new Parse.Object(className);
  for (const [k, v] of Object.entries(fields)) if (!isBlank(v)) obj.set(k, v);
  obj.setACL(ownerAcl());
  await obj.save();
}

// list() + summary(): the caller's conditions (primary, newest onset, name) and the summary with each active
// condition's own note count and last note date
export function listConditions(): Promise<{ conditions: Condition[]; summary: Summary }> {
  return run(async () => {
    const [conditionRows, noteRows] = await Promise.all([
      new Parse.Query("Condition").limit(MAX_ROWS).find(),
      new Parse.Query("ConditionNote").select("condition_id", "note_date").limit(MAX_ROWS).find(),
    ]);
    const conditions = sortConditions(conditionRows.map(toCondition));
    return { conditions, summary: summarize(conditions, noteRows.map(toNote)) };
  });
}

// getById(): the notes (newest note_date first, then newest created) and the targets (newest first)
export function getConditionDetail(id: string): Promise<{ notes: Note[]; targets: Target[] }> {
  return run(async () => {
    const [notes, targets] = await Promise.all([
      new Parse.Query("ConditionNote").equalTo("condition_id", id).descending("note_date").addDescending("createdAt").limit(MAX_ROWS).find(),
      new Parse.Query("ConditionTarget").equalTo("condition_id", id).descending("createdAt").limit(MAX_ROWS).find(),
    ]);
    return { notes: notes.map(toNote), targets: targets.map(toTarget) };
  });
}

// create(): the server sets user_id, the ACL, status "active" and source "patient_reported"
export function addCondition(input: ConditionInput): Promise<void> {
  return run(() => createRow("Condition", input));
}

// update(): null or "" clears the field (unset); no ACL, no user_id and no source are sent
export function updateCondition(id: string, input: ConditionInput): Promise<void> {
  return run(async () => {
    const obj = new Parse.Object("Condition");
    obj.id = id;
    for (const [k, v] of Object.entries(input)) {
      if (k === "source" || v === undefined) continue;
      if (v === null || v === "") obj.unset(k);
      else obj.set(k, v);
    }
    await obj.save();
  });
}

// remove(): the server's afterDelete removes the condition's notes and targets
export function deleteCondition(id: string): Promise<void> {
  return run(async () => {
    const obj = new Parse.Object("Condition");
    obj.id = id;
    await obj.destroy();
  });
}

// addNote(): the server checks the condition is the caller's own
export function addNote(conditionId: string, input: NoteInput): Promise<void> {
  return run(() => createRow("ConditionNote", { condition_id: conditionId, ...input }));
}

// setTarget(): a NEW active row; the server then turns off the caller's other active targets for that vital_type
// (they stay as history). set_by is not sent: the server stores "patient".
export function setTarget(conditionId: string, input: TargetInput): Promise<void> {
  return run(() => createRow("ConditionTarget", { condition_id: conditionId, ...input }));
}
