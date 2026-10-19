import { useState } from "react";
import AlertBanner from "../components/AlertBanner";
import NavigationBar from "../components/NavigationBar";
import ProfileCard from "../components/ProfileCard";
import SharedRecordView from "../components/SharedRecordView";
import { api, currentName, type SharedView } from "../api";

// Physicians READ patient records through a provider sharing code the patient gives
// them. Everything shown is read-only. Each open is logged, and the patient can see
// that log.
function PhysicianDashboard() {
  const [sharingCode, setSharingCode] = useState("");
  const [view, setView] = useState<SharedView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function accessRecords(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = sharingCode.trim().toUpperCase();
    if (!code) { setError("Enter the patient's sharing code."); return; }
    setBusy(true); setError(""); setView(null);
    try {
      const data = await api<SharedView>(`/shared/${encodeURIComponent(code)}`, { method: "POST", body: "{}" });
      setView(data);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <>
      <NavigationBar />

      <main className="page-container">
        <AlertBanner
          message="Patient information should only be accessed for authorized medical purposes."
          type="info"
        />

        <section className="dashboard-header">
          <div>
            <h2>Physician Dashboard</h2>
            <p>Read patient records that patients have shared with you. Records are read-only.</p>
          </div>
        </section>

        <ProfileCard
          name={currentName() || "Physician"}
          role="Physician"
        />

        <section className="dashboard-section">
          <h3>Access Patient Records</h3>

          {error && <p className="notice error" role="alert">{error}</p>}

          <form className="access-code-form" onSubmit={accessRecords}>
            <label htmlFor="sharing-code">Patient Sharing Code</label>

            <input
              id="sharing-code"
              type="text"
              placeholder="XXXX-XXXX"
              autoComplete="off"
              value={sharingCode}
              onChange={(e) => setSharingCode(e.target.value)}
            />

            <button className="primary-button" type="submit" disabled={busy}>
              {busy ? "Looking up…" : "Access Records"}
            </button>
          </form>

          {view && <SharedRecordView view={view} />}
        </section>
      </main>
    </>
  );
}

export default PhysicianDashboard;
