import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import NavigationBar from "../components/NavigationBar";
import { api, localDate } from "../api";

// Nutrition: search USDA foods, log what you ate, see a day's totals and the last 30 days.
//   POST   /nutrition/search {query}              -> { foods } (502 + message when USDA is unavailable)
//   POST   /nutrition/log                         -> add an entry
//   GET    /nutrition/summary?date=&tz=           -> totals for one day
//   GET    /nutrition/logs?startDate=&endDate=&tz= -> history
//   PUT/DELETE /nutrition/log/:id
// Everything from USDA is shown as plain text.

type Food = {
  fdcId: string; description: string; brandOwner: string | null;
  servingSize: number; servingUnit: string;
  calories?: number; proteinG?: number; carbsG?: number; fatG?: number; fiberG?: number; sugarG?: number; sodiumMg?: number;
};
type LogRow = {
  log_id: string | number; food_name: string; usda_fdc_id: string | null;
  serving_size: number | string | null; serving_unit: string | null; logged_at: string;
  calories: number | string | null; protein_g: number | string | null; carbs_g: number | string | null; fat_g: number | string | null;
  fiber_g: number | string | null; sugar_g: number | string | null; sodium_mg: number | string | null;
};
type Summary = {
  date: string; meal_count: number; total_calories: number; total_protein: number; total_carbs: number;
  total_fat: number; total_fiber: number; total_sugar: number; total_sodium: number;
};

// form field key -> API (camelCase) name -> label
const NUMBER_FIELDS = [
  { key: "servingSize", label: "Serving size *" },
  { key: "calories", label: "Calories" },
  { key: "proteinG", label: "Protein (g)" },
  { key: "carbsG", label: "Carbs (g)" },
  { key: "fatG", label: "Fat (g)" },
  { key: "fiberG", label: "Fiber (g)" },
  { key: "sugarG", label: "Sugar (g)" },
  { key: "sodiumMg", label: "Sodium (mg)" },
] as const;
type NumKey = (typeof NUMBER_FIELDS)[number]["key"];
type FormState = { foodName: string; servingUnit: string; usdaFdcId: string } & Record<NumKey, string>;

const emptyForm = (): FormState => ({
  foodName: "", servingUnit: "", usdaFdcId: "",
  servingSize: "", calories: "", proteinG: "", carbsG: "", fatG: "", fiberG: "", sugarG: "", sodiumMg: "",
});

const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const text = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const round = (v: unknown) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? "" : String(Math.round(Number(v) * 100) / 100));
const fmt = (v: unknown) => (round(v) === "" ? "-" : round(v));

// ---- month grid helpers (days are plain "YYYY-MM-DD" strings) ----
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function dayDate(day: string) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d, 12);
}
// "Friday October 9"
const dayName = (day: string) => {
  const d = dayDate(day);
  return `${DAY_NAMES[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}`;
};
// every date shown for a month: Sunday on or before the 1st through the Saturday on or after the last day
function gridDays(year: number, month: number) {
  const start = new Date(year, month, 1 - new Date(year, month, 1).getDay(), 12);
  const lastDow = new Date(year, month + 1, 0).getDay();
  const end = new Date(year, month + 1, 6 - lastDow, 12);
  const days: string[] = [];
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) days.push(localDate(d));
  return days;
}
// The local day (YYYY-MM-DD) of a time in time zone tz. Same rule as the server: the calendar date in tz.
function dayInZone(iso: string, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
const timeInZone = (iso: string, tz: string) => new Date(iso).toLocaleTimeString([], { timeZone: tz, hour: "numeric", minute: "2-digit" });
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

type DayTotals = { meals: number; calories: number; protein: number; carbs: number; fat: number; fiber: number; sugar: number; sodium: number; rows: LogRow[] };
const emptyTotals = (): DayTotals => ({ meals: 0, calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium: 0, rows: [] });

function Nutrition() {
  const [query, setQuery] = useState("");
  const [foods, setFoods] = useState<Food[] | null>(null);
  const [searchError, setSearchError] = useState("");
  const [searching, setSearching] = useState(false);

  const [form, setForm] = useState<FormState>(emptyForm());
  const [editing, setEditing] = useState<LogRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [refreshError, setRefreshError] = useState("");

  const [day, setDay] = useState(localDate());
  const [summary, setSummary] = useState<Summary | null>(null);
  const [summaryError, setSummaryError] = useState("");
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [logsError, setLogsError] = useState("");
  const [loading, setLoading] = useState(true);
  const summarySeq = useRef(0);   // ignore an older answer when the date changed meanwhile

  // month grid: the logs for the visible weeks, added up per local day in the browser's time zone
  const tz = timeZone();
  const [view, setView] = useState(() => { const n = new Date(); return { year: n.getFullYear(), month: n.getMonth() }; });
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [monthLogs, setMonthLogs] = useState<LogRow[]>([]);
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
      const qs = new URLSearchParams({ startDate: start, endDate: end, tz: timeZone() });
      const r = await api<{ logs: LogRow[] }>(`/nutrition/logs?${qs.toString()}`);
      if (stale()) return;
      setMonthLogs(r.logs); setMonthError("");
    } catch (e) {
      if (stale()) return;
      setMonthLogs([]); setMonthError((e as Error).message);
    }
    setMonthLoading(false);
  }, []);

  useEffect(() => {
    // state is set from a timer callback, not in the effect body itself
    const timer = window.setTimeout(() => { setMonthLoading(true); loadMonth(); }, 0);
    return () => window.clearTimeout(timer);
  }, [gridStart, gridEnd, loadMonth]);

  const totalsByDay = useMemo(() => {
    const map = new Map<string, DayTotals>();
    for (const l of monthLogs) {
      if (!l.logged_at) continue;
      const key = dayInZone(l.logged_at, tz);
      const t = map.get(key) ?? emptyTotals();
      t.meals += 1;
      t.calories += num(l.calories); t.protein += num(l.protein_g); t.carbs += num(l.carbs_g); t.fat += num(l.fat_g);
      t.fiber += num(l.fiber_g); t.sugar += num(l.sugar_g); t.sodium += num(l.sodium_mg);
      t.rows.push(l);
      map.set(key, t);
    }
    for (const t of map.values()) t.rows.sort((a, b) => a.logged_at.localeCompare(b.logged_at));
    return map;
  }, [monthLogs, tz]);

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

  const loadSummary = useCallback(async (date: string) => {
    const seq = ++summarySeq.current;
    try {
      const r = await api<{ summary: Summary }>(`/nutrition/summary?${new URLSearchParams({ date, tz: timeZone() }).toString()}`);
      if (seq === summarySeq.current) { setSummary(r.summary); setSummaryError(""); }
    } catch (e) {
      if (seq === summarySeq.current) { setSummary(null); setSummaryError((e as Error).message); }
    }
  }, []);

  const loadLogs = useCallback(async () => {
    const start = new Date();
    start.setDate(start.getDate() - 30);
    const qs = new URLSearchParams({ startDate: localDate(start), endDate: localDate(), tz: timeZone() });
    try {
      const r = await api<{ logs: LogRow[] }>(`/nutrition/logs?${qs.toString()}`);
      setLogs(r.logs); setLogsError("");
    } catch (e) { setLogsError((e as Error).message); }
  }, []);

  // state is set from a timer callback, not in the effect body itself
  useEffect(() => {
    const timer = window.setTimeout(() => { loadLogs().finally(() => setLoading(false)); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadLogs]);
  useEffect(() => {
    const timer = window.setTimeout(() => { loadSummary(day); }, 0);
    return () => window.clearTimeout(timer);
  }, [day, loadSummary]);

  async function refresh(date = day) {
    setRefreshError("");
    const seq = ++summarySeq.current;   // same guard as loadSummary: a newer day's answer wins
    try {
      const start = new Date();
      start.setDate(start.getDate() - 30);
      const qs = new URLSearchParams({ startDate: localDate(start), endDate: localDate(), tz: timeZone() });
      const [s, l] = await Promise.all([
        api<{ summary: Summary }>(`/nutrition/summary?${new URLSearchParams({ date, tz: timeZone() }).toString()}`),
        api<{ logs: LogRow[] }>(`/nutrition/logs?${qs.toString()}`),
      ]);
      if (seq === summarySeq.current) { setSummary(s.summary); setSummaryError(""); }
      setLogs(l.logs); setLogsError("");
    } catch (e) { setRefreshError(`Saved, but the totals and history could not refresh: ${(e as Error).message}`); }
    await loadMonth();
  }

  async function search(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearchError(""); setFoods(null);
    const q = query.trim();
    if (!q) { setSearchError("Type a food to search for."); return; }
    setSearching(true);
    try {
      const r = await api<{ foods: Food[] }>("/nutrition/search", { method: "POST", body: JSON.stringify({ query: q }) });
      setFoods(r.foods || []);
    } catch (e) { setSearchError((e as Error).message); }   // e.g. "USDA search is unavailable right now"
    finally { setSearching(false); }
  }

  function chooseFood(f: Food) {
    setEditing(null);   // a search result starts a new entry; it must never overwrite the one being edited
    setForm({
      foodName: f.description, servingUnit: text(f.servingUnit), usdaFdcId: text(f.fdcId),
      servingSize: round(f.servingSize), calories: round(f.calories), proteinG: round(f.proteinG), carbsG: round(f.carbsG),
      fatG: round(f.fatG), fiberG: round(f.fiberG), sugarG: round(f.sugarG), sodiumMg: round(f.sodiumMg),
    });
    setMessage(""); setError("");
  }

  function startEdit(l: LogRow) {
    setEditing(l);
    setForm({
      foodName: text(l.food_name), servingUnit: text(l.serving_unit), usdaFdcId: "",
      servingSize: round(l.serving_size), calories: round(l.calories), proteinG: round(l.protein_g), carbsG: round(l.carbs_g),
      fatG: round(l.fat_g), fiberG: round(l.fiber_g), sugarG: round(l.sugar_g), sodiumMg: round(l.sodium_mg),
    });
    setMessage(""); setError("");
    setTimeout(() => document.getElementById("nutrition-form")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }

  function cancelEdit() { setEditing(null); setForm(emptyForm()); setError(""); }

  const setText = (k: "foodName" | "servingUnit") => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setNum = (k: NumKey) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(""); setMessage(""); setRefreshError("");
    const name = form.foodName.trim();
    const unit = form.servingUnit.trim();
    if (!name) { setError("Enter the food name."); return; }
    if (!unit) { setError("Enter the serving unit (for example g, cup or slice)."); return; }
    const values: Partial<Record<NumKey, number | null>> = {};
    for (const { key, label } of NUMBER_FIELDS) {
      const raw = form[key].trim();
      if (raw === "") {
        if (key === "servingSize") { setError("Enter the serving size."); return; }
        values[key] = null;
        continue;
      }
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) { setError(`${label.replace(" *", "")} must be a number of 0 or more.`); return; }
      if (key === "servingSize" && n <= 0) { setError("The serving size must be more than 0."); return; }
      values[key] = n;
    }

    let newDay = day;
    setBusy(true);
    try {
      if (editing) {
        // send only what changed
        const body: Record<string, unknown> = {};
        if (name !== text(editing.food_name)) body.foodName = name;
        if (unit !== text(editing.serving_unit)) body.servingUnit = unit;
        const before: Record<NumKey, unknown> = {
          servingSize: editing.serving_size, calories: editing.calories, proteinG: editing.protein_g, carbsG: editing.carbs_g,
          fatG: editing.fat_g, fiberG: editing.fiber_g, sugarG: editing.sugar_g, sodiumMg: editing.sodium_mg,
        };
        for (const { key } of NUMBER_FIELDS) {
          if (form[key].trim() !== round(before[key])) body[key] = values[key];
        }
        if (Object.keys(body).length === 0) { setError("Nothing was changed."); setBusy(false); return; }
        const r = await api<{ message?: string }>(`/nutrition/log/${encodeURIComponent(String(editing.log_id))}`, { method: "PUT", body: JSON.stringify(body) });
        setMessage(r.message || "Nutrition log updated");
        setEditing(null); setForm(emptyForm());
      } else {
        const body: Record<string, unknown> = { foodName: name, servingUnit: unit };
        for (const { key } of NUMBER_FIELDS) if (values[key] !== null && values[key] !== undefined) body[key] = values[key];
        if (form.usdaFdcId) body.usdaFdcId = form.usdaFdcId;
        const r = await api<{ message?: string }>("/nutrition/log", { method: "POST", body: JSON.stringify(body) });
        setMessage(r.message || "Nutrition log entry created");
        setForm(emptyForm());
        // a new entry is logged for now, so show today's totals
        if (day !== localDate()) { setDay(localDate()); newDay = localDate(); }
      }
    } catch (e) { setError((e as Error).message); setBusy(false); return; }
    // the entry is saved: a failed refresh must not look like a failed save
    await refresh(newDay);
    setBusy(false);
  }

  async function removeLog(l: LogRow) {
    if (!window.confirm(`Delete "${l.food_name}" from your food log?`)) return;
    setBusy(true); setError(""); setMessage(""); setRefreshError("");
    try {
      const r = await api<{ message?: string }>(`/nutrition/log/${encodeURIComponent(String(l.log_id))}`, { method: "DELETE" });
      setMessage(r.message || "Nutrition log deleted");
      if (editing && String(editing.log_id) === String(l.log_id)) { setEditing(null); setForm(emptyForm()); }
    } catch (e) { setError((e as Error).message); setBusy(false); return; }
    await refresh();
    setBusy(false);
  }

  return (
    <>
      <NavigationBar />
      <main className="page-container">
        <section className="page-heading">
          <h2>Nutrition</h2>
          <p>Search for a food, log what you ate, and see your daily totals.</p>
        </section>

        {error && <p className="notice error" role="alert">{error}</p>}
        {message && !error && <p className="notice success" role="status">{message}</p>}
        {refreshError && <p className="notice error" role="alert">{refreshError}</p>}

        <section aria-labelledby="nut-month" className="mg-section">
          <div className="mg-head">
            <h3 id="nut-month">{MONTHS[view.month]} {view.year}</h3>
            <div className="mg-nav">
              <button className="secondary-button" type="button" onClick={() => shiftMonth(-1)}>Previous month</button>
              <button className="secondary-button" type="button" onClick={goToday}>Today</button>
              <button className="secondary-button" type="button" onClick={() => shiftMonth(1)}>Next month</button>
            </div>
          </div>
          {monthError && <p className="notice error" role="alert">{monthError}</p>}
          {monthLoading && <p role="status">Loading…</p>}
          <div className="mg-grid" role="group" aria-label={`${MONTHS[view.month]} ${view.year} daily totals`}>
            {DAY_NAMES.map((n) => <div key={n} className="mg-dow" aria-hidden="true"><span className="mg-dow-long">{n}</span><span className="mg-dow-short">{n.slice(0, 3)}</span></div>)}
            {gridList.map((day) => {
              const t = totalsByDay.get(day);
              const inMonth = Number(day.slice(5, 7)) - 1 === view.month;
              const isToday = day === localDate();
              const isSelected = day === selectedDay;
              const name = `${dayName(day)}, ${t ? `${Math.round(t.calories)} calories, ${fmt(t.protein)} grams protein, ${t.meals === 1 ? "1 entry" : `${t.meals} entries`}` : "nothing logged"}${isToday ? ", today" : ""}`;
              return (
                <button
                  key={day} type="button" aria-label={name} aria-pressed={isSelected}
                  className={`mg-cell${inMonth ? "" : " other"}${isToday ? " today" : ""}${isSelected ? " selected" : ""}`}
                  onClick={() => setSelectedDay(day)}
                >
                  <span className="mg-num">{Number(day.slice(8))}</span>
                  {t && (
                    <span className="mg-totals">
                      <span className="mg-total">{Math.round(t.calories)} cal</span>
                      <span className="mg-total">{fmt(t.protein)} g protein</span>
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {selectedDay && gridList.includes(selectedDay) && (() => {
            const t = totalsByDay.get(selectedDay);
            return (
              <section className="mg-panel" role="region" aria-labelledby="nut-day-heading">
                <h4 id="nut-day-heading">{dayName(selectedDay)}, {selectedDay.slice(0, 4)}</h4>
                {!t ? <p>Nothing logged on this day.</p> : (
                  <>
                    <div className="table-scroll">
                      <table className="access-log">
                        <caption className="sr-only">Totals for {selectedDay}</caption>
                        <thead>
                          <tr><th>Meals</th><th>Calories</th><th>Protein (g)</th><th>Carbs (g)</th><th>Fat (g)</th><th>Fiber (g)</th><th>Sugar (g)</th><th>Sodium (mg)</th></tr>
                        </thead>
                        <tbody>
                          <tr>
                            <td>{t.meals}</td><td>{fmt(t.calories)}</td><td>{fmt(t.protein)}</td><td>{fmt(t.carbs)}</td>
                            <td>{fmt(t.fat)}</td><td>{fmt(t.fiber)}</td><td>{fmt(t.sugar)}</td><td>{fmt(t.sodium)}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                    <h5 className="mg-subhead">Entries</h5>
                    <div className="table-scroll">
                      <table className="access-log">
                        <caption className="sr-only">Entries for {selectedDay}</caption>
                        <thead>
                          <tr><th>Time</th><th>Food</th><th>Serving</th><th>Cal</th><th>Protein</th><th>Carbs</th><th>Fat</th><th>Fiber</th><th>Sugar</th><th>Sodium (mg)</th><th><span className="sr-only">Actions</span></th></tr>
                        </thead>
                        <tbody>
                          {t.rows.map((l) => (
                            <tr key={String(l.log_id)}>
                              <td>{timeInZone(l.logged_at, tz)}</td>
                              <td>{l.food_name}</td>
                              <td>{l.serving_size !== null ? `${fmt(l.serving_size)} ${text(l.serving_unit)}` : "-"}</td>
                              <td>{fmt(l.calories)}</td>
                              <td>{fmt(l.protein_g)}</td>
                              <td>{fmt(l.carbs_g)}</td>
                              <td>{fmt(l.fat_g)}</td>
                              <td>{fmt(l.fiber_g)}</td>
                              <td>{fmt(l.sugar_g)}</td>
                              <td>{fmt(l.sodium_mg)}</td>
                              <td>
                                <button className="text-button med-link" type="button" disabled={busy} onClick={() => startEdit(l)}>Edit</button>{" "}
                                <button className="text-button med-link danger" type="button" disabled={busy} onClick={() => removeLog(l)}>Delete</button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </section>
            );
          })()}
        </section>

        <section aria-labelledby="nut-totals" className="disp-section">
          <div className="med-toolbar">
            <h3 id="nut-totals">Daily totals</h3>
            <label>Day
              <input type="date" value={day} max={localDate()} onChange={(e) => { if (e.target.value) setDay(e.target.value); }} />
            </label>
          </div>
          {summaryError && <p className="notice error" role="alert">{summaryError}</p>}
          {summary && !summaryError && (
            <div className="table-scroll">
              <table className="access-log">
                <caption className="sr-only">Totals for {summary.date}</caption>
                <thead>
                  <tr><th>Meals</th><th>Calories</th><th>Protein (g)</th><th>Carbs (g)</th><th>Fat (g)</th><th>Fiber (g)</th><th>Sugar (g)</th><th>Sodium (mg)</th></tr>
                </thead>
                <tbody>
                  <tr>
                    <td>{summary.meal_count}</td><td>{fmt(summary.total_calories)}</td><td>{fmt(summary.total_protein)}</td>
                    <td>{fmt(summary.total_carbs)}</td><td>{fmt(summary.total_fat)}</td><td>{fmt(summary.total_fiber)}</td>
                    <td>{fmt(summary.total_sugar)}</td><td>{fmt(summary.total_sodium)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section aria-labelledby="nut-search" className="disp-section">
          <h3 id="nut-search">Find a food</h3>
          <form className="med-add" onSubmit={search} noValidate>
            <div className="med-add-grid">
              <label className="med-wide">Food (USDA database)
                <input value={query} onChange={(e) => setQuery(e.target.value)} maxLength={200} placeholder="e.g. banana" />
              </label>
            </div>
            <button className="primary-button" type="submit" disabled={searching}>{searching ? "Searching…" : "Search"}</button>
          </form>
          {searchError && <p className="notice error" role="alert">{searchError}</p>}
          {foods && foods.length === 0 && !searchError && <p>No foods found. You can still type the food in below.</p>}
          {foods && foods.length > 0 && (
            <div className="table-scroll">
              <table className="access-log">
                <thead><tr><th>Food</th><th>Serving</th><th>Calories</th><th><span className="sr-only">Choose</span></th></tr></thead>
                <tbody>
                  {foods.map((f) => (
                    <tr key={f.fdcId}>
                      <td>{f.description}{f.brandOwner && <small> · {f.brandOwner}</small>}</td>
                      <td>{fmt(f.servingSize)} {f.servingUnit}</td>
                      <td>{fmt(f.calories)}</td>
                      <td><button className="text-button med-link" type="button" onClick={() => chooseFood(f)}>Use</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section aria-labelledby="nut-log" className="disp-section">
          <form id="nutrition-form" className="med-add" onSubmit={submit} noValidate>
            <h3 id="nut-log">{editing ? "Edit entry" : "Log food"}</h3>
            <div className="med-add-grid">
              <label className="med-wide">Food name *<input value={form.foodName} onChange={setText("foodName")} maxLength={255} /></label>
              <label>Serving size *
                <input type="number" inputMode="decimal" min={0} step="any" value={form.servingSize} onChange={setNum("servingSize")} />
              </label>
              <label>Serving unit *<input value={form.servingUnit} onChange={setText("servingUnit")} maxLength={50} placeholder="e.g. g, cup, slice" /></label>
              {NUMBER_FIELDS.filter((f) => f.key !== "servingSize").map((f) => (
                <label key={f.key}>{f.label}
                  <input type="number" inputMode="decimal" min={0} step="any" value={form[f.key]} onChange={setNum(f.key)} />
                </label>
              ))}
            </div>
            <p className="form-hint">Leave a number blank if you don't know it.</p>
            <button className="primary-button" type="submit" disabled={busy}>{busy ? "Saving…" : editing ? "Save changes" : "Log food"}</button>
            {editing && <button className="secondary-button" type="button" disabled={busy} onClick={cancelEdit}>Cancel</button>}
          </form>
        </section>

        <section aria-labelledby="nut-history" className="disp-section">
          <h3 id="nut-history">History (last 30 days)</h3>
          {logsError && <p className="notice error" role="alert">{logsError}</p>}
          {loading ? <p role="status">Loading…</p> : logs.length === 0 && !logsError ? <p>Nothing logged yet.</p> : logs.length > 0 && (
            <div className="table-scroll">
              <table className="access-log">
                <thead>
                  <tr><th>Date</th><th>Food</th><th>Cal</th><th>Protein</th><th>Carbs</th><th>Fat</th><th><span className="sr-only">Actions</span></th></tr>
                </thead>
                <tbody>
                  {logs.map((l) => (
                    <tr key={String(l.log_id)}>
                      <td>{localDate(new Date(l.logged_at))}</td>
                      <td>{l.food_name}{l.serving_size !== null && <small> · {fmt(l.serving_size)} {text(l.serving_unit)}</small>}</td>
                      <td>{fmt(l.calories)}</td>
                      <td>{fmt(l.protein_g)}</td>
                      <td>{fmt(l.carbs_g)}</td>
                      <td>{fmt(l.fat_g)}</td>
                      <td>
                        <button className="text-button med-link" type="button" disabled={busy} onClick={() => startEdit(l)}>Edit</button>{" "}
                        <button className="text-button med-link danger" type="button" disabled={busy} onClick={() => removeLog(l)}>Delete</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </>
  );
}

export default Nutrition;
