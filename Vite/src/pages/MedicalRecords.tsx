import { useEffect, useState } from "react";
import AlertBanner from "../components/AlertBanner";
import HealthHistoryForm from "../components/HealthHistoryForm";
import NavigationBar from "../components/NavigationBar";
import SearchBar from "../components/SearchBar";
import { normalizeHealthHistory } from "../healthHistory";
import { listMedications, type Med } from "../data/medications";
import { getRecord } from "../data/records";

// One row of the Records List, built from the patient's own data:
//   - the Health History form (conditions, medications, allergies, immunizations, surgeries)
//   - the Medications tracker (what they're taking and how much they have)
type ListRecord = {
  id: string;
  category: "Condition" | "Medication" | "Allergy" | "Immunization" | "Procedure";
  name: string;
  details: string;
  date: string;
  more: [string, string][];   // label/value pairs shown by "View Details"
};

const CATEGORIES = ["Condition", "Medication", "Allergy", "Immunization", "Procedure"] as const;
const num = (v: number | string | null) => (v == null || v === "" ? "" : String(Number(v)));
const pretty = (s: string) => s.replaceAll("_", " ");

function buildRecords(formData: unknown, formSaved: string | null, meds: Med[]): ListRecord[] {
  const h = normalizeHealthHistory(formData);
  const saved = formSaved ? new Date(formSaved).toLocaleDateString() : "";
  const fromForm: [string, string] = ["Source", "Health History form"];
  const list: ListRecord[] = [];

  h.conditions.filter((c) => c !== "None").forEach((c, i) => list.push({
    id: `cond-${i}`, category: "Condition",
    name: c === "Arthritis" && h.arthritis_type ? `Arthritis (${h.arthritis_type})` : c,
    details: "Past medical history", date: saved,
    more: [fromForm, ["Recorded", saved || "—"]],
  }));
  if (h.cancer.trim()) list.push({ id: "cancer", category: "Condition", name: "Cancer", details: h.cancer, date: saved, more: [fromForm, ["Type / treatment", h.cancer]] });
  if (h.other_conditions.trim()) list.push({ id: "other-cond", category: "Condition", name: h.other_conditions, details: "Other condition", date: saved, more: [fromForm] });

  h.prescriptions.filter((m) => m.name.trim()).forEach((m, i) => list.push({
    id: `rx-${i}`, category: "Medication", name: m.name, details: m.dose || "Prescription", date: saved,
    more: [fromForm, ["Type", "Prescription"], ["Dose / per day", m.dose || "—"]],
  }));
  h.non_prescriptions.filter((m) => m.name.trim()).forEach((m, i) => list.push({
    id: `otc-${i}`, category: "Medication", name: m.name, details: m.dose || "Non-prescription", date: saved,
    more: [fromForm, ["Type", "Non-prescription / supplement"], ["Dose / per day", m.dose || "—"]],
  }));
  meds.forEach((m) => list.push({
    id: `med-${m.medication_id}`, category: "Medication",
    name: m.medication_name + (m.strength ? ` ${num(m.strength)} ${m.strength_unit ?? ""}`.trimEnd() : ""),
    details: `${num(m.dose_amount)} ${m.dose_unit}, ${pretty(m.frequency)} · ${pretty(m.status)}`,
    date: m.start_date ? new Date(`${m.start_date}T00:00:00`).toLocaleDateString() : "",
    more: [
      ["Source", "Medications tracker"],
      ["Type", m.medication_type === "non_prescription" ? "Non-prescription" : "Prescription"],
      ["Status", pretty(m.status)],
      ["On hand", `${num(m.quantity_on_hand)} ${m.dose_unit}${Number(m.quantity_on_hand) === 1 ? "" : "s"}`],
      ...(m.refills_remaining != null ? [["Refills left", String(m.refills_remaining)] as [string, string]] : []),
      ...(m.purpose ? [["For", m.purpose] as [string, string]] : []),
      ...(m.instructions ? [["Instructions", m.instructions] as [string, string]] : []),
      ...(m.prescriber_name ? [["Prescriber", m.prescriber_name] as [string, string]] : []),
      ...(m.pharmacy_name ? [["Pharmacy", m.pharmacy_name] as [string, string]] : []),
      ...(m.end_date ? [["Ended", new Date(`${m.end_date}T00:00:00`).toLocaleDateString()] as [string, string]] : []),
    ],
  }));

  if (h.no_known_allergies) {
    list.push({ id: "nka", category: "Allergy", name: "No known allergies", details: "", date: saved, more: [fromForm] });
  }
  h.allergies.filter((a) => a.allergen.trim()).forEach((a, i) => list.push({
    id: `alg-${i}`, category: "Allergy", name: a.allergen, details: a.reaction || "Reaction not listed", date: saved,
    more: [fromForm, ["Reaction", a.reaction || "—"]],
  }));
  h.immunizations.filter((v) => v.vaccine.trim()).forEach((v, i) => list.push({
    id: `imm-${i}`, category: "Immunization", name: v.vaccine, details: v.date ? `Received ${v.date}` : "Date not listed", date: v.date,
    more: [fromForm, ["Received", v.date || "—"]],
  }));
  h.surgeries.filter((s) => s.type.trim()).forEach((s, i) => list.push({
    id: `surg-${i}`, category: "Procedure", name: s.type, details: s.year ? `Year ${s.year}` : "Year not listed", date: s.year,
    more: [fromForm, ["Year", s.year || "—"]],
  }));
  return list;
}

type Tab = "form" | "list";

function MedicalRecords() {
  // the Health History form is shown first
  const [tab, setTab] = useState<Tab>("form");
  const [records, setRecords] = useState<ListRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [category, setCategory] = useState("All");
  const [openId, setOpenId] = useState<string | null>(null);

  // Reload the list whenever its tab is opened, so a just-saved form shows up
  useEffect(() => {
    if (tab !== "list") return;
    let cancelled = false;
    Promise.all([
      getRecord(),
      listMedications(),
    ])
      .then(([rec, meds]) => { if (!cancelled) { setRecords(buildRecords(rec.data, rec.updated_at, meds)); setError(""); } })
      .catch((e) => { if (!cancelled) setError((e as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tab]);

  function openTab(next: Tab) {
    if (next === "list") setLoading(true);
    setTab(next);
  }

  const term = searchTerm.trim().toLowerCase();
  const filteredRecords = records.filter((record) =>
    (category === "All" || record.category === category) &&
    (!term || record.name.toLowerCase().includes(term) || record.details.toLowerCase().includes(term)));

  return (
    <>
      <NavigationBar />

      <main className="page-container">
        <section className="page-heading">
          <h2>Medical Records</h2>
          <p>Fill out your health history once and bring it to any doctor, or browse your records.</p>
        </section>

        <div className="tab-bar" role="tablist" aria-label="Medical records sections">
          <button type="button" role="tab" id="tab-form" aria-controls="panel-form" aria-selected={tab === "form"}
            className={tab === "form" ? "tab active" : "tab"} onClick={() => openTab("form")}>
            Health History Form
          </button>
          <button type="button" role="tab" id="tab-list" aria-controls="panel-list" aria-selected={tab === "list"}
            className={tab === "list" ? "tab active" : "tab"} onClick={() => openTab("list")}>
            Records List
          </button>
        </div>

        {tab === "form" && (
          <section id="panel-form" role="tabpanel" aria-labelledby="tab-form">
            <HealthHistoryForm />
          </section>
        )}

        {tab === "list" && (
          <section id="panel-list" role="tabpanel" aria-labelledby="tab-list">
            <AlertBanner message="Everything here comes from your Health History form and your Medications tracker." type="info" />
            {error && <p className="notice error" role="alert">{error}</p>}

            <div className="records-tools">
              <SearchBar
                value={searchTerm}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => setSearchTerm(event.target.value)}
                placeholder="Search medical records"
              />

              <div className="form-group">
                <label htmlFor="record-category">Category</label>
                <select id="record-category" value={category} onChange={(event) => setCategory(event.target.value)}>
                  <option value="All">All Records</option>
                  {CATEGORIES.map((c) => <option key={c} value={c}>{c === "Allergy" ? "Allergies" : `${c}s`}</option>)}
                </select>
              </div>
            </div>

            <div className="records-list">
              {loading ? <p role="status">Loading your records…</p>
                : records.length === 0 ? (
                  <p>No records yet. Fill out the Health History Form or add a medication to see them here.</p>
                ) : filteredRecords.length === 0 ? (
                  <p>No medical records match your search.</p>
                ) : filteredRecords.map((record) => {
                  const open = openId === record.id;
                  return (
                    <article className="medical-record-item" key={record.id}>
                      <div>
                        <span className="record-category">{record.category}</span>
                        <h3>{record.name}</h3>
                        {record.details && <p>{record.details}</p>}
                        {record.date && <p className="record-date">{record.date}</p>}
                        {open && (
                          <dl className="record-details" id={`record-details-${record.id}`}>
                            {record.more.map(([label, value]) => (
                              <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
                            ))}
                          </dl>
                        )}
                      </div>

                      <button className="secondary-button" type="button" aria-expanded={open}
                        aria-controls={`record-details-${record.id}`}
                        onClick={() => setOpenId(open ? null : record.id)}>
                        {open ? "Hide Details" : "View Details"}
                      </button>
                    </article>
                  );
                })}
            </div>
          </section>
        )}
      </main>
    </>
  );
}

export default MedicalRecords;
