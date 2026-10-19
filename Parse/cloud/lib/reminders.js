// reminders.js — Reminder schedules (Task 2.5) and reminder CRUD with snooze (Task 2.6).
// A reminder row carries:
//   schedule_type  "once" | "daily" | "weekly"
//   remind_at      Date, once only
//   times          ["HH:MM", ...] 1-8 local wall times, daily and weekly
//   days_of_week   [0-6, ...] 0 = Sunday, weekly only
//   start_date / end_date   optional "YYYY-MM-DD", judged in the patient's time zone
//   time_zone      the patient's IANA zone, e.g. "America/New_York" (UTC when missing)
//   last_fired_at  set when a once reminder has fired; a fired once reminder has no next time
// Daylight saving: a wall time that does not exist (spring forward) resolves to the instant after the gap,
// a wall time that happens twice (fall back) uses the earlier instant. No dependency, only Intl.DateTimeFormat.

const { isId, isDate, isDateTime, toRow, findAll, getOwned, save, create, destroy, audit, optText, fail } = require("./db");

const DAY_MS = 24 * 60 * 60 * 1000;
// Longest search for the next occurrence: a year of days covers weekly gaps and a far start_date is jumped to directly.
const MAX_SEARCH_DAYS = 370;

const formatters = new Map();
function formatterFor(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

// The wall-clock fields of an instant in a zone.
function wallParts(date, timeZone) {
  const p = {};
  for (const part of formatterFor(timeZone).formatToParts(date)) p[part.type] = part.value;
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute, second: +p.second };
}

// How far the zone is ahead of UTC at an instant, in milliseconds.
function offsetAt(ms, timeZone) {
  const w = wallParts(new Date(ms), timeZone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000;
}

function parseDate(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr));
  if (!m) throw new RangeError(`Invalid date: ${dateStr}`);
  return { y: +m[1], m: +m[2], d: +m[3] };
}

function parseTime(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm));
  if (!m || +m[1] > 23 || +m[2] > 59) throw new RangeError(`Invalid time: ${hhmm}`);
  return { h: +m[1], min: +m[2] };
}

// The UTC instant for a local wall time ("YYYY-MM-DD", "HH:MM") in an IANA zone.
function zonedTime(dateStr, hhmm, timeZone) {
  const { y, m, d } = parseDate(dateStr);
  const { h, min } = parseTime(hhmm);
  const wallMs = Date.UTC(y, m - 1, d, h, min);
  // The zone's offset a day before and a day after bracket any transition that touches this wall time.
  const before = offsetAt(wallMs - DAY_MS, timeZone);
  const after = offsetAt(wallMs + DAY_MS, timeZone);
  const candidates = [];
  for (const off of new Set([before, after])) {
    const t = wallMs - off;
    if (offsetAt(t, timeZone) === off) candidates.push(t);   // the wall time really reads this way at t
  }
  // Two valid readings = repeated time (fall back): take the earlier. None = gap (spring forward): read the
  // wall time with the offset from before the gap, which lands the same distance past the gap (02:30 -> 03:30).
  const t = candidates.length ? Math.min(...candidates) : wallMs - before;
  return new Date(t);
}

// "YYYY-MM-DD" of an instant as the patient's wall calendar shows it.
function localDate(date, timeZone) {
  const w = wallParts(date, timeZone);
  return `${String(w.year).padStart(4, "0")}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
}

function addDays(dateStr, n) {
  const { y, m, d } = parseDate(dateStr);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function weekday(dateStr) {
  const { y, m, d } = parseDate(dateStr);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// "HH:MM" strings sorted by clock time, duplicates dropped.
function sortedTimes(times) {
  const clean = (Array.isArray(times) ? times : []).map((t) => {
    const { h, min } = parseTime(t);
    return String(h).padStart(2, "0") + ":" + String(min).padStart(2, "0");
  });
  return [...new Set(clean)].sort();
}

// The next time the reminder is due after `after`, or null when it has ended (past end_date) or a once reminder has fired.
function nextOccurrence(reminder, after) {
  const afterMs = after.getTime();
  const kind = reminder.schedule_type;

  if (kind === "once") {
    if (reminder.last_fired_at || !reminder.remind_at) return null;
    const at = new Date(reminder.remind_at);
    return at.getTime() > afterMs ? at : null;
  }
  if (kind !== "daily" && kind !== "weekly") return null;

  const times = sortedTimes(reminder.times);
  if (!times.length) return null;
  let days = null;
  if (kind === "weekly") {
    days = new Set((Array.isArray(reminder.days_of_week) ? reminder.days_of_week : []).map(Number));
    if (!days.size) return null;
  }

  const timeZone = reminder.time_zone || "UTC";
  const end = reminder.end_date ? String(reminder.end_date).slice(0, 10) : null;
  const start = reminder.start_date ? String(reminder.start_date).slice(0, 10) : null;
  // Start one day back so a zone ahead of or behind the date of `after` never skips a same-day time.
  let day = addDays(localDate(after, timeZone), -1);
  if (start && start > day) day = start;

  for (let i = 0; i < MAX_SEARCH_DAYS; i += 1, day = addDays(day, 1)) {
    if (end && day > end) return null;
    if (days && !days.has(weekday(day))) continue;
    for (const hhmm of times) {
      const at = zonedTime(day, hhmm, timeZone);
      if (at.getTime() > afterMs) return at;
    }
  }
  return null;
}

// --- CRUD and snooze (Task 2.6) --------------------------------------------------------------
// Class: Reminder. Routes (wired in router.js, Task 2.8):
//   list(user)  get(id, user)  create(body, user, ctx)  update(id, body, user, ctx)  remove(id, user, ctx)
//   snooze(id, minutes, user, ctx)
// Firing a reminder and turning a fired once reminder off belong to runDue, not to this code.

const REMINDER_TYPES = ["medication", "refill", "appointment", "device_supply", "custom"];
const SCHEDULE_TYPES = ["once", "daily", "weekly"];
// The class a linked item must come from, and the field holding its name. Custom reminders link to nothing.
const LINKS = {
  medication: { className: "Medication", nameField: "medication_name" },
  refill: { className: "Medication", nameField: "medication_name" },
  device_supply: { className: "DeviceSupply", nameField: "part_name" },
  appointment: { className: "CalendarEvent", nameField: "title" },
};
const MIN_TIMES = 1, MAX_TIMES = 8;
const SNOOZE_MIN = 5, SNOOZE_MAX = 1440;
const PAST_GRACE_MS = 60 * 1000;   // a once reminder may be up to a minute in the past, so a time chosen just now is not refused

const REMINDER_FIELDS = ["user_id", "reminder_type", "title", "linked_id", "linked_name", "schedule_type", "time_zone",
  "start_date", "end_date", "times", "days_of_week", "remind_at", "next_due_at", "last_fired_at", "snoozed_until", "email_me", "active"];
const reminderRow = (o) => toRow(o, "reminder_id", REMINDER_FIELDS);

const has = (body, k) => Object.prototype.hasOwnProperty.call(body, k);
const blank = (v) => v === undefined || v === null || v === "" || (typeof v === "string" && !v.trim());

function validZone(zone) {
  if (typeof zone !== "string" || !zone.trim()) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return true; } catch { return false; }
}

// Checks the fields present in `body` and returns the values to store (before the cross-field checks).
function readFields(body, isNew) {
  const out = {};

  if (isNew || has(body, "reminder_type")) {
    if (!REMINDER_TYPES.includes(body.reminder_type)) return { error: `Reminder type must be one of: ${REMINDER_TYPES.join(", ")}` };
    out.reminder_type = body.reminder_type;
  }
  if (isNew || has(body, "schedule_type")) {
    if (!SCHEDULE_TYPES.includes(body.schedule_type)) return { error: `Schedule must be one of: ${SCHEDULE_TYPES.join(", ")}` };
    out.schedule_type = body.schedule_type;
  }
  if (has(body, "title")) {
    const title = optText(body.title, 200, "Title");
    if (title.error) return { error: title.error };
    out.title = title.value;
  }
  if (has(body, "linked_id")) {
    if (blank(body.linked_id)) out.linked_id = null;
    else if (!isId(body.linked_id)) return { error: "Invalid linked item ID" };
    else out.linked_id = body.linked_id;
  }
  if (has(body, "time_zone")) {
    if (blank(body.time_zone)) out.time_zone = "UTC";
    else if (!validZone(body.time_zone)) return { error: "Time zone must be an IANA name such as America/New_York" };
    else out.time_zone = body.time_zone;
  }
  if (has(body, "times")) {
    if (body.times === null) out.times = null;
    else {
      if (!Array.isArray(body.times) || body.times.length < MIN_TIMES || body.times.length > MAX_TIMES) {
        return { error: `Enter ${MIN_TIMES} to ${MAX_TIMES} times of day` };
      }
      try { out.times = sortedTimes(body.times); } catch { return { error: "Times must be in the format HH:MM" }; }
    }
  }
  if (has(body, "days_of_week")) {
    if (body.days_of_week === null) out.days_of_week = null;
    else {
      const days = body.days_of_week;
      if (!Array.isArray(days) || !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
        return { error: "Days of the week must be whole numbers from 0 (Sunday) to 6 (Saturday)" };
      }
      out.days_of_week = [...new Set(days)].sort((a, b) => a - b);
    }
  }
  if (has(body, "remind_at")) {
    if (blank(body.remind_at)) out.remind_at = null;
    else if (!isDateTime(body.remind_at)) return { error: "Remind at must be a date and time" };
    else out.remind_at = new Date(body.remind_at);
  }
  for (const f of ["start_date", "end_date"]) {
    if (!has(body, f)) continue;
    if (blank(body[f])) out[f] = null;
    else if (!isDate(body[f])) return { error: "Use the date format YYYY-MM-DD" };
    else out[f] = body[f];
  }
  for (const f of ["email_me", "active"]) {
    if (!has(body, f)) continue;
    if (typeof body[f] !== "boolean") return { error: `${f === "active" ? "Active" : "Email me"} must be true or false` };
    out[f] = body[f];
  }
  return { values: out };
}

// Checks the whole reminder as it will be stored (`merged` = stored row + changes). Returns the schedule
// fields that don't belong to the schedule type, cleared.
function checkSchedule(merged) {
  const kind = merged.schedule_type;
  if (kind === "once") {
    if (!merged.remind_at) return { error: "Choose the date and time for a one-time reminder" };
    return { values: { times: null, days_of_week: null } };
  }
  const times = Array.isArray(merged.times) ? merged.times : [];
  if (times.length < MIN_TIMES || times.length > MAX_TIMES) return { error: `Enter ${MIN_TIMES} to ${MAX_TIMES} times of day` };
  if (kind === "weekly") {
    if (!Array.isArray(merged.days_of_week) || !merged.days_of_week.length) return { error: "Choose at least one day of the week" };
    return { values: { remind_at: null } };
  }
  return { values: { remind_at: null, days_of_week: null } };
}

// The item a reminder points at, or a 404 when it isn't the caller's
async function resolveLink(type, linkedId, user) {
  const link = LINKS[type];
  const item = await getOwned(link.className, linkedId, user.user_id);
  if (!item) return { res: fail(404, "Linked item not found") };
  const name = item.get(link.nameField);
  return { name: typeof name === "string" && name.trim() ? name.trim() : null };
}

// What create and update share: validate `body` against the stored values `current` (a row; just the defaults for a
// new reminder) and return the values to save, with next_due_at computed.
async function prepare(body, current, user, isNew) {
  const fields = readFields(body, isNew);
  if (fields.error) return { res: fail(400, fields.error) };
  const out = fields.values;
  const merged = { ...current, ...out };

  const schedule = checkSchedule(merged);
  if (schedule.error) return { res: fail(400, schedule.error) };
  Object.assign(out, schedule.values);
  Object.assign(merged, schedule.values);

  // A once reminder in the past can never fire. Only checked when the time or schedule is being set, so editing
  // another field of a reminder that already fired (for example turning it off) still works.
  if (merged.schedule_type === "once" && (isNew || has(body, "remind_at") || has(body, "schedule_type"))
    && new Date(merged.remind_at).getTime() < Date.now() - PAST_GRACE_MS) {
    return { res: fail(400, "Pick a time in the future") };
  }

  if (merged.start_date && merged.end_date && merged.end_date < merged.start_date) {
    return { res: fail(400, "The end date can't be before the start date") };
  }

  if (merged.reminder_type === "custom") {
    if (!blank(out.linked_id)) return { res: fail(400, "A custom reminder can't be linked to an item") };
    out.linked_id = null;
    out.linked_name = null;
  } else if (isNew || has(body, "linked_id") || has(body, "reminder_type")) {
    // Re-check the link whenever it or the type changes (the type decides which class the id must belong to)
    if (merged.linked_id) {
      const { name, res } = await resolveLink(merged.reminder_type, merged.linked_id, user);
      if (res) return { res };
      out.linked_name = name;
    } else out.linked_name = null;
  }
  const linkedName = has(out, "linked_name") ? out.linked_name : current.linked_name;

  if (!(has(out, "title") ? out.title : current.title)) {
    if (!linkedName) return { res: fail(400, "Enter a title for the reminder") };
    out.title = linkedName;
  }

  // A new time or schedule starts a once reminder over, so one that already fired can fire again
  const remindIso = (v) => (v ? new Date(v).toISOString() : null);
  if (!isNew && ((has(out, "schedule_type") && out.schedule_type !== current.schedule_type)
    || (has(out, "remind_at") && remindIso(out.remind_at) !== remindIso(current.remind_at)))) {
    out.last_fired_at = null;
    merged.last_fired_at = null;
  }
  out.next_due_at = nextOccurrence(merged, new Date());
  return { values: out };
}

async function ownedReminder(id, user) {
  if (!isId(id)) return { res: fail(400, "Invalid reminder ID") };
  const reminder = await getOwned("Reminder", id, user.user_id);
  if (!reminder) return { res: fail(404, "Reminder not found") };
  return { reminder };
}

// GET /reminders
async function list(user) {
  const rows = await findAll("Reminder", { user_id: user.user_id }, { ascending: "createdAt" });
  return { status: 200, reminders: rows.map(reminderRow) };
}

// GET /reminders/:id
async function get(id, user) {
  const { reminder, res } = await ownedReminder(id, user);
  if (res) return res;
  return { status: 200, reminder: reminderRow(reminder) };
}

// POST /reminders {reminder_type, title?, linked_id?, schedule_type, times?, days_of_week?, remind_at?, start_date?, end_date?, time_zone?, email_me?}
async function createReminder(body, user, ctx) {
  if (!body || typeof body !== "object") return fail(400, "Missing reminder details");
  const prep = await prepare(body, {}, user, true);
  if (prep.res) return prep.res;
  const reminder = await create("Reminder", { user_id: user.user_id, time_zone: "UTC", email_me: false, active: true, ...prep.values });
  const row = reminderRow(reminder);
  await audit({ userId: user.user_id, event: "INSERT", targetClass: "Reminder", targetId: reminder.id, newData: row, ip: ctx.ip });
  return { status: 201, message: "Reminder added", reminder: row };
}

// PUT /reminders/:id — only the fields sent change; the result as a whole must still be a valid reminder
async function update(id, body, user, ctx) {
  body = body || {};
  const { reminder, res } = await ownedReminder(id, user);
  if (res) return res;
  const oldData = reminderRow(reminder);
  const prep = await prepare(body, oldData, user, false);
  if (prep.res) return prep.res;
  await save(reminder, prep.values);
  const newData = reminderRow(reminder);
  await audit({ userId: user.user_id, event: "UPDATE", targetClass: "Reminder", targetId: reminder.id, oldData, newData, ip: ctx.ip });
  return { status: 200, message: "Reminder updated", reminder: newData };
}

// DELETE /reminders/:id
async function remove(id, user, ctx) {
  const { reminder, res } = await ownedReminder(id, user);
  if (res) return res;
  const oldData = reminderRow(reminder);
  await destroy(reminder);
  await audit({ userId: user.user_id, event: "DELETE", targetClass: "Reminder", targetId: id, oldData, ip: ctx.ip });
  return { status: 200, message: "Reminder removed" };
}

// POST /reminders/:id/snooze {minutes} — hold the reminder back for 5 minutes to 24 hours from now.
// A once reminder that already fired (and was turned off) is set to fire again at that time.
async function snooze(id, minutes, user, ctx) {
  const { reminder, res } = await ownedReminder(id, user);
  if (res) return res;
  const n = typeof minutes === "string" && /^\d+$/.test(minutes.trim()) ? Number(minutes) : minutes;
  if (!Number.isInteger(n) || n < SNOOZE_MIN || n > SNOOZE_MAX) {
    return fail(400, `Snooze must be a whole number of minutes from ${SNOOZE_MIN} to ${SNOOZE_MAX}`);
  }
  const oldData = reminderRow(reminder);
  const until = new Date(Date.now() + n * 60 * 1000);
  const changes = { snoozed_until: until };
  // A once reminder is turned off when it fires, so snoozing a fired one re-arms it for the snoozed time.
  // One that hasn't fired keeps its own time and only waits out the snooze.
  if (reminder.get("schedule_type") === "once" && reminder.get("last_fired_at")) {
    Object.assign(changes, { active: true, remind_at: until, next_due_at: until, last_fired_at: null });
  }
  await save(reminder, changes);
  const newData = reminderRow(reminder);
  await audit({ userId: user.user_id, event: "UPDATE", targetClass: "Reminder", targetId: reminder.id, oldData, newData, ip: ctx.ip,
    detail: `Snoozed ${n} minutes` });
  return { status: 200, message: "Reminder snoozed", reminder: newData };
}

module.exports = {
  zonedTime, nextOccurrence, wallParts, localDate, addDays, weekday, validZone,
  list, get, create: createReminder, update, remove, snooze,
  REMINDER_TYPES, SCHEDULE_TYPES, reminderRow,
};
