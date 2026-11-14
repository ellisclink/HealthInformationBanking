import { useCallback, useEffect, useRef, useState } from "react";
import NavigationBar from "../components/NavigationBar";
import { api, localDate } from "../api";
import type { VitalType } from "../api";
import {
  listConditions, getConditionDetail, addCondition, updateCondition, deleteCondition, addNote as saveNote, setTarget, setByText,
  type Condition, type Note, type Target, type Summary, type ConditionInput, type TargetInput,
} from "../data/conditions";

// Conditions: the patient's health conditions, with notes and vital-sign targets for each.
// Condition, ConditionNote and ConditionTarget are read and saved with the Parse SDK (data/conditions.ts); the summary
// (counts, active conditions with their own note count and last note date) is worked out on the page from that list.
//   GET  /vitals/types               -> the vital types a target can be set for (reference data, still a server route)
// Everything from the server is shown as plain text.

const CATEGORIES = ["chronic", "acute", "allergy", "mental_health", "injury", "surgical", "other"] as const;
const STATUSES = ["active", "managed", "in_remission", "resolved", "inactive"] as const;
const SEVERITIES = ["mild", "moderate", "severe"] as const;
const NOTE_TYPES = ["general", "symptom_change", "treatment_change", "provider_visit", "flare_up", "improvement"] as const;

type Detail = { notes: Note[]; targets: Target[] };

type FormState = {
  name: string; icd10: string; category: string; status: string; severity: string;
  onset: string; diagnosed: string; resolved: string; diagnosing: string; managing: string;
  facility: string; primary: boolean; notes: string;
};
type TargetForm = { vital_type: string; min: string; max: string; secMin: string; secMax: string };

const label = (s: string | null | undefined) => (s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ") : "");
const day = (s: string | null | undefined) => (s ? String(s).slice(0, 10) : "");
const fmtDate = (s: string | null | undefined) => (s ? new Date(`${day(s)}T00:00:00`).toLocaleDateString([], { dateStyle: "medium" }) : "");
const idOf = (v: string) => v;

const emptyForm = (): FormState => ({
  name: "", icd10: "", category: "", status: "active", severity: "",
  onset: "", diagnosed: "", resolved: "", diagnosing: "", managing: "",
  facility: "", primary: false, notes: "",
});
const formFrom = (c: Condition): FormState => ({
  name: c.condition_name, icd10: c.icd10_code ?? "", category: c.category ?? "", status: c.status, severity: c.severity ?? "",
  onset: day(c.onset_date), diagnosed: day(c.diagnosed_date), resolved: day(c.resolved_date),
  diagnosing: c.diagnosing_provider ?? "", managing: c.managing_provider ?? "", facility: c.provider_facility ?? "",
  primary: !!c.is_primary, notes: c.notes ?? "",
});
const emptyTarget = (): TargetForm => ({ vital_type: "", min: "", max: "", secMin: "", secMax: "" });

function range(lo: unknown, hi: unknown) {
  const has = (v: unknown) => v !== null && v !== undefined && v !== "";
  if (has(lo) && has(hi)) return `${lo} to ${hi}`;
  if (has(lo)) return `${lo} or more`;
  if (has(hi)) return `${hi} or less`;
  return "";
}

function Conditions() {
  const [conditions, setConditions] = useState<Condition[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [vitalTypes, setVitalTypes] = useState<VitalType[]>([]);
  const [typesError, setTypesError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [refreshError, setRefreshError] = useState("");   // the change worked but the lists could not reload
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [formError, setFormError] = useState("");

  // the opened condition (one at a time)
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [noteForm, setNoteForm] = useState({ date: localDate(), type: "general", text: "" });
  const [noteError, setNoteError] = useState("");
  const [targetForm, setTargetForm] = useState<TargetForm>(emptyTarget());
  const [targetError, setTargetError] = useState("");
  const openRef = useRef<string | null>(null);   // ignore an older answer when another condition was opened meanwhile

  const loadDetail = useCallback(async (id: string) => {
    const r = await getConditionDetail(id);
    if (openRef.current !== id) return;
    setDetail(r);
  }, []);

  // Will's queryConditions: the Parse queries and the summary now live in data/conditions.ts (listConditions)
  async function queryConditions() {
    const { conditions: list, summary: counts } = await listConditions();
    setConditions(list);
    setSummary(counts);
  }

  useEffect(() => {
    // the vital types are an extra: the list still works without them
    api<{ types: VitalType[] }>("/vitals/types")
      .then((t) => setVitalTypes(t.types))
      .catch((e: Error) => setTypesError(e.message));
    listConditions()
      .then(({ conditions: list, summary: counts }) => { setConditions(list); setSummary(counts); })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const set = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  function scrollToId(id: string) {
    setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }

  function openNew() {
    setEditingId(null); setForm(emptyForm()); setFormOpen(true); setFormError(""); setMessage(""); setError("");
    scrollToId("condition-form");
  }
  function openEdit(c: Condition) {
    setEditingId(idOf(c.condition_id)); setForm(formFrom(c)); setFormOpen(true); setFormError(""); setMessage(""); setError("");
    scrollToId("condition-form");
  }
  function closeForm() { setFormOpen(false); setEditingId(null); setFormError(""); }

  // after a change: reload what is on the page. A failed reload must not look like a failed save.
  async function refreshAfter(done: string) {
    const tasks: Promise<unknown>[] = [queryConditions()];
    if (openRef.current) tasks.push(loadDetail(openRef.current));
    try { await Promise.all(tasks); }
    catch (e) { setRefreshError(`${done}, but the page could not refresh: ${(e as Error).message}`); }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(""); setMessage(""); setRefreshError(""); setFormError("");
    const today = localDate();
    if (!form.name.trim()) { setFormError("Enter the condition's name."); return; }
    if (form.status === "resolved" && !form.resolved) { setFormError("Enter the date the condition was resolved."); return; }
    for (const [d, what] of [[form.onset, "onset"], [form.diagnosed, "diagnosed"], [form.resolved, "resolved"]] as const) {
      if (d && d > today) { setFormError(`The ${what} date can't be in the future.`); return; }
    }
    const orNull = (v: string) => v.trim() || null;
    const body: ConditionInput = {
      condition_name: form.name.trim(), icd10_code: orNull(form.icd10), category: form.category || null,
      status: form.status, severity: form.severity || null,
      onset_date: form.onset || null, diagnosed_date: form.diagnosed || null,
      resolved_date: form.status === "resolved" ? form.resolved || null : null,
      diagnosing_provider: orNull(form.diagnosing), managing_provider: orNull(form.managing),
      provider_facility: orNull(form.facility), is_primary: form.primary, notes: orNull(form.notes),
    };
    setBusy(true);
    const wasEdit = editingId !== null;
    try {
      if (wasEdit) await updateCondition(editingId, body);
      else await addCondition(body);
      closeForm(); setForm(emptyForm());
      setMessage(wasEdit ? "Condition updated" : "Condition added");
    } catch (e) { setFormError((e as Error).message); setBusy(false); return; }
    await refreshAfter("Saved");
    setBusy(false);
  }

  async function removeCondition(c: Condition) {
    if (!window.confirm(`Delete "${c.condition_name}"? Its notes and targets are deleted too. This can't be undone.`)) return;
    setBusy(true); setError(""); setMessage(""); setRefreshError("");
    const id = idOf(c.condition_id);
    try {
      await deleteCondition(id);
      setMessage("Condition deleted");
      if (editingId === id) closeForm();
      if (openRef.current === id) { openRef.current = null; setOpenId(null); setDetail(null); }
    } catch (e) { setError((e as Error).message); setBusy(false); return; }
    await refreshAfter("Deleted");
    setBusy(false);
  }

  async function toggleOpen(c: Condition) {
    const id = idOf(c.condition_id);
    if (openRef.current === id) { openRef.current = null; setOpenId(null); setDetail(null); return; }
    openRef.current = id;
    setOpenId(id); setDetail(null); setDetailError(""); setNoteError(""); setTargetError("");
    setNoteForm({ date: localDate(), type: "general", text: "" }); setTargetForm(emptyTarget());
    setDetailLoading(true);
    try { await loadDetail(id); }
    catch (e) { if (openRef.current === id) setDetailError((e as Error).message); }
    finally { if (openRef.current === id) setDetailLoading(false); }
  }

  async function addNote(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!openId) return;
    setNoteError(""); setMessage(""); setError(""); setRefreshError("");
    if (!noteForm.text.trim()) { setNoteError("Write the note."); return; }
    if (noteForm.date && noteForm.date > localDate()) { setNoteError("The note's date can't be in the future."); return; }
    setBusy(true);
    try {
      await saveNote(openId, { note_date: noteForm.date || localDate(), note_type: noteForm.type, note_text: noteForm.text.trim() });
      setNoteForm({ date: localDate(), type: "general", text: "" });
      setMessage("Note added");
    } catch (e) { setNoteError((e as Error).message); setBusy(false); return; }
    await refreshAfter("Saved");
    setBusy(false);
  }

  const typeInfo = (key: string) => vitalTypes.find((t) => t.vital_type === key);
  const typeName = (key: string) => typeInfo(key)?.display_name ?? label(key);
  const pickedType = typeInfo(targetForm.vital_type);

  async function addTarget(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!openId) return;
    setTargetError(""); setMessage(""); setError(""); setRefreshError("");
    if (!targetForm.vital_type) { setTargetError("Choose the vital sign."); return; }
    const dual = !!pickedType?.is_dual_value;
    const raw: [string, string][] = [["lowest", targetForm.min], ["highest", targetForm.max]];
    if (dual) raw.push(["second lowest", targetForm.secMin], ["second highest", targetForm.secMax]);
    for (const [what, v] of raw) {
      if (v.trim() !== "" && !Number.isFinite(Number(v))) { setTargetError(`The ${what} value must be a number.`); return; }
    }
    const num = (v: string) => (v.trim() === "" ? null : Number(v));
    const min = num(targetForm.min), max = num(targetForm.max);
    const sMin = dual ? num(targetForm.secMin) : null, sMax = dual ? num(targetForm.secMax) : null;
    if (min === null && max === null && sMin === null && sMax === null) { setTargetError("Enter at least one limit."); return; }
    if (min !== null && max !== null && min > max) { setTargetError("The lowest value can't be higher than the highest value."); return; }
    if (sMin !== null && sMax !== null && sMin > sMax) { setTargetError("The second lowest value can't be higher than the second highest value."); return; }
    const body: TargetInput = { vital_type: targetForm.vital_type, target_min: min, target_max: max };
    if (dual) { body.secondary_min = sMin; body.secondary_max = sMax; }
    setBusy(true);
    try {
      await setTarget(openId, body);
      setTargetForm(emptyTarget());
      setMessage("Target set");
    } catch (e) { setTargetError((e as Error).message); setBusy(false); return; }
    await refreshAfter("Saved");
    setBusy(false);
  }

  function targetText(t: Target) {
    const info = typeInfo(t.vital_type);
    const first = range(t.target_min, t.target_max);
    const second = range(t.secondary_min, t.secondary_max);
    const parts: string[] = [];
    if (first) parts.push(info?.is_dual_value && info.value_label ? `${info.value_label}: ${first}` : first);
    if (second) parts.push(`${info?.secondary_label || "Second value"}: ${second}`);
    return parts.join("; ") || "No limits set";
  }

  const todayStr = localDate();

  return (
    <>
      <NavigationBar />
      <main className="page-container">
        <section className="page-heading">
          <h2>Conditions</h2>
          <p>Keep track of your health conditions, add notes as things change, and set the vital-sign ranges you are aiming for.</p>
        </section>

        {error && <p className="notice error" role="alert">{error}</p>}
        {message && !error && <p className="notice success" role="status">{message}</p>}
        {refreshError && <p className="notice error" role="alert">{refreshError}</p>}

        <section aria-labelledby="cond-summary">
          <h3 id="cond-summary">Summary</h3>
          {loading ? <p role="status">Loading…</p> : summary && (
            <>
              <p>
                Total conditions: {summary.total_conditions} · Active or managed: {summary.active_count}
              </p>
              {summary.by_status.length > 0 && (
                <p>By status: {summary.by_status.map((s) => `${label(s.status)} ${s.count}`).join(", ")}</p>
              )}
              {summary.by_category.length > 0 && (
                <p>By category: {summary.by_category.map((c) => `${label(c.category)} ${c.count}`).join(", ")}</p>
              )}
              {summary.active_conditions.length > 0 && (
                <div className="table-scroll">
                  <table className="access-log">
                    <caption className="sr-only">Active and managed conditions</caption>
                    <thead>
                      <tr><th>Condition</th><th>Status</th><th>Severity</th><th>Category</th><th>Notes</th><th>Last note</th></tr>
                    </thead>
                    <tbody>
                      {summary.active_conditions.map((c) => (
                        <tr key={idOf(c.condition_id)}>
                          <td>{c.condition_name}{c.is_primary && <small> · Primary</small>}</td>
                          <td>{label(c.status)}</td>
                          <td>{label(c.severity) || "Not set"}</td>
                          <td>{label(c.category) || "Not set"}</td>
                          <td>{c.note_count}</td>
                          <td>{fmtDate(c.last_note_date) || "None"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </section>

        <section aria-labelledby="cond-list" className="disp-section">
          <div className="med-toolbar">
            <h3 id="cond-list">Your conditions</h3>
            <button className="primary-button" type="button" disabled={busy} onClick={() => { if (formOpen) closeForm(); else openNew(); }}>
              {formOpen ? "Cancel" : "Add condition"}
            </button>
          </div>

          {formOpen && (
            <form id="condition-form" className="med-add" onSubmit={submit} noValidate>
              <h3>{editingId !== null ? "Edit condition" : "New condition"}</h3>
              {formError && <p className="notice error" role="alert">{formError}</p>}
              <div className="med-add-grid">
                <label className="med-wide">Condition name *<input value={form.name} onChange={set("name")} maxLength={255} /></label>
                <label>ICD-10 code (optional)
                  <input value={form.icd10} onChange={set("icd10")} maxLength={10} placeholder="e.g. E11.9" />
                </label>
                <label>Category
                  <select value={form.category} onChange={set("category")}>
                    <option value="">Not set</option>
                    {CATEGORIES.map((c) => <option key={c} value={c}>{label(c)}</option>)}
                  </select>
                </label>
                <label>Status *
                  <select value={form.status} onChange={set("status")}>
                    {STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
                  </select>
                </label>
                <label>Severity
                  <select value={form.severity} onChange={set("severity")}>
                    <option value="">Not set</option>
                    {SEVERITIES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
                  </select>
                </label>
                <label>Onset date<input type="date" value={form.onset} max={todayStr} onChange={set("onset")} /></label>
                <label>Diagnosed date<input type="date" value={form.diagnosed} max={todayStr} onChange={set("diagnosed")} /></label>
                {form.status === "resolved" && (
                  <label>Resolved date *<input type="date" value={form.resolved} max={todayStr} onChange={set("resolved")} /></label>
                )}
                <label>Diagnosing provider<input value={form.diagnosing} onChange={set("diagnosing")} maxLength={255} /></label>
                <label>Managing provider<input value={form.managing} onChange={set("managing")} maxLength={255} /></label>
                <label>Facility<input value={form.facility} onChange={set("facility")} maxLength={255} /></label>
                <label className="rem-check">
                  <input type="checkbox" checked={form.primary} onChange={(e) => setForm((f) => ({ ...f, primary: e.target.checked }))} /> Primary condition
                </label>
                <label className="med-wide">Notes (optional)
                  <textarea rows={3} value={form.notes} onChange={set("notes")} maxLength={5000} />
                </label>
              </div>
              <button className="primary-button" type="submit" disabled={busy}>
                {busy ? "Saving…" : editingId !== null ? "Save changes" : "Save condition"}
              </button>
            </form>
          )}

          {loading ? <p role="status">Loading…</p> : conditions.length === 0 ? (
            <p>No conditions yet. Choose "Add condition" to add one.</p>
          ) : (
            <div className="med-list">
              {conditions.map((c) => {
                const id = idOf(c.condition_id);
                const isOpen = openId === id;
                return (
                  <article key={id} className="med-card">
                    <div className="med-main">
                      <div>
                        <h3>{c.condition_name}{c.is_primary && " (Primary condition)"}</h3>
                        <p>
                          Status: {label(c.status)} · Severity: {label(c.severity) || "Not set"} · Category: {label(c.category) || "Not set"}
                          {c.icd10_code && <> · ICD-10: {c.icd10_code}</>}
                        </p>
                        <p>
                          {c.onset_date ? <>Onset: {fmtDate(c.onset_date)}</> : <>Onset: Not set</>}
                          {c.diagnosed_date && <> · Diagnosed: {fmtDate(c.diagnosed_date)}</>}
                          {c.resolved_date && <> · Resolved: {fmtDate(c.resolved_date)}</>}
                        </p>
                        {(c.managing_provider || c.diagnosing_provider || c.provider_facility) && (
                          <p>
                            {c.managing_provider && <>Managing provider: {c.managing_provider}</>}
                            {c.diagnosing_provider && <>{c.managing_provider ? " · " : ""}Diagnosed by: {c.diagnosing_provider}</>}
                            {c.provider_facility && <>{c.managing_provider || c.diagnosing_provider ? " · " : ""}Facility: {c.provider_facility}</>}
                          </p>
                        )}
                        {c.notes && <p>Notes: {c.notes}</p>}
                      </div>
                    </div>
                    <div className="med-actions">
                      <button className="secondary-button" type="button" disabled={busy} aria-expanded={isOpen} aria-controls={`cond-detail-${id}`}
                        onClick={() => toggleOpen(c)}>
                        {isOpen ? "Hide notes and targets" : "Notes and targets"}
                      </button>
                      <button className="secondary-button" type="button" disabled={busy} onClick={() => openEdit(c)}>Edit</button>
                      <button className="text-button med-link danger" type="button" disabled={busy} onClick={() => removeCondition(c)}>Delete</button>
                    </div>

                    {isOpen && (
                      <div id={`cond-detail-${id}`} className="disp-section">
                        {detailError && <p className="notice error" role="alert">{detailError}</p>}
                        {detailLoading && <p role="status">Loading…</p>}

                        {detail && (
                          <>
                            <h4>Notes</h4>
                            {detail.notes.length === 0 ? <p>No notes yet.</p> : (
                              <div className="table-scroll">
                                <table className="access-log">
                                  <caption className="sr-only">Notes for {c.condition_name}</caption>
                                  <thead><tr><th>Date</th><th>Type</th><th>Note</th></tr></thead>
                                  <tbody>
                                    {detail.notes.map((n) => (
                                      <tr key={idOf(n.note_id)}>
                                        <td>{fmtDate(n.note_date)}</td>
                                        <td>{label(n.note_type)}</td>
                                        <td>{n.note_text}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}

                            <form className="med-add" onSubmit={addNote} noValidate>
                              <h4>Add note</h4>
                              {noteError && <p className="notice error" role="alert">{noteError}</p>}
                              <div className="med-add-grid">
                                <label>Date<input type="date" value={noteForm.date} max={todayStr}
                                  onChange={(e) => setNoteForm((f) => ({ ...f, date: e.target.value }))} /></label>
                                <label>Type
                                  <select value={noteForm.type} onChange={(e) => setNoteForm((f) => ({ ...f, type: e.target.value }))}>
                                    {NOTE_TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}
                                  </select>
                                </label>
                                <label className="med-wide">Note *
                                  <textarea rows={3} value={noteForm.text} maxLength={5000}
                                    onChange={(e) => setNoteForm((f) => ({ ...f, text: e.target.value }))} />
                                </label>
                              </div>
                              <button className="primary-button" type="submit" disabled={busy}>{busy ? "Saving…" : "Add note"}</button>
                            </form>

                            <h4>Vital-sign targets</h4>
                            {detail.targets.length === 0 ? <p>No targets set for this condition.</p> : (
                              <div className="table-scroll">
                                <table className="access-log">
                                  <caption className="sr-only">Vital-sign targets for {c.condition_name}</caption>
                                  <thead><tr><th>Vital sign</th><th>Target</th><th>Set by</th><th>Status</th></tr></thead>
                                  <tbody>
                                    {detail.targets.map((t) => (
                                      <tr key={idOf(t.target_id)}>
                                        <td>{typeName(t.vital_type)}</td>
                                        <td>{targetText(t)}</td>
                                        <td>{setByText(t.set_by)}</td>
                                        <td>{t.active ? "Active" : "Replaced"}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}

                            <form className="med-add" onSubmit={addTarget} noValidate>
                              <h4>Add target</h4>
                              {typesError && <p className="notice error" role="alert">{typesError}</p>}
                              {targetError && <p className="notice error" role="alert">{targetError}</p>}
                              <div className="med-add-grid">
                                <label>Vital sign *
                                  <select value={targetForm.vital_type} onChange={(e) => setTargetForm({ ...emptyTarget(), vital_type: e.target.value })}>
                                    <option value="">Choose…</option>
                                    {vitalTypes.map((t) => (
                                      <option key={t.vital_type} value={t.vital_type}>{t.display_name}{t.default_unit ? ` (${t.default_unit})` : ""}</option>
                                    ))}
                                  </select>
                                </label>
                                <label>{pickedType?.is_dual_value ? `Lowest ${pickedType.value_label || "value"}` : "Lowest"}
                                  <input type="number" inputMode="decimal" step="any" value={targetForm.min}
                                    onChange={(e) => setTargetForm((f) => ({ ...f, min: e.target.value }))} />
                                </label>
                                <label>{pickedType?.is_dual_value ? `Highest ${pickedType.value_label || "value"}` : "Highest"}
                                  <input type="number" inputMode="decimal" step="any" value={targetForm.max}
                                    onChange={(e) => setTargetForm((f) => ({ ...f, max: e.target.value }))} />
                                </label>
                                {pickedType?.is_dual_value && (
                                  <>
                                    <label>Lowest {pickedType.secondary_label || "second value"}
                                      <input type="number" inputMode="decimal" step="any" value={targetForm.secMin}
                                        onChange={(e) => setTargetForm((f) => ({ ...f, secMin: e.target.value }))} />
                                    </label>
                                    <label>Highest {pickedType.secondary_label || "second value"}
                                      <input type="number" inputMode="decimal" step="any" value={targetForm.secMax}
                                        onChange={(e) => setTargetForm((f) => ({ ...f, secMax: e.target.value }))} />
                                    </label>
                                  </>
                                )}
                              </div>
                              <p className="form-hint">Enter at least one limit. A new target replaces your current active target for the same vital sign.</p>
                              <button className="primary-button" type="submit" disabled={busy}>{busy ? "Saving…" : "Add target"}</button>
                            </form>
                          </>
                        )}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </main>
    </>
  );
}

export default Conditions;
