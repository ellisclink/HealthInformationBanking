// calendar.js — Calendar & events (Tasks 4.3 / 4.4), on Parse. Class: CalendarEvent
// The website reads and writes its events with the Parse SDK (Vite/src/data/calendar.ts: the list, upcoming, the repeat
// expansion and the .ics downloads are ported there), guarded by access.js RULES.CalendarEvent with prepareEvent's rules
// (below). This file keeps the rules, the seed's create and the .ics builder for the subscribe
// feed (feedIcs, calendarFeed.js). The repeat expansion lives in Vite/src/data/calendarRules.ts; keep its .ics writer
// and the one here the same.
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
// List and upcoming (calendar.ts) still expand in the browser's time zone.
//
// Subscribe feed (D-016): feedIcs writes the same .ics with the minimal option (title, times and repeat rule only);
// the token handling and the public route are in calendarFeed.js.

const { isId, isDate, isDateTime, toRow, findAll, getOwned, create, audit } = require("./db");
const { zonedTime, wallParts, localDate, validZone } = require("./reminders");

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

const row = (o) => toRow(o, "event_id", FIELDS);
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
// Read the same way by the .ics (icsRule) here and by the expansion in Vite/src/data/calendarRules.ts.
const ruleWeekdays = (event) => [...new Set(Array.isArray(event.recurrence_weekdays) ? event.recurrence_weekdays.filter((d) => between(d, 0, 6)) : [])]
  .sort((a, b) => a - b);

// The rules of a create (old = null) or an edit (old = the stored row) with `body` = the fields sent (a cleared field is
// null; times as ISO text). {error} or {values} (the values to store; null clears a field). The old POST and PUT rules.
async function prepareEvent(body, old, userId) {
  if (!old) {
    if (body.title == null || !String(body.title).trim()) return { error: "Missing required field: title" };
    if (body.start_time == null || body.start_time === "") return { error: "Missing required field: start_time" };
  }
  const err = validate(body);
  if (err) return { error: err };
  const tz = readZone(body);
  if (tz.error) return { error: tz.error };
  if (old) for (const f of ["title", "start_time", "category", "status", "all_day"]) if (body[f] === null) return { error: `${f} can't be cleared` };
  // an edit keeps the stored zone unless a new one is sent; an unset / blank zone is refused (it would drop the zone)
  if (old && "time_zone" in body && blank(body.time_zone)) return { error: "time_zone can't be cleared" };
  const condErr = await checkCondition(body, { user_id: userId });
  if (condErr) return { error: condErr };

  if (!old) {
    const repeat = validateRecurrence({ ...body, time_zone: tz.zone });   // the cleaned zone decides the start day
    if (repeat.error) return { error: repeat.error };
    const values = { category: "appointment", status: "scheduled", all_day: false, ...repeat.values, time_zone: tz.zone || "UTC" };
    for (const f of EDITABLE) if (body[f] != null) values[f] = value(f, body[f]);
    if (values.all_day) {
      values.start_time = allDayMidnight(body.start_time);
      if (values.end_time) values.end_time = allDayMidnight(body.end_time);
    }
    if (values.end_time && values.end_time < values.start_time) return { error: "end_time cannot be before start_time" };
    return { values };
  }

  const fields = EDITABLE.filter((f) => body[f] !== undefined);
  const repeatFields = REPEAT_FIELDS.filter((f) => body[f] !== undefined);
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
  if (nextEnd && nextEnd < nextStart) return { error: "end_time cannot be before start_time" };
  // The rule is checked as the whole series will be stored, so a new start can't land after its end date
  if (repeatFields.length || "start_time" in updates || "all_day" in updates || "time_zone" in updates) {
    const merged = { ...old, ...Object.fromEntries(repeatFields.map((f) => [f, body[f]])),
      start_time: "start_time" in body ? body.start_time : old.start_time, all_day: nextAllDay, time_zone: tz.zone || old.time_zone };
    const repeat = validateRecurrence(merged);
    if (repeat.error) return { error: repeat.error };
    // skipping an occurrence (the old DELETE /calendar/events/:id/occurrences/:date) = an edit of exceptions
    if ("exceptions" in body && !blank(body.exceptions) && !isRepeating(repeat.values)) return { error: "This event does not repeat" };
    if (repeatFields.length) Object.assign(updates, repeat.values);
  }
  return { values: updates };
}

// The seed's create (seed.js calls it directly; the website saves CalendarEvent rows with the Parse SDK, below)
async function createEvent(body, user) {
  if (!body || typeof body !== "object") return { status: 400, error: "Missing event details" };
  const prep = await prepareEvent(body, null, user.user_id);
  if (prep.error) return { status: 400, error: prep.error };
  const e = await create("CalendarEvent", { ...prep.values, user_id: user.user_id });
  const data = row(e);
  await audit({ userId: user.user_id, event: "INSERT", targetClass: "CalendarEvent", targetId: e.id, newData: data });
  return { status: 201, message: "Event created", event: data };
}

// ---------- browser saves (access.js RULES.CalendarEvent) ----------
// The website reads, creates, edits, removes and skips occurrences of its CalendarEvent rows with the Parse SDK
// (Vite/src/data/calendar.ts, which also expands the repeats and writes the .ics downloads). The rules are prepareEvent's:
// the server stores the cleaned values (all-day times at UTC midnight, the time zone, the normalised repeat fields), and
// condition_id must be one of the caller's own conditions. Skipping an occurrence = an edit that sends `exceptions`.
const BROWSER_FIELDS = [...EDITABLE, ...REPEAT_FIELDS, "time_zone"];
// the SDK sends start_time / end_time as Dates; the rules read the route's ISO text
function routeBody(body) {
  const out = { ...body };
  for (const f of ["start_time", "end_time"]) if (out[f] instanceof Date) out[f] = out[f].toISOString();
  return out;
}
async function browserProblem(body, { user, original }) {
  return (await prepareEvent(routeBody(body), original ? row(original) : null, user.id)).error || null;
}
async function browserValues(body, { user, original }) {
  const prep = await prepareEvent(routeBody(body), original ? row(original) : null, user.id);
  if (prep.error) throw new Parse.Error(Parse.Error.VALIDATION_ERROR, prep.error);   // validate ran the same checks
  return prep.values;
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
module.exports = {
  create: createEvent, feedIcs, validateRecurrence, browserProblem, browserValues,
  BROWSER_FIELDS, ICS_TYPE, row,
};
