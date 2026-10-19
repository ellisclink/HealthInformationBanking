import { useCallback, useEffect, useRef, useState } from "react";
import NavigationBar from "../components/NavigationBar";
import CcdaImport from "../components/CcdaImport";
import AutofillPdf from "../components/AutofillPdf";      
import { api, apiFile, apiUpload, localDate } from "../api";


// Health documents: upload a PDF, JPG or PNG (8 MB each, 100 MB in total), search and
// filter them, view them in the page, download them, edit their details or delete them.
//   GET    /documents?category=&search=  -> { documents, storage }
//   POST   /documents?title=&...         -> upload (apiUpload)
//   PUT    /documents/:id                -> changed details only
//   DELETE /documents/:id
//   GET    /documents/:id/file          -> the file (apiFile)
// Everything from the server is shown as plain text. The page never logs document names or content.

type Doc = {
  document_id: string | number; title: string; category: string; provider: string | null;
  document_date: string | null; notes: string | null; tags: string[]; file_name: string;
  content_type: string; file_size: number; file_sha256?: string; is_encrypted?: boolean;
  created_at?: string; updated_at?: string;
};
type Storage = { used_bytes: number; limit_bytes: number };

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const CATEGORIES: { key: string; label: string }[] = [
  { key: "insurance", label: "Insurance" },
  { key: "visit_summary", label: "Visit summary" },
  { key: "imaging", label: "Imaging" },
  { key: "lab_report", label: "Lab report" },
  { key: "vaccination", label: "Vaccination" },
  { key: "prescription", label: "Prescription" },
  { key: "referral", label: "Referral" },
  { key: "hospital_discharge", label: "Hospital discharge" },
  { key: "advance_directive", label: "Advance directive" },
  { key: "billing", label: "Billing" },
  { key: "other", label: "Other" },
  { key: "health_record", label: "Health record (C-CDA)" }
];
const categoryLabel = (key: string) => CATEGORIES.find((c) => c.key === key)?.label ?? key;

const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
function sizeLabel(bytes: number) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${mb(n)} MB`;
}
// "Lab results 2025.PDF" -> "Lab results 2025"
const baseName = (name: string) => name.replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "").trim();

// Only these file types are ever opened in the page
const kindOf = (contentType: string): "pdf" | "image" | null =>
  contentType === "application/pdf" ? "pdf" : contentType === "image/jpeg" || contentType === "image/png" ? "image" : null;

type Viewing = { id: string; url: string; kind: "pdf" | "image"; title: string };

const emptyUpload = () => ({ title: "", category: "other", document_date: "", provider: "", tags: "", notes: "" });
const editFrom = (d: Doc) => ({
  title: d.title, category: d.category, document_date: d.document_date || "",
  provider: d.provider || "", tags: (d.tags || []).join(", "), notes: d.notes || "",
});

function Documents() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [storage, setStorage] = useState<Storage | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [listError, setListError] = useState("");     // the last list load failed
  const [message, setMessage] = useState("");

  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState("");        // sent to the server (after a short pause)
  const [category, setCategory] = useState("all");

  const [formOpen, setFormOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);        // resets the file input
  const [form, setForm] = useState(emptyUpload());

  const [viewing, setViewing] = useState<Viewing | null>(null);
  const viewUrl = useRef<string | null>(null);
  const [editing, setEditing] = useState<Doc | null>(null);
  const [editForm, setEditForm] = useState(editFrom({} as Doc));

  const requestId = useRef(0);

  // short pause after typing before the search goes to the server
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchText.trim()), 300);
    return () => clearTimeout(t);
  }, [searchText]);

  const load = useCallback(async () => {
    const mine = ++requestId.current;
    const qs = new URLSearchParams();
    if (category !== "all") qs.set("category", category);
    if (search) qs.set("search", search);
    const q = qs.toString();
    let r: { documents: Doc[]; storage: Storage };
    try {
      r = await api<{ documents: Doc[]; storage: Storage }>(`/documents${q ? `?${q}` : ""}`);
    } catch (e) {
      if (mine !== requestId.current) return;       // an older request failing is not worth showing
      throw e;
    }
    if (mine !== requestId.current) return;         // a newer request is already on its way
    setDocs(r.documents); setStorage(r.storage);
  }, [category, search]);

  // "Loading…" only covers the first load; later searches and filters update the list in place.
  // A list error is kept apart from action errors, so reloading never wipes a message from an action.
  useEffect(() => {
    load()
      .then(() => setListError(""))
      .catch((e) => setListError((e as Error).message))
      .finally(() => setLoading(false));
  }, [load]);

  // the blob URL is released when the viewer closes and when the page goes away
  function releaseView() {
    if (viewUrl.current) { URL.revokeObjectURL(viewUrl.current); viewUrl.current = null; }
  }
  useEffect(() => releaseView, []);
  function closeView() { releaseView(); setViewing(null); }

  const setF = (k: keyof ReturnType<typeof emptyUpload>) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const setE = (k: keyof ReturnType<typeof emptyUpload>) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setEditForm((f) => ({ ...f, [k]: e.target.value }));

  function chooseFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setError(""); setMessage("");
    if (f && f.size > MAX_FILE_BYTES) {
      setError("That file is too large (8 MB max)");
      setFile(null); setFileKey((k) => k + 1);
      return;
    }
    setFile(f);
  }

  function resetUpload() {
    setForm(emptyUpload()); setFile(null); setFileKey((k) => k + 1);
  }

  async function submitUpload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(""); setMessage("");
    if (!file) { setError("Choose a PDF, JPG or PNG file to upload"); return; }
    if (file.size > MAX_FILE_BYTES) { setError("That file is too large (8 MB max)"); return; }
    if (form.document_date && form.document_date > localDate()) { setError("The document date can't be in the future"); return; }
    const title = form.title.trim() || baseName(file.name);
    if (!title) { setError("Give the document a title"); return; }

    const qs = new URLSearchParams({ title, category: form.category, file_name: file.name });
    if (form.document_date) qs.set("document_date", form.document_date);
    if (form.provider.trim()) qs.set("provider", form.provider.trim());
    if (form.tags.trim()) qs.set("tags", form.tags.trim());
    if (form.notes.trim()) qs.set("notes", form.notes.trim());

    setBusy(true);
    try {
      const r = await apiUpload<{ message?: string; storage?: Storage }>(`/documents?${qs.toString()}`, file);
      setMessage(r.message || "Document saved");
      if (r.storage) setStorage(r.storage);
      resetUpload(); setFormOpen(false);
    } catch (e) { setError((e as Error).message); setBusy(false); return; }
    // the file is saved: a failed refresh must not look like a failed upload
    try { await load(); }
    catch (e) { setError(`Saved, but the list could not refresh: ${(e as Error).message}`); }
    finally { setBusy(false); }
  }

  async function view(d: Doc) {
    const kind = kindOf(d.content_type);
    if (!kind) { setError("This file type can't be shown here. Use Download instead."); return; }
    setError(""); setMessage(""); setBusy(true);
    try {
      const blob = await apiFile(`/documents/${encodeURIComponent(String(d.document_id))}/file`);
      releaseView();
      const url = URL.createObjectURL(new Blob([blob], { type: d.content_type }));
      viewUrl.current = url;
      setViewing({ id: String(d.document_id), url, kind, title: d.title });
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function download(d: Doc) {
    setError(""); setMessage(""); setBusy(true);
    try {
      const blob = await apiFile(`/documents/${encodeURIComponent(String(d.document_id))}/file`);
      const url = URL.createObjectURL(new Blob([blob], { type: d.content_type || blob.type }));
      const a = document.createElement("a");
      a.href = url; a.download = d.file_name || "document";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  function startEdit(d: Doc) {
    setEditing(d); setEditForm(editFrom(d)); setError(""); setMessage("");
    setTimeout(() => document.getElementById("document-edit")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }

  async function submitEdit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    setError(""); setMessage("");
    const before = editFrom(editing);
    const changes: Record<string, string> = {};
    for (const k of Object.keys(before) as (keyof typeof before)[]) {
      const now = k === "category" || k === "document_date" ? editForm[k] : editForm[k].trim();
      if (now !== before[k]) changes[k] = now;
    }
    if (!Object.keys(changes).length) { setError("Nothing changed"); return; }
    if ("title" in changes && !changes.title) { setError("Give the document a title"); return; }
    if (changes.document_date && changes.document_date > localDate()) { setError("The document date can't be in the future"); return; }

    setBusy(true);
    try {
      const r = await api<{ message?: string }>(`/documents/${encodeURIComponent(String(editing.document_id))}`,
        { method: "PUT", body: JSON.stringify(changes) });
      setMessage(r.message || "Document updated");
      setEditing(null);
    } catch (e) { setError((e as Error).message); setBusy(false); return; }
    try { await load(); }
    catch (e) { setError(`Saved, but the list could not refresh: ${(e as Error).message}`); }
    finally { setBusy(false); }
  }

  async function remove(d: Doc) {
    if (!window.confirm("Delete this document? This can't be undone.")) return;
    setError(""); setMessage(""); setBusy(true);
    try {
      const r = await api<{ message?: string }>(`/documents/${encodeURIComponent(String(d.document_id))}`, { method: "DELETE" });
      setMessage(r.message || "Document deleted");
      if (viewing?.id === String(d.document_id)) closeView();
      if (editing && String(editing.document_id) === String(d.document_id)) setEditing(null);
    } catch (e) { setError((e as Error).message); setBusy(false); return; }
    try { await load(); }
    catch (e) { setError(`Deleted, but the list could not refresh: ${(e as Error).message}`); }
    finally { setBusy(false); }
  }

  const pct = storage && storage.limit_bytes > 0 ? Math.min(100, (storage.used_bytes / storage.limit_bytes) * 100) : 0;
  const filtered = category !== "all" || search !== "";

  return (
    <>
      <NavigationBar />
      <main className="page-container">
        <section className="page-heading">
          <h2>Documents</h2>
          <p>Keep your health documents in one place: insurance cards, visit summaries, scans and more. PDF, JPG or PNG, up to 8 MB each.</p>
        </section>

        {(error || listError) && <p className="notice error" role="alert">{error || listError}</p>}
        {message && !error &&<p className="notice success" role="status">{message}</p>}

        {storage && (
          <div className="med-add" aria-label="Storage used">
            <p style={{ margin: "0 0 8px" }}>
              <strong>{mb(storage.used_bytes)} MB</strong> of {mb(storage.limit_bytes)} MB used
            </p>
            <progress style={{ width: "100%" }} value={storage.used_bytes} max={storage.limit_bytes}
              aria-label={`Storage used: ${mb(storage.used_bytes)} of ${mb(storage.limit_bytes)} MB`}>{Math.round(pct)}%</progress>
          </div>
        )}

        <AutofillPdf onDone={() => { load().catch((e) => setError((e as Error).message)); }} />

        <CcdaImport onDone={() => { load().catch((e) => setError((e as Error).message)); }} />

        <section aria-labelledby="docs-list">
          <div className="med-toolbar">
            <h3 id="docs-list">Your documents</h3>
            <button className="primary-button" type="button" onClick={() => { setFormOpen((o) => !o); setError(""); setMessage(""); }}>
              {formOpen ? "Cancel" : "Upload a document"}
            </button>
          </div>

          {formOpen && (
            <form className="med-add" onSubmit={submitUpload} noValidate>
              <h3>Upload a document</h3>
              <div className="med-add-grid">
                <label className="med-wide">File (PDF, JPG or PNG, 8 MB max) *
                  <input key={fileKey} type="file" accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png" onChange={chooseFile} />
                </label>
                <label>Title
                  <input value={form.title} onChange={setF("title")} maxLength={200}
                    placeholder={file ? baseName(file.name) : "Uses the file name if left blank"} />
                </label>
                <label>Type
                  <select value={form.category} onChange={setF("category")}>
                    {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                  </select>
                </label>
                <label>Document date (optional)
                  <input type="date" value={form.document_date} max={localDate()} onChange={setF("document_date")} />
                </label>
                <label>Provider (optional)
                  <input value={form.provider} onChange={setF("provider")} maxLength={200} />
                </label>
                <label>Tags (optional, separated by commas)
                  <input value={form.tags} onChange={setF("tags")} placeholder="e.g. 2025, insurance" />
                </label>
                <label className="med-wide">Notes (optional)
                  <textarea rows={2} value={form.notes} onChange={setF("notes")} maxLength={2000} />
                </label>
              </div>
              <button className="primary-button" type="submit" disabled={busy}>{busy ? "Saving…" : "Save document"}</button>
            </form>
          )}

          {editing && (
            <form id="document-edit" className="med-add" onSubmit={submitEdit} noValidate>
              <h3>Edit document details</h3>
              <div className="med-add-grid">
                <label>Title *
                  <input value={editForm.title} onChange={setE("title")} maxLength={200} />
                </label>
                <label>Type
                  <select value={editForm.category} onChange={setE("category")}>
                    {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                  </select>
                </label>
                <label>Document date (optional)
                  <input type="date" value={editForm.document_date} max={localDate()} onChange={setE("document_date")} />
                </label>
                <label>Provider (optional)
                  <input value={editForm.provider} onChange={setE("provider")} maxLength={200} />
                </label>
                <label>Tags (optional, separated by commas)
                  <input value={editForm.tags} onChange={setE("tags")} />
                </label>
                <label className="med-wide">Notes (optional)
                  <textarea rows={2} value={editForm.notes} onChange={setE("notes")} maxLength={2000} />
                </label>
              </div>
              <button className="primary-button" type="submit" disabled={busy}>{busy ? "Saving…" : "Save changes"}</button>
              <button className="secondary-button" type="button" disabled={busy} onClick={() => setEditing(null)}>Cancel</button>
            </form>
          )}

          <div className="med-toolbar">
            <label className="med-filter">Search
              <input type="search" value={searchText} onChange={(e) => setSearchText(e.target.value)} maxLength={100}
                placeholder="Title, provider, tag or note" />
            </label>
            <label className="med-filter">Type
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="all">All types</option>
                {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            </label>
          </div>

          {loading ? <p role="status">Loading…</p> : docs.length === 0 ? (
            <p>{filtered ? "No documents match your search." : "No documents yet. Use \"Upload a document\" to add your first one."}</p>
          ) : (
            <div className="med-list">
              {docs.map((d) => {
                const id = String(d.document_id);
                const isViewing = viewing?.id === id;
                return (
                  <article key={id} className="med-card">
                    <div className="med-main">
                      <div>
                        <h3>{d.title}</h3>
                        <p>
                          {categoryLabel(d.category)}
                          {d.document_date && <> · {d.document_date}</>}
                          {d.provider && <> · {d.provider}</>}
                          {" · "}{sizeLabel(d.file_size)}
                        </p>
                        {d.tags && d.tags.length > 0 && (
                          <p>{d.tags.map((t) => <span key={t} className="med-badge">{t}</span>)}</p>
                        )}
                        {d.notes && <p className="form-hint">{d.notes}</p>}
                      </div>
                    </div>
                    <div className="med-actions">
                      {kindOf(d.content_type)&&(
                        <button className="secondary-button" type="button" disabled={busy}
                          onClick={() => (isViewing ? closeView() : view(d))}>{isViewing ? "Close" : "View"}</button>
                      )}
                      <button className="secondary-button" type="button" disabled={busy} onClick={() => download(d)}>Download</button>
                      <button className="text-button med-link" type="button" disabled={busy} onClick={() => startEdit(d)}>Edit</button>
                      <button className="text-button med-link danger" type="button" disabled={busy} onClick={() => remove(d)}>Delete</button>
                    </div>
                    {isViewing && viewing && (
                      viewing.kind === "pdf"
                        ? <iframe className="lab-pdf" src={viewing.url} title={`Document: ${viewing.title}`} />
                        : <img src={viewing.url} alt={viewing.title} style={{ display: "block", maxWidth: "100%", height: "auto", marginTop: 12 }} />
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

export default Documents;
