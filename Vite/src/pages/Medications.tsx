import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import AlertBanner from "../components/AlertBanner";
import NavigationBar from "../components/NavigationBar";
import { api, localDate } from "../api";

// Medication inventory: what the patient takes and how many pills they have.
//   "Took dose"  -> POST /api/medications/:id/doses   (subtracts the dose from the count)
//   "Add refill" -> POST /api/medications/:id/refills (adds to the count)
// The server does the counting, low-stock check and run-out estimate.
// Safety: GET /api/safety/alerts checks every medication against the allergies on the
// Health History form and against each other; POST /api/safety/check runs the same check
// on a new medication before it is saved.

type Med = {
  medication_id: number; medication_name: string; brand_name: string | null;
  medication_type: "prescription" | "non_prescription";
  strength: string | null; strength_unit: string | null; dosage_form: string | null;
  dose_amount: string; dose_unit: string; frequency: string;
  instructions: string | null; purpose: string | null; pharmacy_name: string | null;
  status: "active" | "paused" | "completed" | "discontinued";
  quantity_on_hand: string; refill_threshold: string | null; refills_remaining: number | null;
  last_refill_date: string | null;
  days_supply: number | null; estimated_run_out_date: string | null; low_stock: boolean;
};
type Dose = { dose_log_id: number; taken_at: string; dose_status: string; quantity: string };
type Refill = { refill_id: number; refill_date: string; quantity_added: string; pharmacy_name: string | null };
type SafetyWarning = {
  alert_type: "allergy" | "cross_reactivity" | "interaction" | "duplicate_therapy";
  severity: "major" | "moderate" | "minor"; title: string; message: string; advice: string;
};
type SafetyAlert = SafetyWarning & { alert_id: number; acknowledged_at: string | null; acknowledged_note: string | null };
const SEVERITY_LABEL = { major: "Serious", moderate: "Caution", minor: "Low risk" } as const;
const TYPE_LABEL = { allergy: "Allergy", cross_reactivity: "Possible allergy", interaction: "Interaction", duplicate_therapy: "Doubling up" } as const;

function WarningBox({ w, children }: { w: SafetyWarning; children?: React.ReactNode }) {
  return (
    <div className={`safety-alert ${w.severity}`}>
      <p className="safety-tags">
        <span className={`safety-sev ${w.severity}`}><span aria-hidden="true">{w.severity === "major" ? "⚠" : "!"}</span> {SEVERITY_LABEL[w.severity]}</span>
        <span className="safety-type">{TYPE_LABEL[w.alert_type]}</span>
      </p>
      <h4>{w.title}</h4>
      <p>{w.message}</p>
      <p className="safety-advice">{w.advice}</p>
      {children}
    </div>
  );
}
type Summary = { active_count: number; needs_refill: { medication_id: number }[]; overall_adherence_7_day_pct: number | null };

const FREQUENCIES: [string, string][] = [
  ["once_daily", "Once a day"], ["twice_daily", "Twice a day"], ["three_times_daily", "3 times a day"],
  ["four_times_daily", "4 times a day"], ["every_other_day", "Every other day"], ["weekly", "Once a week"],
  ["as_needed", "As needed"], ["other", "Other"],
];
const FORMS = ["tablet", "capsule", "liquid", "injection", "inhaler", "patch", "cream", "drops", "spray", "powder", "other"];
const ALWAYS = "Don't stop or change a medicine on your own.";
const freqLabel = (f: string) => FREQUENCIES.find(([k]) => k === f)?.[1] ?? f;
const n = (v: string | number | null | undefined) => (v == null || v === "" ? "" : String(Number(v)));
const plural = (count: string, unit: string) => `${n(count)} ${unit}${Number(count) === 1 ? "" : "s"}`;

const emptyNew = {
  medication_type: "prescription" as "prescription" | "non_prescription",
  medication_name: "", strength: "", strength_unit: "mg", dosage_form: "tablet",
  dose_amount: "1", dose_unit: "tablet", frequency: "once_daily",
  quantity_on_hand: "", refill_threshold: "7", refills_remaining: "", pharmacy_name: "",
  purpose: "", instructions: "", start_date: localDate(),
};

function Medications() {
  const navigate = useNavigate();
  // From the Health History form: /medications?add=prescription|non_prescription&from=records
  // opens the add form with that type, and goes back to the form after saving.
  const [params] = useSearchParams();
  const startType = params.get("add") === "non_prescription" ? "non_prescription" : "prescription";
  const fromRecords = params.get("from") === "records";
  const [meds, setMeds] = useState<Med[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [show, setShow] = useState<"active" | "all">("active");
  const [adding, setAdding] = useState(params.has("add"));
  const [draft, setDraft] = useState({ ...emptyNew, medication_type: startType });
  const [refillFor, setRefillFor] = useState<number | null>(null);
  const [refillQty, setRefillQty] = useState("");
  const [historyFor, setHistoryFor] = useState<number | null>(null);
  const [history, setHistory] = useState<{ doses: Dose[]; refills: Refill[] }>({ doses: [], refills: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [alerts, setAlerts] = useState<SafetyAlert[]>([]);
  const [showAcked, setShowAcked] = useState(false);
  const [checkWarnings, setCheckWarnings] = useState<SafetyWarning[] | null>(null);

  // safety warnings are extra: if that module isn't installed, the page still works
  const loadAlerts = () => api<{ alerts: SafetyAlert[] }>("/safety/alerts").then((r) => r.alerts).catch(() => [] as SafetyAlert[]);

  async function load() {
    const [list, sum, al] = await Promise.all([
      api<{ medications: Med[] }>("/medications"),
      api<Summary>("/medications/summary"),
      loadAlerts(),
    ]);
    setMeds(list.medications); setSummary(sum); setAlerts(al);
  }

  useEffect(() => {
    Promise.all([api<{ medications: Med[] }>("/medications"), api<Summary>("/medications/summary"), loadAlerts()])
      .then(([list, sum, al]) => { setMeds(list.medications); setSummary(sum); setAlerts(al); })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  // run an action, show its result, reload the list
  async function act(work: () => Promise<string | void>) {
    setBusy(true); setError(""); setMessage("");
    try {
      const msg = await work();
      await load();
      if (msg) setMessage(msg);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  function addMedication(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.medication_name.trim()) { setError("Enter the medication name."); return; }
    if (draft.quantity_on_hand === "" || Number(draft.quantity_on_hand) < 0) { setError("Enter how many you have on hand (0 or more)."); return; }
    const body: Record<string, unknown> = {
      medication_name: draft.medication_name.trim(), medication_type: draft.medication_type, dosage_form: draft.dosage_form,
      dose_amount: Number(draft.dose_amount), dose_unit: draft.dose_unit.trim() || draft.dosage_form,
      frequency: draft.frequency, quantity_on_hand: Number(draft.quantity_on_hand), start_date: draft.start_date,
    };
    if (draft.strength) { body.strength = Number(draft.strength); body.strength_unit = draft.strength_unit; }
    if (draft.refill_threshold !== "") body.refill_threshold = Number(draft.refill_threshold);
    if (draft.refills_remaining !== "" && draft.medication_type === "prescription") body.refills_remaining = Number(draft.refills_remaining);
    for (const k of ["pharmacy_name", "purpose", "instructions"] as const) if (draft[k].trim()) body[k] = draft[k].trim();
    act(async () => {
      // First save: check it against allergies and current medications. If anything is
      // flagged, show it and let the patient choose "Add anyway" (the second submit).
      if (checkWarnings === null) {
        const check = await api<{ warnings: SafetyWarning[] }>("/safety/check", {
          method: "POST", body: JSON.stringify({ medication_name: body.medication_name }),
        }).catch(() => ({ warnings: [] as SafetyWarning[] }));
        if (check.warnings.length) { setCheckWarnings(check.warnings); return; }
      }
      await api("/medications", { method: "POST", body: JSON.stringify(body) });
      if (fromRecords) {
        navigate("/medical-records", { state: { addedMedication: body.medication_name } });
        return;
      }
      setDraft(emptyNew); setAdding(false); setCheckWarnings(null);
      return `${body.medication_name} added.`;
    });
  }

  const acknowledge = (a: SafetyAlert, acknowledged: boolean) => act(async () => {
    await api(`/safety/alerts/${a.alert_id}/acknowledge`, { method: "POST", body: JSON.stringify({ acknowledged }) });
  });

  const logDose = (m: Med, status: "taken" | "skipped") => act(async () => {
    const r = await api<{ inventory_warning?: string; medication: Med }>(`/medications/${m.medication_id}/doses`, {
      method: "POST", body: JSON.stringify({ dose_status: status }),
    });
    if (historyFor === m.medication_id) await openHistory(m.medication_id, true);
    if (r.inventory_warning) return r.inventory_warning;
    return status === "taken"
      ? `Logged a dose of ${m.medication_name}. ${plural(r.medication.quantity_on_hand, m.dose_unit)} left.`
      : `Marked a skipped dose of ${m.medication_name}.`;
  });

  function addRefill(event: React.FormEvent<HTMLFormElement>, m: Med) {
    event.preventDefault();
    const qty = Number(refillQty);
    if (!(qty > 0)) { setError("Enter how many you picked up."); return; }
    act(async () => {
      const r = await api<{ refill_warning?: string; medication: Med }>(`/medications/${m.medication_id}/refills`, {
        method: "POST", body: JSON.stringify({ quantity_added: qty }),
      });
      setRefillFor(null); setRefillQty("");
      if (historyFor === m.medication_id) await openHistory(m.medication_id, true);
      return `Added ${plural(String(qty), m.dose_unit)}. Now ${plural(r.medication.quantity_on_hand, m.dose_unit)} on hand.`
        + (r.refill_warning ? ` ${r.refill_warning}` : "");
    });
  }

  const setStatus = (m: Med, status: Med["status"]) => act(async () => {
    await api(`/medications/${m.medication_id}`, { method: "PUT", body: JSON.stringify({ status }) });
    return `${m.medication_name} is now ${status}.`;
  });

  const remove = (m: Med) => {
    if (!window.confirm(`Delete ${m.medication_name} and its dose history?`)) return;
    act(async () => {
      await api(`/medications/${m.medication_id}`, { method: "DELETE" });
      return `${m.medication_name} deleted.`;
    });
  };

  async function openHistory(id: number, keepOpen = false) {
    if (historyFor === id && !keepOpen) { setHistoryFor(null); return; }
    const r = await api<{ recent_doses: Dose[]; refills: Refill[] }>(`/medications/${id}`);
    setHistory({ doses: r.recent_doses, refills: r.refills });
    setHistoryFor(id);
  }

  const shown = show === "active" ? meds.filter((m) => m.status === "active" || m.status === "paused") : meds;
  const set = (k: keyof typeof emptyNew) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    if (k === "medication_name") setCheckWarnings(null);   // a different medicine needs a new check
    setDraft((d) => ({ ...d, [k]: e.target.value }));
  };
  const openAlerts = alerts.filter((a) => !a.acknowledged_at);
  const ackedAlerts = alerts.filter((a) => a.acknowledged_at);

  return (
    <>
      <NavigationBar />
      <main className="page-container">
        <AlertBanner message="Log each dose when you take it and each refill when you pick it up, and your pill count stays accurate." type="info" />

        <section className="page-heading">
          <h2>Medications</h2>
          <p>Track what you take, how many you have left, and when to refill.</p>
        </section>

        {summary && (
          <div className="med-stats">
            <div className="med-stat"><strong>{summary.active_count}</strong><span>Active medications</span></div>
            <div className={`med-stat ${summary.needs_refill.length ? "warn" : ""}`}>
              <strong>{summary.needs_refill.length}</strong><span>Need a refill soon</span>
            </div>
            <div className="med-stat">
              <strong>{summary.overall_adherence_7_day_pct == null ? "—" : `${summary.overall_adherence_7_day_pct}%`}</strong>
              <span>Doses taken (last 7 days)</span>
            </div>
          </div>
        )}

        {error && <p className="notice error" role="alert">{error}</p>}
        {message && !error && <p className="notice success" role="status">{message}</p>}

        {alerts.length > 0 && (
          <section className="safety-panel" aria-labelledby="safety-heading">
            <h3 id="safety-heading">Safety warnings {openAlerts.length > 0 && <span className="safety-count">{openAlerts.length}</span>}</h3>
            <p className="form-hint">Checked against the allergies on your Health History form and your other medicines (common drugs only). {ALWAYS}</p>
            {openAlerts.length === 0 && <p>You've reviewed every warning.</p>}
            {openAlerts.map((a) => (
              <WarningBox key={a.alert_id} w={a}>
                <button type="button" className="secondary-button" disabled={busy} onClick={() => acknowledge(a, true)}>
                  I've talked to my doctor or pharmacist about this
                </button>
              </WarningBox>
            ))}
            {ackedAlerts.length > 0 && (
              <button type="button" className="text-button med-link" onClick={() => setShowAcked((v) => !v)}>
                {showAcked ? "Hide" : "Show"} {ackedAlerts.length} reviewed warning{ackedAlerts.length === 1 ? "" : "s"}
              </button>
            )}
            {showAcked && ackedAlerts.map((a) => (
              <WarningBox key={a.alert_id} w={a}>
                <p className="shared-sub">Reviewed {new Date(a.acknowledged_at!).toLocaleDateString()}{a.acknowledged_note && ` · ${a.acknowledged_note}`}</p>
                <button type="button" className="text-button med-link" disabled={busy} onClick={() => acknowledge(a, false)}>Mark as not reviewed</button>
              </WarningBox>
            ))}
          </section>
        )}

        <div className="med-toolbar">
          <div className="med-toolbar-left">
            {fromRecords && (
              <button className="secondary-button" type="button" onClick={() => navigate("/medical-records")}>← Back to Medical Records</button>
            )}
            <button className="primary-button" type="button" onClick={() => { setAdding((a) => !a); setCheckWarnings(null); }}>
              {adding ? "Cancel" : "+ Add Medication"}
            </button>
          </div>
          <label className="med-filter">Show
            <select value={show} onChange={(e) => setShow(e.target.value as "active" | "all")}>
              <option value="active">Current</option>
              <option value="all">All (including stopped)</option>
            </select>
          </label>
        </div>

        {adding && (
          <form className="med-add" onSubmit={addMedication} noValidate>
            <h3>Add a medication</h3>
            <div className="med-type" role="radiogroup" aria-label="Type of medication">
              {([["prescription", "Prescription", "prescribed by a doctor"], ["non_prescription", "Non-prescription", "over-the-counter, vitamin or supplement"]] as const).map(([v, label, hint]) => (
                <label key={v} className={`med-type-option ${draft.medication_type === v ? "on" : ""}`}>
                  <input type="radio" name="med-type" checked={draft.medication_type === v}
                    onChange={() => setDraft((d) => ({ ...d, medication_type: v }))} />
                  <span><strong>{label}</strong><small>{hint}</small></span>
                </label>
              ))}
            </div>
            <div className="med-add-grid">
              <label>Medication name *<input value={draft.medication_name} onChange={set("medication_name")} placeholder="e.g. Metformin" /></label>
              <label>Strength<span className="med-pair">
                <input inputMode="decimal" value={draft.strength} onChange={set("strength")} placeholder="500" />
                <select value={draft.strength_unit} onChange={set("strength_unit")} aria-label="Strength unit">
                  {["mg", "mcg", "g", "mL", "units", "%"].map((u) => <option key={u}>{u}</option>)}
                </select></span></label>
              <label>Form<select value={draft.dosage_form} onChange={(e) => setDraft((d) => ({ ...d, dosage_form: e.target.value, dose_unit: e.target.value === "liquid" ? "mL" : e.target.value }))}>
                {FORMS.map((f) => <option key={f}>{f}</option>)}</select></label>
              <label>Each dose<span className="med-pair">
                <input inputMode="decimal" value={draft.dose_amount} onChange={set("dose_amount")} />
                <input value={draft.dose_unit} onChange={set("dose_unit")} aria-label="Dose unit" /></span></label>
              <label>How often<select value={draft.frequency} onChange={set("frequency")}>
                {FREQUENCIES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
              <label>How many you have now *<input inputMode="decimal" value={draft.quantity_on_hand} onChange={set("quantity_on_hand")} placeholder="e.g. 60" /></label>
              <label>Warn me when down to<input inputMode="decimal" value={draft.refill_threshold} onChange={set("refill_threshold")} /></label>
              {draft.medication_type === "prescription" && (
                <label>Refills left on prescription<input inputMode="numeric" value={draft.refills_remaining} onChange={set("refills_remaining")} /></label>
              )}
              <label>Pharmacy<input value={draft.pharmacy_name} onChange={set("pharmacy_name")} /></label>
              <label>What it's for<input value={draft.purpose} onChange={set("purpose")} /></label>
              <label className="med-wide">Instructions<input value={draft.instructions} onChange={set("instructions")} placeholder="e.g. take with food" /></label>
              <label>Started<input type="date" value={draft.start_date} onChange={set("start_date")} /></label>
            </div>
            {checkWarnings && (
              <div className="safety-check" role="alert">
                <h4>Before you add {draft.medication_name.trim()}</h4>
                {checkWarnings.map((w, i) => <WarningBox key={i} w={w} />)}
              </div>
            )}
            <button className="primary-button" type="submit" disabled={busy}>
              {busy ? "Saving…" : checkWarnings ? "Add anyway" : "Save Medication"}
            </button>
            {checkWarnings && (
              <button className="secondary-button" type="button" onClick={() => { if (fromRecords) { navigate("/medical-records"); return; } setAdding(false); setCheckWarnings(null); setDraft(emptyNew); }}>
                Don't add it
              </button>
            )}
          </form>
        )}

        {loading ? <p role="status">Loading medications…</p> : shown.length === 0 ? (
          <p>No medications yet. Click "+ Add Medication" to start tracking.</p>
        ) : (
          <div className="med-list">
            {shown.map((m) => {
              const active = m.status === "active";
              const stopped = m.status === "completed" || m.status === "discontinued";
              return (
                <article key={m.medication_id} className={`med-card ${m.low_stock ? "low" : ""} ${!active ? "inactive" : ""}`}>
                  <div className="med-main">
                    <div>
                      <h3>{m.medication_name}{m.strength && <span className="med-strength"> {n(m.strength)} {m.strength_unit}</span>}</h3>
                      <p>{plural(m.dose_amount, m.dose_unit)} · {freqLabel(m.frequency)}{m.purpose && <> · for {m.purpose}</>}</p>
                      {m.instructions && <p className="shared-sub">{m.instructions}</p>}
                      <span className="med-badge type">{m.medication_type === "non_prescription" ? "Non-prescription" : "Prescription"}</span>
                      {!active && <span className={`med-badge ${m.status}`}>{m.status}</span>}
                      {m.low_stock && <span className="med-badge low">Low — refill soon</span>}
                    </div>
                    <div className="med-count" aria-label={`${n(m.quantity_on_hand)} on hand`}>
                      <strong>{n(m.quantity_on_hand)}</strong>
                      <span>{m.dose_unit}s left</span>
                      {m.days_supply != null && <small>~{m.days_supply} day{m.days_supply === 1 ? "" : "s"}{m.estimated_run_out_date && ` · runs out ${m.estimated_run_out_date}`}</small>}
                      {m.refills_remaining != null && <small>{m.refills_remaining} refill{m.refills_remaining === 1 ? "" : "s"} left</small>}
                    </div>
                  </div>

                  {!stopped && (
                    <div className="med-actions">
                      <button className="primary-button" type="button" disabled={busy || !active} onClick={() => logDose(m, "taken")}>
                        Took dose (−{n(m.dose_amount)})
                      </button>
                      <button className="secondary-button" type="button" disabled={busy || !active} onClick={() => logDose(m, "skipped")}>Skipped</button>
                      <button className="secondary-button" type="button" disabled={busy}
                        onClick={() => { setRefillFor(refillFor === m.medication_id ? null : m.medication_id); setRefillQty(""); }}>
                        Add refill (+)
                      </button>
                      <button className="text-button med-link" type="button" onClick={() => openHistory(m.medication_id)}>
                        {historyFor === m.medication_id ? "Hide history" : "History"}
                      </button>
                    </div>
                  )}

                  {refillFor === m.medication_id && (
                    <form className="med-refill" onSubmit={(e) => addRefill(e, m)}>
                      <label>How many did you pick up?
                        <input inputMode="decimal" autoFocus value={refillQty} onChange={(e) => setRefillQty(e.target.value)} placeholder="e.g. 30" />
                      </label>
                      <button className="primary-button" type="submit" disabled={busy}>Add to count</button>
                    </form>
                  )}

                  {historyFor === m.medication_id && (
                    <div className="med-history">
                      <div>
                        <h4>Recent doses</h4>
                        {history.doses.length === 0 ? <p>None logged yet.</p> : (
                          <ul>{history.doses.map((d) => (
                            <li key={d.dose_log_id}>{new Date(d.taken_at).toLocaleString()} · {d.dose_status}{d.dose_status === "taken" && ` (−${n(d.quantity)})`}</li>
                          ))}</ul>
                        )}
                      </div>
                      <div>
                        <h4>Refills</h4>
                        {history.refills.length === 0 ? <p>None recorded yet.</p> : (
                          <ul>{history.refills.map((r) => (
                            <li key={r.refill_id}>{r.refill_date} · +{n(r.quantity_added)}{r.pharmacy_name && ` · ${r.pharmacy_name}`}</li>
                          ))}</ul>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="med-manage">
                    {m.status === "active" && <button className="text-button med-link" type="button" disabled={busy} onClick={() => setStatus(m, "paused")}>Pause</button>}
                    {m.status === "paused" && <button className="text-button med-link" type="button" disabled={busy} onClick={() => setStatus(m, "active")}>Resume</button>}
                    {!stopped && <button className="text-button med-link" type="button" disabled={busy} onClick={() => setStatus(m, "discontinued")}>Stop taking</button>}
                    {stopped && <button className="text-button med-link" type="button" disabled={busy} onClick={() => setStatus(m, "active")}>Start again</button>}
                    {stopped && Number(m.quantity_on_hand) > 0 && <Link className="text-button med-link" to={`/disposal?med=${m.medication_id}`}>How to dispose of leftovers</Link>}
                    <button className="text-button med-link danger" type="button" disabled={busy} onClick={() => remove(m)}>Delete</button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </main>
    </>
  );
}

export default Medications;
