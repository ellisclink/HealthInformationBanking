import { useEffect, useState } from "react";
import AlertBanner from "../components/AlertBanner";
import NavigationBar from "../components/NavigationBar";
import { api, SHARE_SECTIONS, type ShareAudience, type ShareSection } from "../api";

type Share = {
  share_code: string; expires_at: string; revoked: boolean; created_at?: string;
  audience: ShareAudience; sections: ShareSection[]; label: string | null;
};
type AccessEntry = {
  accessed_at: string; action: "view" | "verify"; audience: ShareAudience; share_code: string;
  viewer_name: string; viewer_npi: string | null; sections: ShareSection[] | null; label: string | null;
};

const EXPIRATION_OPTIONS = [
  { hours: 1, label: "1 Hour" },
  { hours: 12, label: "12 Hours" },
  { hours: 24, label: "24 Hours" },
  { hours: 168, label: "7 Days" },
];
const AUDIENCE_LABEL: Record<ShareAudience, string> = { provider: "Healthcare provider", family: "Family or friend" };
const sectionNames = (list: ShareSection[] | null) =>
  (list ?? []).map((k) => SHARE_SECTIONS.find((s) => s.key === k)?.label ?? k).join(", ");

// Patients choose who each code is for and what it shows. Everything shared is
// read-only. Provider codes only open for a logged-in physician; family codes open
// for anyone with the code, who must give their name. The "Who viewed your records"
// list shows every open (older "verify" entries from before D-015 still display).
function ShareRecords() {
  const [expiresHours, setExpiresHours] = useState(24);
  const [audience, setAudience] = useState<ShareAudience>("provider");
  const [sections, setSections] = useState<ShareSection[]>(SHARE_SECTIONS.map((s) => s.key));
  const [label, setLabel] = useState("");
  const [newCode, setNewCode] = useState<Share | null>(null);
  const [shares, setShares] = useState<Share[]>([]);
  const [log, setLog] = useState<AccessEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function refresh() {
    const [s, l] = await Promise.all([
      api<{ shares: Share[] }>("/share"),
      api<{ entries: AccessEntry[] }>("/share/access-log"),
    ]);
    setShares(s.shares); setLog(l.entries);
  }

  useEffect(() => {
    Promise.all([api<{ shares: Share[] }>("/share"), api<{ entries: AccessEntry[] }>("/share/access-log")])
      .then(([s, l]) => { setShares(s.shares); setLog(l.entries); })
      .catch((e) => setError((e as Error).message));
  }, []);

  function toggleSection(key: ShareSection) {
    setSections((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]));
  }

  async function generateCode() {
    if (sections.length === 0) { setError("Choose at least one thing to share."); return; }
    setBusy(true); setError(""); setMessage("");
    try {
      const data = await api<{ shareCode: string; expiresInHours: number; audience: ShareAudience; sections: ShareSection[]; label: string | null }>("/share", {
        method: "POST", body: JSON.stringify({ expiresHours, audience, sections, label: label.trim() || null }),
      });
      setNewCode({
        share_code: data.shareCode, audience: data.audience, sections: data.sections, label: data.label,
        expires_at: new Date(Date.now() + data.expiresInHours * 3600000).toISOString(), revoked: false,
      });
      setLabel("");
      await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function revoke(code: string) {
    setBusy(true); setError(""); setMessage("");
    try {
      await api(`/share/${encodeURIComponent(code)}`, { method: "DELETE" });
      if (newCode?.share_code === code) setNewCode(null);
      setMessage(`Code ${code} was revoked. It no longer opens your records.`);
      await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setMessage("Copied.");
    } catch {
      // clipboard needs https or localhost; don't fail silently
      setError("Couldn't copy automatically. Select it and copy it by hand.");
    }
  }

  const activeShares = shares.filter((s) => !s.revoked);
  const familyLink = newCode ? `${window.location.origin}/view?code=${newCode.share_code}` : "";

  return (
    <>
      <NavigationBar />

      <main className="page-container">
        <AlertBanner
          message="Anyone with a sharing code can read what it includes until it expires or you revoke it. Shared records are read-only."
          type="info"
        />

        <section className="page-heading">
          <h2>Share Medical Records</h2>
          <p>Make a temporary, read-only code for a doctor or for family and friends.</p>
        </section>

        {error && <p className="notice error" role="alert">{error}</p>}
        {message && !error && <p className="notice success" role="status">{message}</p>}

        <section className="share-card">
          <fieldset className="checkbox-group">
            <legend>Who is this code for?</legend>
            {(Object.keys(AUDIENCE_LABEL) as ShareAudience[]).map((a) => (
              <label key={a}>
                <input type="radio" name="audience" value={a} checked={audience === a} onChange={() => setAudience(a)} />
                {AUDIENCE_LABEL[a]}
              </label>
            ))}
          </fieldset>
          <p className="form-hint">
            {audience === "provider"
              ? "Only a doctor logged in with a physician account can open it. They can read it but can't change anything."
              : "Anyone with the code can read it without an account. They'll be asked for their name, and you'll see who viewed it."}
          </p>

          <fieldset className="checkbox-group">
            <legend>What should it show?</legend>
            {SHARE_SECTIONS.map((s) => (
              <label key={s.key}>
                <input type="checkbox" checked={sections.includes(s.key)} onChange={() => toggleSection(s.key)} />
                {s.label}
              </label>
            ))}
          </fieldset>

          <div className="form-group">
            <label htmlFor="share-label">Note for yourself (optional)</label>
            <input id="share-label" maxLength={100} placeholder={audience === "provider" ? "e.g. Dr. Lee, cardiology" : "e.g. Mom"}
              value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>

          <div className="form-group">
            <label htmlFor="expiration">Code Expiration</label>
            <select
              id="expiration"
              value={expiresHours}
              onChange={(event) => setExpiresHours(Number(event.target.value))}
            >
              {EXPIRATION_OPTIONS.map((o) => <option key={o.hours} value={o.hours}>{o.label}</option>)}
            </select>
          </div>

          <button className="primary-button" type="button" onClick={generateCode} disabled={busy}>
            {busy ? "Working…" : "Generate Sharing Code"}
          </button>

          {newCode && (
            <div className="generated-code">
              <p>Your {newCode.audience === "provider" ? "provider" : "family & friends"} sharing code is:</p>
              <strong className="share-code">{newCode.share_code}</strong>
              <p>Shows: {sectionNames(newCode.sections)}. Expires {new Date(newCode.expires_at).toLocaleString()}.</p>
              {newCode.audience === "family" && (
                <p>They can open it at <strong>{familyLink}</strong></p>
              )}

              <div className="qr-placeholder">
                <span>QR Code Placeholder</span>
              </div>

              <button className="secondary-button" type="button" onClick={() => copy(newCode.share_code)}>
                Copy Code
              </button>
              {newCode.audience === "family" && (
                <> <button className="secondary-button" type="button" onClick={() => copy(familyLink)}>Copy Link</button></>
              )}
            </div>
          )}
        </section>

        <section className="share-card">
          <h3>Active codes</h3>
          {activeShares.length === 0 ? (
            <p>You have no active sharing codes.</p>
          ) : (
            <ul className="share-list">
              {activeShares.map((s) => (
                <li key={s.share_code}>
                  <span>
                    <span className="share-code">{s.share_code}</span>
                    {" "}· {AUDIENCE_LABEL[s.audience]}{s.label && <> ({s.label})</>}
                    <span className="shared-sub"> Shows {sectionNames(s.sections)} · expires {new Date(s.expires_at).toLocaleString()}</span>
                  </span>
                  <button className="danger-button" type="button" disabled={busy} onClick={() => revoke(s.share_code)}>
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="share-card">
          <h3>Who viewed your records</h3>
          {log.length === 0 ? (
            <p>No one has opened your shared records yet.</p>
          ) : (
            <div className="table-scroll">
              <table className="access-log">
                <thead>
                  <tr><th>When</th><th>Who</th><th>What happened</th><th>Code</th></tr>
                </thead>
                <tbody>
                  {log.map((e, i) => (
                    <tr key={i}>
                      <td>{new Date(e.accessed_at).toLocaleString()}</td>
                      <td>{e.viewer_name}{e.viewer_npi && <> (NPI {e.viewer_npi})</>}<div className="shared-sub">{AUDIENCE_LABEL[e.audience]}</div></td>
                      <td>{e.action === "verify" ? "Verified your record" : <>Viewed {sectionNames(e.sections)}</>}</td>
                      <td><span className="share-code">{e.share_code}</span>{e.label && <div className="shared-sub">{e.label}</div>}</td>
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

export default ShareRecords;
