// diary.ts — the only browser file that reads and writes DiaryEntry, with the Parse SDK (William Murray's queryDiary,
// moved here from HealthDiary.tsx). Cloud Code triggers (RULES in Parse/cloud/lib/access.js) guard every request:
// own rows only, patients only, the field rules of diary.js validate (category required), and the audit log.
//   - never send user_id (the server sets it)
//   - send the owner ACL on create only (the server overwrites it); never on update (a changed ACL is refused)
//   - plain values only; numbers as numbers, booleans as booleans; clearing a field = unset
import Parse from "../parse";
import { run } from "./parseCall";
import type { DiaryInput } from "../api";
import { MAX_ROWS, ownerAcl } from "./common";

export type { DiaryInput };

// what the page's form holds (select values are text)
export type DiaryForm = {
  entryDate: string; category: string; title: string; description: string;
  severity: string; mood: string; followUpNeeded: boolean;
};
// a saved entry as the page shows it; id is the Parse objectId
export type DisplayEntry = DiaryForm & { id: string };

// page label -> stored category (diary.js CATEGORIES)
export const categories: Record<string, string> = {
  Symptoms: "symptom", Medication: "medication", General: "general"
};
const labels: Record<string, string> = Object.fromEntries(
  Object.entries(categories).map(([label, value]) => [value, label])
);


const dateText = (v: unknown): string => (v instanceof Date ? v.toISOString() : typeof v === "string" ? v : "").slice(0, 10);

function toDisplay(result: Parse.Object): DisplayEntry {
  const severity = result.get("severity");
  return {
    id: result.id,   // result.get("objectId") is undefined: the id is not an attribute
    entryDate: dateText(result.get("entry_date")),
    category: labels[result.get("category")] || "General",
    title: result.get("title") || "",
    description: result.get("description") || "",
    severity: severity == null ? "" : String(severity),
    mood: result.get("mood") || "",
    followUpNeeded: result.get("follow_up_needed") === true,
  };
}

// list(): newest entry_date first, then newest created first (as diary.list did)
export function listDiary(): Promise<DisplayEntry[]> {
  return run(async () => {
    const results = await new Parse.Query("DiaryEntry")
      .descending("entry_date").addDescending("createdAt").limit(MAX_ROWS).find();
    return results.map(toDisplay);
  });
}

// create(): empty optional fields are not sent; the server sets user_id, the ACL and follow_up_needed's default
export function addDiary(input: DiaryInput): Promise<void> {
  return run(async () => {
    const entry = new Parse.Object("DiaryEntry");
    for (const [k, v] of Object.entries(input)) if (v !== undefined && v !== null && v !== "") entry.set(k, v);
    entry.setACL(ownerAcl());
    await entry.save();
  });
}

// update(): null or "" clears the field (unset); no ACL and no user_id are sent
export function updateDiary(id: string, input: DiaryInput): Promise<void> {
  return run(async () => {
    const entry = new Parse.Object("DiaryEntry");
    entry.id = id;
    for (const [k, v] of Object.entries(input)) {
      if (v === undefined) continue;
      if (v === null || v === "") entry.unset(k);
      else entry.set(k, v);
    }
    await entry.save();
  });
}

export function deleteDiary(id: string): Promise<void> {
  return run(async () => {
    const entry = new Parse.Object("DiaryEntry");
    entry.id = id;
    await entry.destroy();
  });
}
