import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";

// Public page for emergency responders. No account needed: enter the patient's emergency code, your name and agency.
// The patient is told who opened it. Shows DNR / declined treatments first.
//   POST /emergency-access/:code            -> the emergency information
//   POST /emergency-access/:code/document   -> the signed directive document, if the patient shared it
// Everything from the server is shown as plain text.

type Measure = { measure: string; label: string };
type Directives = {
  alert: string; code_status: string; code_status_label: string; declined_measures: Measure[]; wants_all_treatment: boolean;
  notes: string | null; signed_order_on_file: boolean; document_available: boolean; last_updated: string | null; disclaimer: string;
};
type Info = {
  patient: { name: string; date_of_birth: string | null; age: number | null; sex: string | null; blood_type: string | null };
  directives: Directives | null; medical_notes: string | null;
  allergies?: { allergen: string; reaction: string | null; severity: string | null }[]; no_known_allergies?: boolean;
  medications?: { medication_name: string; strength: string | null; strength_unit: string | null; dose_amount: string | null; dose_unit: string | null; frequency: string | null }[];
  conditions?: { condition_name: string; severity: string | null }[];
  contacts?: { name: string; phone: string | null; relationship: string | null }[];
  devices?: { device_type: string; name: string | null; flow_lpm: number | null; epap: number | null; ipap: number | null }[];
  disclaimer: string;
};

function EmergencyAccess() {
  const [params] = useSearchParams();
  const [code, setCode] = useState(params.get("code") ?? "");
  const [name, setName] = useState("");
  const [agency, setAgency] = useState("");
  const [badge, setBadge] = useState("");
  const [reason, setReason] = useState("");
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const body = () => ({ responder_name: name.trim(), agency: agency.trim(), badge_id: badge.trim(), reason: reason.trim() });
  const path = () => `/emergency-access/${encodeURIComponent(code.trim().toUpperCase())}`;

  async function open(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim() || !name.trim() || !agency.trim()) { setError("Enter the code, your name and your agency."); return; }
    setBusy(true); setError(""); setInfo(null);
    try { setInfo(await api<Info>(path(), { method: "POST", body: JSON.stringify(body()) })); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  async function openDocument() {
    setError("");
    try {
      const r = await api<{ file_base64: string; content_type: string }>(`${path()}/document`, { method: "POST", body: JSON.stringify(body()) });
      const bin = atob(r.file_base64);
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      window.open(URL.createObjectURL(new Blob([bytes], { type: r.content_type })), "_blank", "noopener");
    } catch (err) { setError((err as Error).message); }
  }

  const d = info?.directives;
  return (
    <main className="page-container">
      <section className="page-heading">
        <h2>Emergency Information</h2>
        <p>For emergency responders. Enter the patient’s emergency code. The patient is notified of who opened it and when.</p>
      </section>
      {error && <p className="notice error" role="alert">{error}</p>}

      {!info && (
        <section className="share-card">
          <form className="access-code-form" onSubmit={open} noValidate>
            <label htmlFor="em-code">Emergency code</label>
            <input id="em-code" placeholder="E-XXXX-XXXX" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} />
            <label htmlFor="em-name">Your name</label>
            <input id="em-name" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
            <label htmlFor="em-agency">Agency or hospital</label>
            <input id="em-agency" maxLength={150} value={agency} onChange={(e) => setAgency(e.target.value)} />
            <label htmlFor="em-badge">Badge or license number (optional)</label>
            <input id="em-badge" maxLength={50} value={badge} onChange={(e) => setBadge(e.target.value)} />
            <label htmlFor="em-reason">Reason (optional)</label>
            <input id="em-reason" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
            <button className="primary-button" type="submit" disabled={busy}>{busy ? "Opening…" : "Open emergency information"}</button>
          </form>
        </section>
      )}

      {info && (
        <section className="share-card">
          <h3>{info.patient.name}{info.patient.age !== null && `, ${info.patient.age}`}{info.patient.sex && `, ${info.patient.sex}`}</h3>
          {info.patient.blood_type && <p>Blood type: <strong>{info.patient.blood_type}</strong></p>}

          {d ? (
            <div className="notice error" role="alert" style={{ border: "3px solid #8c1d23" }}>
              <h3 style={{ margin: 0 }}>{d.alert}</h3>
              {d.declined_measures.length > 0 && (
                <>
                  <p style={{ marginBottom: 4 }}><strong>Patient does NOT want:</strong></p>
                  <ul style={{ marginTop: 0 }}>{d.declined_measures.map((m) => <li key={m.measure}>{m.label}</li>)}</ul>
                </>
              )}
              {d.wants_all_treatment && <p>Patient wants all life-saving treatment.</p>}
              {d.notes && <p>Notes: {d.notes}</p>}
              <p>{d.signed_order_on_file ? "Patient says a signed DNR/POLST form exists. Look for it." : "No signed order reported."}</p>
              {d.document_available && <button className="primary-button" type="button" onClick={openDocument}>Open the signed form</button>}
              <p><small>{d.disclaimer}</small></p>
            </div>
          ) : <p>No resuscitation wishes recorded. Treat as full code unless told otherwise.</p>}

          {info.medical_notes && <p><strong>Medical notes:</strong> {info.medical_notes}</p>}
          {info.allergies && (
            <>
              <h4>Allergies</h4>
              {info.allergies.length ? <ul>{info.allergies.map((a, i) => <li key={i}>{a.allergen}{a.reaction && ` — ${a.reaction}`}{a.severity && ` (${a.severity.replace("life_threatening", "life-threatening").replace(/_/g, " ")})`}</li>)}</ul>
                : <p>{info.no_known_allergies ? "No known allergies" : "None recorded"}</p>}
            </>
          )}
          {info.conditions && (<><h4>Conditions</h4>{info.conditions.length ? <ul>{info.conditions.map((c, i) => <li key={i}>{c.condition_name}</li>)}</ul> : <p>None recorded</p>}</>)}
          {info.medications && (
            <>
              <h4>Current medications</h4>
              {info.medications.length ? <ul>{info.medications.map((m, i) => <li key={i}>{m.medication_name} {m.strength} {m.strength_unit} {m.frequency?.replace(/_/g, " ")}</li>)}</ul> : <p>None recorded</p>}
            </>
          )}
          {info.devices && info.devices.length > 0 && (
            <><h4>Breathing devices</h4><ul>{info.devices.map((v, i) => <li key={i}>{v.name || v.device_type}{v.flow_lpm ? ` ${v.flow_lpm} L/min` : ""}{v.ipap ? ` IPAP ${v.ipap}/EPAP ${v.epap}` : ""}</li>)}</ul></>
          )}
          {info.contacts && info.contacts.length > 0 && (
            <><h4>Emergency contacts</h4><ul>{info.contacts.map((c, i) => <li key={i}>{c.name}{c.relationship && ` (${c.relationship})`} {c.phone}</li>)}</ul></>
          )}
          <p><small>{info.disclaimer}</small></p>
          <button className="secondary-button" type="button" onClick={() => setInfo(null)}>Close</button>
        </section>
      )}
      <p className="auth-switch"><Link to="/">Back to log in</Link></p>
    </main>
  );
}

export default EmergencyAccess;
