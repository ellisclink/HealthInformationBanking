import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import "./features.css";
import RequireAuth from "./components/RequireAuth";
import Login from "./pages/Login";
import Register from "./pages/Register";
import ViewShared from "./pages/ViewShared";
import MedicalRecords from "./pages/MedicalRecords";
import PatientDashboard from "./pages/PatientDashboard";
import PhysicianDashboard from "./pages/PhysicianDashboard";
import Settings from "./pages/Settings";
import ShareRecords from "./pages/ShareRecords";
import HealthDiary from "./pages/HealthDiary";
import VitalSigns from "./pages/VitalSigns";
import Medications from "./pages/Medications";
import LabResults from "./pages/LabResults";
import MyLinks from "./pages/MyLinks";
import Disposal from "./pages/Disposal";
import Documents from "./pages/Documents";
import Respiratory from "./pages/Respiratory";
import Reminders from "./pages/Reminders";
import Nutrition from "./pages/Nutrition";
import Calendar from "./pages/Calendar";
import Conditions from "./pages/Conditions";
import Emergency from "./pages/Emergency";
import EmergencyAccess from "./pages/EmergencyAccess";
import PreVisit from "./pages/PreVisit";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* public */}
        <Route path="/" element={<Login />} />
        <Route path="/register" element={<Register />} />
        {/* family & friends open a shared record here with a code, no account needed */}
        <Route path="/view" element={<ViewShared />} />
        {/* emergency responders open a patient's emergency code here, no account needed */}
        <Route path="/emergency-access" element={<EmergencyAccess />} />

        {/* patients only */}
        <Route path="/patient-dashboard" element={<RequireAuth role="patient"><PatientDashboard /></RequireAuth>} />
        <Route path="/share-records" element={<RequireAuth role="patient"><ShareRecords /></RequireAuth>} />
        <Route path="/health-diary" element={<RequireAuth role="patient"><HealthDiary /></RequireAuth>} />
        <Route path="/vital-signs" element={<RequireAuth role="patient"><VitalSigns /></RequireAuth>} />
        <Route path="/medications" element={<RequireAuth role="patient"><Medications /></RequireAuth>} />
        <Route path="/lab-results" element={<RequireAuth role="patient"><LabResults /></RequireAuth>} />
        <Route path="/my-links" element={<RequireAuth role="patient"><MyLinks /></RequireAuth>} />
        <Route path="/disposal" element={<RequireAuth role="patient"><Disposal /></RequireAuth>} />
        <Route path="/documents" element={<RequireAuth role="patient"><Documents /></RequireAuth>} />
        <Route path="/respiratory" element={<RequireAuth role="patient"><Respiratory /></RequireAuth>} />
        <Route path="/reminders" element={<RequireAuth role="patient"><Reminders /></RequireAuth>} />
        <Route path="/nutrition" element={<RequireAuth role="patient"><Nutrition /></RequireAuth>} />
        <Route path="/calendar" element={<RequireAuth role="patient"><Calendar /></RequireAuth>} />
        <Route path="/conditions" element={<RequireAuth role="patient"><Conditions /></RequireAuth>} />

        <Route path="/emergency" element={<RequireAuth role="patient"><Emergency /></RequireAuth>} />
        <Route path="/pre-visit" element={<RequireAuth role="patient"><PreVisit /></RequireAuth>} />

        {/* physicians only */}
        <Route path="/physician-dashboard" element={<RequireAuth role="physician"><PhysicianDashboard /></RequireAuth>} />

        {/* any logged-in user */}
        <Route path="/medical-records" element={<RequireAuth><MedicalRecords /></RequireAuth>} />
        <Route path="/settings" element={<RequireAuth><Settings /></RequireAuth>} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
