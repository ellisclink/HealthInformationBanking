// notifications.ts — the only browser file that reads Notification (the bell) and reads / writes NotificationPrefs (the
// automatic alert switches on the Reminders page), with the Parse SDK. Cloud Code triggers (RULES in
// Parse/cloud/lib/access.js) guard every request: own rows only, patients only, and the audit log.
//   - Notification rows are made only by the server (the sendReminders job, and the sweep below); the browser can't
//     create one. An edit may only set read_at / dismissed_at, and the server uses its own time for them.
//     Dismissing keeps the row (its dedupe_key keeps the alert from coming back), as the old route did.
//   - NotificationPrefs: one row per user, booleans only. No row = the defaults (DEFAULT_PREFS, the same as the server's
//     notifications.js); the first change creates the row.
// The one server call left is the sweep (POST /notifications/sweep): it fires your due reminders and makes your automatic
// alerts, which the old inbox and count routes did before answering.
import Parse from "../parse";
import { api } from "../api";
import { run } from "./parseCall";
import { MAX_ROWS, textOrNull, iso } from "./common";

export type Notice = {
  notification_id: string; user_id: string | null; kind: string; title: string; message: string | null; link: string | null;
  action: string | null; dedupe_key: string | null; reminder_id: string | null; read_at: string | null; dismissed_at: string | null;
  created_at: string; updated_at: string | null;
};
export type Settings = { low_stock: boolean; appointments: boolean; supplies: boolean; disposal: boolean; email: boolean };
export type SettingKey = keyof Settings;

// the same defaults as notifications.js DEFAULT_PREFS
export const DEFAULT_PREFS: Settings = { low_stock: true, appointments: true, supplies: true, disposal: true, email: false };
const PREF_KEYS = Object.keys(DEFAULT_PREFS) as SettingKey[];
const LIST_LIMIT = 100;      // the old inbox showed the newest 100
const PREFS_EXIST = "Your alert settings are already saved";   // notifications.js PREFS_EXIST


function toNotice(o: Parse.Object): Notice {
  return {
    notification_id: o.id, user_id: textOrNull(o.get("user_id")), kind: o.get("kind") || "", title: o.get("title") || "",
    message: textOrNull(o.get("message")), link: textOrNull(o.get("link")), action: textOrNull(o.get("action")),
    dedupe_key: textOrNull(o.get("dedupe_key")), reminder_id: textOrNull(o.get("reminder_id")),
    read_at: iso(o.get("read_at")), dismissed_at: iso(o.get("dismissed_at")),
    created_at: iso(o.createdAt) || "", updated_at: iso(o.updatedAt),
  };
}

// The inbox should still load if the sweep fails (as the old routes)
async function sweep(): Promise<void> {
  try { await api("/notifications/sweep", { method: "POST" }); } catch { /* the inbox still loads */ }
}

const visible = () => new Parse.Query("Notification").doesNotExist("dismissed_at");
const unreadCount = () => visible().doesNotExist("read_at").count();

// GET /notifications: the sweep, then the newest 100 not dismissed, and the unread count
export function listNotifications(): Promise<{ notifications: Notice[]; unread: number }> {
  return run(async () => {
    await sweep();
    const rows = await visible().descending("createdAt").limit(LIST_LIMIT).find();
    return { notifications: rows.map(toNotice), unread: await unreadCount() };
  });
}

// GET /notifications/count: the sweep, then unread and not dismissed
export function countUnread(): Promise<{ count: number }> {
  return run(async () => { await sweep(); return { count: await unreadCount() }; });
}

// one edit of read_at / dismissed_at (the value is a placeholder: the server stores its own time)
async function stamp(id: string, field: "read_at" | "dismissed_at"): Promise<void> {
  const obj = new Parse.Object("Notification");
  obj.id = id;
  obj.set(field, new Date());
  await obj.save();
}

// POST /notifications/:id/read (one already read keeps its time)
export function markRead(id: string): Promise<{ message: string }> {
  return run(async () => { await stamp(id, "read_at"); return { message: "Marked read" }; });
}

// DELETE /notifications/:id: dismissed (and read), the row is kept
export function dismiss(id: string): Promise<{ message: string }> {
  return run(async () => { await stamp(id, "dismissed_at"); return { message: "Notification dismissed" }; });
}

// POST /notifications/read-all: every unread one not dismissed
export function readAll(): Promise<{ message: string; updated: number }> {
  return run(async () => {
    const rows = await visible().doesNotExist("read_at").limit(MAX_ROWS).find();
    for (const r of rows) await stamp(r.id, "read_at");
    return { message: "All marked read", updated: rows.length };
  });
}

// DELETE /notifications?read=true: the read ones leave the inbox (dismissed, not deleted)
export function clearRead(): Promise<{ message: string; cleared: number }> {
  return run(async () => {
    const rows = await visible().exists("read_at").limit(MAX_ROWS).find();
    for (const r of rows) await stamp(r.id, "dismissed_at");
    return { message: "Read notifications cleared", cleared: rows.length };
  });
}

// ---- alert settings ----

const prefsRow = () => new Parse.Query("NotificationPrefs").ascending("createdAt").first();

// the stored settings over the defaults (a missing or non-boolean value falls back to its default), as prefsOf()
function prefsOf(row: Parse.Object | undefined): Settings {
  const out = { ...DEFAULT_PREFS };
  if (row) for (const k of PREF_KEYS) { const v = row.get(k); if (typeof v === "boolean") out[k] = v; }
  return out;
}

// GET /notifications/settings (nothing is created by reading)
export function getSettings(): Promise<{ settings: Settings }> {
  return run(async () => ({ settings: prefsOf(await prefsRow()) }));
}

async function editPrefs(id: string, changes: Partial<Settings>): Promise<void> {
  const obj = new Parse.Object("NotificationPrefs");
  obj.id = id;
  obj.set(changes);
  await obj.save();
}

// PUT /notifications/settings: only the keys sent change; the first change creates the row (the server adds the defaults)
export function putSettings(changes: Partial<Settings>): Promise<{ message: string; settings: Settings }> {
  return run(async () => {
    const row = await prefsRow();
    if (row) await editPrefs(row.id, changes);
    else {
      const obj = new Parse.Object("NotificationPrefs");
      obj.set(changes);
      const acl = new Parse.ACL();
      acl.setPublicReadAccess(false);
      acl.setPublicWriteAccess(false);
      const user = Parse.User.current();
      if (user) { acl.setReadAccess(user, true); acl.setWriteAccess(user, true); }
      obj.setACL(acl);
      let created: Parse.Object | null = null;
      try { created = await obj.save(); }
      catch (err) { if (!(err instanceof Error && err.message === PREFS_EXIST)) throw err; }
      // another tab made the row at the same moment: ours was refused or removed again, so change the one that is kept
      const kept = await prefsRow();
      if (kept && (!created || kept.id !== created.id)) await editPrefs(kept.id, changes);
    }
    return { message: "Settings saved", settings: prefsOf(await prefsRow()) };
  });
}
