import { useState } from "react";
import { apiUpload, currentName } from "../api";

// Import a C-CDA health record: choose the file, see what it contains, tick what to import.
//   POST /ccda/preview  -> { patient, sections }            (saves nothing)
//   POST /ccda/import   -> { result, problems, original }   (the same file plus the ticked row numbers)
// Everything from the server is shown as plain text. The page never logs the file or its content.

type Item = { index: number; label: string; date: string | null };
type Section = { importable: boolean; items: Item[] };
type Preview = { patient: { name: string | null; birth_date: string | null }; sections: Record<string, Section> };
type Outcome = { added: number; skipped: number; failed: number };
type Done = { message?: string; result: Record<string, Outcome>; problems?: { section: string; label: string; reason: string }[]; original?: string; safety?: { open_count: number; major_open_count: number } | null };

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const normalizeName = (value: string | null | undefined) =>
  String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
// the site's global label/input styles stretch checkboxes across the row; keep these on one line
const row: React.CSSProperties = { display: "flex", flexDirection: "row", alignItems: "center", gap: 8, margin: "4px 0" };
const box: React.CSSProperties = { width: "auto", margin: 0, flex: "none" };
const TITLES: Record<string, string> = {
  medications: "Medications", problems: "Problems (saved as conditions)", vitals: "Vital signs",
  allergies: "Allergies", immunizations: "Immunizations", procedures: "Procedures", social_history: "Social history",
};

export default function CcdaImport({ onDone }: { onDone?: () => void }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [picked, setPicked] = useState<Record<string, number[]>>({});
  const [keepOriginal, setKeepOriginal] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<Done | null>(null);

  function reset() {
    setFile(null); setFileKey((k) => k + 1); setPreview(null); setPicked({}); setError(""); setDone(null);
  }

  function choose(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setError(""); setDone(null); setPreview(null); setPicked({});
    if (f && f.size > MAX_FILE_BYTES) { setError("That file is too large (8 MB max)"); setFile(null); setFileKey((k) => k + 1); return; }
    setFile(f);
  }

  async function readFile() {
    if (!file) { setError("Choose a C-CDA (.xml) file first"); return; }
    setError(""); setDone(null); setBusy(true);
    try {
      const p = await apiUpload<Preview>("/ccda/preview", file);
      setPreview(p);
      // everything importable starts ticked
      const all: Record<string, number[]> = {};
      for (const [k, s] of Object.entries(p.sections)) if (s.importable) all[k] = s.items.map((i) => i.index);
      setPicked(all);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  const toggleItem = (key: string, index: number) =>
    setPicked((p) => {
      const cur = p[key] || [];
      return { ...p, [key]: cur.includes(index) ? cur.filter((i) => i !== index) : [...cur, index] };
    });
  const toggleAll = (key: string, s: Section) =>
    setPicked((p) => ({ ...p, [key]: (p[key] || []).length === s.items.length ? [] : s.items.map((i) => i.index) }));

  const total = Object.values(picked).reduce((n, a) => n + a.length, 0);
  const accountName = currentName();
  const nameMismatch = !!preview && !!preview.patient.name && !!accountName && normalizeName(preview.patient.name) !== normalizeName(accountName);

  async function runImport() {
    if (!file || !total) return;
    setError(""); setBusy(true);
    try {
      const r = await apiUpload<Done>("/ccda/import", file, { selected: picked, keep_original: keepOriginal, file_name: file.name });
      setDone(r); setPreview(null); setFile(null); setFileKey((k) => k + 1);
      onDone?.();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <section aria-labelledby="ccda-title" className="ccda-shell">
      <div className="med-toolbar ccda-header">
        <h3 id="ccda-title">Import a health record (C-CDA)</h3>
        <button className="primary-button" type="button" onClick={() => { setOpen((o) => !o); reset(); }}>{open ? "Close" : "Import"}</button>
      </div>

      {open && (
        <div className="med-add ccda-import-panel">
          <p className="form-hint">Choose the .xml health record file (CCD/C-CDA) you downloaded from your provider's portal. You will see what it contains before anything is saved.</p>
          {error && <p className="notice error" role="alert">{error}</p>}

          {done && (
            <div className="notice success" role="status">
              <p>{done.message || "Import finished"}{done.original ? ` · original file: ${done.original}` : ""}</p>
              <ul>
                {Object.entries(done.result).filter(([, o]) => o.added + o.skipped + o.failed > 0).map(([k, o]) => (
                  <li key={k}>{TITLES[k] || k}: {o.added} added, {o.skipped} already there, {o.failed} not saved</li>
                ))}
              </ul>
              {done.safety && done.safety.open_count > 0 && (
                <p role="alert"><strong>{done.safety.open_count} medication safety warning{done.safety.open_count === 1 ? "" : "s"}</strong>
                  {done.safety.major_open_count > 0 ? ` (${done.safety.major_open_count} major)` : ""} found after this import. Please review them on your medication safety page.</p>
              )}
              {done.problems && done.problems.length > 0 && (
                <details><summary>Why some rows were not saved</summary>
                  <ul>{done.problems.map((p, i) => <li key={i}>{p.label}: {p.reason}</li>)}</ul>
                </details>
              )}
            </div>
          )}

          <label className="med-wide">C-CDA file (.xml, 8 MB max)
            <input key={fileKey} type="file" accept=".xml,.ccda,application/xml,text/xml" onChange={choose} />
          </label>
          <button className="primary-button" type="button" disabled={busy || !file} onClick={readFile}>{busy && !preview ? "Reading…" : "Read file"}</button>

          {preview && (
            <div>
              <p><strong>{preview.patient.name || "Unnamed patient"}</strong>{preview.patient.birth_date ? ` · born ${preview.patient.birth_date}` : ""}</p>
              {nameMismatch && (
                <p className="notice error" role="alert">
                  Warning: this file is for <strong>{preview.patient.name}</strong>, but your account name is <strong>{accountName}</strong>. Please double-check before importing.
                </p>
              )}
              {!nameMismatch && <p className="form-hint">Check that this is your record before importing.</p>}

              {Object.entries(preview.sections).filter(([, s]) => s.items.length > 0).map(([key, s]) => (
                <fieldset key={key}>
                  <legend>{TITLES[key] || key} ({s.items.length}){s.importable ? "" : " — preview only"}</legend>
                  {s.importable && (
                    <label style={row}><input type="checkbox" style={box} checked={(picked[key] || []).length === s.items.length} onChange={() => toggleAll(key, s)} /> Select all</label>
                  )}
                  <details>
                    <summary>Show items</summary>
                    <ul>
                      {s.items.map((i) => (
                        <li key={i.index}>
                          {s.importable
                            ? <label style={row}><input type="checkbox" style={box} checked={(picked[key] || []).includes(i.index)} onChange={() => toggleItem(key, i.index)} /> {i.label}{i.date ? ` (${i.date})` : ""}</label>
                            : <>{i.label}{i.date ? ` (${i.date})` : ""}</>}
                        </li>
                      ))}
                    </ul>
                  </details>
                </fieldset>
              ))}

              <label style={row}><input type="checkbox" style={box} checked={keepOriginal} onChange={(e) => setKeepOriginal(e.target.checked)} /> Also keep the original file in my documents</label>
              <p className="form-hint">Imported medications need their dose and schedule filled in afterwards. Rows that are already in your account are skipped.</p>
              <button className="primary-button" type="button" disabled={busy || !total} onClick={runImport}>{busy ? "Importing…" : `Import ${total} selected`}</button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}