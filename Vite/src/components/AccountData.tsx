import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, clearSession } from "../api";
import PasswordInput from "./PasswordInput";

// Your data: download everything as a file, or delete the account. Both ask for your password again.
//   POST /account/export       GET/POST/DELETE /account/deletion
// Deletion waits 7 days (you can cancel); "delete right now" skips the wait.

type Status = { pending: boolean; scheduled_for?: string; days_left?: number; grace_days: number; confirm_phrase: string };

export default function AccountData() {
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [files, setFiles] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [now, setNow] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api<Status>("/account/deletion").then(setStatus), []);
  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, [load]);

  async function run(fn: () => Promise<void>) {
    setBusy(true); setError(""); setMessage("");
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); setPassword(""); }
  }

  const download = () => run(async () => {
    const r = await api<{ file_name: string }>("/account/export", { method: "POST", body: JSON.stringify({ password, include_files: files }) });
    const url = URL.createObjectURL(new Blob([JSON.stringify(r, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url; a.download = r.file_name; a.click();
    URL.revokeObjectURL(url);
    setMessage("Your file was downloaded. It holds private health information, so keep it somewhere safe.");
  });

  const remove = () => run(async () => {
    const r = await api<{ deleted?: boolean; message: string }>("/account/deletion", { method: "POST", body: JSON.stringify({ password, confirm: phrase, immediate: now }) });
    if (r.deleted) { await clearSession(); navigate("/", { state: { loggedOutReason: r.message } }); return; }
    setMessage(r.message); setPhrase(""); await load();
  });

  const cancel = () => run(async () => {
    const r = await api<{ message: string }>("/account/deletion", { method: "DELETE" });
    setMessage(r.message); await load();
  });

  const row: React.CSSProperties = { display: "flex", flexDirection: "row", alignItems: "center", gap: 8, margin: "4px 0" };
  const box: React.CSSProperties = { width: "auto", margin: 0, flex: "none" };

  return (
    <section className="settings-card">
      <h3>Your data</h3>
      {error && <p className="notice error" role="alert">{error}</p>}
      {message && !error && <p className="notice success" role="status">{message}</p>}

      <PasswordInput id="acct-password" label="Your password (needed for both actions below)" value={password} onChange={setPassword} autoComplete="current-password" />

      <h4>Download my data</h4>
      <p>Everything in your account as one file (JSON).</p>
      <label style={row}><input style={box} type="checkbox" checked={files} onChange={(e) => setFiles(e.target.checked)} /><span>Include my uploaded files (PDFs, images)</span></label>
      <button className="secondary-button" type="button" disabled={busy || !password} onClick={download}>Download my data</button>

      <h4>Delete my account</h4>
      {status?.pending ? (
        <>
          <p className="notice error">Your account will be deleted on {status.scheduled_for ? new Date(status.scheduled_for).toLocaleDateString() : "—"} ({status.days_left} day(s) left).</p>
          <button className="primary-button" type="button" disabled={busy} onClick={cancel}>Cancel the deletion</button>
        </>
      ) : (
        <>
          <p>This permanently erases your records, documents, share codes and login. We suggest downloading your data first. It is deleted after {status?.grace_days ?? 7} days and you can cancel until then.</p>
          <div className="form-group">
            <label htmlFor="acct-phrase">Type {status?.confirm_phrase ?? "DELETE MY ACCOUNT"} to confirm</label>
            <input id="acct-phrase" autoComplete="off" value={phrase} onChange={(e) => setPhrase(e.target.value)} />
          </div>
          <label style={row}><input style={box} type="checkbox" checked={now} onChange={(e) => setNow(e.target.checked)} /><span>Delete right now (no waiting period, can’t be undone)</span></label>
          <button className="danger-button" type="button" disabled={busy || !password || phrase !== (status?.confirm_phrase ?? "DELETE MY ACCOUNT")} onClick={remove}>
            {now ? "Delete my account now" : "Schedule deletion"}
          </button>
        </>
      )}
    </section>
  );
}
