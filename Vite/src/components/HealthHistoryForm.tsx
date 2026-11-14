import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api, currentName, type Me } from "../api";
import {
  ALCOHOL_OPTIONS, CONDITIONS, MARITAL_OPTIONS, RACE_OPTIONS, SEX_OPTIONS, TOBACCO_OPTIONS,
  ageFrom, compactHealthHistory, emptyHealthHistory, isNonPrescription, medicationLine, normalizeHealthHistory,
  type Allergy, type HealthHistory, type Immunization, type Medication, type Surgery,
} from "../healthHistory";
import { addMedication as saveMedication, listMedications, type Med } from "../data/medications";

type MedKind = "prescription" | "non_prescription";

type RecordResponse = {
  data: unknown;
  updated_at: string | null;
};

// The patient's health history, laid out like the paper intake form a doctor's
// office hands you. Saved as the patient's record (PUT /api/records), which is what
// share codes show under "Medical record".
// Medications are listed from the Medications tracker; "+ Add" goes to that page and
// comes back here when the medication is saved.
function HealthHistoryForm() {
  const navigate = useNavigate();
  const location = useLocation();
  const addedName = (location.state as { addedMedication?: string } | null)?.addedMedication;
  const [meds, setMeds] = useState<Med[]>([]);
  const [form, setForm] = useState<HealthHistory>(() => emptyHealthHistory(currentName()));
  const [meta, setMeta] = useState<{ updated_at: string | null }>({ updated_at: null });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState(addedName ? `${addedName} was added to your medications.` : "");

  useEffect(() => {
    Promise.all([
      api<RecordResponse>("/records"),
      listMedications(),
      api<Me>("/me").catch(() => null),
    ])
      .then(([r, m, me]) => {
        const h = normalizeHealthHistory(r.data, currentName());
        // start with the account email if the form doesn't have one yet
        if (!h.patient.email && me?.email) h.patient.email = me.email;
        setForm(h);
        setMeds(m.filter((x) => x.status === "active" || x.status === "paused"));
        setMeta({ updated_at: r.updated_at });
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  // Go to the Medications page to add one. It sends the patient back here after saving.
  function addMedication(kind: MedKind) {
    if (dirty && !window.confirm("You have unsaved changes on this form. Leave without saving them?")) return;
    navigate(`/medications?add=${kind}&from=records`);
  }

  // A medicine typed into an older version of this form: add it to the tracker and
  // take it off the form's old list (the patient then saves the form).
  async function moveToTracker(kind: MedKind, index: number) {
    const key = kind === "prescription" ? "prescriptions" : "non_prescriptions";
    const old = form[key][index];
    setBusy(true); setError(""); setMessage("");
    try {
      const saved = await saveMedication({
        medication_name: old.name.trim(), medication_type: kind, quantity_on_hand: 0,
        ...(old.dose.trim() ? { instructions: old.dose.trim() } : {}),
      });
      setMeds((list) => [...list, saved]);
      update((f) => ({ ...f, [key]: f[key].filter((_, i) => i !== index) }));
      setMessage(`${old.name} moved to your Medications. Save the form to finish, then set its pill count on the Medications page.`);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  // ---- small update helpers ----
  function update(change: (f: HealthHistory) => HealthHistory) {
    setForm((f) => change(f));
    setDirty(true); setMessage("");
  }
  const setPatient = (key: keyof HealthHistory["patient"], value: string) =>
    update((f) => ({ ...f, patient: { ...f.patient, [key]: value } }));
  const toggleIn = (list: string[], value: string) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
  function toggleCondition(name: string) {
    update((f) => {
      if (name === "None") return { ...f, conditions: f.conditions.includes("None") ? [] : ["None"] };
      return { ...f, conditions: toggleIn(f.conditions.filter((c) => c !== "None"), name) };
    });
  }
  function setRow<K extends "surgeries" | "allergies" | "immunizations">(
    key: K, index: number, field: string, value: string,
  ) {
    update((f) => ({
      ...f,
      [key]: (f[key] as Array<Surgery | Allergy | Immunization>).map((row, i) => (i === index ? { ...row, [field]: value } : row)),
    }));
  }
  function addRow(key: "surgeries" | "allergies" | "immunizations") {
    update((f) => {
      const blank = key === "surgeries" ? { type: "", year: "" }
        : key === "allergies" ? { allergen: "", reaction: "" }
        : { vaccine: "", date: "" };
      return { ...f, [key]: [...(f[key] as object[]), blank] };
    });
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form.patient.name.trim()) { setError("Please enter your name."); return; }
    setBusy(true); setError(""); setMessage("");
    try {
      await api("/records", { method: "PUT", body: JSON.stringify({ data: compactHealthHistory(form) }) });
      setMeta({ updated_at: new Date().toISOString() });
      setDirty(false);
      setMessage("Saved.");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  if (loading) return <p role="status">Loading your health history…</p>;

  const p = form.patient;
  const age = ageFrom(p.dob);

  return (
    <form className="hh-form" onSubmit={save} noValidate>
      <header className="hh-title">
        <h3>Health History Form</h3>
        <p className="hh-meta">
          {meta.updated_at ? <>Last saved {new Date(meta.updated_at).toLocaleString()}</> : "Not saved yet"}        </p>
      </header>

      {error && <p className="notice error" role="alert">{error}</p>}

      {/* ---------- Patient information ---------- */}
      <fieldset className="hh-section">
        <legend>Patient Information</legend>
        <div className="hh-grid">
          <label className="hh-field hh-wide">Name
            <input value={p.name} onChange={(e) => setPatient("name", e.target.value)} autoComplete="name" />
          </label>
          <label className="hh-field">Date of Birth
            <input type="date" value={p.dob} onChange={(e) => setPatient("dob", e.target.value)} />
          </label>
          <label className="hh-field hh-narrow">Age
            <input value={age} readOnly tabIndex={-1} aria-readonly="true" placeholder="—" />
          </label>
          <label className="hh-field">Phone
            <input type="tel" value={p.phone} onChange={(e) => setPatient("phone", e.target.value)} autoComplete="tel" />
          </label>
          <label className="hh-field hh-half">Email
            <input type="email" value={p.email} onChange={(e) => setPatient("email", e.target.value)} autoComplete="email" />
          </label>
          <label className="hh-field hh-full">Address
            <input value={p.address} onChange={(e) => setPatient("address", e.target.value)} autoComplete="street-address"
              placeholder="Street, city, state, ZIP" />
          </label>
          <label className="hh-field hh-wide">Emergency Contact (name &amp; phone)
            <input value={p.emergency_contact} onChange={(e) => setPatient("emergency_contact", e.target.value)} />
          </label>
        </div>

        <div className="hh-inline-group" role="group" aria-label="Race">
          <span className="hh-inline-label">Race:</span>
          {RACE_OPTIONS.map((r) => (
            <label key={r} className="hh-check">
              <input type="checkbox" checked={p.race.includes(r)}
                onChange={() => update((f) => ({ ...f, patient: { ...f.patient, race: toggleIn(f.patient.race, r) } }))} />
              {r}
            </label>
          ))}
        </div>

        <div className="hh-inline-group" role="radiogroup" aria-label="Sex">
          <span className="hh-inline-label">Sex:</span>
          {SEX_OPTIONS.map((s) => (
            <label key={s} className="hh-check">
              <input type="radio" name="hh-sex" checked={p.sex === s} onChange={() => setPatient("sex", s)} />{s}
            </label>
          ))}
        </div>

        <div className="hh-inline-group" role="radiogroup" aria-label="Marital status">
          <span className="hh-inline-label">Marital Status:</span>
          {MARITAL_OPTIONS.map((m) => (
            <label key={m} className="hh-check">
              <input type="radio" name="hh-marital" checked={p.marital_status === m} onChange={() => setPatient("marital_status", m)} />{m}
            </label>
          ))}
          <label className="hh-check"># Children
            <input className="hh-tiny" inputMode="numeric" maxLength={2} value={p.children}
              onChange={(e) => setPatient("children", e.target.value.replace(/\D/g, ""))} />
          </label>
        </div>

        <div className="hh-grid">
          <label className="hh-field hh-half">Previous Family Physician
            <input value={p.previous_physician} onChange={(e) => setPatient("previous_physician", e.target.value)} />
          </label>
          <label className="hh-field hh-half">Referring Physician
            <input value={p.referring_physician} onChange={(e) => setPatient("referring_physician", e.target.value)} />
          </label>
        </div>
      </fieldset>

      {/* ---------- Past medical history ---------- */}
      <fieldset className="hh-section">
        <legend>Past Medical History</legend>
        <p className="hh-hint">Please check all conditions that you have or have had.</p>
        <div className="hh-checkgrid">
          <label className="hh-check">
            <input type="checkbox" checked={form.conditions.includes("None")} onChange={() => toggleCondition("None")} />None
          </label>
          {CONDITIONS.map((c) => (
            <label key={c} className="hh-check">
              <input type="checkbox" checked={form.conditions.includes(c)} onChange={() => toggleCondition(c)} />
              {c}
              {c === "Arthritis" && form.conditions.includes("Arthritis") && (
                <input className="hh-small" placeholder="type" aria-label="Arthritis type" value={form.arthritis_type}
                  onChange={(e) => update((f) => ({ ...f, arthritis_type: e.target.value }))} />
              )}
            </label>
          ))}
        </div>
        <div className="hh-grid">
          <label className="hh-field hh-full">Cancer: Type / Treatment
            <input value={form.cancer} onChange={(e) => update((f) => ({ ...f, cancer: e.target.value }))} />
          </label>
          <label className="hh-field hh-full">Other (specify)
            <input value={form.other_conditions} onChange={(e) => update((f) => ({ ...f, other_conditions: e.target.value }))} />
          </label>
        </div>
      </fieldset>

      {/* ---------- Past surgical history ---------- */}
      <fieldset className="hh-section">
        <legend>Past Surgical History</legend>
        <p className="hh-hint">Type of surgery &amp; year</p>
        <ol className="hh-lines">
          {form.surgeries.map((s, i) => (
            <li key={i}>
              <input aria-label={`Surgery ${i + 1}`} placeholder="Surgery" value={s.type} onChange={(e) => setRow("surgeries", i, "type", e.target.value)} />
              <input className="hh-year" aria-label={`Surgery ${i + 1} year`} placeholder="Year" inputMode="numeric" maxLength={4}
                value={s.year} onChange={(e) => setRow("surgeries", i, "year", e.target.value.replace(/\D/g, ""))} />
            </li>
          ))}
        </ol>
        <button type="button" className="text-button hh-add" onClick={() => addRow("surgeries")}>+ Add line</button>
      </fieldset>

      {/* ---------- Medications (from the Medications tracker) ---------- */}
      {(["prescription", "non_prescription"] as const).map((kind) => {
        const list = meds.filter((m) => (kind === "non_prescription") === isNonPrescription(m));
        const legacy: Medication[] = form[kind === "prescription" ? "prescriptions" : "non_prescriptions"];
        return (
          <fieldset className="hh-section" key={kind}>
            <legend>{kind === "prescription" ? "Prescription Medications" : "Non-Prescription Medications"}</legend>
            <p className="hh-hint">
              {kind === "prescription" ? "Medicines a doctor prescribed." : "Over-the-counter medicine, vitamins, supplements."}{" "}
              Kept up to date from your Medications page.
            </p>
            {list.length === 0 ? <p className="hh-empty">None added.</p> : (
              <ol className="hh-medlist">
                {list.map((m) => (
                  <li key={m.medication_id}>{medicationLine(m)}{m.status === "paused" && <span className="hh-paused"> (paused)</span>}</li>
                ))}
              </ol>
            )}
            {legacy.length > 0 && (
              <div className="hh-legacy">
                <p className="hh-hint">Typed into an earlier version of this form. Move each one to your Medications so it stays up to date:</p>
                <ul>
                  {legacy.map((m, i) => (
                    <li key={i}>
                      <span>{m.name}{m.dose && ` — ${m.dose}`}</span>
                      <button type="button" className="text-button hh-move" disabled={busy || !m.name.trim()}
                        onClick={() => moveToTracker(kind, i)}>Move to Medications</button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <button type="button" className="secondary-button hh-addmed" onClick={() => addMedication(kind)}>
              + Add {kind === "prescription" ? "prescription" : "non-prescription"} medication
            </button>
          </fieldset>
        );
      })}

      {/* ---------- Allergies ---------- */}
      <fieldset className="hh-section">
        <legend>Allergies (medications, food, other)</legend>
        <label className="hh-check">
          <input type="checkbox" checked={form.no_known_allergies}
            onChange={() => update((f) => ({ ...f, no_known_allergies: !f.no_known_allergies }))} />
          No known allergies
        </label>
        {!form.no_known_allergies && (
          <>
            <ol className="hh-lines">
              {form.allergies.map((a, i) => (
                <li key={i}>
                  <input aria-label={`Allergy ${i + 1}`} placeholder="Allergic to" value={a.allergen}
                    onChange={(e) => setRow("allergies", i, "allergen", e.target.value)} />
                  <input className="hh-dose" aria-label={`Reaction ${i + 1}`} placeholder="Reaction"
                    value={a.reaction} onChange={(e) => setRow("allergies", i, "reaction", e.target.value)} />
                </li>
              ))}
            </ol>
            <button type="button" className="text-button hh-add" onClick={() => addRow("allergies")}>+ Add line</button>
          </>
        )}
      </fieldset>

      {/* ---------- Immunizations ---------- */}
      <fieldset className="hh-section">
        <legend>Immunizations</legend>
        <p className="hh-hint">Vaccine &amp; date (or year) received</p>
        <ol className="hh-lines">
          {form.immunizations.map((v, i) => (
            <li key={i}>
              <input aria-label={`Vaccine ${i + 1}`} placeholder="Vaccine" value={v.vaccine}
                onChange={(e) => setRow("immunizations", i, "vaccine", e.target.value)} />
              <input className="hh-dose" aria-label={`Vaccine ${i + 1} date`} placeholder="Date or year"
                value={v.date} onChange={(e) => setRow("immunizations", i, "date", e.target.value)} />
            </li>
          ))}
        </ol>
        <button type="button" className="text-button hh-add" onClick={() => addRow("immunizations")}>+ Add line</button>
      </fieldset>

      {/* ---------- Family & social history ---------- */}
      <fieldset className="hh-section">
        <legend>Family History</legend>
        <p className="hh-hint">Conditions in parents, siblings or grandparents (e.g. "Father – heart disease, age 60")</p>
        <textarea rows={3} aria-label="Family history" value={form.family_history}
          onChange={(e) => update((f) => ({ ...f, family_history: e.target.value }))} />
      </fieldset>

      <fieldset className="hh-section">
        <legend>Social History</legend>
        <div className="hh-inline-group" role="radiogroup" aria-label="Tobacco">
          <span className="hh-inline-label">Tobacco:</span>
          {TOBACCO_OPTIONS.map((t) => (
            <label key={t} className="hh-check">
              <input type="radio" name="hh-tobacco" checked={form.social.tobacco === t}
                onChange={() => update((f) => ({ ...f, social: { ...f.social, tobacco: t } }))} />{t}
            </label>
          ))}
        </div>
        <div className="hh-inline-group" role="radiogroup" aria-label="Alcohol">
          <span className="hh-inline-label">Alcohol:</span>
          {ALCOHOL_OPTIONS.map((a) => (
            <label key={a} className="hh-check">
              <input type="radio" name="hh-alcohol" checked={form.social.alcohol === a}
                onChange={() => update((f) => ({ ...f, social: { ...f.social, alcohol: a } }))} />{a}
            </label>
          ))}
        </div>
        <label className="hh-field hh-full">Notes (exercise, diet, occupation…)
          <input value={form.social.notes} onChange={(e) => update((f) => ({ ...f, social: { ...f.social, notes: e.target.value } }))} />
        </label>
      </fieldset>

      {message && <p className="notice success" role="status">{message}</p>}
      <div className="hh-actions">
        <button className="primary-button" type="submit" disabled={busy}>{busy ? "Saving…" : "Save Form"}</button>
        <button className="secondary-button" type="button" onClick={() => window.print()}>Print</button>
        {dirty && <span className="hh-unsaved">Unsaved changes</span>}
      </div>
    </form>
  );
}

export default HealthHistoryForm;
