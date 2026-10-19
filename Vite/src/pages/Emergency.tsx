import { useCallback, useEffect, useState } from "react";
import AlertBanner from "../components/AlertBanner";
import NavigationBar from "../components/NavigationBar";
import { api } from "../api";

// Emergency access: what an emergency responder may see, your DNR / declined-treatment wishes, and the emergency code.
//   GET/PUT /emergency/settings     GET /emergency/preview     POST/DELETE /emergency/code     GET /emergency/access-log
// Responders open the code at /emergency-access (no account). Everything from the server is shown as plain text.

type Contact = { name: string; phone: string; relationship: string | null };
type Settings = {
  enabled: boolean; sections: string[]; blood_type: string | null; medical_notes: string | null; contacts: Contact[];
  code_status: string; declined_measures: string[]; directive_notes: string | null; polst_on_file: boolean;
  directive_document_id: string | null; share_directive_document: boolean; directive_updated_at: string | null;
};
type SettingsReply = {
  settings: Settings;
  access: { has_code: boolean; code: string | null; created_at: string | null; last_opened_at: string | null; open_count: number };
  options: {
    code_statuses: { value: string; label: string }[]; measures: { value: string; label: string }[];
    implied_by_status: Record<string, string[]>; sections: string[]; blood_types: string[]; max_contacts: number;
  };
  disclaimer: string;
};
type LogEntry = { accessed_at: string; action: string; responder_name: string; agency: string | null; badge_id: string | null; reason: string | null };
type Doc = { document_id: string; title: string; category: string };
type Preview = Record<string, unknown> & { directives?: { alert: string } | null };

const SECTION_LABELS: Record<string, string> = {
  allergies: "Allergies", medications: "Current medications", conditions: "Conditions", contacts: "Emergency contacts", devices: "Breathing devices (CPAP/BiPAP/oxygen)",
};
const row: React.CSSProperties = { display: "flex", flexDirection: "row", alignItems: "center", gap: 8, margin: "4px 0" };
const box: React.CSSProperties = { width: "auto", margin: 0, flex: "none" };
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "never");

function Emergency() {
  const [data, setData] = useState<SettingsReply | null>(null);
  const [form, setForm] = useState<Settings | null>(null);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => Promise.all([
    api<SettingsReply>("/emergency/settings"),
    api<{ documents: Doc[] }>("/documents?category=advance_directive"),
    api<{ entries: LogEntry[] }>("/emergency/access-log"),
  ]).then(([s, d, l]) => { setData(s); setForm(s.settings); setDocs(d.documents); setLog(l.entries); }), []);
  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, [load]);

  if (!data || !form) {
    return (<><NavigationBar /><main className="page-container">{error ? <p className="notice error" role="alert">{error}</p> : <p>Loading…</p>}</main></>);
  }
  const { options } = data;
  const implied = options.implied_by_status[form.code_status] || [];
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setForm({ ...form, [k]: v });
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  async function run(fn: () => Promise<void>, ok: string) {
    setBusy(true); setError(""); setMessage("");
    try { await fn(); setMessage(ok); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const save = () => run(async () => {
    const f = form!;
    const r = await api<{ settings: Settings }>("/emergency/settings", { method: "PUT", body: JSON.stringify({
      enabled: f.enabled, sections: f.sections, blood_type: f.blood_type, medical_notes: f.medical_notes, contacts: f.contacts.filter((c) => c.name && c.phone),
      code_status: f.code_status, declined_measures: f.declined_measures, directive_notes: f.directive_notes, polst_on_file: f.polst_on_file,
      directive_document_id: f.directive_document_id, share_directive_document: f.share_directive_document,
    }) });
    setForm(r.settings); await load();
  }, "Emergency settings saved");
  const newCode = () => run(async () => { await api("/emergency/code", { method: "POST" }); await load(); }, "New emergency code created. The old one no longer works.");
  const turnOff = () => run(async () => { await api("/emergency/code", { method: "DELETE" }); await load(); }, "Emergency code turned off");
  const showPreview = () => run(async () => { setPreview((await api<{ preview: Preview }>("/emergency/preview")).preview); }, "This is what a responder sees with your saved settings.");

  return (
    <>
      <NavigationBar />
      <main className="page-container">
        <AlertBanner message={data.disclaimer} type="info" />
        <section className="page-heading">
          <h2>Emergency Access</h2>
          <p>Choose what emergency responders can see and give them a code to open it. They don’t need an account, you are told every time it is opened.</p>
        </section>
        {error && <p className="notice error" role="alert">{error}</p>}
        {message && !error && <p className="notice success" role="status">{message}</p>}

        <section className="settings-card">
          <h3>Emergency code</h3>
          <p>Status: <strong>{data.settings.enabled ? "On, responders can open it with the code" : "Off, codes will not work"}</strong></p>
          <label className="toggle-row">
            <span>Turn on emergency access</span>
            <input type="checkbox" checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} />
          </label>
          {data.access.has_code ? (
            <>
              <p>Code for your wallet card or phone: <strong style={{ fontSize: "1.4em", letterSpacing: 1 }}>{data.access.code}</strong></p>
              <p>Opened {data.access.open_count} time(s). Last opened: {when(data.access.last_opened_at)}.</p>
              <p>Responders open it at <strong>{window.location.origin}/emergency-access</strong></p>
              <button className="secondary-button" type="button" disabled={busy} onClick={newCode}>Replace code</button>{" "}
              <button className="danger-button" type="button" disabled={busy} onClick={turnOff}>Turn code off</button>
            </>
          ) : (
            <button className="primary-button" type="button" disabled={busy} onClick={newCode}>Create emergency code</button>
          )}
          <p><small className="form-hint">Tick “Turn on emergency access” and press Save below. Access stays off until you do.</small></p>
        </section>

        <section className="settings-card">
          <h3>Your wishes: DNR and treatments you decline</h3>
          <div className="form-group">
            <label htmlFor="code-status">Overall wish</label>
            <select id="code-status" value={form.code_status} onChange={(e) => set("code_status", e.target.value)}>
              {options.code_statuses.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <fieldset>
            <legend>Treatments I do NOT want</legend>
            {options.measures.map((m) => {
              const forced = implied.includes(m.value);
              return (
                <label key={m.value} style={row}>
                  <input style={box} type="checkbox" checked={forced || form.declined_measures.includes(m.value)} disabled={forced}
                    onChange={() => set("declined_measures", toggle(form.declined_measures, m.value))} />
                  <span>{m.label}{forced && " (from your overall wish)"}</span>
                </label>
              );
            })}
          </fieldset>
          <label style={row}>
            <input style={box} type="checkbox" checked={form.polst_on_file} onChange={(e) => set("polst_on_file", e.target.checked)} />
            <span>I have a signed DNR / POLST / MOLST form</span>
          </label>
          <div className="form-group">
            <label htmlFor="directive-doc">Attach the signed form (from your Documents, type “Advance directive”)</label>
            <select id="directive-doc" value={form.directive_document_id ?? ""} onChange={(e) => set("directive_document_id", e.target.value || null)}>
              <option value="">None</option>
              {docs.map((d) => <option key={d.document_id} value={d.document_id}>{d.title}</option>)}
            </select>
          </div>
          <label style={row}>
            <input style={box} type="checkbox" checked={form.share_directive_document && !!form.directive_document_id} disabled={!form.directive_document_id}
              onChange={(e) => set("share_directive_document", e.target.checked)} />
            <span>Let responders open that document</span>
          </label>
          <div className="form-group">
            <label htmlFor="directive-notes">Notes for responders (optional)</label>
            <textarea id="directive-notes" maxLength={1000} value={form.directive_notes ?? ""} onChange={(e) => set("directive_notes", e.target.value)} />
          </div>
          <p><small className="form-hint">Last changed: {when(form.directive_updated_at)}. These are your wishes, not a medical order. Responders are told this.</small></p>
        </section>

        <section className="settings-card">
          <h3>What else responders can see</h3>
          {options.sections.map((s) => (
            <label key={s} style={row}>
              <input style={box} type="checkbox" checked={form.sections.includes(s)} onChange={() => set("sections", toggle(form.sections, s))} />
              <span>{SECTION_LABELS[s] ?? s}</span>
            </label>
          ))}
          <p><small className="form-hint">Your name, age and your wishes above are always shown.</small></p>
          <div className="form-group">
            <label htmlFor="blood-type">Blood type</label>
            <select id="blood-type" value={form.blood_type ?? ""} onChange={(e) => set("blood_type", e.target.value || null)}>
              <option value="">Not shown</option>
              {options.blood_types.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="medical-notes">Important medical notes (pacemaker, implants…)</label>
            <textarea id="medical-notes" maxLength={500} value={form.medical_notes ?? ""} onChange={(e) => set("medical_notes", e.target.value)} />
          </div>
          <h4>Extra emergency contacts</h4>
          {form.contacts.map((c, i) => (
            <div className="form-grid" key={i}>
              {(["name", "phone", "relationship"] as const).map((k) => (
                <input key={k} aria-label={`Contact ${i + 1} ${k}`} placeholder={k[0].toUpperCase() + k.slice(1)} value={c[k] ?? ""}
                  onChange={(e) => set("contacts", form.contacts.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)))} />
              ))}
              <button className="secondary-button" type="button" onClick={() => set("contacts", form.contacts.filter((_, j) => j !== i))}>Remove</button>
            </div>
          ))}
          {form.contacts.length < options.max_contacts && (
            <button className="secondary-button" type="button" onClick={() => set("contacts", [...form.contacts, { name: "", phone: "", relationship: "" }])}>Add a contact</button>
          )}
        </section>

        <div className="med-toolbar">
          <button className="primary-button" type="button" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</button>
          <button className="secondary-button" type="button" disabled={busy} onClick={showPreview}>Preview what a responder sees</button>
        </div>

        {preview && (
          <section className="settings-card" aria-label="Responder preview">
            <h3>Preview (saved settings)</h3>
            {preview.directives && <p className="notice error"><strong>{preview.directives.alert}</strong></p>}
            <pre style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>{JSON.stringify(preview, null, 2)}</pre>
          </section>
        )}

        <section className="settings-card">
          <h3>Who opened it</h3>
          {log.length === 0 ? <p>Nobody yet.</p> : (
            <ul>
              {log.map((l, i) => (
                <li key={i}>{when(l.accessed_at)}: <strong>{l.responder_name}</strong>, {l.agency}{l.badge_id ? ` (${l.badge_id})` : ""}
                  {l.reason ? ` — ${l.reason}` : ""}{l.action === "emergency_view_document" ? " [opened your directive document]" : ""}</li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}

export default Emergency;
