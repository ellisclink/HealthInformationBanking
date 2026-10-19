import { useState } from "react";
import { api, apiUpload } from "../api";

// Auto-fill from a PDF: choose the file, review what was found, fix anything wrong, tick what to keep, confirm.
//   POST   /documents/autofill                    -> { draft_id, proposals, ... }   (saves nothing)
//   POST   /documents/autofill/:id/confirm        -> only the ticked items are saved
//   DELETE /documents/autofill/:id                -> cancel
// Nothing starts ticked, and nothing is saved until the "I have reviewed" box is ticked and Save is pressed.
// Everything from the server is shown as plain text. The page never logs the file or its content.

type Proposal = {
  proposal_id: string; section: string; label: string; confidence: "high" | "medium" | "low";
  fields: Record<string, string | number | boolean | null>; source_text: string; warnings: string[];
};
type Draft = { draft_id: string; file_name: string; proposals: Proposal[]; already_saved_as?: string };
type Done = { message: string; results: { proposal_id: string; label: string; saved: boolean; error?: string }[]; safety?: { open_count: number; major_open_count: number } | null };

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const row: React.CSSProperties = { display: "flex", flexDirection: "row", alignItems: "center", gap: 8, margin: "4px 0" };
const box: React.CSSProperties = { width: "auto", margin: 0, flex: "none" };

const TITLES: Record<string, string> = {
  document: "Keep the PDF", lab_result: "Lab results", medication: "Medications", condition: "Conditions",
  allergy: "Allergies", vital: "Vital signs",
};
const ORDER = ["document", "lab_result", "medication", "condition", "allergy", "vital"];
// the fields the patient may correct (same lists as the server's EDITABLE)
const EDIT: Record<string, string[]> = {
  document: ["title", "category", "provider", "document_date", "notes"],
  lab_result: ["test_name", "value", "unit", "collected_date"],
  medication: ["medication_name", "strength", "strength_unit", "frequency", "instructions"],
  condition: ["condition_name", "icd10_code", "status", "onset_date"],
  allergy: ["allergen", "reaction"],
  vital: ["value_numeric", "value_secondary", "unit", "measured_at"],
};
const NUMERIC = new Set(["value", "strength", "value_numeric", "value_secondary"]);
const LABEL = (k: string) => k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export default function AutofillPdf({ onDone }: { onDone?: () => void }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [edits, setEdits] = useState<Record<string, Record<string, string>>>({});
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<Done | null>(null);

  function reset() {
    setFile(null); setFileKey((k) => k + 1); setDraft(null); setPicked({}); setEdits({}); setReviewed(false); setError(""); setDone(null);
  }

  async function read() {
    if (!file) { setError("Choose a PDF first."); return; }
    if (file.size > MAX_FILE_BYTES) { setError("That file is too large (8 MB max)."); return; }
    setBusy(true); setError(""); setDone(null);
    try {
      const d = await apiUpload<Draft>("/documents/autofill", file, { file_name: file.name });
      setDraft(d); setPicked({}); setEdits({}); setReviewed(false);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  const shown = (p: Proposal, k: string) => {
    const e = edits[p.proposal_id]?.[k];
    if (e !== undefined) return e;
    const v = p.fields[k];
    return v === null || v === undefined ? "" : String(v);
  };
  const setEdit = (id: string, k: string, v: string) => setEdits((all) => ({ ...all, [id]: { ...all[id], [k]: v } }));

  async function save() {
    if (!draft) return;
    const items = draft.proposals.map((p) => {
      const fields: Record<string, string | number | null> = {};
      for (const [k, v] of Object.entries(edits[p.proposal_id] || {})) {
        const n = Number(v);
        fields[k] = NUMERIC.has(k) && v.trim() !== "" && Number.isFinite(n) ? n : v;
      }
      return { proposal_id: p.proposal_id, accept: !!picked[p.proposal_id], ...(Object.keys(fields).length ? { fields } : {}) };
    });
    setBusy(true); setError("");
    try {
      const r = await api<Done>(`/documents/autofill/${draft.draft_id}/confirm`, { method: "POST", body: JSON.stringify({ confirmed: true, items }) });
      setDone(r); setDraft(null);
      onDone?.();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function cancel() {
    if (draft) await api(`/documents/autofill/${draft.draft_id}`, { method: "DELETE" }).catch(() => {});
    reset();
  }

  const count = Object.values(picked).filter(Boolean).length;
  const groups = draft ? ORDER.map((s) => ({ s, items: draft.proposals.filter((p) => p.section === s) })).filter((g) => g.items.length) : [];

  return (
    <section className="med-add" aria-labelledby="autofill-title">
      <div className="med-toolbar">
        <h3 id="autofill-title">Auto-fill from a PDF</h3>
        <button className="secondary-button" type="button" onClick={() => { if (open) cancel(); setOpen(!open); }}>{open ? "Close" : "Auto-fill"}</button>
      </div>
      {!open && <p style={{ margin: 0 }}>Upload a lab report or visit summary (PDF) and we will suggest entries. You review everything before anything is saved.</p>}

      {open && (
        <>
          {error && <p className="notice error" role="alert">{error}</p>}
          {done && (
            <div className="notice success" role="status">
              <p style={{ margin: 0 }}>{done.message}</p>
              {done.results.filter((r) => !r.saved).map((r) => <p key={r.proposal_id} style={{ margin: "4px 0 0" }}>Not saved: {r.label}. {r.error}</p>)}
              {done.safety && done.safety.open_count > 0 && <p style={{ margin: "4px 0 0" }}>Medication warnings need a look: {done.safety.open_count} open.</p>}
            </div>
          )}

          {!draft && (
            <div className="form-group">
              <label htmlFor="autofill-file">PDF file (8 MB max, PDFs with typed text only; scans can’t be read)</label>
              <input key={fileKey} id="autofill-file" type="file" accept="application/pdf,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              <button className="primary-button" type="button" disabled={busy || !file} onClick={read}>{busy ? "Reading…" : "Read the PDF"}</button>
            </div>
          )}

          {draft && (
            <>
              <p className="notice" role="status">Nothing is saved yet. Tick the items you want, correct any mistakes, then confirm at the bottom. These are guesses from the PDF’s text, so please check each one.</p>
              {draft.already_saved_as && <p className="notice">This PDF is already in your documents as “{draft.already_saved_as}”.</p>}
              {draft.proposals.length <= 1 && <p>We couldn’t find any entries to suggest in this PDF.</p>}

              {groups.map((g) => (
                <fieldset key={g.s} style={{ margin: "12px 0" }}>
                  <legend><strong>{TITLES[g.s]}</strong></legend>
                  {g.items.map((p) => (
                    <div key={p.proposal_id} style={{ borderTop: "1px solid #ddd", padding: "8px 0" }}>
                      <label style={row}>
                        <input style={box} type="checkbox" checked={!!picked[p.proposal_id]} onChange={(e) => setPicked({ ...picked, [p.proposal_id]: e.target.checked })} />
                        <span><strong>{p.label}</strong>{p.confidence !== "high" && <em> (check this one)</em>}</span>
                      </label>
                      {p.source_text && g.s !== "document" && <small className="form-hint">From the PDF: “{p.source_text}”</small>}
                      {p.warnings.map((w) => <small key={w} className="form-hint" style={{ display: "block" }}>{w}</small>)}
                      {picked[p.proposal_id] && (
                        <div className="form-grid" style={{ marginTop: 6 }}>
                          {EDIT[g.s].filter((k) => k in p.fields || NUMERIC.has(k) === false).map((k) => (
                            <div className="form-group" key={k}>
                              <label htmlFor={`${p.proposal_id}-${k}`}>{LABEL(k)}</label>
                              <input id={`${p.proposal_id}-${k}`} value={shown(p, k)} onChange={(e) => setEdit(p.proposal_id, k, e.target.value)} />
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </fieldset>
              ))}

              <label style={row}>
                <input style={box} type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />
                <span>I have reviewed the ticked items and they are correct.</span>
              </label>
              <div className="med-toolbar">
                <button className="primary-button" type="button" disabled={busy || !reviewed || count === 0} onClick={save}>
                  {busy ? "Saving…" : `Save ${count} item${count === 1 ? "" : "s"}`}
                </button>
                <button className="secondary-button" type="button" disabled={busy} onClick={cancel}>Cancel — save nothing</button>
              </div>
            </>
          )}
          {done && <button className="secondary-button" type="button" onClick={reset}>Auto-fill another PDF</button>}
        </>
      )}
    </section>
  );
}
