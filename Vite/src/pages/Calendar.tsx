import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import NavigationBar from "../components/NavigationBar";
import { api, localDate } from "../api";

// Calendar: appointments, reminders and other events, including repeating ones.
//   GET    /calendar/events?startDate=&endDate=&timeZone=  -> { events } (a repeating event comes back once per occurrence)
//   GET    /calendar/upcoming?limit=&timeZone=             -> { events } (the next occurrences)
//   GET    /calendar/events/:id                            -> { event } (the whole series, used for editing)
//   POST   /calendar/events, PUT /calendar/events/:id      -> save (time_zone is sent every time)
//   DELETE /calendar/events/:id                            -> delete the whole series
//   DELETE /calendar/events/:id/occurrences/:date          -> skip one occurrence
//   GET    /calendar/events/:id/ics, GET /calendar/ics     -> { ics, filename, content_type }
// Everything from the server is shown as plain text.

const CATEGORIES = ["appointment", "medication", "reminder", "personal", "lab", "procedure"] as const;
const STATUSES = ["scheduled", "completed", "cancelled"] as const;
const REPEATS = [
  { key: "none", label: "Does not repeat" },
  { key: "daily", label: "Every day" },
  { key: "every_n_days", label: "Every N days" },
  { key: "weekly", label: "Weekly on chosen days" },
  { key: "monthly", label: "Monthly on a day of the month" },
] as const;
const END_TYPES = [
  { key: "never", label: "Never" },
  { key: "date", label: "On a date" },
  { key: "count", label: "After a number of times" },
] as const;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type CalEvent = {
  event_id: string | number; title: string; description: string | null; category: string;
  start_time: string; end_time: string | null; all_day: boolean; location: string | null;
  provider_name: string | null; status: string; condition_id?: string | null;
  recurrence_type: string | null; recurrence_interval: number | null; recurrence_weekdays: number[] | null;
  recurrence_day: number | null; end_type: string | null; end_date: string | null; end_count: number | null;
  exceptions: string[] | null;
  occurrence_date?: string;   // set on each row of a repeating event
};
type IcsReply = { ics: string; filename?: string; content_type?: string };
// subscribe links (D-016): the token itself comes back only once, from the create call
type FeedLink = {
  token_id: string; label: string | null; expires_at: string | null; revoked_at: string | null;
  created_at: string | null; status: "active" | "expired" | "revoked";
  last_fetched_at: string | null; fetch_count: number;
};
type NewFeedReply = { token_id: string; expires_at: string };

// The link's secret is made here in the browser and never sent to the server: 32 random bytes as base64url. Only
// its SHA-256 (64 lower-case hex characters) is sent, so the token can't end up in a server log.
async function newFeedSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  const hash = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  return { token, hash };
}
const FEED_DAYS = [30, 90, 365] as const;
const FEED_STATUS: Record<FeedLink["status"], string> = { active: "Active", expired: "Expired", revoked: "Revoked" };

type FormState = {
  title: string; category: string; start: string; end: string; allDay: boolean;
  location: string; provider: string; status: string; notes: string;
  repeat: string; interval: string; weekdays: number[]; monthDay: string;
  endType: string; endDate: string; endCount: string;
};

const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const label = (s: string | null | undefined) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");
const pad = (n: number) => String(n).padStart(2, "0");
const repeats = (e: { recurrence_type: string | null }) => !!e.recurrence_type && e.recurrence_type !== "none";

// "2026-10-09T14:30" in the browser's time zone from an ISO time
function toLocalInput(iso: string) {
  const d = new Date(iso);
  return `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const emptyForm = (): FormState => {
  const now = new Date();
  now.setMinutes(0, 0, 0);
  now.setHours(now.getHours() + 1);
  return {
    title: "", category: "appointment", start: toLocalInput(now.toISOString()), end: "", allDay: false,
    location: "", provider: "", status: "scheduled", notes: "",
    repeat: "none", interval: "2", weekdays: [], monthDay: String(now.getDate()),
    endType: "never", endDate: "", endCount: "10",
  };
};

function formFromEvent(e: CalEvent): FormState {
  const allDay = !!e.all_day;
  return {
    title: e.title, category: e.category, allDay,
    // an all-day event is stored at UTC midnight of its day; a timed one is shown in the local time zone
    start: allDay ? e.start_time.slice(0, 10) : toLocalInput(e.start_time),
    end: e.end_time ? (allDay ? e.end_time.slice(0, 10) : toLocalInput(e.end_time)) : "",
    location: e.location ?? "", provider: e.provider_name ?? "", status: e.status, notes: e.description ?? "",
    repeat: e.recurrence_type || "none",
    interval: e.recurrence_interval != null ? String(e.recurrence_interval) : "2",
    weekdays: Array.isArray(e.recurrence_weekdays) ? [...e.recurrence_weekdays] : [],
    monthDay: e.recurrence_day != null ? String(e.recurrence_day) : String(new Date(e.start_time).getDate()),
    endType: e.end_type || "never",
    endDate: e.end_date ?? "",
    endCount: e.end_count != null ? String(e.end_count) : "10",
  };
}

const fmtDate = (day: string) => new Date(`${day}T00:00:00`).toLocaleDateString([], { dateStyle: "medium" });
const fmtDateTime = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

function when(e: CalEvent) {
  if (e.all_day) {
    const first = e.start_time.slice(0, 10), last = e.end_time ? e.end_time.slice(0, 10) : first;
    return `${fmtDate(first)}${last !== first ? ` to ${fmtDate(last)}` : ""} (all day)`;
  }
  return `${fmtDateTime(e.start_time)}${e.end_time ? ` to ${fmtDateTime(e.end_time)}` : ""}`;
}

function repeatText(e: CalEvent) {
  let t = "";
  if (e.recurrence_type === "daily") t = "Repeats every day";
  else if (e.recurrence_type === "every_n_days") t = `Repeats every ${e.recurrence_interval} days`;
  else if (e.recurrence_type === "weekly") {
    t = `Repeats weekly on ${(e.recurrence_weekdays ?? []).map((d) => WEEKDAYS[d]?.slice(0, 3)).filter(Boolean).join(", ")}`;
  } else if (e.recurrence_type === "monthly") t = `Repeats monthly on day ${e.recurrence_day}`;
  else return "";
  if (e.end_type === "date" && e.end_date) t += `, until ${fmtDate(e.end_date)}`;
  else if (e.end_type === "count" && e.end_count) t += `, ${e.end_count} times in all`;
  return t;
}

// ---- month view helpers (days are plain "YYYY-MM-DD" strings) ----
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MAX_SPAN_DAYS = 60;
const MONTH_LIMIT = 1000;   // the most the server will send for the month view

function dayDate(day: string) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d, 12);
}
// "Friday October 9"
const dayName = (day: string) => {
  const d = dayDate(day);
  return `${DAY_NAMES[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}`;
};
function addDays(day: string, n: number) {
  const d = dayDate(day);
  d.setDate(d.getDate() + n);
  return localDate(d);
}
// every date shown for a month: Sunday on or before the 1st through the Saturday on or after the last day
function gridDays(year: number, month: number) {
  const start = new Date(year, month, 1 - new Date(year, month, 1).getDay(), 12);
  const lastDow = new Date(year, month + 1, 0).getDay();
  const end = new Date(year, month + 1, 6 - lastDow, 12);
  const days: string[] = [];
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) days.push(localDate(d));
  return days;
}
// the calendar days an event (or one occurrence) appears on
function eventDays(e: CalEvent) {
  if (!e.all_day) {
    // a timed event shows on every local day it overlaps (one that ends exactly at midnight does not reach the next day)
    const first = localDate(new Date(e.start_time));
    const endMs = e.end_time ? Date.parse(e.end_time) : NaN;
    const startMs = Date.parse(e.start_time);
    if (!(endMs > startMs)) return [first];
    const last = localDate(new Date(endMs - 1));
    const span = Math.min(Math.max(Math.round((dayDate(last).getTime() - dayDate(first).getTime()) / 86400000), 0), MAX_SPAN_DAYS);
    return Array.from({ length: span + 1 }, (_, i) => addDays(first, i));
  }
  const first = e.start_time.slice(0, 10);
  const last = e.end_time ? e.end_time.slice(0, 10) : first;
  const span = Math.min(Math.max(Math.round((Date.parse(last) - Date.parse(first)) / 86400000), 0), MAX_SPAN_DAYS);
  const from = e.occurrence_date ?? first;
  return Array.from({ length: span + 1 }, (_, i) => addDays(from, i));
}
// "All day", plus the occurrence's own dates when it spans several days (a repeat starts on its occurrence_date, not the series' first date)
function allDayText(e: CalEvent) {
  const days = eventDays(e);
  return days.length > 1 ? `All day, ${fmtDate(days[0])} to ${fmtDate(days[days.length - 1])}` : "All day";
}
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const chipTime = (e: CalEvent) => (e.all_day ? "All day" : fmtTime(e.start_time));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// "Subscribe in your phone calendar": private, revocable links to a read-only feed of titles and times.
//   POST   /calendar/feed-tokens {token_hash, days, label?} -> {token_id, expires_at}; the link is built and shown here, once
//   GET    /calendar/feed-tokens                -> the patient's links (never the token)
//   DELETE /calendar/feed-tokens/:id            -> revoke
function SubscribeLinks() {
  const [links, setLinks] = useState<FeedLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [days, setDays] = useState("365");
  const [name, setName] = useState("");
  const [newLink, setNewLink] = useState<{ url: string; expires: string } | null>(null);
  const [copied, setCopied] = useState("");

  const load = useCallback(async () => {
    const r = await api<{ tokens: FeedLink[] }>("/calendar/feed-tokens");
    setLinks(r.tokens);
  }, []);

  useEffect(() => {
    // state is set from a timer callback, not in the effect body itself
    const timer = window.setTimeout(() => {
      load().catch((e) => setError((e as Error).message)).finally(() => setLoading(false));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function createLink(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(""); setMessage(""); setCopied(""); setNewLink(null);
    try {
      const secret = await newFeedSecret();
      const body: { token_hash: string; days: number; label?: string } = { token_hash: secret.hash, days: Number(days) };
      if (name.trim()) body.label = name.trim();
      const r = await api<NewFeedReply>("/calendar/feed-tokens", { method: "POST", body: JSON.stringify(body) });
      setNewLink({ url: `${window.location.origin}/calendar/feed/${secret.token}`, expires: r.expires_at });
      setName("");
    } catch (e) { setError((e as Error).message); setBusy(false); return; }
    try { await load(); } catch (e) { setError(`The link was made, but the list could not refresh: ${(e as Error).message}`); }
    setBusy(false);
  }

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(`${what} copied.`);
    } catch {
      setCopied("Could not copy. Select the link and copy it yourself.");
    }
  }

  async function revoke(link: FeedLink) {
    if (!window.confirm(`Revoke "${link.label || "this link"}"? Calendars using it will stop getting your events. This can't be undone.`)) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const r = await api<{ message?: string }>(`/calendar/feed-tokens/${encodeURIComponent(link.token_id)}`, { method: "DELETE" });
      setMessage(r.message || "Link revoked");
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  const webcal = newLink ? newLink.url.replace(/^https?:\/\//, "webcal://") : "";

  return (
    <section aria-labelledby="cal-subscribe" className="disp-section">
      <h3 id="cal-subscribe">Subscribe in your phone calendar</h3>
      <p className="notice error" role="note">
        Anyone with the link can read the titles and times of your events. Your phone's calendar app copies them to its
        own servers. Notes, locations, providers and conditions are never included. You can revoke the link at any time.
      </p>
      {error && <p className="notice error" role="alert">{error}</p>}
      {message && !error && <p className="notice success" role="status">{message}</p>}

      <form className="med-add-grid" onSubmit={createLink} noValidate>
        <label>Link expires after
          <select value={days} onChange={(e) => setDays(e.target.value)}>
            {FEED_DAYS.map((d) => <option key={d} value={String(d)}>{d} days</option>)}
          </select>
        </label>
        <label>Name (optional)
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="e.g. My phone" />
        </label>
        <div>
          <button className="primary-button" type="submit" disabled={busy}>{busy ? "Working…" : "Create link"}</button>
        </div>
      </form>

      {newLink && (
        <div className="med-card" role="region" aria-label="Your new calendar link">
          <p><strong>Copy it now; it can't be shown again.</strong> It works until {fmtDateTime(newLink.expires)}.</p>
          <label className="med-wide">Link
            <input readOnly value={newLink.url} onFocus={(e) => e.target.select()} />
          </label>
          <button className="secondary-button" type="button" onClick={() => copy(newLink.url, "Link")}>Copy</button>
          <label className="med-wide">For calendar apps that open webcal:// links
            <input readOnly value={webcal} onFocus={(e) => e.target.select()} />
          </label>
          <button className="secondary-button" type="button" onClick={() => copy(webcal, "webcal:// link")}>Copy</button>{" "}
          <button className="text-button" type="button" onClick={() => { setNewLink(null); setCopied(""); }}>Done</button>
          {copied && <p role="status">{copied}</p>}
        </div>
      )}

      <h4>Your links</h4>
      {loading ? <p role="status">Loading…</p> : links.length === 0 ? (
        <p>No links yet.</p>
      ) : (
        <ul>
          {links.map((l) => (
            <li key={l.token_id}>
              <strong>{l.label || "Calendar link"}</strong>
              {l.created_at && <> · made {fmtDateTime(l.created_at)}</>}
              {l.expires_at && <> · expires {fmtDateTime(l.expires_at)}</>}
              {" · "}{FEED_STATUS[l.status] ?? l.status}
              {" · "}Last fetched: {l.last_fetched_at ? fmtDateTime(l.last_fetched_at) : "never"}
              {" · "}Fetches: {l.fetch_count ?? 0}
              {l.status === "active" && (
                <>{" "}<button className="text-button med-link danger" type="button" disabled={busy} onClick={() => revoke(l)}>Revoke</button></>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Calendar() {
  const [from, setFrom] = useState(() => localDate());
  const [to, setTo] = useState(() => { const d = new Date(); d.setDate(d.getDate() + 90); return localDate(d); });
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [upcoming, setUpcoming] = useState<CalEvent[]>([]);
  const [upcomingError, setUpcomingError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [refreshError, setRefreshError] = useState("");   // the change worked but the lists could not reload
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | number | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const seq = useRef(0);   // ignore an older answer when the dates changed meanwhile

  // month view: the visible grid (whole weeks) is loaded with its own first and last date
  const [view, setView] = useState(() => { const n = new Date(); return { year: n.getFullYear(), month: n.getMonth() }; });
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [monthEvents, setMonthEvents] = useState<CalEvent[]>([]);
  const [monthLoading, setMonthLoading] = useState(true);
  const [monthError, setMonthError] = useState("");
  const monthSeq = useRef(0);
  const gridList = useMemo(() => gridDays(view.year, view.month), [view]);
  const gridStart = gridList[0], gridEnd = gridList[gridList.length - 1];
  // the visible range, kept in a ref so a load or refresh started earlier never uses (or shows) an older month
  const rangeRef = useRef({ start: gridStart, end: gridEnd });

  // never throws: a failure is shown above the grid as plain text. It always loads the range that is visible now.
  const loadMonth = useCallback(async () => {
    const mine = ++monthSeq.current;
    const { start, end } = rangeRef.current;
    const stale = () => mine !== monthSeq.current || start !== rangeRef.current.start || end !== rangeRef.current.end;
    try {
      // the server cuts days at UTC midnight, so ask for one extra day on each side; days are placed locally below
      const qs = new URLSearchParams({ startDate: addDays(start, -1), endDate: addDays(end, 1), timeZone: timeZone(), limit: String(MONTH_LIMIT) });
      const r = await api<{ events: CalEvent[] }>(`/calendar/events?${qs.toString()}`);
      if (stale()) return;
      setMonthEvents(r.events); setMonthError("");
    } catch (e) {
      if (stale()) return;
      setMonthEvents([]); setMonthError((e as Error).message);
    }
    setMonthLoading(false);
  }, []);

  useEffect(() => {
    // state is set from a timer callback, not in the effect body itself
    const timer = window.setTimeout(() => { setMonthLoading(true); loadMonth(); }, 0);
    return () => window.clearTimeout(timer);
  }, [gridStart, gridEnd, loadMonth]);

  const eventsByDay = useMemo(() => {
    const visible = new Set(gridList);
    const map = new Map<string, CalEvent[]>();
    for (const e of monthEvents) {
      for (const day of eventDays(e)) {
        if (!visible.has(day)) continue;
        const list = map.get(day);
        if (list) list.push(e); else map.set(day, [e]);
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) => Number(!!b.all_day) - Number(!!a.all_day) || a.start_time.localeCompare(b.start_time));
    }
    return map;
  }, [monthEvents, gridList]);

  function showMonth(year: number, month: number) {
    const days = gridDays(year, month);
    rangeRef.current = { start: days[0], end: days[days.length - 1] };
    setView({ year, month });
  }
  function shiftMonth(delta: number) {
    const d = new Date(view.year, view.month + delta, 1);
    showMonth(d.getFullYear(), d.getMonth());
  }
  function goToday() {
    const n = new Date();
    showMonth(n.getFullYear(), n.getMonth());
    setSelectedDay(localDate(n));
  }

  // both bounds are always sent: without them the server's default window can drop future occurrences
  const loadLists = useCallback(async (start: string, end: string) => {
    const mine = ++seq.current;
    const tz = timeZone();
    const [list, soon] = await Promise.all([
      api<{ events: CalEvent[] }>(`/calendar/events?${new URLSearchParams({ startDate: start, endDate: end, timeZone: tz }).toString()}`),
      api<{ events: CalEvent[] }>(`/calendar/upcoming?${new URLSearchParams({ limit: "10", timeZone: tz }).toString()}`)
        .catch((e: Error) => e),
    ]);
    if (mine !== seq.current) return;
    setEvents(list.events);
    if (soon instanceof Error) { setUpcoming([]); setUpcomingError(soon.message); }
    else { setUpcoming(soon.events); setUpcomingError(""); }
  }, []);

  useEffect(() => {
    // state is set from a timer callback, not in the effect body itself
    const timer = window.setTimeout(() => {
      // with unusable dates, drop the old list (and ignore any answer still on its way) instead of showing stale events
      if (!from || !to) { seq.current++; setEvents([]); setError("Choose both dates to show."); setLoading(false); return; }
      if (to < from) { seq.current++; setEvents([]); setError("The last date can't be before the first date."); setLoading(false); return; }
      setError("");
      setLoading(true);
      loadLists(from, to).catch((e) => setError((e as Error).message)).finally(() => setLoading(false));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [from, to, loadLists]);

  const set = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  function toggleAllDay(on: boolean) {
    // keep what was typed: a date-time becomes its date, a date gets a default time
    setForm((f) => ({
      ...f, allDay: on,
      start: on ? f.start.slice(0, 10) : f.start ? `${f.start.slice(0, 10)}T09:00` : f.start,
      end: on ? f.end.slice(0, 10) : f.end ? `${f.end.slice(0, 10)}T10:00` : f.end,
    }));
  }

  function toggleWeekday(d: number) {
    setForm((f) => ({ ...f, weekdays: f.weekdays.includes(d) ? f.weekdays.filter((x) => x !== d) : [...f.weekdays, d].sort((a, b) => a - b) }));
  }

  function openNew() {
    setEditingId(null); setForm(emptyForm()); setFormOpen(true); setMessage(""); setError("");
    setTimeout(() => document.getElementById("calendar-form")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }

  async function openEdit(id: string | number) {
    setBusy(true); setError(""); setMessage(""); setRefreshError("");
    try {
      // a list row is one occurrence; editing changes the whole series, so load the stored event
      const r = await api<{ event: CalEvent }>(`/calendar/events/${encodeURIComponent(String(id))}`);
      setEditingId(id); setForm(formFromEvent(r.event)); setFormOpen(true);
      setTimeout(() => document.getElementById("calendar-form")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  function closeForm() { setFormOpen(false); setEditingId(null); }

  async function refreshAfter(done: string) {
    try { await Promise.all([loadLists(from, to), loadMonth()]); }
    catch (e) { setRefreshError(`${done}, but the lists could not refresh: ${(e as Error).message}`); }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(""); setMessage(""); setRefreshError("");
    if (!form.title.trim()) { setError("Enter a title."); return; }
    if (!form.start) { setError("Choose when the event starts."); return; }
    // an all-day event is sent as a plain date (its own calendar day); a timed one as an ISO time
    let startTime = form.start, endTime: string | null = form.end || null;
    if (!form.allDay) {
      const s = new Date(form.start);
      if (isNaN(s.getTime())) { setError("Enter a valid start date and time."); return; }
      startTime = s.toISOString();
      if (form.end) {
        const en = new Date(form.end);
        if (isNaN(en.getTime())) { setError("Enter a valid end date and time."); return; }
        endTime = en.toISOString();
      }
    }
    const isRepeat = form.repeat !== "none";
    const num = (v: string) => (v.trim() === "" ? null : Number(v));
    const body = {
      title: form.title.trim(), category: form.category, status: form.status,
      start_time: startTime, end_time: endTime, all_day: form.allDay,
      location: form.location.trim() || null, provider_name: form.provider.trim() || null,
      description: form.notes.trim() || null,
      time_zone: timeZone(),
      recurrence_type: form.repeat,
      recurrence_interval: form.repeat === "every_n_days" ? num(form.interval) : null,
      recurrence_weekdays: form.repeat === "weekly" ? form.weekdays : null,
      recurrence_day: form.repeat === "monthly" ? num(form.monthDay) : null,
      end_type: isRepeat ? form.endType : null,
      end_date: isRepeat && form.endType === "date" ? form.endDate || null : null,
      end_count: isRepeat && form.endType === "count" ? num(form.endCount) : null,
    };
    setBusy(true);
    const wasEdit = editingId !== null;
    try {
      const r = await api<{ message?: string }>(
        wasEdit ? `/calendar/events/${encodeURIComponent(String(editingId))}` : "/calendar/events",
        { method: wasEdit ? "PUT" : "POST", body: JSON.stringify(body) },
      );
      closeForm(); setForm(emptyForm());
      setMessage(r.message || (wasEdit ? "Event updated" : "Event created"));
    } catch (e) { setError((e as Error).message); setBusy(false); return; }
    // the event is saved: a failed refresh must not look like a failed save
    await refreshAfter("Saved");
    setBusy(false);
  }

  async function removeEvent(e: CalEvent) {
    const warn = repeats(e) ? "Delete this event and all of its repeats?" : "Delete this event?";
    if (!window.confirm(`${warn} This can't be undone.`)) return;
    setBusy(true); setError(""); setMessage(""); setRefreshError("");
    try {
      const r = await api<{ message?: string }>(`/calendar/events/${encodeURIComponent(String(e.event_id))}`, { method: "DELETE" });
      setMessage(r.message || "Event deleted");
      if (editingId !== null && String(editingId) === String(e.event_id)) closeForm();
    } catch (err) { setError((err as Error).message); setBusy(false); return; }
    await refreshAfter("Deleted");
    setBusy(false);
  }

  async function skipOccurrence(e: CalEvent) {
    if (!e.occurrence_date) return;
    if (!window.confirm(`Skip only the ${fmtDate(e.occurrence_date)} occurrence of "${e.title}"? The other repeats stay.`)) return;
    setBusy(true); setError(""); setMessage(""); setRefreshError("");
    try {
      const r = await api<{ message?: string }>(
        `/calendar/events/${encodeURIComponent(String(e.event_id))}/occurrences/${encodeURIComponent(e.occurrence_date)}`,
        { method: "DELETE" },
      );
      setMessage(r.message || "Occurrence skipped");
    } catch (err) { setError((err as Error).message); setBusy(false); return; }
    await refreshAfter("Skipped");
    setBusy(false);
  }

  // The server sends the .ics text; save it as a file with the server's filename
  async function download(path: string, fallbackName: string) {
    setBusy(true); setError(""); setMessage(""); setRefreshError("");
    try {
      const r = await api<IcsReply>(path);
      const blob = new Blob([r.ics], { type: r.content_type || "text/calendar" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = r.filename || fallbackName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  const rowKey = (e: CalEvent) => `${e.event_id}-${e.occurrence_date ?? e.start_time}`;
  const dateType = form.allDay ? "date" : "datetime-local";

  const meta = (e: CalEvent) => (
    <>
      <p>{when(e)}</p>
      <p>
        Category: {label(e.category)} · Status: {label(e.status)}
        {e.location && <> · Location: {e.location}</>}
        {e.provider_name && <> · Provider: {e.provider_name}</>}
      </p>
      {repeats(e) && <p>{repeatText(e)}</p>}
    </>
  );

  return (
    <>
      <NavigationBar />
      <main className="page-container">
        <section className="page-heading">
          <h2>Calendar</h2>
          <p>Keep your appointments, medicine times and other events in one place. Events can repeat.</p>
        </section>

        {error && <p className="notice error" role="alert">{error}</p>}
        {message && !error && <p className="notice success" role="status">{message}</p>}
        {refreshError && <p className="notice error" role="alert">{refreshError}</p>}

        <section aria-labelledby="cal-month" className="mg-section">
          <div className="mg-head">
            <h3 id="cal-month">{MONTHS[view.month]} {view.year}</h3>
            <div className="mg-nav">
              <button className="secondary-button" type="button" onClick={() => shiftMonth(-1)}>Previous month</button>
              <button className="secondary-button" type="button" onClick={goToday}>Today</button>
              <button className="secondary-button" type="button" onClick={() => shiftMonth(1)}>Next month</button>
            </div>
          </div>
          {monthError && <p className="notice error" role="alert">{monthError}</p>}
          {monthLoading && <p role="status">Loading…</p>}
          {monthEvents.length >= MONTH_LIMIT && <p className="notice error" role="note">Some events may not be shown. Use the event list below to see them.</p>}
          <div className="mg-grid" role="group" aria-label={`${MONTHS[view.month]} ${view.year} calendar`}>
            {DAY_NAMES.map((n) => <div key={n} className="mg-dow" aria-hidden="true"><span className="mg-dow-long">{n}</span><span className="mg-dow-short">{n.slice(0, 3)}</span></div>)}
            {gridList.map((day) => {
              const list = eventsByDay.get(day) ?? [];
              const inMonth = Number(day.slice(5, 7)) - 1 === view.month;
              const isToday = day === localDate();
              const isSelected = day === selectedDay;
              const name = `${dayName(day)}, ${list.length === 0 ? "no events" : plural(list.length, "event")}${isToday ? ", today" : ""}`;
              return (
                <button
                  key={day} type="button" aria-label={name} aria-pressed={isSelected}
                  className={`mg-cell${inMonth ? "" : " other"}${isToday ? " today" : ""}${isSelected ? " selected" : ""}`}
                  onClick={() => setSelectedDay(day)}
                >
                  <span className="mg-num">{Number(day.slice(8))}</span>
                  {list.length > 0 && <span className="mg-count">{plural(list.length, "event")}</span>}
                  <span className="mg-chips">
                    {list.slice(0, 3).map((e) => (
                      <span key={rowKey(e)} className="mg-chip">
                        <span className="mg-chip-main">{chipTime(e)} {e.title}</span>
                        <span className="mg-chip-meta">{label(e.category)}, {label(e.status)}</span>
                      </span>
                    ))}
                    {list.length > 3 && <span className="mg-more">+{list.length - 3} more</span>}
                  </span>
                </button>
              );
            })}
          </div>

          {selectedDay && gridList.includes(selectedDay) && (
            <section className="mg-panel" role="region" aria-labelledby="cal-day-heading">
              <h4 id="cal-day-heading">{dayName(selectedDay)}, {selectedDay.slice(0, 4)}</h4>
              {(eventsByDay.get(selectedDay) ?? []).length === 0 ? <p>No events on this day.</p> : (
                <div className="med-list">
                  {(eventsByDay.get(selectedDay) ?? []).map((e) => (
                    <article key={rowKey(e)} className="med-card">
                      <h5 className="mg-event-title">{e.title}</h5>
                      <p>{e.all_day ? allDayText(e) : e.end_time && localDate(new Date(e.end_time)) !== localDate(new Date(e.start_time)) ? when(e) : `${fmtTime(e.start_time)}${e.end_time ? ` to ${fmtTime(e.end_time)}` : ""}`}</p>
                      <p>
                        Category: {label(e.category)} · Status: {label(e.status)}
                        {e.location && <> · Location: {e.location}</>}
                        {e.provider_name && <> · Provider: {e.provider_name}</>}
                      </p>
                      {repeats(e) && <p>{repeatText(e)}</p>}
                      {e.description && <p>Notes: {e.description}</p>}
                      <div className="med-actions">
                        <button className="secondary-button" type="button" disabled={busy} onClick={() => openEdit(e.event_id)}>Edit</button>
                        {repeats(e) && e.occurrence_date && (
                          <button className="secondary-button" type="button" disabled={busy} onClick={() => skipOccurrence(e)}>Skip this occurrence</button>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          )}
        </section>

        <section aria-labelledby="cal-upcoming" className="disp-section">
          <h3 id="cal-upcoming">Upcoming</h3>
          {upcomingError && <p className="notice error" role="alert">{upcomingError}</p>}
          {loading ? <p role="status">Loading…</p> : upcoming.length === 0 && !upcomingError ? (
            <p>Nothing coming up.</p>
          ) : (
            <ul>
              {upcoming.map((e) => (
                <li key={rowKey(e)}><strong>{e.title}</strong> — {when(e)} ({label(e.category)})</li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="cal-events" className="disp-section">
          <div className="med-toolbar">
            <h3 id="cal-events">Events</h3>
            <div>
              <button className="secondary-button" type="button" disabled={busy} onClick={() => download("/calendar/ics", "calendar.ics")}>
                Download whole calendar (.ics)
              </button>{" "}
              <button className="primary-button" type="button" disabled={busy} onClick={() => { if (formOpen) closeForm(); else openNew(); }}>
                {formOpen ? "Cancel" : "Add event"}
              </button>
            </div>
          </div>

          {formOpen && (
            <form id="calendar-form" className="med-add" onSubmit={submit} noValidate>
              <h3>{editingId !== null ? "Edit event" : "New event"}</h3>
              {editingId !== null && form.repeat !== "none" && (
                <p className="form-hint">This changes every repeat of the event.</p>
              )}
              <div className="med-add-grid">
                <label className="med-wide">Title *<input value={form.title} onChange={set("title")} maxLength={255} /></label>
                <label>Category *
                  <select value={form.category} onChange={set("category")}>
                    {CATEGORIES.map((c) => <option key={c} value={c}>{label(c)}</option>)}
                  </select>
                </label>
                <label>Status *
                  <select value={form.status} onChange={set("status")}>
                    {STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
                  </select>
                </label>
                <label className="rem-check">
                  <input type="checkbox" checked={form.allDay} onChange={(e) => toggleAllDay(e.target.checked)} /> All day
                </label>
                <label>Starts *<input type={dateType} value={form.start} onChange={set("start")} /></label>
                <label>Ends (optional)<input type={dateType} value={form.end} onChange={set("end")} /></label>
                <label>Location (optional)<input value={form.location} onChange={set("location")} maxLength={255} /></label>
                <label>Provider (optional)<input value={form.provider} onChange={set("provider")} maxLength={255} /></label>
                <label className="med-wide">Notes (optional)
                  <textarea rows={3} value={form.notes} onChange={set("notes")} maxLength={5000} />
                </label>

                <label>Repeat
                  <select value={form.repeat} onChange={set("repeat")}>
                    {REPEATS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                  </select>
                </label>
                {form.repeat === "every_n_days" && (
                  <label>Every how many days? (1 to 365)
                    <input type="number" inputMode="numeric" min={1} max={365} step={1} value={form.interval} onChange={set("interval")} />
                  </label>
                )}
                {form.repeat === "monthly" && (
                  <label>Day of the month (1 to 31)
                    <input type="number" inputMode="numeric" min={1} max={31} step={1} value={form.monthDay} onChange={set("monthDay")} />
                  </label>
                )}
                {form.repeat === "weekly" && (
                  <fieldset className="checkbox-group med-wide">
                    <legend>Repeat on</legend>
                    {WEEKDAYS.map((name, d) => (
                      <label key={name} className="rem-check">
                        <input type="checkbox" checked={form.weekdays.includes(d)} onChange={() => toggleWeekday(d)} /> {name}
                      </label>
                    ))}
                  </fieldset>
                )}
                {form.repeat !== "none" && (
                  <label>Ends
                    <select value={form.endType} onChange={set("endType")}>
                      {END_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                    </select>
                  </label>
                )}
                {form.repeat !== "none" && form.endType === "date" && (
                  <label>Last day<input type="date" value={form.endDate} onChange={set("endDate")} /></label>
                )}
                {form.repeat !== "none" && form.endType === "count" && (
                  <label>Number of times (1 to 1000)
                    <input type="number" inputMode="numeric" min={1} max={1000} step={1} value={form.endCount} onChange={set("endCount")} />
                  </label>
                )}
              </div>
              <button className="primary-button" type="submit" disabled={busy}>{busy ? "Saving…" : editingId !== null ? "Save changes" : "Save event"}</button>
            </form>
          )}

          <div className="med-add-grid">
            <label>Show events from
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label>Show events until
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
          </div>

          {loading ? <p role="status">Loading…</p> : events.length === 0 ? (
            <p>No events in these dates.</p>
          ) : (
            <div className="med-list">
              {events.map((e) => (
                <article key={rowKey(e)} className="med-card">
                  <div className="med-main">
                    <div>
                      <h3>{e.title}</h3>
                      {meta(e)}
                      {e.description && <p>Notes: {e.description}</p>}
                    </div>
                  </div>
                  <div className="med-actions">
                    <button className="secondary-button" type="button" disabled={busy} onClick={() => openEdit(e.event_id)}>Edit</button>
                    {repeats(e) && e.occurrence_date && (
                      <button className="secondary-button" type="button" disabled={busy} onClick={() => skipOccurrence(e)}>
                        Skip this one ({fmtDate(e.occurrence_date)})
                      </button>
                    )}
                    <button className="secondary-button" type="button" disabled={busy}
                      onClick={() => download(`/calendar/events/${encodeURIComponent(String(e.event_id))}/ics`, `event-${e.event_id}.ics`)}>
                      Download .ics
                    </button>
                    <button className="text-button med-link danger" type="button" disabled={busy} onClick={() => removeEvent(e)}>Delete event</button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <SubscribeLinks />
      </main>
    </>
  );
}

export default Calendar;
