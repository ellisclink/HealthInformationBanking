// reminders.ts — the only browser file that reads and writes Reminder (the Reminders page; the bell's snooze), with the
// Parse SDK. Cloud Code triggers (RULES.Reminder in Parse/cloud/lib/access.js) guard every request: own rows only,
// patients only, the rules of reminders.js (types, 1 to 8 times, days 0-6, a once time in the future, a real time zone,
// dates, a linked item that is one of your own), and the audit log. The server computes next_due_at, linked_name,
// last_fired_at and the cleared schedule fields; the sendReminders job fires the reminders.
//   - never send user_id, next_due_at, linked_name, last_fired_at or snoozed_until (refused: only the server sets them)
//   - send the owner ACL on create only (the server overwrites it); never on update (a changed ACL is refused)
//   - plain values only; remind_at as a Date; clearing a field = unset
//   - snooze = an update that sends ONLY snooze_minutes (the server sets snoozed_until from its own clock)
import Parse from "../parse";
import { run } from "./parseCall";
import { MAX_ROWS, ownerAcl, isBlank, textOrNull, iso } from "./common";

export type ReminderType = "medication" | "refill" | "appointment" | "device_supply" | "custom";
export type Freq = "daily" | "weekly" | "once";

// the old reminderRow (reminder_id is the Parse objectId; dates as ISO text)
export type Reminder = {
  reminder_id: string; user_id: string | null; reminder_type: ReminderType; title: string; linked_id: string | null;
  linked_name: string | null; schedule_type: Freq; time_zone: string | null; start_date: string | null; end_date: string | null;
  times: string[] | null; days_of_week: number[] | null; remind_at: string | null; next_due_at: string | null;
  last_fired_at: string | null; snoozed_until: string | null; email_me: boolean; active: boolean;
  created_at: string | null; updated_at: string | null;
};

const TEXT = ["reminder_type", "title", "linked_id", "linked_name", "schedule_type", "time_zone", "start_date", "end_date"] as const;
const DATES = ["remind_at", "next_due_at", "last_fired_at", "snoozed_until"] as const;


function toReminder(o: Parse.Object): Reminder {
  const out = {
    reminder_id: o.id, user_id: textOrNull(o.get("user_id")),
    times: Array.isArray(o.get("times")) ? o.get("times") : null,
    days_of_week: Array.isArray(o.get("days_of_week")) ? o.get("days_of_week") : null,
    email_me: o.get("email_me") === true, active: o.get("active") === true,
    created_at: iso(o.createdAt), updated_at: iso(o.updatedAt),
  } as Reminder;
  const rec = out as unknown as Record<string, unknown>;
  for (const f of TEXT) rec[f] = textOrNull(o.get(f));
  for (const f of DATES) rec[f] = iso(o.get(f));
  return out;
}

// the page's body (the old route's): remind_at is ISO text; the SDK sends a Date
const value = (k: string, v: unknown) => (k === "remind_at" && typeof v === "string" ? new Date(v) : v);

// GET /reminders: oldest first
export function listReminders(): Promise<{ reminders: Reminder[] }> {
  return run(async () => ({ reminders: (await new Parse.Query("Reminder").ascending("createdAt").limit(MAX_ROWS).find()).map(toReminder) }));
}

// POST /reminders: blank fields are not sent
export function createReminder(body: Record<string, unknown>): Promise<{ message: string; reminder: Reminder }> {
  return run(async () => {
    const obj = new Parse.Object("Reminder");
    for (const [k, v] of Object.entries(body)) if (!isBlank(v)) obj.set(k, value(k, v));
    obj.setACL(ownerAcl());
    return { message: "Reminder added", reminder: toReminder(await obj.save()) };
  });
}

// PUT /reminders/:id: only the fields sent change (null or "" clears one); the whole reminder must still be valid
export function updateReminder(id: string, body: Record<string, unknown>): Promise<{ message: string; reminder: Reminder }> {
  return run(async () => {
    const obj = new Parse.Object("Reminder");
    obj.id = id;
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue;
      if (isBlank(v)) obj.unset(k);
      else obj.set(k, value(k, v));
    }
    await obj.save();
    const stored = await new Parse.Query("Reminder").get(id);
    return { message: "Reminder updated", reminder: toReminder(stored) };
  });
}

// DELETE /reminders/:id
export function removeReminder(id: string): Promise<{ message: string }> {
  return run(async () => {
    const obj = new Parse.Object("Reminder");
    obj.id = id;
    await obj.destroy();
    return { message: "Reminder removed" };
  });
}

// POST /reminders/:id/snooze {minutes}: 5 minutes to 24 hours from now (the server's clock)
export function snoozeReminder(id: string, minutes: number): Promise<{ message: string }> {
  return run(async () => {
    const obj = new Parse.Object("Reminder");
    obj.id = id;
    obj.set("snooze_minutes", minutes);
    await obj.save();
    return { message: "Reminder snoozed" };
  });
}
