import { useEffect, useMemo, useState } from "react";
import AlertBanner from "../components/AlertBanner";
import NavigationBar from "../components/NavigationBar";
import { localDate, type DiaryInput } from "../api";
import { listDiary, addDiary, updateDiary, deleteDiary, categories, type DiaryForm, type DisplayEntry } from "../data/diary";

// localDate(), not toISOString(): the ISO string is the UTC date, so after 8pm in
// Florida new entries defaulted to tomorrow.
const emptyForm: DiaryForm = {
  entryDate: localDate(), category: "General",
  title: "", description: "", severity: "", mood: "", followUpNeeded: false
};
function toPayload(form: DiaryForm): DiaryInput {
  return {
    entry_date: form.entryDate, category: categories[form.category] || "general",
    title: form.title.trim(), description: form.description.trim(),
    severity: form.severity ? Number(form.severity) : null,
    mood: form.mood || null, follow_up_needed: form.followUpNeeded
  };
}
function formatDate(date: string) {
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric" })
    .format(new Date(`${date}T00:00:00`));
}
function HealthDiary() {
  const [entries, setEntries] = useState<DisplayEntry[]>([]);
  const [formData, setFormData] = useState<DiaryForm>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("All");
  const [formError, setFormError] = useState("");
  const [listError, setListError] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // Will's queryDiary: the Parse query now lives in data/diary.ts (listDiary)
  const queryDiary = () => listDiary();

  async function refresh() {
    setEntries(await queryDiary());
    setListError("");
  }
  useEffect(() => {
    queryDiary()
      .then((list) => { setEntries(list); setListError(""); })
      .catch((error) => setListError((error as Error).message))
      .finally(() => setLoading(false));
  }, []);

  const filteredEntries = useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLowerCase();
    // entries come newest first (listDiary); the filter keeps that order
    return entries.filter(entry =>
      (categoryFilter === "All" || entry.category === categoryFilter) &&
      (!normalizedSearch || entry.title.toLowerCase().includes(normalizedSearch) ||
        entry.description.toLowerCase().includes(normalizedSearch))
    );
  }, [entries, searchTerm, categoryFilter]);

  function handleChange(event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) {
    const { name, value, checked, type } = event.target as HTMLInputElement;
    setFormData(previous => ({ ...previous, [name]: type === "checkbox" ? checked : value }));
  }
  function resetForm() {
    setFormData({ ...emptyForm, entryDate: localDate() });
    setEditingId(null); setFormError("");
  }
  async function handleSubmit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!formData.entryDate || !formData.title.trim() || !formData.description.trim()) {
      setFormError("Please enter a date, title, and description."); return;
    }
    setBusy(true); setFormError(""); setStatusMessage("");
    try {
      if (editingId != null) await updateDiary(editingId, toPayload(formData));
      else await addDiary(toPayload(formData));
      await refresh();
      setStatusMessage(editingId != null ? "Diary entry updated successfully." : "Diary entry saved successfully.");
      resetForm();
    } catch (error) { setFormError((error as Error).message); }
    finally { setBusy(false); }
  }
  function handleEdit(entry: DisplayEntry) {
    setEditingId(entry.id);
    setFormData({ entryDate: entry.entryDate, category: entry.category, title: entry.title,
      description: entry.description, severity: entry.severity, mood: entry.mood,
      followUpNeeded: entry.followUpNeeded });
    setFormError(""); setStatusMessage(`Editing “${entry.title}.”`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  async function handleDelete(entry: DisplayEntry) {
    if (!window.confirm(`Delete “${entry.title}”?`)) return;
    setBusy(true); setFormError(""); setStatusMessage("");
    try {
      await deleteDiary(entry.id);
      await refresh();
      if (editingId === entry.id) resetForm();
      setStatusMessage("Diary entry deleted.");
    } catch (error) { setFormError((error as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <>
      <NavigationBar />

      <main className="page-container">
        <AlertBanner
          message="Diary entries are saved to your patient account when connected to the server."
          type="info"
        />

        <section className="page-heading diary-heading">
          <div>
            <h2>Health Diary</h2>
            <p>Record symptoms, medications, and daily health notes.</p>
          </div>
          <span className="entry-count">
            {entries.length} {entries.length === 1 ? "entry" : "entries"}
          </span>
        </section>

        <section className="diary-layout">
          <form className="diary-form-card" onSubmit={handleSubmit}>
            <div className="section-title-row">
              <div>
                <h3>{editingId != null ? "Edit Diary Entry" : "New Diary Entry"}</h3>
                <p>Fields marked with * are required.</p>
              </div>
            </div>

            {formError && <p className="form-error" role="alert">{formError}</p>}

            <div className="diary-form-grid">
              <div className="form-group">
                <label htmlFor="entry-date">Date *</label>
                <input
                  id="entry-date"
                  name="entryDate"
                  type="date"
                  value={formData.entryDate}
                  onChange={handleChange}
                  required
                />
              </div>

              <div className="form-group">
                <label htmlFor="diary-category">Category</label>
                <select
                  id="diary-category"
                  name="category"
                  value={formData.category}
                  onChange={handleChange}
                >
                  <option value="Symptoms">Symptoms</option>
                  <option value="Medication">Medication</option>
                  <option value="General">General</option>
                </select>
              </div>
            </div>

            <div className="form-group">
              <label htmlFor="diary-title">Title *</label>
              <input
                id="diary-title"
                name="title"
                type="text"
                maxLength={80}
                placeholder="Example: Headache after lunch"
                value={formData.title}
                onChange={handleChange}
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="diary-description">Description *</label>
              <textarea
                id="diary-description"
                name="description"
                rows={5}
                maxLength={600}
                placeholder="Describe how you felt, what happened, or any action you took."
                value={formData.description}
                onChange={handleChange}
                required
              />
              <span className="character-count">
                {formData.description.length}/600
              </span>
            </div>

            <div className="diary-form-grid">
              <div className="form-group">
                <label htmlFor="severity">Severity</label>
                <select
                  id="severity"
                  name="severity"
                  value={formData.severity}
                  onChange={handleChange}
                >
                  <option value="">Not applicable</option>
                  <option value="1">1 - Very mild</option>
                  <option value="2">2 - Mild</option>
                  <option value="3">3 - Moderate</option>
                  <option value="4">4 - Severe</option>
                  <option value="5">5 - Very severe</option>
                </select>
              </div>

              <div className="form-group">
                <label htmlFor="mood">Mood</label>
                <select
                  id="mood"
                  name="mood"
                  value={formData.mood}
                  onChange={handleChange}
                >
                  <option value="">Not selected</option>
                  <option value="Great">Great</option>
                  <option value="Good">Good</option>
                  <option value="Okay">Okay</option>
                  <option value="Low">Low</option>
                  <option value="Stressed">Stressed</option>
                </select>
              </div>
            </div>

            <label className="checkbox-row">
              <input
                name="followUpNeeded"
                type="checkbox"
                checked={formData.followUpNeeded}
                onChange={handleChange}
              />
              <span>Mark this entry for follow-up</span>
            </label>

            <div className="form-actions">
              <button className="primary-button" type="submit" disabled={busy}>
                {busy ? "Saving…" : editingId != null ? "Save Changes" : "Save Entry"}
              </button>
              {editingId != null && (
                <button className="secondary-button" type="button" onClick={resetForm}>
                  Cancel
                </button>
              )}
            </div>
          </form>

          <section className="diary-entries-panel" aria-labelledby="diary-entries-title">
            <div className="section-title-row">
              <div>
                <h3 id="diary-entries-title">Diary Entries</h3>
                <p>Review and manage previously saved notes.</p>
              </div>
            </div>

            <div className="diary-filters">
              <div className="form-group">
                <label htmlFor="diary-search">Search</label>
                <input
                  id="diary-search"
                  type="search"
                  placeholder="Search title or description"
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                />
              </div>

              <div className="form-group">
                <label htmlFor="diary-filter">Category</label>
                <select
                  id="diary-filter"
                  value={categoryFilter}
                  onChange={(event) => setCategoryFilter(event.target.value)}
                >
                  <option value="All">All Categories</option>
                  <option value="Symptoms">Symptoms</option>
                  <option value="Medication">Medication</option>
                  <option value="General">General</option>
                </select>
              </div>
            </div>

            {listError && <p className="form-error" role="alert">{listError}</p>}

            <p className="status-message" role="status" aria-live="polite">{loading ? "Loading diary entries…" : statusMessage}</p>

            <div className="diary-entry-list">
              {filteredEntries.length > 0 ? (
                filteredEntries.map((entry) => (
                  <article className="diary-entry-card" key={entry.id}>
                    <div className="diary-entry-topline">
                      <span className={`record-category category-${entry.category.toLowerCase()}`}>
                        {entry.category}
                      </span>
                      <time dateTime={entry.entryDate}>{formatDate(entry.entryDate)}</time>
                    </div>
                    <h4>{entry.title}</h4>
                    <p>{entry.description}</p>

                    <div className="diary-entry-details">
                      {entry.severity && <span>Severity: {entry.severity}/5</span>}
                      {entry.mood && <span>Mood: {entry.mood}</span>}
                      {entry.followUpNeeded && <span className="follow-up-badge">Follow-up needed</span>}
                    </div>

                    <div className="entry-actions">
                      <button className="secondary-button" type="button" onClick={() => handleEdit(entry)} disabled={busy}>
                        Edit
                      </button>
                      <button className="danger-button" type="button" onClick={() => handleDelete(entry)} disabled={busy}>
                        Delete
                      </button>
                    </div>
                  </article>
                ))
              ) : (
                <div className="empty-state">
                  <h4>No diary entries found</h4>
                  <p>Adjust the filters or create a new entry.</p>
                </div>
              )}
            </div>
          </section>
        </section>
      </main>
    </>
  );
}

export default HealthDiary;
