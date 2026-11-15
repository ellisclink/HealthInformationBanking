// calendarRules.ts — the calendar's pure logic, ported 1:1 from the server (no imports, so Node can run it):
//   - the time zone helpers of Parse/cloud/lib/reminders.js (wall times in an IANA zone, daylight saving)
//   - the repeat expansion, list and upcoming of the old calendar.js routes
//   - the .ics writer of calendar.js (the same file the old /calendar/ics and /calendar/events/:id/ics sent)
// calendar.js keeps its own copy of the .ics writer for the subscribe feed; keep the two the same.

export type EventRow = {
  event_id: string; user_id: string | null; title: string; description: string | null; category: string;
  start_time: string; end_time: string | null; all_day: boolean; location: string | null; provider_name: string | null;
  status: string; condition_id: string | null;
  recurrence_type: string | null; recurrence_interval: number | null; recurrence_weekdays: number[] | null;
  recurrence_day: number | null; end_type: string | null; end_date: string | null; end_count: number | null;
  exceptions: string[] | null; time_zone: string | null; created_at: string | null; updated_at: string | null;
  occurrence_date?: string;   // set on each row of a repeating event
};

// ---------- time zones (reminders.js) ----------
const DAY_MS = 24 * 60 * 60 * 1000;
type Wall = { year: number; month: number; day: number; hour: number; minute: number; second: number };

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timeZone: string): Intl.DateTimeFormat {
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
export function wallParts(date: Date, timeZone: string): Wall {
  const p: Record<string, string> = {};
  for (const part of formatterFor(timeZone).formatToParts(date)) p[part.type] = part.value;
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute, second: +p.second };
}
// How far the zone is ahead of UTC at an instant, in milliseconds.
function offsetAt(ms: number, timeZone: string): number {
  const w = wallParts(new Date(ms), timeZone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000;
}
function parseDate(dateStr: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr));
  if (!m) throw new RangeError(`Invalid date: ${dateStr}`);
  return { y: +m[1], m: +m[2], d: +m[3] };
}
function parseTime(hhmm: string) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm));
  if (!m || +m[1] > 23 || +m[2] > 59) throw new RangeError(`Invalid time: ${hhmm}`);
  return { h: +m[1], min: +m[2] };
}
// The UTC instant for a local wall time ("YYYY-MM-DD", "HH:MM") in an IANA zone (a gap: the instant after it; a repeat: the earlier).
export function zonedTime(dateStr: string, hhmm: string, timeZone: string): Date {
  const { y, m, d } = parseDate(dateStr);
  const { h, min } = parseTime(hhmm);
  const wallMs = Date.UTC(y, m - 1, d, h, min);
  const before = offsetAt(wallMs - DAY_MS, timeZone);
  const after = offsetAt(wallMs + DAY_MS, timeZone);
  const candidates: number[] = [];
  for (const off of new Set([before, after])) {
    const t = wallMs - off;
    if (offsetAt(t, timeZone) === off) candidates.push(t);
  }
  const t = candidates.length ? Math.min(...candidates) : wallMs - before;
  return new Date(t);
}
// "YYYY-MM-DD" of an instant as the patient's wall calendar shows it.
export function localDate(date: Date, timeZone: string): string {
  const w = wallParts(date, timeZone);
  return `${String(w.year).padStart(4, "0")}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
}
export function addDays(dateStr: string, n: number): string {
  const { y, m, d } = parseDate(dateStr);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function weekday(dateStr: string): number {
  const { y, m, d } = parseDate(dateStr);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
export function validZone(zone: unknown): boolean {
  if (typeof zone !== "string" || !zone.trim()) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return true; } catch { return false; }
}

// ---------- calendar.js ----------
const MAX_END_COUNT = 1000, MAX_INTERVAL = 365;
const MAX_OCCURRENCES = 1000;   // most occurrences one series gives back from one expansion
export const WINDOW_MS = 366 * DAY_MS;   // how far list and upcoming look when no range bound is given
export const CATEGORIES = ["appointment", "medication", "reminder", "personal", "lab", "procedure"];
export const STATUSES = ["scheduled", "completed", "cancelled"];
export const ICS_TYPE = "text/calendar; charset=utf-8";

const isDate = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
};
export const isDateTime = (v: unknown): v is string => typeof v === "string" && v.length > 0 && !isNaN(new Date(v).getTime());
const blank = (v: unknown) => v === undefined || v === null || v === "";
const between = (n: unknown, lo: number, hi: number): n is number => Number.isInteger(n) && (n as number) >= lo && (n as number) <= hi;
export const isRepeating = (e: { recurrence_type: string | null }) => !blank(e.recurrence_type) && e.recurrence_type !== "none";
export const sortEvents = (rows: EventRow[]) => rows.sort((a, b) => a.start_time.localeCompare(b.start_time) || a.event_id.localeCompare(b.event_id));

// IANA zone names only: "UTC", a name Intl lists, or an alias Intl resolves to one of those
const IANA_ZONES = new Set<string>(typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : []);
const IANA_SHAPE = /^[A-Z][A-Za-z0-9_+-]*(\/[A-Z][A-Za-z0-9_+-]*)*$/;
export function isIanaZone(z: unknown): z is string {
  if (typeof z !== "string") return false;
  if (z === "UTC" || IANA_ZONES.has(z)) return true;
  if (!IANA_SHAPE.test(z) || !validZone(z)) return false;
  const canonical = new Intl.DateTimeFormat("en-US", { timeZone: z }).resolvedOptions().timeZone;
  return canonical === "UTC" || IANA_ZONES.has(canonical);
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const ruleWeekdays = (event: EventRow) => [...new Set(Array.isArray(event.recurrence_weekdays) ? event.recurrence_weekdays.filter((d) => between(d, 0, 6)) : [])]
  .sort((a, b) => a - b);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);

// The days ("YYYY-MM-DD", ascending, endless) a valid rule falls on, from `fromDay` on; null for a rule that can't repeat.
function ruleDays(event: EventRow, firstDay: string, fromDay: string): Generator<string> | null {
  const type = event.recurrence_type;
  if (type === "daily" || type === "every_n_days") {
    const step = type === "daily" ? 1 : event.recurrence_interval;
    if (!between(step, 1, MAX_INTERVAL)) return null;
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
        const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
        const day = `${String(y).padStart(4, "0")}-${pad2(m)}-${pad2(Math.min(want, last))}`;
        if (day >= fromDay) yield day;
        if (++m > 12) { m = 1; y += 1; }
      }
    })();
  }
  return null;
}

export type Occurrence = { start: string; end: string | null; date: string };
// The occurrences of `event` that overlap [rangeStart, rangeEnd) (a missing bound is open), in the given zone.
export function expandOccurrences(event: EventRow, rangeStart: number | string | null, rangeEnd: number | string | null, timeZone: string): Occurrence[] {
  const startMs = new Date(event.start_time).getTime();
  if (isNaN(startMs)) return [];
  const fromMs = rangeStart == null ? -Infinity : new Date(rangeStart).getTime();
  const toMs = rangeEnd == null ? Infinity : new Date(rangeEnd).getTime();
  if (isNaN(fromMs) || isNaN(toMs)) return [];
  const length = event.end_time ? Math.max(new Date(event.end_time).getTime() - startMs, 0) : null;
  const zone = event.all_day ? "UTC" : isIanaZone(timeZone) ? timeZone : "UTC";
  const firstDay = localDate(new Date(startMs), zone);
  const overlaps = (s: number) => s < toMs && s + (length || 0) >= fromMs;
  const occurrence = (s: number, date: string): Occurrence => ({ start: new Date(s).toISOString(), end: length === null ? null : new Date(s + length).toISOString(), date });

  const maxCount = event.end_type === "count" && between(event.end_count, 1, MAX_END_COUNT) ? event.end_count : null;
  let fromDay = firstDay;
  if (maxCount === null && fromMs > startMs) {
    const near = addDays(localDate(new Date(fromMs - (length || 0)), zone), -1);
    if (near > fromDay) fromDay = near;
  }
  let days: Generator<string> | null = isRepeating(event) ? ruleDays(event, firstDay, fromDay) : null;
  // the stored start is always the first occurrence (DTSTART), even when it is not a day the rule picks
  if (days && fromDay === firstDay) days = (function* (rest: Generator<string>) {
    let first = true;
    for (const d of rest) { if (first && d !== firstDay) yield firstDay; first = false; yield d; }
  })(days);
  if (!days) return overlaps(startMs) ? [occurrence(startMs, firstDay)] : [];

  const w = wallParts(new Date(startMs), zone);
  const hhmm = `${pad2(w.hour)}:${pad2(w.minute)}`;
  const extraMs = w.second * 1000 + (((startMs % 1000) + 1000) % 1000);
  const at = (day: string) => (day === firstDay ? startMs : zonedTime(day, hhmm, zone).getTime() + extraMs);

  const endDate = event.end_type === "date" && isDate(event.end_date) ? event.end_date : null;
  const skip = new Set(Array.isArray(event.exceptions) ? event.exceptions : []);
  const out: Occurrence[] = [];
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
function occurrenceRows(e: EventRow, fromMs: number, toMs: number, timeZone: string): EventRow[] {
  if (!isRepeating(e)) return [e];
  return expandOccurrences(e, fromMs, toMs, timeZone).map((o) => ({ ...e, start_time: o.start, end_time: o.end, occurrence_date: o.date }));
}

export type ListQuery = { startDate?: string; endDate?: string; category?: string; status?: string; limit?: string | number; timeZone?: string };

// The patient's zone (UTC when missing), or the old route's error
function zoneOf(tz: string | undefined): string {
  if (tz == null) return "UTC";
  if (!validZone(tz)) throw new Error("Time zone must be an IANA name such as America/New_York");
  return tz;
}

// GET /calendar/events: the stored rows -> the old answer (filters, occurrences, sort, limit). Throws the old 400 messages.
export function listRows(stored: EventRow[], query: ListQuery = {}, now = Date.now()): EventRow[] {
  const { startDate, endDate, category, status } = query;
  if (startDate && !isDateTime(startDate)) throw new Error("startDate is not a valid date");
  if (endDate && !isDateTime(endDate)) throw new Error("endDate is not a valid date");
  if (startDate && endDate && new Date(endDate) < new Date(startDate)) throw new Error("endDate cannot be before startDate");
  if (category && !CATEGORIES.includes(category)) throw new Error(`Invalid category. Must be one of: ${CATEGORIES.join(", ")}`);
  if (status && !STATUSES.includes(status)) throw new Error(`Invalid status. Must be one of: ${STATUSES.join(", ")}`);
  let limit = 500;
  if (query.limit != null) {
    limit = parseInt(String(query.limit), 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("limit must be between 1 and 1000");
  }
  const zone = zoneOf(query.timeZone);
  let rows = stored.slice();
  if (category) rows = rows.filter((e) => e.category === category);
  if (status) rows = rows.filter((e) => e.status === status);
  const s = startDate ? new Date(startDate.slice(0, 10)).toISOString() : null;
  const e2 = endDate ? new Date(Date.parse(endDate.slice(0, 10)) + 86400000).toISOString() : null;
  const toMs = e2 ? Date.parse(e2) : (s ? Date.parse(s) : now) + WINDOW_MS;
  const fromMs = s ? Date.parse(s) : (e2 ? Date.parse(e2) : now) - WINDOW_MS;
  rows = rows.flatMap((e) => occurrenceRows(e, fromMs, toMs, zone));
  if (s) rows = rows.filter((e) => (e.end_time || e.start_time) >= s);
  if (e2) rows = rows.filter((e) => e.start_time < e2);
  return sortEvents(rows).slice(0, limit);
}

// GET /calendar/upcoming: scheduled events (and occurrences) not over yet, soonest first
export function upcomingRows(stored: EventRow[], query: { limit?: string | number; timeZone?: string } = {}, now = Date.now()): EventRow[] {
  let limit = 5;
  if (query.limit != null) {
    limit = parseInt(String(query.limit), 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("limit must be between 1 and 50");
  }
  const zone = zoneOf(query.timeZone);
  return sortEvents(stored.filter((e) => e.status === "scheduled")
    .flatMap((e) => occurrenceRows(e, now - DAY_MS, now + WINDOW_MS, zone))
    .filter((e) => Date.parse(e.end_time || e.start_time) + (e.all_day ? 86400000 : 0) > now)).slice(0, limit);
}

// ---------- .ics (RFC 5545), the same writer as calendar.js ----------
const icsDateTime = (v: string | number | Date) => new Date(v).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
function icsDate(v: string, plusDays = 0) {
  const d = new Date(v);
  d.setUTCDate(d.getUTCDate() + plusDays);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}
const icsZone = (e: EventRow) => (isIanaZone(e.time_zone) ? e.time_zone : "UTC");
function icsWall(v: string, zone: string) {
  const w = wallParts(new Date(v), zone);
  return `${String(w.year).padStart(4, "0")}${pad2(w.month)}${pad2(w.day)}T${pad2(w.hour)}${pad2(w.minute)}${pad2(w.second)}`;
}
const icsTimed = (name: string, v: string, zone: string) => (zone === "UTC" ? `${name}:${icsDateTime(v)}` : `${name};TZID=${zone}:${icsWall(v, zone)}`);
// eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
const ICS_CONTROLS = /[\x00-\x09\x0b\x0c\x0e-\x1f]/g;
const ICS_SEPARATORS = new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]`, "g");
const icsText = (v: unknown) => String(v).replace(ICS_CONTROLS, "").replace(ICS_SEPARATORS, "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
const encoder = new TextEncoder();
function foldLine(line: string) {
  const out: string[] = [];
  let current = "", bytes = 0;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    if (bytes + size > (out.length === 0 ? 75 : 74)) { out.push(current); current = ""; bytes = 0; }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join("\r\n ");
}
const ICS_DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
function icsRule(e: EventRow): string | null {
  if (!isRepeating(e)) return null;
  let rule: string;
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
    const until = e.all_day ? e.end_date.replace(/-/g, "") : icsDateTime(zonedTime(e.end_date, "23:59", icsZone(e)).getTime() + 59000);
    rule += `;UNTIL=${until}`;
  } else if (e.end_type === "count" && between(e.end_count, 1, MAX_END_COUNT)) rule += `;COUNT=${e.end_count}`;
  return rule;
}
function vevent(e: EventRow, stamp: string): string[] {
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
    const skipped = [...new Set(Array.isArray(e.exceptions) ? e.exceptions.filter(isDate) : [])].sort();
    const time = e.all_day ? "" : icsWall(e.start_time, zone).slice(9);
    for (const d of skipped) {
      const day = d.replace(/-/g, "");
      lines.push(e.all_day ? `EXDATE;VALUE=DATE:${day}` : zone === "UTC" ? `EXDATE:${day}T${time}Z` : `EXDATE;TZID=${zone}:${day}T${time}`);
    }
  }
  lines.push(`SUMMARY:${icsText(e.title)}`);
  const desc = [e.description, e.provider_name && `Provider: ${e.provider_name}`].filter(Boolean);
  if (desc.length) lines.push(`DESCRIPTION:${icsText(desc.join("\n"))}`);
  if (e.location) lines.push(`LOCATION:${icsText(e.location)}`);
  lines.push(`CATEGORIES:${icsText(e.category.toUpperCase())}`, `STATUS:${e.status === "cancelled" ? "CANCELLED" : "CONFIRMED"}`,
    `CREATED:${icsDateTime(e.created_at as string)}`, `LAST-MODIFIED:${icsDateTime(e.updated_at as string)}`, "END:VEVENT");
  return lines;
}
const CAL_NAME = "Health Information Banking";
// the full .ics the downloads use (the subscribe feed's minimal one is written by the server)
export function buildCalendar(events: EventRow[], now = new Date()): string {
  const stamp = icsDateTime(now);
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", `PRODID:-//${CAL_NAME}//Calendar//EN`, "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  lines.push(`X-WR-CALNAME:${icsText(CAL_NAME)}`);
  for (const e of events) lines.push(...vevent(e, stamp));
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
