// calendar.js — Calendar & events (Tasks 4.3 / 4.4), on Parse. Class: CalendarEvent
//   GET/POST /calendar/events, GET/PUT/DELETE /calendar/events/:id, GET /calendar/upcoming,
//   GET /calendar/events/:id/ics, GET /calendar/ics
// The .ics handlers return { ics, filename, content_type } for the browser to download.
//
// Repeating events (Task 3.2). One stored event is the whole series; editing it changes every occurrence.
//   recurrence_type      none | daily | every_n_days | weekly | monthly   (missing = none)
//   recurrence_interval  every_n_days only, 1-365 (every other day = 2)
//   recurrence_weekdays  weekly only, [0-6, ...] 0 = Sunday; occurrences fall only on these days
//   recurrence_day       monthly only, 1-31; a month without that day uses its last day
//   end_type             never | date (end_date "YYYY-MM-DD", inclusive) | count (end_count 1-1000)
//   exceptions           ["YYYY-MM-DD", ...] local dates whose occurrence is skipped (a skipped one still counts toward end_count)
// Occurrences are worked out in the patient's time zone (query timeZone, UTC when missing) with the reminders'
// local-day helpers: each occurrence keeps the series' local time of day across daylight saving changes, and keeps
// the series' length. All-day events are stored at UTC midnight, so they are expanded in UTC.
// The stored start is always the first occurrence, even when it is not a day the rule picks (RFC 5545 DTSTART).
// The .ics (Task 3.3) writes the same rule as RRULE with one EXDATE per exception; see icsRule.
//
// Stored time zone (Task 5.1a). time_zone is the IANA zone the event was made in (create/update body; UTC when none
// was given, unknown zone -> 400). The .ics writes timed DTSTART/DTEND/EXDATE as local wall times with TZID=<zone>
// (plain UTC "...Z" values when the zone is UTC) and UNTIL in UTC, so BYDAY/BYMONTHDAY land on the patient's local day.
// List and upcoming still expand in the query's timeZone.
//
// Subscribe feed (D-016): feedIcs writes the same .ics with the minimal option (title, times and repeat rule only);
// the token handling and the public route are in calendarFeed.js.

const { M, isId, isDate, isDateTime, toRow, findAll, getOwned, save, create, audit, param } = require("./db");
const { zonedTime, wallParts, localDate, addDays, weekday, validZone } = require("./reminders");

const BASE_FIELDS = ["user_id", "title", "description", "category", "start_time", "end_time", "all_day", "location", "provider_name", "status", "condition_id"];
const REPEAT_FIELDS = ["recurrence_type", "recurrence_interval", "recurrence_weekdays", "recurrence_day", "end_type", "end_date", "end_count", "exceptions"];
const FIELDS = [...BASE_FIELDS, ...REPEAT_FIELDS, "time_zone"];
const CATEGORIES = ["appointment", "medication", "reminder", "personal", "lab", "procedure"];
const STATUSES = ["scheduled", "completed", "cancelled"];
const EDITABLE = BASE_FIELDS.slice(1);
const ICS_TYPE = "text/calendar; charset=utf-8";
const REPEAT_TYPES = ["none", "daily", "every_n_days", "weekly", "monthly"];
const END_TYPES = ["never", "date", "count"];
const MAX_END_COUNT = 1000, MAX_INTERVAL = 365, MAX_EXCEPTIONS = 1000;
const MAX_OCCURRENCES = 1000;   // most occurrences one series gives back from one expansion
const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = 366 * DAY_MS; // how far list and upcoming look when no range bound is given

const row = (o) => toRow(o, "event_id", FIELDS);
const notFound = (id) => ({ status: isId(id) ? 404 : 400, error: isId(id) ? "Event not found" : "Invalid event ID" });
const sortEvents = (rows) => rows.sort((a, b) => a.start_time.localeCompare(b.start_time) || a.event_id.localeCompare(b.event_id));

// all-day events are stored at UTC midnight of the chosen day
function allDayMidnight(value) {
  if (value === null || value === undefined) return null;
  const s = typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : new Date(value).toISOString().slice(0, 10);
  return new Date(`${s}T00:00:00Z`);
}

function validate(body) {
  if ("title" in body) {
    const t = body.title == null ? "" : String(body.title).trim();
    if (!t) return "title cannot be empty";
    if (t.length > 255) return "title is too long (max 255)";
  }
  if ("category" in body && !CATEGORIES.includes(body.category)) return `Invalid category. Must be one of: ${CATEGORIES.join(", ")}`;
  if ("status" in body && !STATUSES.includes(body.status)) return `Invalid status. Must be one of: ${STATUSES.join(", ")}`;
  if ("start_time" in body && !isDateTime(body.start_time)) return "start_time is not a valid date/time";
  if (body.end_time != null && !isDateTime(body.end_time)) return "end_time is not a valid date/time";
  if ("all_day" in body && typeof body.all_day !== "boolean") return "all_day must be true or false";
  for (const f of ["location", "provider_name"]) if (body[f] != null && String(body[f]).trim().length > 255) return `${f} is too long (max 255)`;
  if (body.description != null && String(body.description).length > 5000) return "description is too long";
  if (body.condition_id != null && !isId(String(body.condition_id))) return "condition_id must be a valid id";
  return null;
}
// IANA zone names only (they go into TZID): "UTC", a name Intl lists, or an alias Intl resolves to one of those
// (Node lists "Asia/Calcutta" but not "Asia/Kolkata", and not "Etc/UTC"). Offsets such as "+05:30" resolve to
// themselves and are refused; the shape check refuses lower-case spellings Intl would accept ("america/new_york").
const IANA_ZONES = new Set(Intl.supportedValuesOf("timeZone"));
const IANA_SHAPE = /^[A-Z][A-Za-z0-9_+-]*(\/[A-Z][A-Za-z0-9_+-]*)*$/;
function isIanaZone(z) {
  if (typeof z !== "string") return false;
  if (z === "UTC" || IANA_ZONES.has(z)) return true;
  if (!IANA_SHAPE.test(z) || !validZone(z)) return false;
  const canonical = new Intl.DateTimeFormat("en-US", { timeZone: z }).resolvedOptions().timeZone;
  return canonical === "UTC" || IANA_ZONES.has(canonical);
}
// The event's time zone from body.time_zone: {zone} (trimmed, as the client sent it), {zone: null} when not given,
// or {error} for anything that is not an IANA zone name.
function readZone(body) {
  const v = body.time_zone;
  if (v === undefined || v === null || v === "") return { zone: null };
  const z = typeof v === "string" ? v.trim() : v;
  return isIanaZone(z) ? { zone: z } : { error: "Unknown time zone" };
}
async function checkCondition(body, user) {
  if (body.condition_id == null) return null;
  return (await getOwned("Condition", String(body.condition_id), user.user_id)) ? null : "condition_id does not match one of your conditions";
}
function value(f, v) {
  if (v === null || v === undefined) return null;
  if (f === "all_day") return v;
  if (f === "start_time" || f === "end_time") return new Date(v);
  const s = String(v).trim();
  return s === "" ? null : s;
}

// ---------- repeating events (Task 3.2) ----------
const blank = (v) => v === undefined || v === null || v === "";
// A whole number from a number or a string of digits; anything else is NaN
const whole = (v) => (typeof v === "string" && /^\s*\d+\s*$/.test(v) ? Number(v) : Number.isInteger(v) ? v : NaN);
const between = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;
const isRepeating = (e) => !blank(e.recurrence_type) && e.recurrence_type !== "none";

// The calendar day the series starts on, which end_date is compared with: the stored UTC day for an all-day
// event; otherwise the day in body.time_zone when given, else the date as written in start_time.
function startDay(body) {
  const s = body.start_time;
  if (!(s instanceof Date) && !isDateTime(s)) return null;
  if (body.all_day === true) return allDayMidnight(s).toISOString().slice(0, 10);
  if (isIanaZone(body.time_zone)) return localDate(new Date(s), body.time_zone);
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : new Date(s).toISOString().slice(0, 10);
}

// Checks the repeat rule in `body` (an event as it will be stored) and returns every recurrence field to store,
// with the ones that don't belong to the rule cleared. {values} or {error}.
function validateRecurrence(body) {
  const b = body || {};
  const type = blank(b.recurrence_type) ? "none" : b.recurrence_type;
  if (!REPEAT_TYPES.includes(type)) return { error: `Repeat must be one of: ${REPEAT_TYPES.join(", ")}` };
  const values = Object.fromEntries(REPEAT_FIELDS.map((f) => [f, null]));
  values.recurrence_type = type;
  if (type === "none") return { values };

  if (type === "every_n_days") {
    const n = whole(b.recurrence_interval);
    if (!between(n, 1, MAX_INTERVAL)) return { error: `every N days needs a number from 1 to ${MAX_INTERVAL}` };
    values.recurrence_interval = n;
  } else if (type === "weekly") {
    const w = b.recurrence_weekdays;
    if (!Array.isArray(w) || !w.length) return { error: "Choose at least one day of the week" };
    const nums = w.map(whole);   // 1 or "1": the same whole-number rule as the interval and the day
    if (!nums.every((d) => between(d, 0, 6))) return { error: "Days of the week must be whole numbers from 0 (Sunday) to 6 (Saturday)" };
    values.recurrence_weekdays = [...new Set(nums)].sort((x, y) => x - y);
  } else if (type === "monthly") {
    const d = whole(b.recurrence_day);
    if (!between(d, 1, 31)) return { error: "Day of the month must be a number from 1 to 31" };
    values.recurrence_day = d;
  }

  const endType = blank(b.end_type) ? "never" : b.end_type;
  if (!END_TYPES.includes(endType)) return { error: `End must be one of: ${END_TYPES.join(", ")}` };
  values.end_type = endType;
  if (endType === "date") {
    if (!isDate(b.end_date)) return { error: "Use the date format YYYY-MM-DD for the end date" };
    const first = startDay(b);
    if (first && b.end_date < first) return { error: "The end date can't be before the start date" };
    values.end_date = b.end_date;
  } else if (endType === "count") {
    const c = whole(b.end_count);
    if (!between(c, 1, MAX_END_COUNT)) return { error: `The number of times must be from 1 to ${MAX_END_COUNT}` };
    values.end_count = c;
  }

  if (!blank(b.exceptions)) {
    if (!Array.isArray(b.exceptions) || !b.exceptions.every(isDate)) return { error: "Skipped dates must use the date format YYYY-MM-DD" };
    if (b.exceptions.length > MAX_EXCEPTIONS) return { error: `Too many skipped dates (max ${MAX_EXCEPTIONS})` };
    values.exceptions = [...new Set(b.exceptions)].sort();
  }
  return { values };
}

const pad2 = (n) => String(n).padStart(2, "0");
// The weekdays (0 = Sunday .. 6) a stored weekly rule picks: valid whole numbers only, no repeats, ascending. [] when none.
// Shared by the expansion (ruleDays) and the .ics (icsRule) so both read the stored rule the same way.
const ruleWeekdays = (event) => [...new Set(Array.isArray(event.recurrence_weekdays) ? event.recurrence_weekdays.filter((d) => between(d, 0, 6)) : [])]
  .sort((a, b) => a - b);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);

// The days ("YYYY-MM-DD", ascending, endless) a valid rule falls on, from `fromDay` on; null for a rule that can't
// repeat (bad stored values), which is then shown once like a plain event.
function ruleDays(event, firstDay, fromDay) {
  const type = event.recurrence_type;
  if (type === "daily" || type === "every_n_days") {
    const step = type === "daily" ? 1 : event.recurrence_interval;
    if (!between(step, 1, MAX_INTERVAL)) return null;
    // the first step on or after fromDay, counted from the series' first day
    let day = addDays(firstDay, Math.ceil(daysBetween(firstDay, fromDay) / step) * step);
    return (function* () { for (;; day = addDays(day, step)) yield day; })();
  }
  if (type === "weekly") {
    const set = new Set(ruleWeekdays(event));
    if (!set.size) return null;
    return (function* () { for (let day = fromDay; ; day = addDays(day, 1)) if (set.has(weekday(day))) yield day; })();
  }
  if (type === "monthly") {
    const want = event.recurrence_day;
    if (!between(want, 1, 31)) return null;
    return (function* () {
      let y = +fromDay.slice(0, 4), m = +fromDay.slice(5, 7);
      for (;;) {
        const last = new Date(Date.UTC(y, m, 0)).getUTCDate();   // day 0 of the next month = last day of this one
        const day = `${String(y).padStart(4, "0")}-${pad2(m)}-${pad2(Math.min(want, last))}`;
        if (day >= fromDay) yield day;
        if (++m > 12) { m = 1; y += 1; }
      }
    })();
  }
  return null;
}

// The occurrences of `event` (a row) that overlap [rangeStart, rangeEnd), as [{start, end, date}] with ISO
// start/end (end null when the event has none) and the occurrence's local date. A missing bound is open.
function expandOccurrences(event, rangeStart, rangeEnd, timeZone) {
  const startMs = new Date(event.start_time).getTime();
  if (isNaN(startMs)) return [];
  const fromMs = rangeStart == null ? -Infinity : new Date(rangeStart).getTime();
  const toMs = rangeEnd == null ? Infinity : new Date(rangeEnd).getTime();
  if (isNaN(fromMs) || isNaN(toMs)) return [];   // an unreadable bound would never end an endless series
  const length = event.end_time ? Math.max(new Date(event.end_time).getTime() - startMs, 0) : null;
  const zone = event.all_day ? "UTC" : isIanaZone(timeZone) ? timeZone : "UTC";
  const firstDay = localDate(new Date(startMs), zone);
  const overlaps = (s) => s < toMs && s + (length || 0) >= fromMs;
  const occurrence = (s, date) => ({ start: new Date(s).toISOString(), end: length === null ? null : new Date(s + length).toISOString(), date });

  const maxCount = event.end_type === "count" && between(event.end_count, 1, MAX_END_COUNT) ? event.end_count : null;
  // Counting needs every occurrence from the first; otherwise start a day before the earliest one that could overlap.
  let fromDay = firstDay;
  if (maxCount === null && fromMs > startMs) {
    const near = addDays(localDate(new Date(fromMs - (length || 0)), zone), -1);
    if (near > fromDay) fromDay = near;
  }
  let days = isRepeating(event) ? ruleDays(event, firstDay, fromDay) : null;
  // The stored start is always the first occurrence, as DTSTART is in the .ics (RFC 5545), even when it is not a day the
  // rule picks (a Tuesday start on a Monday/Thursday rule). It counts toward end_count like any other.
  if (days && fromDay === firstDay) days = (function* (rest) {
    let first = true;
    for (const d of rest) { if (first && d !== firstDay) yield firstDay; first = false; yield d; }
  })(days);
  if (!days) return overlaps(startMs) ? [occurrence(startMs, firstDay)] : [];

  // Each occurrence keeps the series' local time of day; the first one is the stored start itself.
  const w = wallParts(new Date(startMs), zone);
  const hhmm = `${pad2(w.hour)}:${pad2(w.minute)}`;
  const extraMs = w.second * 1000 + (((startMs % 1000) + 1000) % 1000);
  const at = (day) => (day === firstDay ? startMs : zonedTime(day, hhmm, zone).getTime() + extraMs);

  const endDate = event.end_type === "date" && isDate(event.end_date) ? event.end_date : null;
  const skip = new Set(Array.isArray(event.exceptions) ? event.exceptions : []);
  const out = [];
  let count = 0;
  for (const day of days) {
    if (endDate && day > endDate) break;
    if (maxCount !== null && count >= maxCount) break;
    count += 1;
    const s = at(day);
    if (s >= toMs) break;
    if (skip.has(day) || !overlaps(s)) continue;
    out.push(occurrence(s, day));
    if (out.length >= MAX_OCCURRENCES) break;
  }
  return out;
}

// A repeating event row -> one row per occurrence in range (same event_id, with occurrence_date); others unchanged.
function occurrenceRows(e, fromMs, toMs, timeZone) {
  if (!isRepeating(e)) return [e];
  return expandOccurrences(e, fromMs, toMs, timeZone).map((o) => ({ ...e, start_time: o.start, end_time: o.end, occurrence_date: o.date }));
}

// The patient's zone from ?timeZone= (or ?time_zone=), UTC when missing
function zoneParam(query) {
  const tz = param(query, "timeZone") ?? param(query, "time_zone");
  if (tz == null) return { zone: "UTC" };
  return validZone(tz) ? { zone: tz } : { error: "Time zone must be an IANA name such as America/New_York" };
}

async function list(query, user) {
  const startDate = param(query, "startDate"), endDate = param(query, "endDate"), category = param(query, "category"),
    status = param(query, "status"), limitRaw = param(query, "limit");
  if (startDate && !isDateTime(startDate)) return { status: 400, error: "startDate is not a valid date" };
  if (endDate && !isDateTime(endDate)) return { status: 400, error: "endDate is not a valid date" };
  if (startDate && endDate && new Date(endDate) < new Date(startDate)) return { status: 400, error: "endDate cannot be before startDate" };
  if (category && !CATEGORIES.includes(category)) return { status: 400, error: `Invalid category. Must be one of: ${CATEGORIES.join(", ")}` };
  if (status && !STATUSES.includes(status)) return { status: 400, error: `Invalid status. Must be one of: ${STATUSES.join(", ")}` };
  let limit = 500;
  if (limitRaw != null) {
    limit = parseInt(limitRaw, 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return { status: 400, error: "limit must be between 1 and 1000" };
  }
  const tz = zoneParam(query);
  if (tz.error) return { status: 400, error: tz.error };
  let rows = (await findAll("CalendarEvent", { user_id: user.user_id })).map(row);
  if (category) rows = rows.filter((e) => e.category === category);
  if (status) rows = rows.filter((e) => e.status === status);
  const s = startDate ? new Date(startDate.slice(0, 10)).toISOString() : null;
  const e2 = endDate ? new Date(Date.parse(endDate.slice(0, 10)) + 86400000).toISOString() : null;
  // Repeating events become one row per occurrence. A missing bound looks a year back from the end (or from now)
  // and a year ahead of the start (or of now), so an endless series stays finite.
  const toMs = e2 ? Date.parse(e2) : (s ? Date.parse(s) : Date.now()) + WINDOW_MS;
  const fromMs = s ? Date.parse(s) : (e2 ? Date.parse(e2) : Date.now()) - WINDOW_MS;
  rows = rows.flatMap((e) => occurrenceRows(e, fromMs, toMs, tz.zone));
  if (s) rows = rows.filter((e) => (e.end_time || e.start_time) >= s);
  if (e2) rows = rows.filter((e) => e.start_time < e2);
  rows = sortEvents(rows).slice(0, limit);
  return { status: 200, events: rows, count: rows.length };
}

async function getById(id, user) {
  const e = await getOwned("CalendarEvent", id, user.user_id);
  return e ? { status: 200, event: row(e) } : notFound(id);
}

async function createEvent(body, user) {
  if (!body || typeof body !== "object") return { status: 400, error: "Missing event details" };
  if (body.title == null || !String(body.title).trim()) return { status: 400, error: "Missing required field: title" };
  if (body.start_time == null || body.start_time === "") return { status: 400, error: "Missing required field: start_time" };
  const err = validate(body);
  if (err) return { status: 400, error: err };
  const tz = readZone(body);
  if (tz.error) return { status: 400, error: tz.error };
  const repeat = validateRecurrence({ ...body, time_zone: tz.zone });   // the cleaned zone decides the start day
  if (repeat.error) return { status: 400, error: repeat.error };
  const values = { category: "appointment", status: "scheduled", all_day: false, ...repeat.values, time_zone: tz.zone || "UTC" };
  for (const f of EDITABLE) if (body[f] != null) values[f] = value(f, body[f]);
  if (values.all_day) {
    values.start_time = allDayMidnight(body.start_time);
    if (values.end_time) values.end_time = allDayMidnight(body.end_time);
  }
  if (values.end_time && values.end_time < values.start_time) return { status: 400, error: "end_time cannot be before start_time" };
  const condErr = await checkCondition(body, user);
  if (condErr) return { status: 400, error: condErr };
  const e = await create("CalendarEvent", { ...values, user_id: user.user_id });
  const data = row(e);
  await audit({ userId: user.user_id, event: "INSERT", targetClass: "CalendarEvent", targetId: e.id, newData: data });
  return { status: 201, message: "Event created", event: data };
}

async function update(id, body, user) {
  if (!body || typeof body !== "object") return { status: 400, error: "No fields to update" };
  const fields = EDITABLE.filter((f) => body[f] !== undefined);
  const repeatFields = REPEAT_FIELDS.filter((f) => body[f] !== undefined);
  const tz = readZone(body);
  if (!fields.length && !repeatFields.length && !tz.zone && !tz.error) return { status: 400, error: "No fields to update" };
  const err = validate(body);
  if (err) return { status: 400, error: err };
  if (tz.error) return { status: 400, error: tz.error };
  for (const f of ["title", "start_time", "category", "status", "all_day"]) if (body[f] === null) return { status: 400, error: `${f} can't be cleared` };
  const e = await getOwned("CalendarEvent", id, user.user_id);
  if (!e) return notFound(id);
  const condErr = await checkCondition(body, user);
  if (condErr) return { status: 400, error: condErr };
  const old = row(e);
  const updates = {};
  for (const f of fields) updates[f] = value(f, body[f]);
  if (tz.zone) updates.time_zone = tz.zone;   // the stored zone stays unless a new one is sent
  const nextAllDay = "all_day" in updates ? updates.all_day : old.all_day;
  let nextStart = "start_time" in updates ? updates.start_time : new Date(old.start_time);
  let nextEnd = "end_time" in updates ? updates.end_time : old.end_time ? new Date(old.end_time) : null;
  if (nextAllDay) {
    nextStart = allDayMidnight(nextStart);
    nextEnd = allDayMidnight(nextEnd);
    if (nextAllDay !== old.all_day || "start_time" in updates) updates.start_time = nextStart;
    if (nextAllDay !== old.all_day || "end_time" in updates) updates.end_time = nextEnd;
  }
  if (nextEnd && nextEnd < nextStart) return { status: 400, error: "end_time cannot be before start_time" };
  // The rule is checked as the whole series will be stored, so a new start can't land after its end date
  if (repeatFields.length || "start_time" in updates || "all_day" in updates || "time_zone" in updates) {
    const merged = { ...old, ...Object.fromEntries(repeatFields.map((f) => [f, body[f]])),
      start_time: "start_time" in body ? body.start_time : old.start_time, all_day: nextAllDay, time_zone: tz.zone || old.time_zone };
    const repeat = validateRecurrence(merged);
    if (repeat.error) return { status: 400, error: repeat.error };
    if (repeatFields.length) Object.assign(updates, repeat.values);
  }
  await save(e, updates);
  const data = row(e);
  await audit({ userId: user.user_id, event: "UPDATE", targetClass: "CalendarEvent", targetId: e.id, oldData: old, newData: data });
  return { status: 200, message: "Event updated", event: data };
}

async function remove(id, user) {
  const e = await getOwned("CalendarEvent", id, user.user_id);
  if (!e) return notFound(id);
  const old = row(e);
  await e.destroy(M);
  await audit({ userId: user.user_id, event: "DELETE", targetClass: "CalendarEvent", targetId: id, oldData: old });
  return { status: 200, message: "Event deleted" };
}

// DELETE /calendar/events/:id/occurrences/:date — skip one occurrence of a series by adding its local date to
// exceptions (once; skipping it again changes nothing). The rest of the series is untouched.
async function skipOccurrence(id, date, user, ctx) {
  if (!isId(id)) return { status: 400, error: "Invalid event ID" };
  if (!isDate(date)) return { status: 400, error: "Use the date format YYYY-MM-DD" };
  const e = await getOwned("CalendarEvent", id, user.user_id);
  if (!e) return notFound(id);
  const old = row(e);
  if (!isRepeating(old)) return { status: 400, error: "This event does not repeat" };
  const current = Array.isArray(old.exceptions) ? old.exceptions : [];
  if (!current.includes(date)) {
    if (current.length >= MAX_EXCEPTIONS) return { status: 400, error: `Too many skipped dates (max ${MAX_EXCEPTIONS})` };
    await save(e, { exceptions: [...current, date].sort() });
    await audit({ userId: user.user_id, event: "UPDATE", targetClass: "CalendarEvent", targetId: e.id, oldData: old, newData: row(e),
      ip: ctx && ctx.ip, detail: `Skipped occurrence ${date}` });
  }
  return { status: 200, message: "Occurrence skipped", event: row(e) };
}

async function upcoming(query, user) {
  let limit = 5;
  const limitRaw = param(query, "limit");
  if (limitRaw != null) {
    limit = parseInt(limitRaw, 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) return { status: 400, error: "limit must be between 1 and 50" };
  }
  const tz = zoneParam(query);
  if (tz.error) return { status: 400, error: tz.error };
  const now = Date.now();
  const rows = sortEvents((await findAll("CalendarEvent", { user_id: user.user_id, status: "scheduled" })).map(row)
    .flatMap((e) => occurrenceRows(e, now - DAY_MS, now + WINDOW_MS, tz.zone))
    .filter((e) => Date.parse(e.end_time || e.start_time) + (e.all_day ? 86400000 : 0) > now)).slice(0, limit);
  return { status: 200, events: rows, count: rows.length };
}

// ---------- .ics (RFC 5545) ----------
const icsDateTime = (v) => new Date(v).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
function icsDate(v, plusDays = 0) {
  const d = new Date(v);
  d.setUTCDate(d.getUTCDate() + plusDays);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}
// The zone the .ics is written in: the stored time_zone when it is an IANA name; UTC for events saved before it was
// stored or holding anything else.
const icsZone = (e) => (isIanaZone(e.time_zone) ? e.time_zone : "UTC");
// "YYYYMMDDTHHMMSS", the wall-clock time of instant `v` in `zone` (no Z)
function icsWall(v, zone) {
  const w = wallParts(new Date(v), zone);
  return `${String(w.year).padStart(4, "0")}${pad2(w.month)}${pad2(w.day)}T${pad2(w.hour)}${pad2(w.minute)}${pad2(w.second)}`;
}
// A timed DTSTART/DTEND: local wall time with TZID, or the plain UTC form when the zone is UTC (the same instant,
// and readable by every client without a VTIMEZONE). No VTIMEZONE is written for other zones (known limitation).
const icsTimed = (name, v, zone) => (zone === "UTC" ? `${name}:${icsDateTime(v)}` : `${name};TZID=${zone}:${icsWall(v, zone)}`);
// Text values lose every control character (U+0000-U+001F) and the U+2028/U+2029 separators before escaping, so no
// value can break or smuggle an .ics line. CR and LF are the exception: they become the escaped "\n" below (never a raw
// line end), which keeps multi-line notes readable in the download.
const ICS_CONTROLS = /[\x00-\x09\x0b\x0c\x0e-\x1f]/g;
const ICS_SEPARATORS = new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]`, "g");
const icsText = (v) => String(v).replace(ICS_CONTROLS, "").replace(ICS_SEPARATORS, "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
function foldLine(line) {
  const out = [];
  let current = "", bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch, "utf8");
    if (bytes + size > (out.length === 0 ? 75 : 74)) { out.push(current); current = ""; bytes = 0; }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join("\r\n ");
}
// The repeat rule as an RRULE value, from the stored fields; null when the event doesn't repeat or its stored rule is
// unusable (the expansion shows that case once, like a plain event). DTSTART is always the first instance (RFC 5545),
// whether or not it falls on the rule, which matches the expansion.
// Known difference: a monthly rule on day 29-31 is BYMONTHDAY=<day>, and calendar apps skip months without that day,
// while the expansion (reminders, list, upcoming) uses the month's last day. The expansion is left as it is.
const ICS_DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
function icsRule(e) {
  if (!isRepeating(e)) return null;
  let rule;
  if (e.recurrence_type === "daily") rule = "FREQ=DAILY";
  else if (e.recurrence_type === "every_n_days") {
    if (!between(e.recurrence_interval, 1, MAX_INTERVAL)) return null;
    rule = `FREQ=DAILY;INTERVAL=${e.recurrence_interval}`;
  } else if (e.recurrence_type === "weekly") {
    const set = ruleWeekdays(e);
    if (!set.length) return null;
    rule = `FREQ=WEEKLY;BYDAY=${set.map((d) => ICS_DAYS[d]).join(",")}`;
  } else if (e.recurrence_type === "monthly") {
    if (!between(e.recurrence_day, 1, 31)) return null;
    rule = `FREQ=MONTHLY;BYMONTHDAY=${e.recurrence_day}`;
  } else return null;
  if (e.end_type === "date" && isDate(e.end_date)) {
    // UNTIL has the value type of DTSTART: a date for all-day events; otherwise UTC (required with a TZID DTSTART,
    // RFC 5545 3.3.10), the instant the end date ends in the event's zone (23:59:59 local)
    const until = e.all_day ? e.end_date.replace(/-/g, "") : icsDateTime(zonedTime(e.end_date, "23:59", icsZone(e)).getTime() + 59000);
    rule += `;UNTIL=${until}`;
  } else if (e.end_type === "count" && between(e.end_count, 1, MAX_END_COUNT)) rule += `;COUNT=${e.end_count}`;
  return rule;
}
// minimal (the subscribe feed, D-016): only UID, DTSTAMP, DTSTART/DTEND, RRULE/EXDATE and SUMMARY. No notes,
// location, provider, category, status or condition, because a calendar app copies the feed to its own servers.
function vevent(e, stamp, minimal = false) {
  const lines = ["BEGIN:VEVENT", `UID:mib-event-${e.event_id}@mib`, `DTSTAMP:${stamp}`];
  const zone = icsZone(e);
  if (e.all_day) {
    lines.push(`DTSTART;VALUE=DATE:${icsDate(e.start_time)}`, `DTEND;VALUE=DATE:${icsDate(e.end_time || e.start_time, 1)}`);
  } else {
    lines.push(icsTimed("DTSTART", e.start_time, zone));
    if (e.end_time) lines.push(icsTimed("DTEND", e.end_time, zone));
  }
  const rule = icsRule(e);
  if (rule) {
    lines.push(`RRULE:${rule}`);
    // one EXDATE per skipped local date, written like DTSTART (a date, or that day at the start's local time of day)
    const skipped = [...new Set(Array.isArray(e.exceptions) ? e.exceptions.filter(isDate) : [])].sort();
    const time = e.all_day ? "" : icsWall(e.start_time, zone).slice(9);
    for (const d of skipped) {
      const day = d.replace(/-/g, "");
      lines.push(e.all_day ? `EXDATE;VALUE=DATE:${day}` : zone === "UTC" ? `EXDATE:${day}T${time}Z` : `EXDATE;TZID=${zone}:${day}T${time}`);
    }
  }
  lines.push(`SUMMARY:${icsText(e.title)}`);
  if (minimal) { lines.push("END:VEVENT"); return lines; }
  const desc = [e.description, e.provider_name && `Provider: ${e.provider_name}`].filter(Boolean);
  if (desc.length) lines.push(`DESCRIPTION:${icsText(desc.join("\n"))}`);
  if (e.location) lines.push(`LOCATION:${icsText(e.location)}`);
  lines.push(`CATEGORIES:${icsText(e.category.toUpperCase())}`, `STATUS:${e.status === "cancelled" ? "CANCELLED" : "CONFIRMED"}`,
    `CREATED:${icsDateTime(e.created_at)}`, `LAST-MODIFIED:${icsDateTime(e.updated_at)}`, "END:VEVENT");
  return lines;
}
const CAL_NAME = "Health Information Banking";
// The subscribe feed is named neutrally: the calendar app shows (and stores) its name, and it shouldn't say "health".
const FEED_CAL_NAME = "My calendar", FEED_PRODID = "-//Calendar//EN";
function buildCalendar(events, name = CAL_NAME, { minimal = false } = {}) {
  const stamp = icsDateTime(new Date());
  const prodid = minimal ? FEED_PRODID : `-//${CAL_NAME}//Calendar//EN`;
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", `PRODID:${prodid}`, "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  lines.push(`X-WR-CALNAME:${icsText(name)}`);
  for (const e of events) lines.push(...vevent(e, stamp, minimal));
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
// The subscribe feed (D-016) for one patient: their events that are not cancelled, written with the minimal builder.
// Each row is cut down to the fields the minimal builder reads first, so nothing private can reach it.
const FEED_FIELDS = ["event_id", "title", "start_time", "end_time", "all_day", "time_zone", ...REPEAT_FIELDS];
async function feedIcs(userId) {
  const rows = sortEvents((await findAll("CalendarEvent", { user_id: userId })).map(row).filter((e) => e.status !== "cancelled"))
    .map((e) => Object.fromEntries(FEED_FIELDS.map((f) => [f, e[f]])));
  return buildCalendar(rows, FEED_CAL_NAME, { minimal: true });
}
async function eventIcs(id, user) {
  const e = await getOwned("CalendarEvent", id, user.user_id);
  if (!e) return notFound(id);
  return { status: 200, ics: buildCalendar([row(e)]), filename: `event-${id}.ics`, content_type: ICS_TYPE };
}
async function calendarIcs(user) {
  const rows = sortEvents((await findAll("CalendarEvent", { user_id: user.user_id })).map(row).filter((e) => e.status !== "cancelled"));
  return { status: 200, ics: buildCalendar(rows), filename: "calendar.ics", content_type: ICS_TYPE, event_count: rows.length };
}

module.exports = { list, getById, create: createEvent, update, remove, skipOccurrence, upcoming, eventIcs, calendarIcs, feedIcs, validateRecurrence, expandOccurrences, ICS_TYPE };
