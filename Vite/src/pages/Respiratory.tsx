import { useCallback, useEffect, useRef, useState } from "react";
import NavigationBar from "../components/NavigationBar";
import { localDate } from "../api";
import {
  listDevices, addDevice, updateDevice, removeDevice as deleteDevice, listSupplies, markReplaced,
  listLogs, addLog, updateLog, removeLog as deleteLog, respiratorySummary,
} from "../data/respiratory";

// Breathing devices: CPAP and other pressure machines, oxygen, nebulizers and peak flow meters.
// Each device has replaceable parts (with due dates) and daily or nightly entries.
// Devices, parts and entries are read and saved with the Parse SDK (data/respiratory.ts), which also works out each
// part's due status and the 30-day summary. Marking a part replaced is an edit of its last_replaced date.
// Everything from the server is shown as plain text. Errors show the server's own message.

type Device = {
  device_id: string | number; device_type: string; name: string; serial_last4: string | null;
  mask_type: string | null; start_date: string | null; notes: string | null;
  pressure_min: number | null; pressure_max: number | null; epap: number | null; ipap: number | null;
  flow_lpm: number | null; personal_best: number | null; is_active: boolean;
};
type Supply = {
  supply_id: string | number; device_id: string | number; part_name: string; interval_days: number;
  last_replaced: string | null; next_due: string | null; days_left: number | null;
  due_status: "overdue" | "due_soon" | "ok";
  device_name?: string;
};
type Log = {
  log_id: string | number; device_id: string | number; log_date: string; notes: string | null;
  hours_used: number | null; ahi: number | null; leak_lpm: number | null; spo2_avg: number | null;
  spo2_min: number | null; flow_lpm_avg: number | null; comfort: number | null; peak_flow: number | null;
};
type Summary = {
  pap: {
    days: number; nights_logged: number; nights_ok: number; percent: number; compliant: boolean; nights_needed: number;
    avg_hours: number | null; avg_ahi: number | null; avg_leak: number | null; ahi_high: boolean; leak_high: boolean;
  } | null;
  oxygen: {
    days_logged: number; avg_hours: number | null; avg_flow_lpm: number | null; avg_spo2: number | null; days_below_88: number;
  } | null;
  peak_flow: {
    personal_best: number | null; personal_best_source: string | null; latest: number | null; latest_date: string | null;
    percent_of_best: number | null; zone: "green" | "yellow" | "red" | null; advice: string | null;
  } | null;
  supplies_due: Supply[];
};

const DEVICE_TYPES: { key: string; label: string }[] = [
  { key: "cpap", label: "CPAP" },
  { key: "apap", label: "APAP" },
  { key: "bipap", label: "BiPAP" },
  { key: "oxygen_concentrator", label: "Oxygen concentrator" },
  { key: "portable_oxygen", label: "Portable oxygen" },
  { key: "nebulizer", label: "Nebulizer" },
  { key: "peak_flow_meter", label: "Peak flow meter" },
  { key: "other", label: "Other device" },
];
const MASK_TYPES: { key: string; label: string }[] = [
  { key: "full_face", label: "Full face" },
  { key: "nasal", label: "Nasal" },
  { key: "nasal_pillows", label: "Nasal pillows" },
  { key: "hybrid", label: "Hybrid" },
  { key: "oral", label: "Oral" },
  { key: "other", label: "Other" },
];
const typeLabel = (key: string) => DEVICE_TYPES.find((t) => t.key === key)?.label ?? key;
const maskLabel = (key: string | null) => (key ? MASK_TYPES.find((m) => m.key === key)?.label ?? key : "");

const isPap = (t: string) => t === "cpap" || t === "apap" || t === "bipap";
const isOxygen = (t: string) => t === "oxygen_concentrator" || t === "portable_oxygen";
const isPeak = (t: string) => t === "peak_flow_meter";

// ---- device form ----
type DeviceNumber = "pressure_min" | "pressure_max" | "epap" | "ipap" | "flow_lpm" | "personal_best";
type DeviceForm = {
  device_type: string; name: string; serial: string; mask_type: string; start_date: string; notes: string; is_active: boolean;
} & Record<DeviceNumber, string>;

const NUMBER_LABEL: Record<DeviceNumber, string> = {
  pressure_min: "Lowest pressure (3 to 30 cm H2O)",
  pressure_max: "Highest pressure (3 to 30 cm H2O)",
  epap: "EPAP (3 to 30 cm H2O)",
  ipap: "IPAP (3 to 30 cm H2O)",
  flow_lpm: "Oxygen flow (0.25 to 15 L/min)",
  personal_best: "Personal best peak flow (L/min)",
};
// which settings each kind of device has
function settingsFor(type: string): DeviceNumber[] {
  if (type === "bipap") return ["epap", "ipap"];
  if (isPap(type)) return ["pressure_min", "pressure_max"];
  if (isOxygen(type)) return ["flow_lpm"];
  if (isPeak(type)) return ["personal_best"];
  return [];
}
const str = (v: number | string | null | undefined) => (v === null || v === undefined ? "" : String(v));

const emptyDeviceForm = (type = "cpap"): DeviceForm => ({
  device_type: type, name: "", serial: "", mask_type: "", start_date: "", notes: "", is_active: true,
  pressure_min: "", pressure_max: "", epap: "", ipap: "", flow_lpm: "", personal_best: "",
});
const deviceFormFrom = (d: Device): DeviceForm => ({
  device_type: d.device_type, name: d.name || "", serial: "", mask_type: d.mask_type || "", start_date: d.start_date || "",
  notes: d.notes || "", is_active: d.is_active !== false,
  pressure_min: str(d.pressure_min), pressure_max: str(d.pressure_max), epap: str(d.epap), ipap: str(d.ipap),
  flow_lpm: str(d.flow_lpm), personal_best: str(d.personal_best),
});

// ---- entry form ----
type FieldKey = "hours_used" | "ahi" | "leak_lpm" | "comfort" | "flow_lpm_avg" | "spo2_avg" | "spo2_min" | "peak_flow";
type Field = { key: FieldKey; label: string; short: string; step: string; min: number; max: number };
const F: Record<FieldKey, Field> = {
  hours_used: { key: "hours_used", label: "Hours used", short: "Hours", step: "0.1", min: 0, max: 24 },
  ahi: { key: "ahi", label: "AHI (events per hour)", short: "AHI", step: "0.1", min: 0, max: 150 },
  leak_lpm: { key: "leak_lpm", label: "Mask leak (L/min)", short: "Leak", step: "0.1", min: 0, max: 200 },
  comfort: { key: "comfort", label: "Comfort (1 to 5)", short: "Comfort", step: "1", min: 1, max: 5 },
  flow_lpm_avg: { key: "flow_lpm_avg", label: "Oxygen flow used (L/min)", short: "Flow", step: "0.25", min: 0, max: 15 },
  spo2_avg: { key: "spo2_avg", label: "Average oxygen level (%)", short: "SpO2 avg", step: "1", min: 40, max: 100 },
  spo2_min: { key: "spo2_min", label: "Lowest oxygen level (%)", short: "SpO2 low", step: "1", min: 40, max: 100 },
  peak_flow: { key: "peak_flow", label: "Peak flow (L/min)", short: "Peak", step: "1", min: 0, max: 1000 },
};
function fieldsFor(type: string): Field[] {
  if (isPap(type)) return [F.hours_used, F.ahi, F.leak_lpm, F.comfort];
  if (isOxygen(type)) return [F.hours_used, F.flow_lpm_avg, F.spo2_avg, F.spo2_min];
  if (isPeak(type)) return [F.peak_flow];
  return [F.hours_used, F.comfort];
}
type EntryForm = { log_date: string; notes: string } & Record<FieldKey, string>;
const emptyEntry = (): EntryForm => ({
  log_date: localDate(), notes: "", hours_used: "", ahi: "", leak_lpm: "", comfort: "",
  flow_lpm_avg: "", spo2_avg: "", spo2_min: "", peak_flow: "",
});
const entryFrom = (l: Log): EntryForm => ({
  log_date: l.log_date, notes: l.notes || "", hours_used: str(l.hours_used), ahi: str(l.ahi), leak_lpm: str(l.leak_lpm),
  comfort: str(l.comfort), flow_lpm_avg: str(l.flow_lpm_avg), spo2_avg: str(l.spo2_avg), spo2_min: str(l.spo2_min),
  peak_flow: str(l.peak_flow),
});

const zoneName = { green: "Green zone", yellow: "Yellow zone", red: "Red zone" } as const;
const num = (v: number | null | undefined, unit = "") => (v === null || v === undefined ? "none yet" : `${v}${unit}`);

function dueText(s: Supply) {
  if (s.next_due === null || s.days_left === null) return "No replacement date yet";
  if (s.due_status === "overdue") {
    const n = Math.abs(s.days_left);
    return `Overdue by ${n} ${n === 1 ? "day" : "days"} (was due ${s.next_due})`;
  }
  if (s.days_left === 0) return `Due today (${s.next_due})`;
  return `Due ${s.next_due}, in ${s.days_left} ${s.days_left === 1 ? "day" : "days"}`;
}
const dueLabel = { overdue: "Overdue", due_soon: "Due soon", ok: "OK" } as const;

function Respiratory() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [summaryFailed, setSummaryFailed] = useState(false);
  const [supplies, setSupplies] = useState<Supply[]>([]);
  const [logs, setLogs] = useState<Log[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const [deviceMode, setDeviceMode] = useState<"" | "add" | "edit">("");
  const [deviceForm, setDeviceForm] = useState<DeviceForm>(emptyDeviceForm());
  const [deviceError, setDeviceError] = useState("");

  const [entryOpen, setEntryOpen] = useState(false);
  const [editingLog, setEditingLog] = useState<Log | null>(null);
  const [entry, setEntry] = useState<EntryForm>(emptyEntry());
  const [entryError, setEntryError] = useState("");

  const detailRequest = useRef(0);
  const device = devices.find((d) => String(d.device_id) === selectedId) || null;

  // open on a CPAP if there is one, else the first device
  const firstChoice = (list: Device[]) => (list.find((d) => d.device_type === "cpap") || list[0])?.device_id;

  const loadTop = useCallback(async () => {
    const [d, s] = await Promise.all([
      listDevices(),
      // the summary is an extra: the page still works without it, but say so instead of hiding it
      respiratorySummary().then(
        (r) => ({ summary: r, failed: false }),
        () => ({ summary: null, failed: true }),
      ),
    ]);
    setDevices(d.devices);
    setSummary(s.summary);
    setSummaryFailed(s.failed);
    return d.devices;
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    if (!id) { setSupplies([]); setLogs([]); return; }
    const mine = ++detailRequest.current;
    const [s, l] = await Promise.all([
      listSupplies(id),
      listLogs({ device_id: id, limit: 30 }),
    ]);
    if (mine !== detailRequest.current) return;   // a newer request is already on its way
    setSupplies(s.supplies); setLogs(l.logs);
    setDetailLoading(false);                      // only the latest request clears the loading flag
  }, []);

  // state is set from timer callbacks, not in the effect bodies themselves
  useEffect(() => {
    const timer = window.setTimeout(() => {
      loadTop()
        .then((list) => { const first = firstChoice(list); if (first !== undefined) setSelectedId(String(first)); })
        .catch((e) => setError((e as Error).message))
        .finally(() => setLoading(false));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadTop]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!selectedId) {
        detailRequest.current++;                    // ignore anything still on its way
        setSupplies([]); setLogs([]); setDetailLoading(false);
        return;
      }
      // never show the previous device's parts and entries while the new ones load
      setSupplies([]); setLogs([]);
      setDetailLoading(true);
      const p = loadDetail(selectedId);
      const mine = detailRequest.current;           // loadDetail has already taken its number
      p.catch((e) => {
        if (mine !== detailRequest.current) return; // a newer request owns the page now
        setError((e as Error).message);
        setDetailLoading(false);
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [selectedId, loadDetail]);

  function closeForms() {
    setDeviceMode(""); setDeviceError(""); setEntryOpen(false); setEditingLog(null); setEntryError("");
  }
  function chooseDevice(id: string) {
    setSelectedId(id); closeForms(); setError(""); setMessage("");
  }

  // the change is saved: a failed reload must not look like a failed save
  async function reload(prefix: string, id = selectedId) {
    try { await Promise.all([loadTop(), loadDetail(id)]); }
    catch (e) { setError(`${prefix}, but the page could not refresh: ${(e as Error).message}`); }
  }

  // ---- devices ----
  const setD = (k: keyof DeviceForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setDeviceForm((f) => ({ ...f, [k]: e.target.value }));

  function openAdd() {
    closeForms(); setError(""); setMessage("");
    setDeviceForm(emptyDeviceForm()); setDeviceMode("add");
    setTimeout(() => document.getElementById("device-form")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }
  function openEdit() {
    if (!device) return;
    closeForms(); setError(""); setMessage("");
    setDeviceForm(deviceFormFrom(device)); setDeviceMode("edit");
    setTimeout(() => document.getElementById("device-form")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }

  async function submitDevice(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setDeviceError(""); setError(""); setMessage("");
    const editing = deviceMode === "edit";
    if (editing && !device) return;
    const f = deviceForm;
    if (f.start_date && f.start_date > localDate()) { setDeviceError("The start date can't be in the future"); return; }

    const body: Record<string, unknown> = {};
    if (!editing) body.device_type = f.device_type;
    if (f.name.trim() || editing) body.name = f.name.trim();
    if (f.serial.trim()) body.serial_last4 = f.serial.trim();
    if (isPap(f.device_type)) {
      if (f.mask_type || editing) body.mask_type = f.mask_type || null;
    }
    if (f.start_date || editing) body.start_date = f.start_date || null;
    if (f.notes.trim() || editing) body.notes = f.notes.trim();
    if (editing) body.is_active = f.is_active;
    for (const k of settingsFor(f.device_type)) {
      const raw = f[k].trim();
      if (raw === "") { if (editing) body[k] = null; continue; }
      const n = Number(raw);
      if (!Number.isFinite(n)) { setDeviceError(`${NUMBER_LABEL[k]} must be a number`); return; }
      body[k] = n;
    }

    setBusy(true);
    let savedId = selectedId;
    let ok = "";
    try {
      if (editing && device) {
        const r = await updateDevice(String(device.device_id), body);
        ok = r.message || "Device updated";
      } else {
        const r = await addDevice(body);
        ok = r.message || "Device added";
        if (r.device) savedId = String(r.device.device_id);
      }
      setDeviceMode(""); setMessage(ok);
    } catch (e) { setDeviceError((e as Error).message); setBusy(false); return; }
    if (savedId !== selectedId) setSelectedId(savedId);   // the detail effect loads the new device's parts
    await reload("Saved", savedId);
    setBusy(false);
  }

  async function removeDevice() {
    if (!device) return;
    if (!window.confirm(`Remove ${device.name}? Its parts and all of its entries will be removed too. This can't be undone.`)) return;
    setBusy(true); setError(""); setMessage(""); closeForms();
    try {
      const r = await deleteDevice(String(device.device_id));
      setMessage(r.message || "Device removed");
    } catch (e) { setError((e as Error).message); setBusy(false); return; }
    try {
      const list = await loadTop();
      const first = firstChoice(list);
      setSelectedId(first !== undefined ? String(first) : "");
    } catch (e) { setError(`Removed, but the page could not refresh: ${(e as Error).message}`); }
    setBusy(false);
  }

  // ---- parts ----
  async function replacedToday(s: Supply) {
    setBusy(true); setError(""); setMessage("");
    try {
      const r = await markReplaced(String(s.supply_id), localDate());
      setMessage(r.message ? `${s.part_name}: ${r.message}` : `${s.part_name} marked as replaced today`);
    } catch (e) { setError((e as Error).message); setBusy(false); return; }
    await reload("Saved");
    setBusy(false);
  }

  // ---- entries ----
  const setE = (k: keyof EntryForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setEntry((f) => ({ ...f, [k]: e.target.value }));

  function openEntry(l: Log | null) {
    closeForms(); setError(""); setMessage("");
    setEditingLog(l); setEntry(l ? entryFrom(l) : emptyEntry()); setEntryOpen(true);
    setTimeout(() => document.getElementById("entry-form")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }

  async function submitEntry(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!device) return;
    setEntryError(""); setError(""); setMessage("");
    if (!entry.log_date) { setEntryError("Choose the date"); return; }
    if (entry.log_date > localDate()) { setEntryError("The date can't be in the future"); return; }
    const editing = !!editingLog;
    const body: Record<string, unknown> = { log_date: entry.log_date };
    if (!editing) body.device_id = String(device.device_id);
    let any = false;
    for (const field of fieldsFor(device.device_type)) {
      const raw = entry[field.key].trim();
      if (raw === "") { if (editing) body[field.key] = null; continue; }
      const n = Number(raw);
      if (!Number.isFinite(n)) { setEntryError(`${field.label} must be a number`); return; }
      body[field.key] = n; any = true;
    }
    if (!any) { setEntryError("Enter at least one reading"); return; }
    if (entry.notes.trim() || editing) body.notes = entry.notes.trim();

    setBusy(true);
    try {
      const r = editingLog
        ? await updateLog(String(editingLog.log_id), body)
        : await addLog(body);
      setMessage(r.message || (editing ? "Entry updated" : "Entry added"));
      setEntryOpen(false); setEditingLog(null); setEntry(emptyEntry());
    } catch (e) { setEntryError((e as Error).message); setBusy(false); return; }   // e.g. a night that already has an entry
    await reload("Saved");
    setBusy(false);
  }

  async function removeLog(l: Log) {
    if (!window.confirm(`Delete the entry for ${l.log_date}? This can't be undone.`)) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const r = await deleteLog(String(l.log_id));
      setMessage(r.message || "Entry removed");
      if (editingLog && String(editingLog.log_id) === String(l.log_id)) { setEntryOpen(false); setEditingLog(null); }
    } catch (e) { setError((e as Error).message); setBusy(false); return; }
    await reload("Removed");
    setBusy(false);
  }

  // ---- views ----
  const dueCount = (id: string | number) => (summary?.supplies_due || []).filter((s) => String(s.device_id) === String(id)).length;

  function summaryCards(d: Device) {
    if (!summary) return null;
    if (isPap(d.device_type) && summary.pap) {
      const p = summary.pap;
      return (
        <section aria-labelledby="resp-summary" className="resp-summary">
          <h3 id="resp-summary">Last 30 days</h3>
          <div className="resp-cards">
            <div className="med-card">
              <h4 className="resp-card-title">Mask use</h4>
              <p className="resp-big">{p.nights_ok}/{p.days}</p>
              <p>nights with 4 or more hours of use ({p.percent}%)</p>
              <p><strong>{p.compliant ? "Compliant: " : "Not yet compliant: "}</strong>
                {p.compliant
                  ? "you reached 21 or more good nights out of 30."
                  : `you need ${p.nights_needed} more good ${p.nights_needed === 1 ? "night" : "nights"} to reach 21 out of 30.`}
              </p>
              <p className="form-hint">Average use: {num(p.avg_hours, " hours")} on {p.nights_logged} {p.nights_logged === 1 ? "night" : "nights"} with an entry. Counts all your pressure machines.</p>
            </div>
            <div className={`med-card ${p.ahi_high ? "resp-flag" : ""}`}>
              <h4 className="resp-card-title">Breathing events (AHI)</h4>
              <p className="resp-big">{num(p.avg_ahi)}</p>
              <p>{p.ahi_high
                ? <><span className="resp-tag resp-tag-warn">Flag: high</span> An AHI of 5 or more is worth talking to your care team about.</>
                : p.avg_ahi === null ? "No AHI entries yet." : <><span className="resp-tag resp-tag-ok">OK</span> Below 5.</>}</p>
            </div>
            <div className={`med-card ${p.leak_high ? "resp-flag" : ""}`}>
              <h4 className="resp-card-title">Mask leak</h4>
              <p className="resp-big">{p.avg_leak === null ? "none yet" : `${p.avg_leak} L/min`}</p>
              <p>{p.leak_high
                ? <><span className="resp-tag resp-tag-warn">Flag: high</span> A leak over 24 L/min may mean the mask needs a refit or a new cushion.</>
                : p.avg_leak === null ? "No leak entries yet." : <><span className="resp-tag resp-tag-ok">OK</span> 24 L/min or less.</>}</p>
            </div>
          </div>
        </section>
      );
    }
    if (isOxygen(d.device_type) && summary.oxygen) {
      const o = summary.oxygen;
      return (
        <section aria-labelledby="resp-summary" className="resp-summary">
          <h3 id="resp-summary">Last 30 days</h3>
          <div className="resp-cards">
            <div className="med-card">
              <h4 className="resp-card-title">Oxygen use</h4>
              <p className="resp-big">{num(o.avg_hours, " h")}</p>
              <p>average hours a day, over {o.days_logged} {o.days_logged === 1 ? "day" : "days"} with an entry</p>
              <p className="form-hint">Average flow: {num(o.avg_flow_lpm, " L/min")}</p>
            </div>
            <div className="med-card">
              <h4 className="resp-card-title">Oxygen level</h4>
              <p className="resp-big">{o.avg_spo2 === null ? "none yet" : `${o.avg_spo2}%`}</p>
              <p>average SpO2</p>
            </div>
            <div className={`med-card ${o.days_below_88 > 0 ? "resp-flag" : ""}`}>
              <h4 className="resp-card-title">Days below 88%</h4>
              <p className="resp-big">{o.days_below_88}</p>
              <p>{o.days_below_88 > 0
                ? <><span className="resp-tag resp-tag-warn">Flag</span> Your lowest level dropped under 88% on these days. Tell your care team.</>
                : <><span className="resp-tag resp-tag-ok">OK</span> No low readings logged.</>}</p>
            </div>
          </div>
        </section>
      );
    }
    if (isPeak(d.device_type) && summary.peak_flow) {
      const pf = summary.peak_flow;
      return (
        <section aria-labelledby="resp-summary" className="resp-summary">
          <h3 id="resp-summary">Peak flow</h3>
          <div className={`med-card ${pf.zone ? `resp-zone-card resp-zone-${pf.zone}` : ""}`}>
            {pf.zone ? (
              <>
                <p><span className={`resp-tag resp-zone-tag resp-zone-${pf.zone}`}>{zoneName[pf.zone]}</span></p>
                <p className="resp-big">{pf.latest} L/min</p>
                <p>{pf.percent_of_best}% of your best of {pf.personal_best} L/min (latest reading, {pf.latest_date})</p>
                {pf.advice && <p>{pf.advice}</p>}
              </>
            ) : (
              <p>{pf.latest === null
                ? "No peak flow reading in the last 30 days."
                : "Enter your personal best on the device so your zone can be worked out."}</p>
            )}
          </div>
        </section>
      );
    }
    return null;
  }

  const fields = device ? fieldsFor(device.device_type) : [];
  const settings = settingsFor(deviceForm.device_type);

  return (
    <>
      <NavigationBar />
      <main className="page-container">
        <section className="page-heading">
          <h2>Breathing Devices</h2>
          <p>Keep track of your CPAP, oxygen, nebulizer or peak flow meter: nightly use, readings and when to replace parts.</p>
        </section>

        {error && <p className="notice error" role="alert">{error}</p>}
        {message && !error && <p className="notice success" role="status">{message}</p>}

        {loading ? <p role="status">Loading…</p> : (
          <>
            <div className="med-toolbar">
              <h3>Your devices</h3>
              <button className="primary-button" type="button" disabled={busy} onClick={() => (deviceMode === "add" ? closeForms() : openAdd())}>
                {deviceMode === "add" ? "Cancel" : "Add a device"}
              </button>
            </div>

            {deviceMode !== "" && (
              <form id="device-form" className="med-add" onSubmit={submitDevice} noValidate>
                <h3>{deviceMode === "edit" ? "Edit device" : "Add a device"}</h3>
                {deviceError && <p className="notice error" role="alert">{deviceError}</p>}
                <div className="med-add-grid">
                  <label>Type *
                    <select value={deviceForm.device_type} onChange={setD("device_type")} disabled={deviceMode === "edit"}>
                      {DEVICE_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                    </select>
                  </label>
                  <label>Name
                    <input value={deviceForm.name} onChange={setD("name")} maxLength={100} placeholder={typeLabel(deviceForm.device_type)} />
                  </label>
                  <label>Serial number (last 4 to 6 characters)
                    <input value={deviceForm.serial} onChange={setD("serial")} maxLength={40} autoComplete="off"
                      placeholder={deviceMode === "edit" && device?.serial_last4 ? `Saved: ending ${device.serial_last4}` : ""} />
                  </label>
                  {isPap(deviceForm.device_type) && (
                    <label>Mask type
                      <select value={deviceForm.mask_type} onChange={setD("mask_type")}>
                        <option value="">Not sure</option>
                        {MASK_TYPES.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
                      </select>
                    </label>
                  )}
                  {settings.map((k) => (
                    <label key={k}>{NUMBER_LABEL[k]}
                      <input type="number" inputMode="decimal" step={k === "flow_lpm" ? "0.25" : k === "personal_best" ? "1" : "0.5"}
                        value={deviceForm[k]} onChange={setD(k)} />
                    </label>
                  ))}
                  <label>Start date
                    <input type="date" value={deviceForm.start_date} max={localDate()} onChange={setD("start_date")} />
                  </label>
                  {deviceMode === "edit" && (
                    <label className="link-fav">
                      <input type="checkbox" checked={deviceForm.is_active}
                        onChange={(e) => setDeviceForm((f) => ({ ...f, is_active: e.target.checked }))} />
                      In use now
                    </label>
                  )}
                  <label className="med-wide">Notes (optional)
                    <textarea rows={2} value={deviceForm.notes} onChange={setD("notes")} maxLength={500} />
                  </label>
                </div>
                {deviceMode === "add" && <p className="form-hint">A starting schedule for replacing parts is added with the device.</p>}
                <button className="primary-button" type="submit" disabled={busy}>{busy ? "Saving…" : "Save device"}</button>
                <button className="secondary-button" type="button" disabled={busy} onClick={closeForms}>Cancel</button>
              </form>
            )}

            {devices.length === 0 ? (
              <p>No devices yet. Use "Add a device" to set up your first one.</p>
            ) : (
              <>
                <div className="tab-bar" role="tablist" aria-label="Your devices">
                  {devices.map((d) => {
                    const id = String(d.device_id);
                    const due = dueCount(id);
                    return (
                      <button key={id} type="button" role="tab" id={`resp-tab-${id}`} aria-controls="resp-panel"
                        aria-selected={id === selectedId} className={id === selectedId ? "tab active" : "tab"}
                        onClick={() => chooseDevice(id)}>
                        {d.name}{!d.is_active && " (not in use)"}{due > 0 && ` (${due} to replace)`}
                      </button>
                    );
                  })}
                </div>

                {device && (
                  <div id="resp-panel" role="tabpanel" aria-labelledby={`resp-tab-${selectedId}`}>
                    <div className="med-card resp-device">
                      <div className="med-main">
                        <div>
                          <h3>{device.name}</h3>
                          <p>
                            {typeLabel(device.device_type)}
                            {device.mask_type && <> · {maskLabel(device.mask_type)} mask</>}
                            {device.serial_last4 && <> · serial ending {device.serial_last4}</>}
                            {device.start_date && <> · since {device.start_date}</>}
                          </p>
                          <p>
                            {device.pressure_min != null && device.pressure_max != null && <>Pressure {device.pressure_min} to {device.pressure_max} cm H2O. </>}
                            {device.epap != null && <>EPAP {device.epap}. </>}
                            {device.ipap != null && <>IPAP {device.ipap}. </>}
                            {device.flow_lpm != null && <>Oxygen flow {device.flow_lpm} L/min. </>}
                            {device.personal_best != null && <>Personal best {device.personal_best} L/min.</>}
                          </p>
                          {device.notes && <p className="form-hint">{device.notes}</p>}
                        </div>
                      </div>
                      <div className="med-actions">
                        <button className="secondary-button" type="button" disabled={busy} onClick={openEdit}>Edit device</button>
                        <button className="text-button med-link danger" type="button" disabled={busy} onClick={removeDevice}>Remove device</button>
                      </div>
                    </div>

                    {summaryFailed
                      ? <p className="notice error" role="alert">The 30-day summary could not be loaded right now. Your parts and entries below are still shown.</p>
                      : summaryCards(device)}

                    <section aria-labelledby="resp-parts" className="resp-section">
                      <h3 id="resp-parts">Parts to replace</h3>
                      {detailLoading ? <p role="status">Loading…</p> : supplies.length === 0 ? (
                        <p>No parts to track for this device.</p>
                      ) : (
                        <ul className="resp-parts">
                          {supplies.map((s) => (
                            <li key={String(s.supply_id)} className={`resp-part resp-due-${s.due_status}`}>
                              <div>
                                <strong>{s.part_name}</strong>{" "}
                                <span className={`resp-tag resp-due-tag resp-due-${s.due_status}`}>{dueLabel[s.due_status]}</span>
                                <br />
                                <span>{dueText(s)}</span>
                                <br />
                                <small>Every {s.interval_days} days{s.last_replaced && <> · last replaced {s.last_replaced}</>}</small>
                              </div>
                              <button className="secondary-button" type="button" disabled={busy} onClick={() => replacedToday(s)}>
                                Replaced today<span className="sr-only">: {s.part_name}</span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>

                    <section aria-labelledby="resp-entries" className="resp-section">
                      <div className="med-toolbar">
                        <h3 id="resp-entries">Recent entries</h3>
                        <button className="primary-button" type="button" disabled={busy}
                          onClick={() => (entryOpen && !editingLog ? closeForms() : openEntry(null))}>
                          {entryOpen && !editingLog ? "Cancel" : "Add an entry"}
                        </button>
                      </div>

                      {entryOpen && (
                        <form id="entry-form" className="med-add" onSubmit={submitEntry} noValidate>
                          <h3>{editingLog ? `Edit entry for ${editingLog.log_date}` : isPap(device.device_type) ? "Add a night" : "Add an entry"}</h3>
                          {entryError && <p className="notice error" role="alert">{entryError}</p>}
                          <div className="med-add-grid">
                            <label>{isPap(device.device_type) ? "Night of *" : "Date *"}
                              <input type="date" value={entry.log_date} max={localDate()} onChange={setE("log_date")} />
                            </label>
                            {fields.map((f) => (
                              <label key={f.key}>{f.label}
                                <input type="number" inputMode="decimal" step={f.step} min={f.min} max={f.max}
                                  value={entry[f.key]} onChange={setE(f.key)} />
                              </label>
                            ))}
                            <label className="med-wide">Notes (optional)
                              <textarea rows={2} value={entry.notes} onChange={setE("notes")} maxLength={500} />
                            </label>
                          </div>
                          <p className="form-hint">
                            {isPap(device.device_type) ? "One entry per night. Fill in what your machine shows; leave the rest blank." : "Fill in what you measured; leave the rest blank."}
                          </p>
                          <button className="primary-button" type="submit" disabled={busy}>{busy ? "Saving…" : editingLog ? "Save changes" : "Save entry"}</button>
                          <button className="secondary-button" type="button" disabled={busy} onClick={closeForms}>Cancel</button>
                        </form>
                      )}

                      {detailLoading ? <p role="status">Loading…</p> : logs.length === 0 ? (
                        <p>No entries yet.</p>
                      ) : (
                        <div className="table-scroll">
                          <table className="access-log">
                            <thead>
                              <tr>
                                <th>Date</th>
                                {fields.map((f) => <th key={f.key}>{f.short}</th>)}
                                <th>Notes</th>
                                <th><span className="sr-only">Actions</span></th>
                              </tr>
                            </thead>
                            <tbody>
                              {logs.map((l) => (
                                <tr key={String(l.log_id)}>
                                  <td>{l.log_date}</td>
                                  {fields.map((f) => <td key={f.key}>{l[f.key] === null || l[f.key] === undefined ? "–" : l[f.key]}</td>)}
                                  <td>{l.notes || ""}</td>
                                  <td>
                                    <button className="text-button med-link" type="button" disabled={busy} onClick={() => openEntry(l)}>Edit</button>
                                    <button className="text-button med-link danger" type="button" disabled={busy} onClick={() => removeLog(l)}>Delete</button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </section>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </main>
    </>
  );
}

export default Respiratory;
