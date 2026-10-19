import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import SharedRecordView from "../components/SharedRecordView";
import { api, type SharedView } from "../api";

// Public page for family and friends. No account needed: enter the code the patient
// gave you and your name. The patient can see who opened their record and when.
// Healthcare-provider codes don't open here; those need a physician login.
function ViewShared() {
  const [params] = useSearchParams();
  const [code, setCode] = useState(params.get("code") ?? "");
  const [name, setName] = useState("");
  const [view, setView] = useState<SharedView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function open(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!code.trim()) { setError("Enter the sharing code."); return; }
    if (!name.trim()) { setError("Enter your name. The patient will see who viewed their record."); return; }
    setBusy(true); setError(""); setView(null);
    try {
      setView(await api<SharedView>(`/shared/${encodeURIComponent(code.trim().toUpperCase())}`, {
        method: "POST", body: JSON.stringify({ viewerName: name.trim() }),
      }));
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <main className="page-container">
      <section className="page-heading">
        <h2>View a Shared Record</h2>
        <p>Someone shared their health information with you. Enter the code they gave you to view it (read-only).</p>
      </section>

      {error && <p className="notice error" role="alert">{error}</p>}

      <section className="share-card">
        <form className="access-code-form" onSubmit={open} noValidate>
          <label htmlFor="view-code">Sharing code</label>
          <input id="view-code" placeholder="XXXX-XXXX" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} />

          <label htmlFor="view-name">Your name</label>
          <input id="view-name" autoComplete="name" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
          <small className="form-hint">The person who shared this will see your name and when you viewed it.</small>

          <button className="primary-button" type="submit" disabled={busy}>{busy ? "Opening…" : "View record"}</button>
        </form>

        {view && <SharedRecordView view={view} />}
      </section>

      <p className="auth-switch"><Link to="/">Back to log in</Link></p>
    </main>
  );
}

export default ViewShared;
