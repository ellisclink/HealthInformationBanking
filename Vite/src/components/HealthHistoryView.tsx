import { ageFrom, isNonPrescription, medicationLine, normalizeHealthHistory, type FormMedication } from "../healthHistory";

// Read-only version of the Health History form, for the people who open a
// share code. Only filled-in parts are shown so it reads like a completed form.
// `medications` = the patient's current medications from the Medications tracker.
function HealthHistoryView({ data, medications = [] }: { data: unknown; medications?: FormMedication[] }) {
  const h = normalizeHealthHistory(data);
  const p = h.patient;
  const age = ageFrom(p.dob);
  const surgeries = h.surgeries.filter((s) => s.type || s.year);
  // tracker medications, plus any typed into an older version of the form
  const rx = [...medications.filter((m) => !isNonPrescription(m)).map(medicationLine),
    ...h.prescriptions.map((m) => `${m.name}${m.dose ? ` — ${m.dose}` : ""}`)];
  const otc = [...medications.filter(isNonPrescription).map(medicationLine),
    ...h.non_prescriptions.map((m) => `${m.name}${m.dose ? ` — ${m.dose}` : ""}`)];
  const allergies = h.allergies.filter((a) => a.allergen || a.reaction);
  const immunizations = h.immunizations.filter((v) => v.vaccine || v.date);
  const conditions = h.conditions.map((c) => (c === "Arthritis" && h.arthritis_type ? `Arthritis (${h.arthritis_type})` : c));
  const row = (label: string, value: string) => (value ? <div className="hh-view-row"><dt>{label}</dt><dd>{value}</dd></div> : null);

  return (
    <div className="hh-view">
      <h6>Patient Information</h6>
      <dl>
        {row("Name", p.name)}
        {row("Date of birth", p.dob ? `${p.dob}${age ? ` (age ${age})` : ""}` : "")}
        {row("Sex", p.sex)}
        {row("Race", p.race.join(", "))}
        {row("Marital status", p.marital_status)}
        {row("Children", p.children)}
        {row("Phone", p.phone)}
        {row("Email", p.email)}
        {row("Address", p.address)}
        {row("Emergency contact", p.emergency_contact)}
        {row("Previous family physician", p.previous_physician)}
        {row("Referring physician", p.referring_physician)}
      </dl>

      <h6>Past Medical History</h6>
      <p>{conditions.length ? conditions.join(", ") : "None checked"}</p>
      <dl>{row("Cancer", h.cancer)}{row("Other", h.other_conditions)}</dl>

      <h6>Past Surgical History</h6>
      {surgeries.length ? <ol>{surgeries.map((s, i) => <li key={i}>{s.type}{s.year && ` (${s.year})`}</li>)}</ol> : <p>None listed</p>}

      <h6>Prescription Medications</h6>
      {rx.length ? <ol>{rx.map((m, i) => <li key={i}>{m}</li>)}</ol> : <p>None listed</p>}

      <h6>Non-Prescription Medications</h6>
      {otc.length ? <ol>{otc.map((m, i) => <li key={i}>{m}</li>)}</ol> : <p>None listed</p>}

      <h6>Allergies</h6>
      {h.no_known_allergies ? <p>No known allergies</p>
        : allergies.length ? <ol>{allergies.map((a, i) => <li key={i}>{a.allergen}{a.reaction && ` — ${a.reaction}`}</li>)}</ol>
        : <p>None listed</p>}

      <h6>Immunizations</h6>
      {immunizations.length ? <ol>{immunizations.map((v, i) => <li key={i}>{v.vaccine}{v.date && ` (${v.date})`}</li>)}</ol> : <p>None listed</p>}

      {h.family_history && <><h6>Family History</h6><p className="hh-pre">{h.family_history}</p></>}

      {(h.social.tobacco || h.social.alcohol || h.social.notes) && (
        <><h6>Social History</h6>
          <dl>{row("Tobacco", h.social.tobacco)}{row("Alcohol", h.social.alcohol)}{row("Notes", h.social.notes)}</dl></>
      )}
    </div>
  );
}

export default HealthHistoryView;
