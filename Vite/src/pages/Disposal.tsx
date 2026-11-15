import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import AlertBanner from "../components/AlertBanner";
import NavigationBar from "../components/NavigationBar";
import { localDate } from "../api";
import { listMedications } from "../data/medications";
import { disposalDue, disposalGuidance, disposalMethods, listDisposals, recordDisposal, removeDisposal, type DisposalInput } from "../data/disposal";

// Safe disposal: leftover medicines with step-by-step guidance, a log of what the
// patient has already gotten rid of, and a look-up for any other medicine.
//   disposalDue()        -> leftover medicines (stopped, completed or past their end date) + guidance
//   disposalGuidance()   -> guidance for any medicine name
//   disposalMethods()    -> the eight disposal methods
//   listDisposals / recordDisposal / removeDisposal -> the disposal history (DisposalLog; the server takes the
//                           quantity off the medicine's count after a disposal)
// All of it is in data/disposal.ts and data/disposalGuide.ts (Parse SDK; the guidance lists are a copy of the server's).
// The medicine pick-list comes from listMedications() (data/medications.ts, Parse SDK).
// All guidance is plain text and is shown as text only.

type Link = { key: string; label: string; url: string };
type Guidance = { method: string; title: string; summary: string; steps: string[]; links: Link[]; on_flush_list: boolean };
type Due = {
  medication_id: string | number; medication_name: string; brand_name: string | null;
  dosage_form: string | null; quantity_on_hand: number; status: string; end_date: string | null;
  guidance: Guidance;
};
type MedOption = { medication_id: string | number; medication_name: string; quantity_on_hand: string | number };
type Method = { key: string; title: string };
type DisposalLog = {
  disposal_id: string | number; medication_id: string | number | null; medication_name: string;
  method: string; location: string | null; disposed_date: string; notes: string | null; quantity: number;
};

const TOLERANCE = 0.000001;   // same as the server, for comparing with the count on hand
const QUANTITY_ERROR = "Quantity must be a number above 0 and up to 100,000, with at most 2 decimal places";
const FORMS = ["tablet", "capsule", "liquid", "injection", "inhaler", "patch", "cream", "drops", "spray", "powder", "other"];
// used until the method titles are loaded (they come from disposalGuide.ts)
const FALLBACK_METHODS: Method[] = [
  { key: "take_back", title: "Drug take-back" }, { key: "flush", title: "Flush (FDA flush list)" },
  { key: "flush_patch", title: "Flush the patch (FDA flush list)" }, { key: "trash", title: "Household trash" },
  { key: "patch", title: "Patch disposal" }, { key: "inhaler", title: "Inhaler disposal" },
  { key: "sharps", title: "Sharps container" }, { key: "controlled", title: "Controlled medicine disposal" },
];

const safeUrl = (u: string) => /^https?:\/\//i.test(u);

function GuidanceCard({ g, heading }: { g: Guidance; heading?: string }) {
  return (
    <div className={`disp-guidance ${g.on_flush_list ? "flush" : ""}`}>
      {g.on_flush_list && (
        <p className="disp-flush-tag"><span aria-hidden="true">⚠</span> On the FDA flush list. Follow these steps closely.</p>
      )}
      {heading && <p className="disp-guidance-for">{heading}</p>}
      <h4>{g.title}</h4>
      <p>{g.summary}</p>
      {g.steps.length > 0 && <ol>{g.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>}
      {g.links.length > 0 && (
        <ul className="disp-links">
          {g.links.filter((l) => safeUrl(l.url)).map((l) => (
            <li key={l.key}><a href={l.url} target="_blank" rel="noopener noreferrer">{l.label} (opens in a new tab)</a></li>
          ))}
        </ul>
      )}
    </div>
  );
}

const emptyForm = () => ({ medication: "", medication_name: "", quantity: "1", method: "take_back", location: "", disposed_date: localDate(), notes: "" });

function Disposal() {
  const [params] = useSearchParams();
  const startMed = params.get("med") || "";
  const [due, setDue] = useState<Due[]>([]);
  const [note, setNote] = useState("");
  const [meds, setMeds] = useState<MedOption[]>([]);
  const [methods, setMethods] = useState<Method[]>(FALLBACK_METHODS);
  const [logs, setLogs] = useState<DisposalLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [refreshError, setRefreshError] = useState("");   // the save worked but the lists could not reload
  const [formOpen, setFormOpen] = useState(!!startMed);
  const [form, setForm] = useState({ ...emptyForm(), medication: startMed });
  const [lookup, setLookup] = useState({ name: "", form: "" });
  const [lookupResult, setLookupResult] = useState<{ guidance: Guidance; note: string; name: string } | null>(null);
  const [lookupError, setLookupError] = useState("");

  async function loadLists() {
    const [d, l] = await Promise.all([disposalDue(), listDisposals()]);
    setDue(d.medications); setNote(d.note); setLogs(l.logs);
  }

  useEffect(() => {
    // the medicine pick-list and the method titles are extras: the page still works without them
    Promise.all([
      disposalDue(),
      listDisposals(),
      listMedications().catch(() => [] as MedOption[]),
      Promise.resolve(disposalMethods()),
    ])
      .then(([d, l, m, t]) => {
        setDue(d.medications); setNote(d.note); setLogs(l.logs); setMeds(m);
        if (t.methods?.length) setMethods(t.methods);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  // medicines you can pick in the form: everything with some left, plus the leftover list
  const options: MedOption[] = [...meds];
  for (const d of due) if (!options.some((m) => String(m.medication_id) === String(d.medication_id))) options.push(d);
  const pickable = options.filter((m) => Number(m.quantity_on_hand) > 0);
  // a ?med= id that isn't a medicine with some left falls back to "type the name"
  const medId = !loading && pickable.some((m) => String(m.medication_id) === form.medication) ? form.medication : "";
  const selected = pickable.find((m) => String(m.medication_id) === medId);

  const set = (k: keyof ReturnType<typeof emptyForm>) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  function openFormFor(id: string | number) {
    setForm({ ...emptyForm(), medication: String(id) });
    setFormOpen(true); setMessage(""); setError("");
    setTimeout(() => document.getElementById("disposal-form")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(""); setMessage(""); setRefreshError("");
    // same rule as the server: digits with up to 2 decimals, at least 0.01, at most 100,000
    const qtyText = form.quantity.trim();
    const qty = /^\d+(\.\d{1,2})?$/.test(qtyText) ? Math.round(Number(qtyText) * 100) / 100 : NaN;
    if (!Number.isFinite(qty) || qty < 0.01 || qty > 100000) { setError(QUANTITY_ERROR); return; }
    if (selected && qty > Number(selected.quantity_on_hand) + TOLERANCE) { setError(`Only ${Number(selected.quantity_on_hand)} left on hand`); return; }
    if (!medId && !form.medication_name.trim()) { setError("Choose the medicine, or type its name."); return; }
    if (form.disposed_date && form.disposed_date > localDate()) { setError("The date can't be in the future."); return; }
    const body: DisposalInput = { quantity: qty, method: form.method };
    if (medId) body.medication_id = medId; else body.medication_name = form.medication_name.trim();
    if (form.location.trim()) body.location = form.location.trim();
    if (form.disposed_date) body.disposed_date = form.disposed_date;
    if (form.notes.trim()) body.notes = form.notes.trim();
    setBusy(true);
    try {
      const r = await recordDisposal(body);
      setForm(emptyForm()); setFormOpen(false);
      setMessage(r.message || "Disposal recorded");
    } catch (e) { setError((e as Error).message); setBusy(false); return; }
    // the disposal is saved: a failed refresh must not look like a failed save
    try {
      await Promise.all([
        loadLists(),
        listMedications().then(setMeds).catch(() => {}),
      ]);
    } catch (e) { setRefreshError(`Saved, but the lists could not refresh: ${(e as Error).message}`); }
    finally { setBusy(false); }
  }

  async function removeLog(l: DisposalLog) {
    if (!window.confirm("Remove this entry from your disposal history? Your pill count will not change.")) return;
    setBusy(true); setError(""); setMessage(""); setRefreshError("");
    try {
      const r = await removeDisposal(String(l.disposal_id));
      setMessage(r.message || "Disposal record removed");
    } catch (e) { setError((e as Error).message); setBusy(false); return; }
    try { await loadLists(); }
    catch (e) { setRefreshError(`Removed, but the lists could not refresh: ${(e as Error).message}`); }
    finally { setBusy(false); }
  }

  async function search(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLookupError(""); setLookupResult(null);
    const name = lookup.name.trim();
    if (!name) { setLookupError("Type the medicine's name."); return; }
    setBusy(true);
    try {
      const r = disposalGuidance({ name, form: lookup.form || null });
      setLookupResult({ guidance: r.guidance, note: r.note, name });
    } catch (e) { setLookupError((e as Error).message); }
    finally { setBusy(false); }
  }

  const methodTitle = (key: string) => methods.find((m) => m.key === key)?.title ?? key;

  return (
    <>
      <NavigationBar />
      <main className="page-container">
        <section className="page-heading">
          <h2>Safe Disposal</h2>
          <p>Find out how to get rid of leftover or expired medicines safely, and keep a record of what you did.</p>
        </section>

        {note && <AlertBanner message={note} type="info" />}

        {error && <p className="notice error" role="alert">{error}</p>}
        {message && !error && <p className="notice success" role="status">{message}</p>}
        {refreshError && <p className="notice error" role="alert">{refreshError}</p>}

        <section aria-labelledby="disp-leftover">
          <div className="med-toolbar">
            <h3 id="disp-leftover">Leftover medicines</h3>
            <button className="primary-button" type="button" onClick={() => { if (formOpen) setFormOpen(false); else { setForm(emptyForm()); setFormOpen(true); } }}>
              {formOpen ? "Cancel" : "I got rid of a medicine"}
            </button>
          </div>

          {formOpen && (
            <form id="disposal-form" className="med-add" onSubmit={submit} noValidate>
              <h3>I got rid of it</h3>
              <div className="med-add-grid">
                <label>Medicine *
                  <select value={medId} onChange={set("medication")}>
                    <option value="">Other (type the name)</option>
                    {pickable.map((m) => (
                      <option key={String(m.medication_id)} value={String(m.medication_id)}>
                        {m.medication_name} ({Number(m.quantity_on_hand)} on hand)
                      </option>
                    ))}
                  </select>
                </label>
                {!medId && (
                  <label>Medicine name *<input value={form.medication_name} onChange={set("medication_name")} maxLength={200} /></label>
                )}
                <label>How many *
                  <input type="number" inputMode="decimal" min={0.01} step="0.01" max={selected ? Number(selected.quantity_on_hand) : undefined}
                    value={form.quantity} onChange={set("quantity")} />
                </label>
                <label>How you got rid of it *
                  <select value={form.method} onChange={set("method")}>
                    {methods.map((m) => <option key={m.key} value={m.key}>{m.title}</option>)}
                  </select>
                </label>
                <label>Where (optional)<input value={form.location} onChange={set("location")} maxLength={200} placeholder="e.g. pharmacy take-back box" /></label>
                <label>Date<input type="date" value={form.disposed_date} max={localDate()} onChange={set("disposed_date")} /></label>
                <label className="med-wide">Notes (optional)<textarea rows={2} value={form.notes} onChange={set("notes")} maxLength={500} /></label>
              </div>
              <p className="form-hint">Recording this lowers your pill count for that medicine.</p>
              <button className="primary-button" type="submit" disabled={busy || loading}>{busy ? "Saving…" : "Save"}</button>
            </form>
          )}

          {loading ? <p role="status">Loading…</p> : due.length === 0 ? (
            <p>No leftover medicines right now. Stopped, finished or expired medicines that you still have will show up here.</p>
          ) : (
            <div className="med-list">
              {due.map((d) => (
                <article key={String(d.medication_id)} className={`med-card ${d.guidance.on_flush_list ? "disp-flush-card" : ""}`}>
                  <div className="med-main">
                    <div>
                      <h3>{d.medication_name}</h3>
                      <p>
                        {d.brand_name && <>{d.brand_name} · </>}{d.dosage_form && <>{d.dosage_form} · </>}
                        {d.quantity_on_hand} left · {d.status}{d.end_date && <> · ended {d.end_date}</>}
                      </p>
                    </div>
                  </div>
                  <GuidanceCard g={d.guidance} />
                  <div className="med-actions">
                    <button className="secondary-button" type="button" disabled={busy} onClick={() => openFormFor(d.medication_id)}>I got rid of it</button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <section aria-labelledby="disp-lookup" className="disp-section">
          <h3 id="disp-lookup">Look up any medicine</h3>
          <form className="med-add" onSubmit={search} noValidate>
            <div className="med-add-grid">
              <label>Medicine name *<input value={lookup.name} onChange={(e) => setLookup((l) => ({ ...l, name: e.target.value }))} maxLength={200} /></label>
              <label>Form (optional)
                <select value={lookup.form} onChange={(e) => setLookup((l) => ({ ...l, form: e.target.value }))}>
                  <option value="">Not sure</option>
                  {FORMS.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
              </label>
            </div>
            <button className="primary-button" type="submit" disabled={busy}>Look up</button>
          </form>
          {lookupError && <p className="notice error" role="alert">{lookupError}</p>}
          {lookupResult && (
            <div className="med-card">
              <GuidanceCard g={lookupResult.guidance} heading={`How to dispose of ${lookupResult.name}`} />
              {lookupResult.note && <p className="form-hint">{lookupResult.note}</p>}
            </div>
          )}
        </section>

        <section aria-labelledby="disp-history" className="disp-section">
          <h3 id="disp-history">Disposal history</h3>
          {loading ? null : logs.length === 0 ? <p>Nothing recorded yet.</p> : (
            <div className="table-scroll">
              <table className="access-log">
                <thead><tr><th>Date</th><th>Medicine</th><th>Qty</th><th>Method</th><th><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {logs.map((l) => (
                    <tr key={String(l.disposal_id)}>
                      <td>{l.disposed_date}</td>
                      <td>{l.medication_name}{l.location && <small> · {l.location}</small>}</td>
                      <td>{l.quantity}</td>
                      <td>{methodTitle(l.method)}</td>
                      <td><button className="text-button med-link danger" type="button" disabled={busy} onClick={() => removeLog(l)}>Remove</button></td>
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

export default Disposal;
