import AlertBanner from "../components/AlertBanner";
import MedicalRecordCard from "../components/MedicalRecordCard";
import NavigationBar from "../components/NavigationBar";
import ProfileCard from "../components/ProfileCard";
import ShareButton from "../components/ShareButton";
import { Link, useNavigate } from 'react-router-dom';
import { currentName } from "../api";
import { listMedications } from "../data/medications";
import { getRecord } from "../data/records";
import { normalizeHealthHistory } from "../healthHistory";
import { useEffect, useState } from "react";

type Counts = { medications: number; allergies: number; immunizations: number; procedures: number };

// Real counts for the 4 cards: active medications from the tracker (Parse SDK, data/medications.ts),
// and the filled lines of the Health History form (data/records.ts getRecord). "Filled" is the same rule the
// Medical Records list uses, so the numbers match what that page shows.
async function loadCounts(): Promise<Counts> {
  const [meds, rec] = await Promise.all([
    listMedications(),
    getRecord(),
  ]);
  const h = normalizeHealthHistory(rec.data);
  return {
    medications: meds.filter((m) => m.status === "active").length,
    allergies: h.allergies.filter((a) => a.allergen.trim()).length,
    immunizations: h.immunizations.filter((v) => v.vaccine.trim()).length,
    procedures: h.surgeries.filter((s) => s.type.trim()).length,
  };
}

function PatientDashboard() {
  const [counts, setCounts] = useState<Counts | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    loadCounts()
      .then((c) => { if (!cancelled) { setCounts(c); setError(""); } })
      .catch((e) => { if (!cancelled) setError(`Could not load your record counts: ${(e as Error).message}`); });
    return () => { cancelled = true; };
  }, []);

  const navigate = useNavigate();

  // Used to pop up "Opening the Share Records page." and then not open it.
  function handleShareRecords() {
    navigate("/share-records");
  }

  return (
    <>
      <NavigationBar />

      <main className="page-container">
        <AlertBanner
          message="Your medical information is protected. Only share your records with people you trust."
          type="info"
        />

        <section className="dashboard-header">
          <div>
            <h2>Patient Dashboard</h2>
            <p>Review and manage your medical information.</p>
          </div>

          <ShareButton
            text="Generate Sharing Code"
            onClick={handleShareRecords}
          />
        </section>

        {/* the logged-in patient's real name (was hard-coded "Maria Rodriguez", P-10045) */}
        <ProfileCard
          name={currentName() || "Patient"}
          role="Patient"
        />

        {error && <p className="notice error" role="alert">{error}</p>}

        <section className="record-grid">
          <Link className="feature-card dashboard-link" to="/health-diary"><h3>Health Diary</h3><p>Record and review your health notes.</p></Link>
          <Link className="feature-card dashboard-link" to="/vital-signs"><h3>Vital Signs</h3><p>Log readings and explore trends.</p></Link>
          <Link className="feature-card dashboard-link" to="/medications"><h3>Medications</h3><p>Track pills on hand, doses taken and refills.</p></Link>
          <Link className="feature-card dashboard-link" to="/lab-results"><h3>Lab Results</h3><p>Upload lab PDFs and see which results are out of range.</p></Link>
          <Link className="feature-card dashboard-link" to="/my-links"><h3>My Links</h3><p>Insurance, pharmacy and patient portal websites.</p></Link>
          <Link className="feature-card dashboard-link" to="/documents"><h3>Documents</h3><p>Keep your medical documents in one place.</p></Link>
          <Link className="feature-card dashboard-link" to="/reminders"><h3>Reminders</h3><p>Set reminders for doses and appointments.</p></Link>
          <Link className="feature-card dashboard-link" to="/respiratory"><h3>Breathing Devices</h3><p>Track your breathing devices and how you use them.</p></Link>
          <Link className="feature-card dashboard-link" to="/disposal"><h3>Safe Disposal</h3><p>Learn how to safely get rid of leftover medicine.</p></Link>
          
          <MedicalRecordCard
            title="Medical Records"
            description="Your health history, medications, allergies, immunizations and procedures."
          />
        </section>
      </main>
    </>
  );
}

export default PatientDashboard;
