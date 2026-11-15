// calendar.ts — the only browser file that reads and writes CalendarEvent (the Calendar page, the Reminders page's
// appointment list, the pre-visit appointment picker), with the Parse SDK. Cloud Code triggers (RULES.CalendarEvent in
// Parse/cloud/lib/access.js) guard every request: own rows only, patients only, the rules of calendar.js (title, times,
// category, status, an IANA time zone, the repeat rule, a condition that is one of your own), and the audit log. The
// server stores the cleaned values (all-day times at UTC midnight, the zone, the normalised repeat fields).
//   - never send user_id (the server sets it); send the owner ACL on create only (never on update)
//   - plain values only; times as Dates; clearing a field = unset
//   - skipping one occurrence = an edit of `exceptions` (the list with that local date added)
// The repeat expansion, the list, upcoming and the .ics downloads are calendarRules.ts (ported from the server). The
// subscribe links (feed tokens) and the feed itself stay on the server (api /calendar/feed-tokens).
import Parse from "../parse";
import { run } from "./parseCall";
import { buildCalendar, ICS_TYPE, isRepeating, listRows, sortEvents, upcomingRows } from "./calendarRules";
import type { EventRow, ListQuery } from "./calendarRules";
import { MAX_ROWS, ownerAcl, isBlank, textOrNull, iso } from "./common";

export type { EventRow };

const MAX_EXCEPTIONS = 1000;
const VISIT_CATEGORIES = ["appointment", "procedure", "lab"];
const TEXT = ["user_id", "title", "description", "category", "location", "provider_name", "status", "condition_id", "recurrence_type",
  "end_type", "end_date", "time_zone"] as const;
const NUMBERS = ["recurrence_interval", "recurrence_day", "end_count"] as const;

const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const isDate = (v: unknown): v is string => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

// the old row() (toRow with calendar.js FIELDS; event_id is the Parse objectId)
function toRow(o: Parse.Object): EventRow {
  const out = {
    event_id: o.id, start_time: iso(o.get("start_time")) || "", end_time: iso(o.get("end_time")), all_day: o.get("all_day") === true,
    recurrence_weekdays: Array.isArray(o.get("recurrence_weekdays")) ? o.get("recurrence_weekdays") : null,
    exceptions: Array.isArray(o.get("exceptions")) ? o.get("exceptions") : null,
    created_at: iso(o.createdAt), updated_at: iso(o.updatedAt),
  } as EventRow;
  const rec = out as unknown as Record<string, unknown>;
  for (const f of TEXT) rec[f] = textOrNull(o.get(f));
  for (const f of NUMBERS) rec[f] = numOrNull(o.get(f));
  rec.title = o.get("title") || "";
  rec.category = o.get("category") || "";
  rec.status = o.get("status") || "";
  return out;
}

const allRows = async () => (await new Parse.Query("CalendarEvent").limit(MAX_ROWS).find()).map(toRow);

// the page's body (the old route's): times are text; the SDK sends Dates. An all-day "YYYY-MM-DD" is that day at UTC
// midnight, which is what the server stores for it anyway.
function value(k: string, v: unknown): unknown {
  if ((k === "start_time" || k === "end_time") && typeof v === "string") {
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
    if (isNaN(d.getTime())) throw new Error(`${k} is not a valid date/time`);
    return d;
  }
  return v;
}

// GET /calendar/events?startDate&endDate&category&status&limit&timeZone: one row per occurrence of a repeating event
export function listEvents(query: ListQuery = {}): Promise<{ events: EventRow[]; count: number }> {
  return run(async () => { const events = listRows(await allRows(), query); return { events, count: events.length }; });
}

// GET /calendar/upcoming?limit&timeZone
export function upcomingEvents(query: { limit?: string | number; timeZone?: string } = {}): Promise<{ events: EventRow[]; count: number }> {
  return run(async () => {
    const stored = (await new Parse.Query("CalendarEvent").equalTo("status", "scheduled").limit(MAX_ROWS).find()).map(toRow);
    const events = upcomingRows(stored, query);
    return { events, count: events.length };
  });
}

// GET /calendar/events/:id: the stored event (a repeating one: the whole series)
export function getEvent(id: string): Promise<{ event: EventRow }> {
  return run(async () => ({ event: toRow(await new Parse.Query("CalendarEvent").get(id)) }));
}

// POST /calendar/events: blank fields are not sent
export function createEvent(body: Record<string, unknown>): Promise<{ message: string; event: EventRow }> {
  return run(async () => {
    const obj = new Parse.Object("CalendarEvent");
    for (const [k, v] of Object.entries(body)) if (!isBlank(v)) obj.set(k, value(k, v));
    obj.setACL(ownerAcl());
    return { message: "Event created", event: toRow(await obj.save()) };
  });
}

async function saveEdit(id: string, body: Record<string, unknown>): Promise<void> {
  const obj = new Parse.Object("CalendarEvent");
  obj.id = id;
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    if (isBlank(v)) obj.unset(k);
    else obj.set(k, value(k, v));
  }
  await obj.save();
}

// PUT /calendar/events/:id: only the fields sent change (null clears one); the whole series must still be valid
export function updateEvent(id: string, body: Record<string, unknown>): Promise<{ message: string }> {
  return run(async () => { await saveEdit(id, body); return { message: "Event updated" }; });
}

// DELETE /calendar/events/:id
export function removeEvent(id: string): Promise<{ message: string }> {
  return run(async () => {
    const obj = new Parse.Object("CalendarEvent");
    obj.id = id;
    await obj.destroy();
    return { message: "Event deleted" };
  });
}

// DELETE /calendar/events/:id/occurrences/:date: add the local date to exceptions (once; again changes nothing)
export function skipOccurrence(id: string, date: string): Promise<{ message: string }> {
  return run(async () => {
    if (!isDate(date)) throw new Error("Use the date format YYYY-MM-DD");
    const e = toRow(await new Parse.Query("CalendarEvent").get(id));
    if (!isRepeating(e)) throw new Error("This event does not repeat");
    const current = Array.isArray(e.exceptions) ? e.exceptions : [];
    if (!current.includes(date)) {
      if (current.length >= MAX_EXCEPTIONS) throw new Error(`Too many skipped dates (max ${MAX_EXCEPTIONS})`);
      await saveEdit(id, { exceptions: [...current, date].sort() });
    }
    return { message: "Occurrence skipped" };
  });
}

export type IcsFile = { ics: string; filename: string; content_type: string };

// GET /calendar/events/:id/ics: one event (its whole series), written here in the browser
export function eventIcs(id: string): Promise<IcsFile> {
  return run(async () => {
    const e = toRow(await new Parse.Query("CalendarEvent").get(id));
    return { ics: buildCalendar([e]), filename: `event-${id}.ics`, content_type: ICS_TYPE };
  });
}

// GET /calendar/ics: every event that is not cancelled
export function calendarIcs(): Promise<IcsFile & { event_count: number }> {
  return run(async () => {
    const rows = sortEvents((await allRows()).filter((e) => e.status !== "cancelled"));
    return { ics: buildCalendar(rows), filename: "calendar.ics", content_type: ICS_TYPE, event_count: rows.length };
  });
}

export type Appointment = { event_id: string; title: string; category: string; start_time: string; location: string | null; provider_name: string | null };

// GET /previsit/appointments?limit= (default 10, 1 to 50): the upcoming appointments, lab tests and procedures (UTC, as the server)
export function previsitAppointments(limit = 10): Promise<{ appointments: Appointment[]; count: number }> {
  return run(async () => {
    const n = Math.min(Math.max(Math.trunc(limit) || 10, 1), 50);
    const stored = (await new Parse.Query("CalendarEvent").equalTo("status", "scheduled").limit(MAX_ROWS).find()).map(toRow);
    const rows = upcomingRows(stored, { limit: 50 }).filter((e) => VISIT_CATEGORIES.includes(e.category)).slice(0, n)
      .map((e) => ({ event_id: e.event_id, title: e.title, category: e.category, start_time: e.start_time, location: e.location ?? null, provider_name: e.provider_name ?? null }));
    return { appointments: rows, count: rows.length };
  });
}
