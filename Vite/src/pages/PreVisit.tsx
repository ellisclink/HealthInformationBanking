import { useEffect, useState } from "react";
import NavigationBar from "../components/NavigationBar";
import { api } from "../api";

// Pre-visit summary: pick an appointment (or none), add why you're going and your questions, and get a one-page
// summary of your medicines, conditions, labs, vitals and diary to print, copy or bring along.
//   GET  /previsit/appointments      POST /previsit/summary
// Everything from the server is shown as plain text.

type Appt = { event_id: string; title: string; start_time: string; provider_name: string | null };
type Summary = { text: string; worth_raising: string[]; period: { days: number; from: string; to: string } };

function PreVisit() {
  const [appts, setAppts] = useState<Appt[]>([]);
  const [eventId, setEventId] = useState("");
  const [reason, setReason] = useState("");
  const [concerns, setConcerns] = useState("");
  const [questions, setQuestions] = useState("");
  const [days, setDays] = useState(90);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ appointments: Appt[] }>("/previsit/appointments").then((r) => setAppts(r.appointments)).catch((e) => setError((e as Error).message));
  }, []);

  async function make(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(""); setNote("");
    try {
      const r = await api<{ summary: Summary }>("/previsit/summary", { method: "POST", body: JSON.stringify({
        ...(eventId ? { event_id: eventId } : {}), reason, concerns, days,
        questions: questions.split("\n").map((q) => q.trim()).filter(Boolean),
      }) });
      setSummary(r.summary);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  async function copy() {
    try { await navigator.clipboard.writeText(summary?.text ?? ""); setNote("Copied."); } catch { setNote("Couldn’t copy. Select the text and copy it by hand."); }
  }

  return (
    <>
      <NavigationBar />
      <main className="page-container">
        <section className="page-heading">
          <h2>Pre-Visit Summary</h2>
          <p>Get ready for an appointment. This lists what you have recorded; it is not medical advice.</p>
        </section>
        {error && <p className="notice error" role="alert">{error}</p>}

        <section className="settings-card no-print">
          <form onSubmit={make} noValidate>
            <div className="form-group">
              <label htmlFor="pv-appt">Appointment</label>
              <select id="pv-appt" value={eventId} onChange={(e) => setEventId(e.target.value)}>
                <option value="">No specific appointment</option>
                {appts.map((a) => <option key={a.event_id} value={a.event_id}>{new Date(a.start_time).toLocaleDateString()} — {a.title}{a.provider_name ? ` (${a.provider_name})` : ""}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="pv-reason">Reason for the visit</label>
              <input id="pv-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <div className="form-group">
              <label htmlFor="pv-concerns">Anything that’s bothering you</label>
              <textarea id="pv-concerns" maxLength={1000} value={concerns} onChange={(e) => setConcerns(e.target.value)} />
            </div>
            <div className="form-group">
              <label htmlFor="pv-questions">Questions for the doctor (one per line, up to 20)</label>
              <textarea id="pv-questions" value={questions} onChange={(e) => setQuestions(e.target.value)} />
            </div>
            <div className="form-group">
              <label htmlFor="pv-days">Look back</label>
              <select id="pv-days" value={days} onChange={(e) => setDays(Number(e.target.value))}>
                {[30, 90, 180, 365].map((d) => <option key={d} value={d}>{d} days</option>)}
              </select>
            </div>
            <button className="primary-button" type="submit" disabled={busy}>{busy ? "Building…" : "Build my summary"}</button>
          </form>
        </section>

        {summary && (
          <section className="settings-card" aria-label="Your summary">
            {summary.worth_raising.length > 0 && (
              <div className="notice">
                <strong>Worth raising</strong>
                <ul>{summary.worth_raising.map((w, i) => <li key={i}>{w}</li>)}</ul>
              </div>
            )}
            <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>{summary.text}</pre>
            <div className="med-toolbar no-print">
              <button className="primary-button" type="button" onClick={() => window.print()}>Print</button>
              <button className="secondary-button" type="button" onClick={copy}>Copy text</button>
            </div>
            {note && <p role="status">{note}</p>}
          </section>
        )}
      </main>
    </>
  );
}

export default PreVisit;
