import { useEffect, useState } from "react";
import NavigationBar from "../components/NavigationBar";
import { api } from "../api";
import { listMedications } from "../data/medications";

// Reminders: repeating or one-time reminders (medicine, refill, appointment, device part, custom)
// and the switches for the automatic alerts.
//   GET/POST /reminders, PUT/DELETE /reminders/:id
//   GET/PUT /notifications/settings
// Snooze is on the notification bell, not on this page.
// Linked items: listMedications() (data/medications.ts), GET /respiratory/devices (+ /:id/supplies), GET /calendar/events.

type ReminderType = "medication" | "refill" | "appointment" | "device_supply" | "custom";
type Freq = "daily" | "weekly" | "once";

type Reminder = {
  reminder_id: string;
  reminder_type: ReminderType;
  title: string;
  linked_id: string | null;
  linked_name: string | null;
  schedule_type: Freq;
  times: string[] | null;
  days_of_week: number[] | null;
  remind_at: string | null;
  start_date: string | null;
  end_date: string | null;
  time_zone: string | null;
  next_due_at: string | null;
  email_me: boolean;
  active: boolean;
  snoozed_until: string | null;
};

type MedOption = { medication_id: string | number; medication_name: string };
type Device = { device_id: string | number; name: string };
type Supply = { supply_id: string | number; device_id: string | number; part_name: string };
type EventOption = { event_id: string; title: string; start_time: string };

type Settings = { low_stock: boolean; appointments: boolean; supplies: boolean; disposal: boolean; email: boolean };
type SettingKey = keyof Settings;

type FormState = {
  type: ReminderType;
  linkedId: string;
  deviceId: string;
  title: string;
  freq: Freq;
  times: string[];
  days: number[];
  onceAt: string;      // datetime-local value, "YYYY-MM-DDTHH:MM"
  endDate: string;
  email: boolean;
};

const TYPES: { key: ReminderType; label: string }[] = [
  { key: "medication", label: "Take a medicine" },
  { key: "refill", label: "Refill a medicine" },
  { key: "appointment", label: "Appointment" },
  { key: "device_supply", label: "Replace a device part" },
  { key: "custom", label: "Something else" },
];
const TYPE_LABEL: Record<ReminderType, string> = {
  medication: "Medicine", refill: "Refill", appointment: "Appointment", device_supply: "Device part", custom: "Custom",
};
const FREQS: { key: Freq; label: string }[] = [
  { key: "daily", label: "Every day" },
  { key: "weekly", label: "On certain days" },
  { key: "once", label: "Just once" },
];
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MAX_TIMES = 8;

const SETTING_LABELS: { key: SettingKey; label: string }[] = [
  { key: "low_stock", label: "Low stock: a medicine is running out" },
  { key: "appointments", label: "Appointments coming up" },
  { key: "supplies", label: "Device parts that need replacing" },
  { key: "disposal", label: "Leftover medicines to dispose of" },
  { key: "email", label: "Also email me these alerts" },
];

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const errText = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong");

const emptyForm = (): FormState => ({
  type: "medication", linkedId: "", deviceId: "", title: "", freq: "daily",
  times: ["08:00"], days: [], onceAt: "", endDate: "", email: false,
});

const pad = (n: number) => String(n).padStart(2, "0");

// datetime-local value (browser's local time) for an ISO instant.
// Used by both the edit form and the list, so a once reminder shows the same time in both.
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function scheduleText(r: Reminder): string {
  let text: string;
  if (r.schedule_type === "once") {
    const local = toLocalInput(r.remind_at);
    const [date, time] = local.split("T");
    text = date && time ? `Once on ${date} at ${time}` : "Once";
  } else {
    const at = (r.times || []).join(", ");
    if (r.schedule_type === "weekly") {
      const days = [...(r.days_of_week || [])].sort((a, b) => a - b).map((d) => DAY_SHORT[d]).filter(Boolean).join(", ");
      text = `${days || "Certain days"}${at ? ` at ${at}` : ""}`;
    } else {
      text = `Daily${at ? ` at ${at}` : ""}`;
    }
  }
  if (r.end_date) text += `, until ${String(r.end_date).slice(0, 10)}`;
  return text;
}

function formatInstant(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function isSnoozed(r: Reminder): boolean {
  return !!r.snoozed_until && new Date(r.snoozed_until).getTime() > Date.now();
}

function nextText(r: Reminder): string {
  if (!r.active) return "Next: none (turned off)";
  if (!r.next_due_at) return "Next: none scheduled";
  return `Next: ${formatInstant(r.next_due_at)}`;
}

function formFromReminder(r: Reminder, supplies: Supply[]): FormState {
  const supply = r.reminder_type === "device_supply" && r.linked_id
    ? supplies.find((s) => String(s.supply_id) === r.linked_id) : undefined;
  return {
    type: r.reminder_type,
    linkedId: r.linked_id || "",
    deviceId: supply ? String(supply.device_id) : "",
    title: r.title || "",
    freq: r.schedule_type,
    times: r.times && r.times.length ? [...r.times] : ["08:00"],
    days: r.days_of_week ? [...r.days_of_week] : [],
    onceAt: toLocalInput(r.remind_at),
    endDate: r.end_date ? String(r.end_date).slice(0, 10) : "",
    email: !!r.email_me,
  };
}

const sameList = (a: (string | number)[], b: (string | number)[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const sortedNums = (a: number[]) => [...a].sort((x, y) => x - y);
const sortedTimes = (a: string[]) => [...a].sort();

function Reminders() {
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [refreshError, setRefreshError] = useState("");

  const [meds, setMeds] = useState<MedOption[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [supplies, setSupplies] = useState<Supply[]>([]);
  const [events, setEvents] = useState<EventOption[]>([]);
  const [linkNote, setLinkNote] = useState("");

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Reminder | null>(null);
  const [initial, setInitial] = useState<FormState>(emptyForm());
  const [form, setForm] = useState<FormState>(emptyForm());
  const [formError, setFormError] = useState("");

  const [settings, setSettings] = useState<Settings | null>(null);
  const [pending, setPending] = useState<SettingKey[]>([]);
  const [settingsError, setSettingsError] = useState("");

  async function loadReminders() {
    const r = await api<{ reminders: Reminder[] }>("/reminders");
    setReminders(r.reminders || []);
  }

  useEffect(() => {
    let alive = true;
    api<{ reminders: Reminder[] }>("/reminders")
      .then((r) => { if (alive) setReminders(r.reminders || []); })
      .catch((e) => { if (alive) setError(errText(e)); })
      .finally(() => { if (alive) setLoading(false); });

    api<{ settings?: Partial<Settings> } & Partial<Settings>>("/notifications/settings")
      .then((r) => {
        if (!alive) return;
        const s = r.settings ?? r;
        setSettings({
          low_stock: !!s.low_stock, appointments: !!s.appointments, supplies: !!s.supplies,
          disposal: !!s.disposal, email: !!s.email,
        });
      })
      .catch((e) => { if (alive) setSettingsError(errText(e)); });

    // the linked-item lists are extras: the page still works without them
    const failed: string[] = [];
    Promise.all([
      listMedications().catch(() => { failed.push("medicines"); return [] as MedOption[]; }),
      api<{ events: EventOption[] }>("/calendar/events").then((r) => r.events || []).catch(() => { failed.push("appointments"); return [] as EventOption[]; }),
      api<{ devices: Device[] }>("/respiratory/devices").then((r) => r.devices || []).catch(() => { failed.push("devices"); return [] as Device[]; }),
    ]).then(async ([m, ev, dev]) => {
      const sup = (await Promise.all(dev.map((d) =>
        api<{ supplies: Supply[] }>(`/respiratory/devices/${encodeURIComponent(String(d.device_id))}/supplies`)
          .then((r) => (r.supplies || []).map((s) => ({ ...s, device_id: d.device_id })))
          .catch(() => { if (!failed.includes("device parts")) failed.push("device parts"); return [] as Supply[]; }),
      ))).flat();
      if (!alive) return;
      setMeds(m); setDevices(dev); setSupplies(sup);
      // one entry per event (repeating events come back once per day)
      const seen = new Set<string>();
      const uniq: EventOption[] = [];
      for (const e of ev) if (!seen.has(e.event_id)) { seen.add(e.event_id); uniq.push(e); }
      setEvents(uniq);
      if (failed.length) setLinkNote(`Could not load your ${failed.join(", ")}, so they can't be picked right now.`);
    });
    return () => { alive = false; };
  }, []);

  // ---- form ----
  const patch = (p: Partial<FormState>) => setForm((f) => ({ ...f, ...p }));

  function openNew() {
    if (editing && !window.confirm("Discard your changes to this reminder and start a new one?")) return;
    const f = emptyForm();
    setEditing(null); setInitial(f); setForm(f); setFormError(""); setFormOpen(true);
    setMessage(""); setError("");
    scrollToForm();
  }
  function openEdit(r: Reminder) {
    const f = formFromReminder(r, supplies);
    setEditing(r); setInitial(f); setForm(f); setFormError(""); setFormOpen(true);
    setMessage(""); setError("");
    scrollToForm();
  }
  function closeForm() { setFormOpen(false); setEditing(null); setFormError(""); }
  function scrollToForm() {
    setTimeout(() => document.getElementById("reminder-form")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }

  function setType(type: ReminderType) { patch({ type, linkedId: "", deviceId: "" }); }
  function setTime(i: number, v: string) { setForm((f) => ({ ...f, times: f.times.map((t, j) => (j === i ? v : t)) })); }
  function addTime() { setForm((f) => (f.times.length >= MAX_TIMES ? f : { ...f, times: [...f.times, "12:00"] })); }
  function removeTime(i: number) { setForm((f) => (f.times.length <= 1 ? f : { ...f, times: f.times.filter((_, j) => j !== i) })); }
  function toggleDay(d: number) {
    setForm((f) => ({ ...f, days: f.days.includes(d) ? f.days.filter((x) => x !== d) : [...f.days, d] }));
  }

  // supplies of the chosen device
  const deviceSupplies = supplies.filter((s) => String(s.device_id) === form.deviceId);

  // Build the request. A new reminder sends everything it needs; an edit sends only what changed
  // (the server re-checks a once time or a schedule change as "must be in the future" whenever it is sent).
  function buildBody(): { body?: Record<string, unknown>; error?: string } {
    const f = form;
    if (f.type !== "custom" && !f.linkedId && !f.title.trim()) {
      return { error: "Choose what this reminder is for, or type a name." };
    }
    if (f.type === "custom" && !f.title.trim()) return { error: "Type a name for the reminder." };
    if (f.freq !== "once") {
      if (f.times.some((t) => !/^\d{2}:\d{2}$/.test(t))) return { error: "Fill in every time, or remove the empty ones." };
    } else if (!f.onceAt) return { error: "Choose the date and time for the reminder." };
    if (f.freq === "weekly" && f.days.length === 0) return { error: "Choose at least one day of the week." };
    if (f.freq === "once" && Number.isNaN(new Date(f.onceAt).getTime())) return { error: "That date and time isn't valid." };

    const i = initial;
    const isNew = !editing;
    const freqChanged = isNew || f.freq !== i.freq;
    const timesChanged = f.freq !== "once" && (freqChanged || !sameList(sortedTimes(f.times), sortedTimes(i.times)));
    const daysChanged = f.freq === "weekly" && (freqChanged || !sameList(sortedNums(f.days), sortedNums(i.days)));
    const onceChanged = f.freq === "once" && (freqChanged || f.onceAt !== i.onceAt);
    const endChanged = isNew ? !!f.endDate : f.endDate !== i.endDate;
    const typeChanged = isNew || f.type !== i.type;
    const linkChanged = isNew || typeChanged || f.linkedId !== i.linkedId;
    const titleChanged = isNew || f.title.trim() !== i.title.trim();
    const emailChanged = isNew || f.email !== i.email;

    const body: Record<string, unknown> = {};
    if (typeChanged) body.reminder_type = f.type;
    if (linkChanged && (f.type !== "custom" || !isNew)) body.linked_id = f.type === "custom" || !f.linkedId ? null : f.linkedId;
    if (titleChanged && (!isNew || f.title.trim())) body.title = f.title.trim();
    if (freqChanged) body.schedule_type = f.freq;
    if (timesChanged) body.times = f.times;
    if (daysChanged) body.days_of_week = sortedNums(f.days);
    if (onceChanged) body.remind_at = new Date(f.onceAt).toISOString();
    if (endChanged) body.end_date = f.endDate || null;
    if (emailChanged) body.email_me = f.email;
    if (isNew || freqChanged || timesChanged || daysChanged || onceChanged || endChanged) body.time_zone = browserZone();
    return { body };
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(""); setError(""); setMessage(""); setRefreshError("");
    const { body, error: problem } = buildBody();
    if (problem || !body) { setFormError(problem || "Check the form."); return; }
    if (editing && Object.keys(body).length === 0) { closeForm(); setMessage("No changes to save."); return; }
    setBusy(true);
    try {
      const r = editing
        ? await api<{ message?: string }>(`/reminders/${encodeURIComponent(editing.reminder_id)}`, { method: "PUT", body: JSON.stringify(body) })
        : await api<{ message?: string }>("/reminders", { method: "POST", body: JSON.stringify(body) });
      closeForm();
      setMessage(r.message || (editing ? "Reminder updated" : "Reminder added"));
    } catch (e) { setFormError(errText(e)); setBusy(false); return; }
    try { await loadReminders(); }
    catch (e) { setRefreshError(`Saved, but the list could not refresh: ${errText(e)}`); }
    finally { setBusy(false); }
  }

  async function toggleActive(r: Reminder) {
    setBusy(true); setError(""); setMessage(""); setRefreshError("");
    try {
      await api(`/reminders/${encodeURIComponent(r.reminder_id)}`, { method: "PUT", body: JSON.stringify({ active: !r.active }) });
      setMessage(r.active ? `"${r.title}" turned off` : `"${r.title}" turned on`);
    } catch (e) { setError(errText(e)); setBusy(false); return; }
    try { await loadReminders(); }
    catch (e) { setRefreshError(`Saved, but the list could not refresh: ${errText(e)}`); }
    finally { setBusy(false); }
  }

  async function remove(r: Reminder) {
    if (!window.confirm(`Delete the reminder "${r.title}"?`)) return;
    setBusy(true); setError(""); setMessage(""); setRefreshError("");
    try {
      const res = await api<{ message?: string }>(`/reminders/${encodeURIComponent(r.reminder_id)}`, { method: "DELETE" });
      if (editing?.reminder_id === r.reminder_id) closeForm();
      setMessage(res.message || "Reminder removed");
    } catch (e) { setError(errText(e)); setBusy(false); return; }
    try { await loadReminders(); }
    catch (e) { setRefreshError(`Removed, but the list could not refresh: ${errText(e)}`); }
    finally { setBusy(false); }
  }

  // ---- automatic alerts: saved at once; rolled back if the save fails ----
  async function changeSetting(key: SettingKey, value: boolean) {
    if (!settings || pending.includes(key)) return;
    const before = settings[key];
    setSettingsError("");
    setSettings((s) => (s ? { ...s, [key]: value } : s));
    setPending((p) => [...p, key]);
    try {
      await api("/notifications/settings", { method: "PUT", body: JSON.stringify({ [key]: value }) });
    } catch (e) {
      setSettings((s) => (s ? { ...s, [key]: before } : s));
      setSettingsError(errText(e));
    } finally {
      setPending((p) => p.filter((k) => k !== key));
    }
  }

  // ---- linked-item choices ----
  const needsLink = form.type !== "custom";
  const missingMed = !!editing && form.linkedId && !meds.some((m) => String(m.medication_id) === form.linkedId);
  const missingEvent = !!editing && form.linkedId && !events.some((e) => e.event_id === form.linkedId);
  const missingSupply = !!editing && form.linkedId && !supplies.some((s) => String(s.supply_id) === form.linkedId);
  const keepName = editing?.linked_name || "current item";

  return (
    <>
      <NavigationBar />
      <main className="page-container">
        <section className="page-heading">
          <h2>Reminders</h2>
          <p>Set reminders for medicines, refills, appointments and device parts. You can snooze a reminder from the bell when it goes off.</p>
        </section>

        {error && <p className="notice error" role="alert">{error}</p>}
        {message && !error && <p className="notice success" role="status">{message}</p>}
        {refreshError && <p className="notice error" role="alert">{refreshError}</p>}

        <section aria-labelledby="rem-list">
          <div className="med-toolbar">
            <h3 id="rem-list">Your reminders</h3>
            <button className="primary-button" type="button" disabled={busy} onClick={() => (formOpen && !editing ? closeForm() : openNew())}>
              {formOpen && !editing ? "Cancel" : "Add a reminder"}
            </button>
          </div>

          {formOpen && (
            <form id="reminder-form" className="med-add" onSubmit={submit} noValidate>
              <h3>{editing ? "Edit reminder" : "New reminder"}</h3>
              {formError && <p className="notice error" role="alert">{formError}</p>}
              {linkNote && <p className="form-hint">{linkNote}</p>}

              <div className="med-add-grid">
                <label>What is it for? *
                  <select value={form.type} onChange={(e) => setType(e.target.value as ReminderType)}>
                    {TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                  </select>
                </label>

                {(form.type === "medication" || form.type === "refill") && (
                  <label>Medicine
                    <select value={form.linkedId} onChange={(e) => patch({ linkedId: e.target.value })}>
                      <option value="">Choose a medicine</option>
                      {missingMed && <option value={form.linkedId}>{keepName}</option>}
                      {meds.map((m) => <option key={String(m.medication_id)} value={String(m.medication_id)}>{m.medication_name}</option>)}
                    </select>
                  </label>
                )}

                {form.type === "appointment" && (
                  <label>Appointment
                    <select value={form.linkedId} onChange={(e) => patch({ linkedId: e.target.value })}>
                      <option value="">Choose an appointment</option>
                      {missingEvent && <option value={form.linkedId}>{keepName}</option>}
                      {events.map((ev) => {
                        const d = new Date(ev.start_time);
                        return (
                          <option key={ev.event_id} value={ev.event_id}>
                            {ev.title}{Number.isNaN(d.getTime()) ? "" : ` (${d.toLocaleDateString()})`}
                          </option>
                        );
                      })}
                    </select>
                  </label>
                )}

                {form.type === "device_supply" && (
                  <>
                    <label>Device
                      <select value={form.deviceId} onChange={(e) => patch({ deviceId: e.target.value, linkedId: "" })}>
                        <option value="">Choose a device</option>
                        {devices.map((d) => <option key={String(d.device_id)} value={String(d.device_id)}>{d.name}</option>)}
                      </select>
                    </label>
                    <label>Part
                      <select value={form.linkedId} onChange={(e) => patch({ linkedId: e.target.value })} disabled={!form.deviceId && !missingSupply}>
                        <option value="">Choose a part</option>
                        {missingSupply && <option value={form.linkedId}>{keepName}</option>}
                        {deviceSupplies.map((s) => <option key={String(s.supply_id)} value={String(s.supply_id)}>{s.part_name}</option>)}
                      </select>
                    </label>
                  </>
                )}

                <label className={needsLink ? "" : "med-wide"}>Name{needsLink ? " (optional)" : " *"}
                  <input value={form.title} onChange={(e) => patch({ title: e.target.value })} maxLength={200}
                    placeholder={needsLink ? "Leave blank to use the name of the item" : "e.g. Drink water"} />
                </label>

                <label>How often? *
                  <select value={form.freq} onChange={(e) => patch({ freq: e.target.value as Freq })}>
                    {FREQS.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                  </select>
                </label>
              </div>

              {form.freq === "once" ? (
                <div className="med-add-grid">
                  <label>Date and time *
                    <input type="datetime-local" value={form.onceAt} onChange={(e) => patch({ onceAt: e.target.value })} />
                  </label>
                </div>
              ) : (
                <>
                  <fieldset className="checkbox-group rem-fieldset">
                    <legend>Times of day *</legend>
                    <div className="rem-times">
                      {form.times.map((t, i) => (
                        <div className="rem-time-row" key={i}>
                          <input type="time" aria-label={`Time ${i + 1}`} value={t} onChange={(e) => setTime(i, e.target.value)} />
                          <button className="text-button med-link danger" type="button" disabled={form.times.length <= 1}
                            aria-label={`Remove time ${i + 1}`} onClick={() => removeTime(i)}>Remove</button>
                        </div>
                      ))}
                    </div>
                    <button className="secondary-button" type="button" disabled={form.times.length >= MAX_TIMES} onClick={addTime}>
                      Add another time
                    </button>
                    {form.times.length >= MAX_TIMES && <span className="form-hint">Up to {MAX_TIMES} times a day.</span>}
                  </fieldset>

                  {form.freq === "weekly" && (
                    <fieldset className="checkbox-group rem-fieldset">
                      <legend>Days *</legend>
                      {DAY_SHORT.map((d, i) => (
                        <label key={d} className="rem-check">
                          <input type="checkbox" checked={form.days.includes(i)} onChange={() => toggleDay(i)} />
                          <span aria-hidden="true">{d}</span>
                          <span className="sr-only">{DAY_LONG[i]}</span>
                        </label>
                      ))}
                    </fieldset>
                  )}

                  <div className="med-add-grid">
                    <label>Stop after (optional)
                      <input type="date" value={form.endDate} onChange={(e) => patch({ endDate: e.target.value })} />
                    </label>
                  </div>
                </>
              )}

              <label className="rem-check rem-email">
                <input type="checkbox" checked={form.email} onChange={(e) => patch({ email: e.target.checked })} />
                <span>Also email me</span>
              </label>

              <p className="form-hint">Times are in your time zone ({browserZone()}).</p>
              <div className="med-actions">
                <button className="primary-button" type="submit" disabled={busy}>{busy ? "Saving…" : editing ? "Save changes" : "Add reminder"}</button>
                <button className="secondary-button" type="button" disabled={busy} onClick={closeForm}>Cancel</button>
              </div>
            </form>
          )}

          {loading ? <p role="status">Loading…</p> : reminders.length === 0 ? (
            <p>No reminders yet. Choose "Add a reminder" to make one.</p>
          ) : (
            <div className="med-list">
              {reminders.map((r) => (
                <article key={r.reminder_id} className={`med-card ${r.active ? "" : "inactive"}`}>
                  <div className="med-main">
                    <div>
                      <h3>{r.title}</h3>
                      <p>
                        <span className={`med-badge ${r.active ? "" : "type"}`}>{r.active ? "On" : "Off"}</span>
                        <span className="med-badge type">{TYPE_LABEL[r.reminder_type] || r.reminder_type}</span>
                        {r.email_me && <span className="med-badge type">Emails you</span>}
                      </p>
                      <p>{scheduleText(r)}</p>
                      <p>{nextText(r)}</p>
                      {r.linked_name && r.linked_name !== r.title && <p className="form-hint">For: {r.linked_name}</p>}
                      {r.snoozed_until && isSnoozed(r) && (
                        <p className="form-hint">Snoozed until {formatInstant(r.snoozed_until)}</p>
                      )}
                    </div>
                  </div>
                  <div className="med-actions">
                    <button className="secondary-button" type="button" disabled={busy} onClick={() => toggleActive(r)}>
                      {r.active ? "Turn off" : "Turn on"}
                    </button>
                    <button className="secondary-button" type="button" disabled={busy} onClick={() => openEdit(r)}>Edit</button>
                    <button className="text-button med-link danger" type="button" disabled={busy} onClick={() => remove(r)}>Delete</button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <section aria-labelledby="rem-auto" className="disp-section">
          <h3 id="rem-auto">Automatic alerts</h3>
          <p className="form-hint">Choose which alerts the app sends you on its own. Changes are saved as soon as you tick a box.</p>
          {settingsError && <p className="notice error" role="alert">{settingsError}</p>}
          <fieldset className="checkbox-group rem-fieldset rem-alerts">
            <legend className="sr-only">Automatic alerts</legend>
            {SETTING_LABELS.map((s) => (
              <label key={s.key} className="rem-check">
                <input type="checkbox" checked={!!settings?.[s.key]} disabled={!settings || pending.includes(s.key)}
                  onChange={(e) => changeSetting(s.key, e.target.checked)} />
                <span>{s.label}</span>
              </label>
            ))}
          </fieldset>
        </section>
      </main>
    </>
  );
}

export default Reminders;
