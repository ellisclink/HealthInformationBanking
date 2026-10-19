import type { SharedView } from "../api";
import HealthHistoryView from "./HealthHistoryView";
import { isHealthHistory } from "../healthHistory";

// Read-only display of whatever sections a share code allows. Used by the physician
// dashboard and the family/friends viewer. There are no edit controls here on purpose:
// shared records can be read, never changed, by anyone but the patient.
const pretty = (s: string) => s.replaceAll("_", " ");
const num = (v: string | null) => (v == null ? "" : String(Number(v)));

function SharedRecordView({ view }: { view: SharedView }) {
  const { record, medications, vitals, diary } = view;
  const recordHasData = record && Object.keys(record.data || {}).length > 0;

  return (
    <article className="shared-record">
      <h4>{view.patient_name}</h4>
      <p className="shared-meta">
        Read-only view · access expires {new Date(view.expires_at).toLocaleString()}
      </p>

      {record && (
        <section className="shared-section">
          <h5>Medical record</h5>
          {record.updated_at && <p>Last updated {new Date(record.updated_at).toLocaleString()}</p>}
          {/* the Health History form reads like a filled-in form; anything older shows as raw data */}
          {!recordHasData
            ? <p>Nothing added to the medical record yet.</p>
            : isHealthHistory(record.data)
              ? <HealthHistoryView data={record.data} medications={record.medications} />
              : <pre>{JSON.stringify(record.data, null, 2)}</pre>}
        </section>
      )}

      {medications && (
        <section className="shared-section">
          <h5>Medications</h5>
          {medications.length === 0 ? <p>No medications listed.</p> : (
            <ul className="shared-list">
              {medications.map((m, i) => (
                <li key={i}>
                  <strong>{m.medication_name}</strong>
                  {m.strength && <> {num(m.strength)}{m.strength_unit ? ` ${m.strength_unit}` : ""}</>}
                  {" "}· {num(m.dose_amount)} {m.dose_unit}{m.frequency && <>, {pretty(m.frequency)}</>}
                  {" "}· <span className={`status-${m.status}`}>{pretty(m.status)}</span>
                  {m.purpose && <div className="shared-sub">For: {m.purpose}</div>}
                  {m.instructions && <div className="shared-sub">{m.instructions}</div>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {vitals && (
        <section className="shared-section">
          <h5>Vital signs (latest)</h5>
          {vitals.length === 0 ? <p>No readings recorded.</p> : (
            <ul className="shared-list">
              {vitals.map((v) => (
                <li key={v.vital_type}>
                  <strong>{v.display_name}:</strong>{" "}
                  {num(v.latest.value_numeric)}{v.latest.value_secondary != null && `/${num(v.latest.value_secondary)}`} {v.latest.unit}
                  {" "}· {new Date(v.latest.measured_at).toLocaleString()}
                  {v.evaluation?.status && v.evaluation.status !== "no_range" && <> · {pretty(v.evaluation.status)}</>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {diary && (
        <section className="shared-section">
          <h5>Health diary (most recent)</h5>
          {diary.length === 0 ? <p>No diary entries.</p> : (
            <ul className="shared-list">
              {diary.map((d, i) => (
                <li key={i}>
                  <strong>{d.entry_date}</strong> · {pretty(d.category)} · {d.title}
                  {d.severity != null && <> · severity {d.severity}</>}
                  {d.follow_up_needed && <> · follow-up needed</>}
                  {d.description && <div className="shared-sub">{d.description}</div>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </article>
  );
}

export default SharedRecordView;
