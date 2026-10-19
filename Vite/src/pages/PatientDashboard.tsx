import AlertBanner from "../components/AlertBanner";
import MedicalRecordCard from "../components/MedicalRecordCard";
import NavigationBar from "../components/NavigationBar";
import ProfileCard from "../components/ProfileCard";
import ShareButton from "../components/ShareButton";
import { Link, useNavigate } from 'react-router-dom';
import { currentName } from "../api";

function PatientDashboard() {
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
          message="Your medical information is protected. Only share records with authorized healthcare providers."
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
            title="Medications"
            count={3}
            description="View current and previous medications."
          />

          <MedicalRecordCard
            title="Allergies"
            count={2}
            description="Review documented allergies and reactions."
          />

          <MedicalRecordCard
            title="Immunizations"
            count={6}
            description="View vaccination history and dates."
          />

          <MedicalRecordCard
            title="Procedures"
            count={1}
            description="Review previous medical procedures."
          />
        </section>
      </main>
    </>
  );
}

export default PatientDashboard;
