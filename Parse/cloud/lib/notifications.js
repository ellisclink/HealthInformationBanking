// notifications.js — the notification inbox, automatic alerts, and firing reminders (Task 2.7).
//   GET    /notifications              the inbox (runs runDue first), newest first, dismissed ones hidden
//   GET    /notifications/count        unread count (runs runDue first)
//   POST   /notifications/read-all     mark every notification read
//   DELETE /notifications?read=true    clear the read ones (sets dismissed_at; rows are kept)
//   POST   /notifications/:id/read     mark one read
//   DELETE /notifications/:id          dismiss one (sets dismissed_at; the row is kept)
//   GET    /notifications/settings     the automatic alert and email settings
//   PUT    /notifications/settings     change them
// Routes are wired in router.js (Task 2.8). runAll() is the background job; purgeOld() removes old read rows.
// Classes: Notification, NotificationPrefs (Reminder, Medication, CalendarEvent, RespiratoryDevice, DeviceSupply are read)
//
// runDue(userId) fires the user's due reminders (one notification even when several times were missed) and then
// creates the automatic alerts. Every notification carries a dedupe_key, and a key already used by any of the user's
// notifications (read, unread or dismissed) is never used again, so an alert never repeats.
//
// Email (D-010): sent only by the job (runAll), never by the app's own calls. One generic email per user per sweep,
// with no health details. A reminder emails when its "Also email me" (email_me) is on; automatic alerts email when
// NotificationPrefs.email is on. Without SMTP settings no email is sent and nothing fails.

const { M, isId, toRow, findAll, findOne, getOwned, save, create, destroyAll, audit, fail } = require("./db");
const sec = require("./security");
const { nextOccurrence, reminderRow } = require("./reminders");
const { medRow, withInventoryInfo } = require("./medications");
const { supplyRow, supplyStatus } = require("./respiratory");
const disposal = require("./disposal");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const APPOINTMENT_WINDOW_MS = 24 * HOUR_MS;    // an appointment, lab or procedure starting within 24 hours
const SUPPLY_DUE_DAYS = 3;                     // a device part due within 3 days (or overdue)
const PURGE_AFTER_DAYS = 90;                   // read notifications older than this are removed by the job
const PURGE_BATCH = 1000;
const LIST_LIMIT = 100;

const PREF_KEYS = ["low_stock", "appointments", "supplies", "disposal", "email"];
const DEFAULT_PREFS = { low_stock: true, appointments: true, supplies: true, disposal: true, email: false };
const PREF_LABELS = { low_stock: "Low stock", appointments: "Appointments", supplies: "Supplies", disposal: "Disposal", email: "Email" };

const APPOINTMENT_CATEGORIES = { appointment: "Appointment", lab: "Lab test", procedure: "Procedure" };
const CLOSED_EVENT_STATUSES = ["cancelled", "completed"];

// What a fired reminder says in the app, and the page it opens, by reminder type
const REMINDER_TEXT = {
  medication: { message: "Time to take your medicine", link: "/medications" },
  refill: { message: "Time to order a refill", link: "/medications" },
  appointment: { message: "Appointment reminder", link: "/calendar" },
  device_supply: { message: "Time to replace a part", link: "/respiratory" },
  custom: { message: "Reminder", link: "/reminders" },
};

// The only email this module sends. Generic on purpose: no names, medicines, times or other health details.
const EMAIL_SUBJECT = "Health Information Banking: you have a reminder waiting";
const EMAIL_TEXT = "Hello, you have a reminder waiting in Health Information Banking. Sign in to see it.\n\n"
  + "For your privacy, these emails never include health details.\n"
  + "To stop them, turn off email on your reminders and in the automatic alert settings.\n";

const NOTE_FIELDS = ["user_id", "kind", "title", "message", "link", "action", "dedupe_key", "reminder_id", "dismissed_at", "read_at"];
const noteRow = (o) => toRow(o, "notification_id", NOTE_FIELDS);

const isoDay = (date) => date.toISOString().slice(0, 10);
const asDate = (v) => (v instanceof Date ? v : v ? new Date(v) : null);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Monday (UTC) of the week `date` falls in: the low-stock alert repeats at most once a week per medicine
function weekStart(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return isoDay(d);
}

// --- settings ---------------------------------------------------------------------------------

const prefsRow = (userId) => findOne("NotificationPrefs", { user_id: userId });

// The stored settings over the defaults (a missing or non-boolean value falls back to its default)
function prefsOf(row) {
  const out = { ...DEFAULT_PREFS };
  if (row) for (const k of PREF_KEYS) if (typeof row.get(k) === "boolean") out[k] = row.get(k);
  return out;
}

// GET /notifications/settings
async function getSettings(user) {
  return { status: 200, settings: prefsOf(await prefsRow(user.user_id)) };
}

// PUT /notifications/settings {low_stock?, appointments?, supplies?, disposal?, email?} — only the keys sent change
async function putSettings(body, user) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail(400, "Missing settings");
  const changes = {};
  for (const k of PREF_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(body, k)) continue;
    if (typeof body[k] !== "boolean") return fail(400, `${PREF_LABELS[k]} must be true or false`);
    changes[k] = body[k];
  }
  if (!Object.keys(changes).length) return fail(400, "No settings to change");
  const row = await prefsRow(user.user_id);
  if (row) {
    const oldData = prefsOf(row);
    await save(row, changes);
    const settings = prefsOf(row);
    await audit({ userId: user.user_id, event: "UPDATE", targetClass: "NotificationPrefs", targetId: row.id, oldData, newData: settings });
    return { status: 200, message: "Settings saved", settings };
  }
  const created = await create("NotificationPrefs", { user_id: user.user_id, ...DEFAULT_PREFS, ...changes });
  const settings = prefsOf(created);
  await audit({ userId: user.user_id, event: "INSERT", targetClass: "NotificationPrefs", targetId: created.id, newData: settings });
  return { status: 200, message: "Settings saved", settings };
}

// --- firing reminders -------------------------------------------------------------------------

// Fires one reminder if it is due (or its snooze has ended). Throws on a bad row; the caller logs and moves on.
async function fireReminder(reminder, now, add) {
  const r = reminderRow(reminder);
  const snoozedUntil = asDate(r.snoozed_until);
  if (snoozedUntil && snoozedUntil.getTime() > now.getTime()) return;   // snoozed: wait until snoozed_until
  const snoozeOver = !!snoozedUntil;

  const schedule = { ...r, remind_at: asDate(r.remind_at) };
  let dueAt;
  if (r.schedule_type === "once") {
    // Ask for the time after the last check, not after now: a once reminder that was missed (its time already
    // passed) still fires. An unfired once reminder has never been checked, so that is the start of time.
    // nextOccurrence gives null once it has fired.
    dueAt = nextOccurrence(schedule, new Date(0));
  } else {
    const lastChecked = asDate(r.last_fired_at) || reminder.createdAt || now;
    dueAt = asDate(r.next_due_at) || nextOccurrence(schedule, lastChecked);
  }
  const isDue = !!dueAt && dueAt.getTime() <= now.getTime();
  if (!isDue && !snoozeOver) return;

  // Work out the reminder's new state before creating anything, so a bad schedule fails without a notification.
  // Every missed time is skipped in one step: the next time is the first one after now.
  // A snooze ending before the scheduled time only re-reminds: last_fired_at is left alone, so an unfired
  // once reminder still fires at its own time.
  const changes = { snoozed_until: null };
  if (isDue) {
    changes.last_fired_at = now;
    if (r.schedule_type === "once") { changes.next_due_at = null; changes.active = false; }
    else changes.next_due_at = nextOccurrence({ ...schedule, last_fired_at: now }, now);
    // No next time (for example past its end_date): turn it off so the sweep stops picking it up
    if (!changes.next_due_at) changes.active = false;
  }

  const text = REMINDER_TEXT[r.reminder_type] || REMINDER_TEXT.custom;
  let link = text.link;
  // The bell's "log dose" button needs the medicine's id; Notification has no field for it, so it rides in the link
  if (r.reminder_type === "medication" && r.linked_id) link = `/medications?medication_id=${encodeURIComponent(r.linked_id)}`;
  await add({
    kind: "reminder",
    title: r.title || "Reminder",
    message: text.message,
    link,
    action: r.reminder_type === "medication" ? "log_dose" : null,
    reminder_id: reminder.id,
    dedupe_key: isDue ? `reminder:${reminder.id}:${dueAt.toISOString()}` : `reminder:${reminder.id}:snooze:${snoozedUntil.toISOString()}`,
  }, r.email_me === true);

  await save(reminder, changes);
  await audit({ userId: r.user_id, event: "UPDATE", targetClass: "Reminder", targetId: reminder.id, oldData: r,
    newData: reminderRow(reminder), detail: { action: "fired" } });
}

// --- automatic alerts -------------------------------------------------------------------------

// Low stock: an active medicine at or under its refill threshold, at most once a week per medicine
async function lowStockAlerts(userId, now, add) {
  const week = weekStart(now);
  const meds = (await findAll("Medication", { user_id: userId })).map(medRow).map(withInventoryInfo);
  for (const m of meds) {
    if (!m.low_stock) continue;
    await add({
      kind: "low_stock",
      title: `Running low: ${m.medication_name}`,
      message: `Only ${Number(m.quantity_on_hand) || 0} left. Time to order a refill.`,
      link: "/medications",
      dedupe_key: `low_stock:${m.medication_id}:${week}`,
    });
  }
}

// An appointment, lab test or procedure that starts within the next 24 hours (not cancelled or completed)
async function appointmentAlerts(userId, now, add) {
  const until = now.getTime() + APPOINTMENT_WINDOW_MS;
  const events = await findAll("CalendarEvent", { user_id: userId });
  for (const e of events) {
    const label = APPOINTMENT_CATEGORIES[e.get("category")];
    if (!label || CLOSED_EVENT_STATUSES.includes(e.get("status"))) continue;
    const start = asDate(e.get("start_time"));
    if (!start || isNaN(start.getTime()) || start.getTime() <= now.getTime() || start.getTime() > until) continue;
    const location = e.get("location");
    await add({
      kind: "appointment",
      title: `Coming up: ${e.get("title") || label}`,
      message: `${label} within the next 24 hours${location ? ` at ${location}` : ""}`,
      link: "/calendar",
      dedupe_key: `appointment:${e.id}:${start.toISOString()}`,
    });
  }
}

// A part of an active breathing device due for replacement within 3 days, or overdue. A new replacement date
// gives a new due date and so a new alert.
async function supplyAlerts(userId, now, add) {
  const devices = await findAll("RespiratoryDevice", { user_id: userId });
  const active = new Map(devices.filter((d) => d.get("is_active")).map((d) => [d.id, d]));
  if (!active.size) return;
  const day = isoDay(now);
  for (const s of await findAll("DeviceSupply", { user_id: userId })) {
    const row = supplyRow(s);
    const device = active.get(row.device_id);
    if (!device) continue;
    const status = supplyStatus(row, day);
    if (status.days_left === null || status.days_left > SUPPLY_DUE_DAYS) continue;
    const when = status.days_left < 0 ? `overdue by ${plural(-status.days_left, "day")}`
      : status.days_left === 0 ? "due today" : `due in ${plural(status.days_left, "day")}`;
    await add({
      kind: "supply",
      title: `Replace soon: ${row.part_name}`,
      message: `${device.get("name") || "Your device"}: ${when}`,
      link: "/respiratory",
      dedupe_key: `supply:${s.id}:${status.next_due}`,
    });
  }
}

// Leftover medicine to dispose of: still on hand and stopped, completed or past its end date (disposal.due decides)
async function disposalAlerts(userId, now, add) {
  const { medications } = await disposal.due({ user_id: userId });
  for (const m of medications) {
    await add({
      kind: "disposal",
      title: `Leftover medicine: ${m.medication_name}`,
      message: `${m.quantity_on_hand} left. See how to get rid of it safely.`,
      link: "/disposal",
      dedupe_key: `disposal:${m.medication_id}:${m.end_date || m.status}`,
    });
  }
}

// Each alert and the NotificationPrefs switch that turns it off
const ALERTS = [
  ["low_stock", lowStockAlerts],
  ["appointments", appointmentAlerts],
  ["supplies", supplyAlerts],
  ["disposal", disposalAlerts],
];

// --- runDue -----------------------------------------------------------------------------------

// Fires the user's due reminders, then creates the automatic alerts the settings allow.
// Returns { created, email }: how many notifications were made, and whether any of them asks for an email
// (only runAll acts on that).
async function runDue(userId, now = new Date()) {
  const prefs = prefsOf(await prefsRow(userId));
  const used = new Set((await findAll("Notification", { user_id: userId }, { select: ["dedupe_key"] }))
    .map((n) => n.get("dedupe_key")).filter(Boolean));
  const result = { created: 0, email: false };

  // Creates a notification unless its dedupe_key has been used before
  const add = async (values, wantsEmail = false) => {
    if (used.has(values.dedupe_key)) return false;
    used.add(values.dedupe_key);
    const note = await create("Notification", { user_id: userId, ...values });
    await audit({ userId, event: "INSERT", targetClass: "Notification", targetId: note.id, newData: noteRow(note) });
    result.created += 1;
    if (wantsEmail) result.email = true;
    return true;
  };

  // Inactive reminders never fire
  const reminders = await findAll("Reminder", { user_id: userId, active: true }, { ascending: "createdAt" });
  for (const reminder of reminders) {
    try {
      await fireReminder(reminder, now, add);
    } catch (err) {
      console.error(`runDue: reminder ${reminder.id} skipped:`, err && err.message ? err.message : err);
    }
  }

  for (const [pref, check] of ALERTS) {
    if (!prefs[pref]) continue;
    try {
      await check(userId, now, (values) => add(values, prefs.email));
    } catch (err) {
      console.error(`runDue: ${pref} alerts skipped for ${userId}:`, err && err.message ? err.message : err);
    }
  }
  return result;
}

// The inbox should still load if a sweep fails
async function runDueQuietly(userId) {
  try {
    await runDue(userId);
  } catch (err) {
    console.error(`runDue failed for ${userId}:`, err && err.message ? err.message : err);
  }
}

// --- the job ----------------------------------------------------------------------------------

// The one generic email. Skipped (not an error) when SMTP isn't set up; a send failure is logged, never thrown.
async function sendReminderEmail(userId) {
  if (sec.DEV_MODE) return false;
  const account = await findOne("_User", { objectId: userId });
  const to = account && (account.get("email") || account.get("username"));
  if (!to) return false;
  try {
    await sec.sendEmail(to, EMAIL_SUBJECT, EMAIL_TEXT, "Reminder email");
    return true;
  } catch (err) {
    console.error(`runAll: reminder email to user ${userId} failed:`, err && err.message ? err.message : err);
    return false;
  }
}

// The sendReminders job (Task 2.8): runDue for everyone with an active reminder or alert emails turned on, one
// email per user who asked for it, then purgeOld. Others get their alerts when they next open the app.
async function runAll(now = new Date()) {
  const ids = new Set();
  for (const r of await findAll("Reminder", { active: true }, { select: ["user_id"] })) ids.add(r.get("user_id"));
  for (const p of await findAll("NotificationPrefs", { email: true }, { select: ["user_id"] })) ids.add(p.get("user_id"));
  ids.delete(undefined);
  ids.delete(null);

  let created = 0, emails = 0;
  for (const userId of ids) {
    try {
      const res = await runDue(userId, now);
      created += res.created;
      if (res.email && await sendReminderEmail(userId)) emails += 1;
    } catch (err) {
      console.error(`runAll: user ${userId} skipped:`, err && err.message ? err.message : err);
    }
  }
  let purged = 0;
  try {
    purged = (await purgeOld(now)).removed;
  } catch (err) {
    console.error("runAll: purgeOld failed:", err && err.message ? err.message : err);
  }
  return { users: ids.size, notifications: created, emails, purged };
}

// Removes read notifications created more than 90 days ago (every user). Unread and newer ones stay.
async function purgeOld(now = new Date()) {
  const cutoff = new Date(now.getTime() - PURGE_AFTER_DAYS * DAY_MS);
  let removed = 0;
  for (;;) {
    const q = new Parse.Query("Notification");
    q.exists("read_at");
    q.lessThan("createdAt", cutoff);
    q.limit(PURGE_BATCH);
    const batch = await q.find(M);
    if (!batch.length) break;
    await destroyAll(batch);
    removed += batch.length;
    if (batch.length < PURGE_BATCH) break;
  }
  // One audit row per run for the hard delete: only the count and the cutoff, no notification content
  await audit({ event: "DELETE", targetClass: "Notification", detail: { purged: removed, cutoff: cutoff.toISOString() } });
  return { removed };
}

// --- the inbox --------------------------------------------------------------------------------

const visible = async (userId) => (await findAll("Notification", { user_id: userId }, { descending: "createdAt" }))
  .filter((n) => !n.get("dismissed_at"));

// GET /notifications
async function list(user) {
  await runDueQuietly(user.user_id);
  const rows = await visible(user.user_id);
  return {
    status: 200,
    notifications: rows.slice(0, LIST_LIMIT).map(noteRow),
    unread: rows.filter((n) => !n.get("read_at")).length,
  };
}

// GET /notifications/count — unread, not dismissed
async function count(user) {
  await runDueQuietly(user.user_id);
  const rows = await visible(user.user_id);
  return { status: 200, count: rows.filter((n) => !n.get("read_at")).length };
}

// Sets `values` on each row and audits each change with its old and new data
async function updateMany(user, rows, values, action) {
  for (const n of rows) {
    const oldData = noteRow(n);
    await save(n, values);
    await audit({ userId: user.user_id, event: "UPDATE", targetClass: "Notification", targetId: n.id, oldData, newData: noteRow(n),
      detail: { action, count: rows.length } });
  }
  return rows.length;
}

// POST /notifications/read-all
async function readAll(user) {
  const rows = (await visible(user.user_id)).filter((n) => !n.get("read_at"));
  const n = await updateMany(user, rows, { read_at: new Date() }, "read_all");
  return { status: 200, message: "All marked read", updated: n };
}

// DELETE /notifications?read=true — clears read notifications from the inbox (dismissed, not deleted)
async function clearRead(user) {
  const rows = (await visible(user.user_id)).filter((n) => n.get("read_at"));
  const n = await updateMany(user, rows, { dismissed_at: new Date() }, "clear_read");
  return { status: 200, message: "Read notifications cleared", cleared: n };
}

async function ownedNote(id, user) {
  if (!isId(id)) return { res: fail(400, "Invalid notification ID") };
  const note = await getOwned("Notification", id, user.user_id);
  if (!note) return { res: fail(404, "Notification not found") };
  return { note };
}

// POST /notifications/:id/read
async function markRead(id, user) {
  const { note, res } = await ownedNote(id, user);
  if (res) return res;
  if (!note.get("read_at")) {
    const oldData = noteRow(note);
    await save(note, { read_at: new Date() });
    await audit({ userId: user.user_id, event: "UPDATE", targetClass: "Notification", targetId: note.id, oldData, newData: noteRow(note) });
  }
  return { status: 200, message: "Marked read", notification: noteRow(note) };
}

// DELETE /notifications/:id — sets dismissed_at and keeps the row (its dedupe_key keeps the alert from coming back).
// A dismissed notification also counts as read, so purgeOld removes it in time.
async function dismiss(id, user) {
  const { note, res } = await ownedNote(id, user);
  if (res) return res;
  if (!note.get("dismissed_at")) {
    const oldData = noteRow(note);
    const now = new Date();
    await save(note, { dismissed_at: now, read_at: note.get("read_at") || now });
    await audit({ userId: user.user_id, event: "UPDATE", targetClass: "Notification", targetId: note.id, oldData, newData: noteRow(note) });
  }
  return { status: 200, message: "Notification dismissed" };
}

module.exports = {
  runDue, runAll, purgeOld,
  list, count, readAll, clearRead, markRead, dismiss, getSettings, putSettings,
  DEFAULT_PREFS, EMAIL_SUBJECT, EMAIL_TEXT, noteRow,
};
