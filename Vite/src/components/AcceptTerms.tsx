import { useState } from "react";
import { Link } from "react-router-dom";
import { api, logout } from "../api";
import { MIN_AGE, SITE_NAME } from "../legal";

// Shown instead of the app when the account has not agreed to the CURRENT Terms of Service and Privacy Policy
// (accounts made before they existed, or after they changed). POST /account/accept-terms records the agreement.
function AcceptTerms({ onDone }: { onDone: () => void }) {
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function accept() {
    setBusy(true); setError("");
    try { await api("/account/accept-terms", { method: "POST", body: JSON.stringify({ accepted: true }) }); onDone(); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  }

  return (
    <main className="login-page">
      <section className="login-card">
        <h1>Our terms have been updated</h1>
        <p>Before you continue, please read and agree to the {SITE_NAME} <Link to="/terms" target="_blank">Terms of Service</Link>, <Link to="/privacy" target="_blank">Privacy Policy</Link> and <Link to="/disclaimer" target="_blank">Medical Disclaimer</Link>.</p>
        {error && <p role="alert" className="notice error">{error}</p>}
        <label className="check-row">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          <span>I am {MIN_AGE} or older and I agree to the Terms of Service, Privacy Policy and Medical Disclaimer.</span>
        </label>
        <button className="primary-button full-width" type="button" disabled={!agreed || busy} onClick={accept}>{busy ? "Saving…" : "Agree and continue"}</button>
        <button className="secondary-button full-width" type="button" onClick={() => logout().then(() => window.location.assign("/"))}>Log out instead</button>
      </section>
    </main>
  );
}

export default AcceptTerms;
