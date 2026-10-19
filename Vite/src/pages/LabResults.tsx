import { useEffect, useMemo, useState } from "react";
import AlertBanner from "../components/AlertBanner";
import NavigationBar from "../components/NavigationBar";
import { api, apiFile, apiUpload, localDate } from "../api";

// Lab results: upload the PDF the lab gave you, type in the numbers, and see which
// ones are out of range and what that means.
//   Needs Attention  out-of-range results first, with what high/low means and the trend
//   Add Results      type in one test or a whole panel (Lipid Panel, CBC, ...)
//   All Results      every result, filter by test / out of range, edit or delete
//   PDF Reports      upload, view, and link results to a report
// The server decides normal / high / low (GET /api/labs/...).

type Flag = "normal" | "low" | "high" | "critical_low" | "critical_high" | "abnormal" | null;
type CatalogTest = {
  test_code: string; display_name: string; panel: string | null; default_unit: string;
  ref_low: number | null; ref_high: number | null; critical_low: number | null; critical_high: number | null;
  about: string | null;
};
type LabResult = {
  result_id: number; report_id: number | null; test_code: string | null; test_name: string; panel: string | null;
  value_numeric: number | null; value_text: string | null; unit: string | null;
  ref_low: number | null; ref_high: number | null; ref_text: string | null;
  range_source: "report" | "catalog" | "none"; flag: Flag; collected_date: string; notes: string | null;
};
type Change = { previous_value: number; previous_date: string; delta: number; direction: string; trend: string | null };
type SummaryItem = LabResult & { change: Change | null; about: string | null; result_count: number };
type AttentionItem = SummaryItem & { percent_outside: number | null; urgent: boolean; advice: string };
type Summary = {
  tests_tracked: number; out_of_range_count: number; urgent_count: number; in_range_count: number; report_count: number;
  needs_attention: AttentionItem[]; latest: SummaryItem[];
};
type Report = {
  report_id: number; title: string; report_date: string | null; lab_name: string | null; ordered_by: string | null;
  notes: string | null; file_name: string; file_size: number; is_encrypted: boolean; created_at: string;
  result_count: number; out_of_range_count: number;
};
type Row = { test_code: string; test_name: string; value: string; unit: string; ref_low: string; ref_high: string };

type Tab = "attention" | "add" | "all" | "reports";
const MAX_PDF = 8 * 1024 * 1024;
const OTHER = "__other";

const FLAG_INFO: Record<string, { label: string; icon: string }> = {
  normal: { label: "Normal", icon: "✓" },
  high: { label: "High", icon: "↑" },
  low: { label: "Low", icon: "↓" },
  critical_high: { label: "Critical high", icon: "⚠" },
  critical_low: { label: "Critical low", icon: "⚠" },
  abnormal: { label: "Abnormal", icon: "!" },
};

const fmt = (v: number | null) => (v == null ? "" : String(Number(v.toFixed(4))));
const dateLabel = (d: string | null) =>
  d ? new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
const valueLabel = (r: LabResult) =>
  r.value_numeric != null ? `${fmt(r.value_numeric)}${r.unit ? ` ${r.unit}` : ""}` : r.value_text ?? "";

function rangeLabel(r: { ref_low: number | null; ref_high: number | null; ref_text?: string | null; unit?: string | null }) {
  const u = r.unit ? ` ${r.unit}` : "";
  if (r.ref_low != null && r.ref_high != null) return `${fmt(r.ref_low)}–${fmt(r.ref_high)}${u}`;
  if (r.ref_high != null) return `${fmt(r.ref_high)}${u} or lower`;
  if (r.ref_low != null) return `${fmt(r.ref_low)}${u} or higher`;
  if (r.ref_text) return r.ref_text;
  return "No range";
}

function FlagBadge({ flag }: { flag: Flag }) {
  if (!flag) return <span className="lab-flag none">No range</span>;
  const info = FLAG_INFO[flag];
  return <span className={`lab-flag ${flag}`}><span aria-hidden="true">{info.icon}</span> {info.label}</span>;
}

// A bar showing the normal range (shaded) and where the value falls (marker).
function RangeMeter({ r }: { r: LabResult }) {
  const v = r.value_numeric;
  if (v == null || (r.ref_low == null && r.ref_high == null)) return null;
  const pts = [v, r.ref_low, r.ref_high].filter((x): x is number => x != null);
  const min = Math.min(...pts), max = Math.max(...pts);
  const span = max - min || Math.abs(max) || 1;
  const lo = min >= 0 ? Math.max(0, min - span * 0.4) : min - span * 0.4;
  const hi = max + span * 0.4;
  const pct = (x: number) => `${((x - lo) / (hi - lo)) * 100}%`;
  const zoneStart = r.ref_low ?? lo, zoneEnd = r.ref_high ?? hi;
  return (
    <div className="lab-meter" aria-hidden="true">
      <div className="lab-meter-track">
        <div className="lab-meter-zone" style={{ left: pct(zoneStart), width: `calc(${pct(zoneEnd)} - ${pct(zoneStart)})` }} />
        <div className={`lab-meter-mark ${r.flag ?? ""}`} style={{ left: pct(v) }} />
      </div>
      <div className="lab-meter-labels">
        {r.ref_low != null && <span style={{ left: pct(r.ref_low) }}>{fmt(r.ref_low)}</span>}
        {r.ref_high != null && <span style={{ left: pct(r.ref_high) }}>{fmt(r.ref_high)}</span>}
      </div>
    </div>
  );
}

function trendText(item: SummaryItem) {
  const c = item.change;
  if (!c) return item.result_count > 1 ? null : "First result for this test.";
  const word = c.direction === "same" ? "Same as" : c.direction === "up" ? "Up from" : "Down from";
  return `${word} ${fmt(c.previous_value)} on ${dateLabel(c.previous_date)}${c.trend ? ` · ${c.trend}` : ""}`;
}

const emptyRow = (): Row => ({ test_code: "", test_name: "", value: "", unit: "", ref_low: "", ref_high: "" });

function LabResults() {
  const [tab, setTab] = useState<Tab>("attention");
  const [catalog, setCatalog] = useState<CatalogTest[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [results, setResults] = useState<LabResult[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  // add form
  const [collected, setCollected] = useState(localDate());
  const [reportFor, setReportFor] = useState("");
  const [rows, setRows] = useState<Row[]>([emptyRow()]);

  // all-results filters / editing
  const [testFilter, setTestFilter] = useState("");
  const [onlyOut, setOnlyOut] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editDate, setEditDate] = useState("");

  // reports
  const [file, setFile] = useState<File | null>(null);
  const [upTitle, setUpTitle] = useState("");
  const [upDate, setUpDate] = useState("");
  const [upLab, setUpLab] = useState("");
  const [upOrdered, setUpOrdered] = useState("");
  const [fileInputKey, setFileInputKey] = useState(0);
  const [viewing, setViewing] = useState<{ id: number; url: string } | null>(null);

  const fetchAll = () => Promise.all([
    api<Summary>("/labs/summary"),
    api<{ results: LabResult[] }>("/labs/results"),
    api<{ reports: Report[] }>("/labs/reports"),
  ]);
  async function load() {
    const [s, r, rp] = await fetchAll();
    setSummary(s); setResults(r.results); setReports(rp.reports);
  }

  useEffect(() => {
    Promise.all([api<{ tests: CatalogTest[] }>("/labs/catalog"), fetchAll()])
      .then(([c, [s, r, rp]]) => { setCatalog(c.tests); setSummary(s); setResults(r.results); setReports(rp.reports); })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  // free the PDF from memory when it's closed or the page is left
  useEffect(() => () => { if (viewing) URL.revokeObjectURL(viewing.url); }, [viewing]);

  async function act(work: () => Promise<string | void>) {
    setBusy(true); setError(""); setMessage("");
    try {
      const msg = await work();
      await load();
      if (msg) setMessage(msg);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  const panels = useMemo(() => [...new Set(catalog.map((c) => c.panel).filter(Boolean))] as string[], [catalog]);
  const testOf = (code: string) => catalog.find((c) => c.test_code === code);

  // ---------- add results ----------
  function setRow(i: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  }
  function pickTest(i: number, code: string) {
    const t = testOf(code);
    setRow(i, { test_code: code, test_name: "", unit: t ? t.default_unit : "", ref_low: "", ref_high: "" });
  }
  function fillPanel(panel: string) {
    if (!panel) return;
    const tests = catalog.filter((c) => c.panel === panel);
    const kept = rows.filter((r) => r.test_code || r.value);
    const have = new Set(kept.map((r) => r.test_code));
    setRows([...kept, ...tests.filter((t) => !have.has(t.test_code)).map((t) => ({ ...emptyRow(), test_code: t.test_code, unit: t.default_unit }))]);
  }

  // what the flag will be (same rules as the server) so the patient sees it while typing
  function previewFlag(r: Row): Flag {
    const v = Number(r.value);
    if (r.value.trim() === "" || !Number.isFinite(v)) return null;
    const t = r.test_code && r.test_code !== OTHER ? testOf(r.test_code) : undefined;
    const typed = r.ref_low.trim() !== "" || r.ref_high.trim() !== "";
    const sameUnit = t && r.unit.trim().toLowerCase().replace(/\s+/g, "") === t.default_unit.toLowerCase().replace(/\s+/g, "");
    if (sameUnit && t!.critical_low != null && v < t!.critical_low) return "critical_low";
    if (sameUnit && t!.critical_high != null && v > t!.critical_high) return "critical_high";
    const low = typed ? (r.ref_low.trim() ? Number(r.ref_low) : null) : sameUnit ? t!.ref_low : null;
    const high = typed ? (r.ref_high.trim() ? Number(r.ref_high) : null) : sameUnit ? t!.ref_high : null;
    if (low == null && high == null) return null;
    if (low != null && v < low) return "low";
    if (high != null && v > high) return "high";
    return "normal";
  }

  function saveResults(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const filled = rows.filter((r) => r.value.trim() !== "");
    if (!collected) { setError("Enter the date the sample was taken."); return; }
    if (filled.length === 0) { setError("Enter at least one result."); return; }
    for (const r of filled) {
      if (!r.test_code) { setError("Pick a test for every result you entered."); return; }
      if (r.test_code === OTHER && !r.test_name.trim()) { setError("Type the name of each test you picked as Other."); return; }
    }
    const body = {
      collected_date: collected,
      ...(reportFor ? { report_id: Number(reportFor) } : {}),
      results: filled.map((r) => ({
        ...(r.test_code === OTHER ? { test_name: r.test_name.trim() } : { test_code: r.test_code }),
        value: r.value.trim(),
        ...(r.unit.trim() ? { unit: r.unit.trim() } : {}),
        // only send a range when one was typed; otherwise the server uses the typical range
        ...(r.ref_low.trim() || r.ref_high.trim()
          ? { ref_low: r.ref_low.trim() === "" ? null : r.ref_low.trim(), ref_high: r.ref_high.trim() === "" ? null : r.ref_high.trim() }
          : {}),
      })),
    };
    act(async () => {
      const r = await api<{ message: string; out_of_range: unknown[] }>("/labs/results", { method: "POST", body: JSON.stringify(body) });
      setRows([emptyRow()]); setReportFor("");
      setTab(r.out_of_range.length ? "attention" : "all");
      return r.message + ".";
    });
  }

  // ---------- all results ----------
  const testNames = useMemo(() => [...new Set(results.map((r) => r.test_name))].sort(), [results]);
  const shown = results.filter((r) =>
    (!testFilter || r.test_name === testFilter) && (!onlyOut || (r.flag && r.flag !== "normal")));

  function startEdit(r: LabResult) {
    setEditId(r.result_id); setEditValue(r.value_numeric != null ? fmt(r.value_numeric) : r.value_text ?? ""); setEditDate(r.collected_date);
  }
  const saveEdit = (r: LabResult) => act(async () => {
    await api(`/labs/results/${r.result_id}`, { method: "PUT", body: JSON.stringify({ value: editValue, collected_date: editDate }) });
    setEditId(null);
    return `${r.test_name} updated.`;
  });
  const removeResult = (r: LabResult) => {
    if (!window.confirm(`Delete the ${r.test_name} result from ${dateLabel(r.collected_date)}?`)) return;
    act(async () => { await api(`/labs/results/${r.result_id}`, { method: "DELETE" }); return `${r.test_name} result deleted.`; });
  };

  // ---------- reports ----------
  function chooseFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setError("");
    if (f && f.type && f.type !== "application/pdf") { setError("Choose a PDF file."); setFile(null); return; }
    if (f && f.size > MAX_PDF) { setError("That PDF is larger than 8 MB."); setFile(null); return; }
    setFile(f);
    if (f && !upTitle) setUpTitle(f.name.replace(/\.pdf$/i, ""));
  }

  function upload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) { setError("Choose a PDF to upload."); return; }
    const params = new URLSearchParams({ file_name: file.name });
    if (upTitle.trim()) params.set("title", upTitle.trim());
    if (upDate) params.set("report_date", upDate);
    if (upLab.trim()) params.set("lab_name", upLab.trim());
    if (upOrdered.trim()) params.set("ordered_by", upOrdered.trim());
    act(async () => {
      await apiUpload(`/labs/reports?${params}`, file);
      setFile(null); setUpTitle(""); setUpDate(""); setUpLab(""); setUpOrdered(""); setFileInputKey((k) => k + 1);
      return "PDF uploaded. You can open it any time, or type its numbers in under Add Results.";
    });
  }

  async function view(rep: Report) {
    if (viewing?.id === rep.report_id) { setViewing(null); return; }
    setError("");
    try {
      const blob = await apiFile(`/labs/reports/${rep.report_id}/file`);
      setViewing({ id: rep.report_id, url: URL.createObjectURL(new Blob([blob], { type: "application/pdf" })) });
    } catch (e) { setError((e as Error).message); }
  }

  async function openInTab(rep: Report) {
    // open the window first (pop-up blockers allow it during the click), then fill it
    const win = window.open("", "_blank");
    try {
      const blob = await apiFile(`/labs/reports/${rep.report_id}/file`);
      const url = URL.createObjectURL(new Blob([blob], { type: "application/pdf" }));
      if (win) win.location.href = url; else window.location.assign(url);
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) { win?.close(); setError((e as Error).message); }
  }

  function addFromReport(rep: Report) {
    setReportFor(String(rep.report_id));
    if (rep.report_date) setCollected(rep.report_date);
    setMessage(""); setError("");
    setTab("add");
  }

  const removeReport = (rep: Report) => {
    if (!window.confirm(`Delete the PDF "${rep.title}"? Results you typed in from it are kept.`)) return;
    act(async () => {
      if (viewing?.id === rep.report_id) setViewing(null);
      const r = await api<{ message: string }>(`/labs/reports/${rep.report_id}`, { method: "DELETE" });
      return r.message;
    });
  };

  const tabButton = (key: Tab, label: string) => (
    <button type="button" role="tab" id={`tab-${key}`} aria-controls={`panel-${key}`} aria-selected={tab === key}
      className={tab === key ? "tab active" : "tab"} onClick={() => { setTab(key); setMessage(""); setError(""); }}>
      {label}
    </button>
  );

  return (
    <>
      <NavigationBar />
      <main className="page-container">
        <section className="page-heading">
          <h2>Lab Results</h2>
          <p>Keep your lab reports in one place and see which results are out of range.</p>
        </section>

        {summary && (
          <div className="med-stats">
            <div className="med-stat"><strong>{summary.tests_tracked}</strong><span>Tests tracked</span></div>
            <div className={`med-stat ${summary.out_of_range_count ? "warn" : ""}`}>
              <strong>{summary.out_of_range_count}</strong><span>Out of range (latest)</span>
            </div>
            <div className="med-stat"><strong>{summary.in_range_count}</strong><span>In range (latest)</span></div>
            <div className="med-stat"><strong>{summary.report_count}</strong><span>PDF reports</span></div>
          </div>
        )}

        <div className="tab-bar" role="tablist" aria-label="Lab results sections">
          {tabButton("attention", "Needs Attention")}
          {tabButton("add", "Add Results")}
          {tabButton("all", "All Results")}
          {tabButton("reports", "PDF Reports")}
        </div>

        {error && <p className="notice error" role="alert">{error}</p>}
        {message && !error && <p className="notice success" role="status">{message}</p>}
        {loading && <p role="status">Loading lab results…</p>}

        {/* ---------- needs attention ---------- */}
        {!loading && tab === "attention" && summary && (
          <section id="panel-attention" role="tabpanel" aria-labelledby="tab-attention">
            {summary.urgent_count > 0 && (
              <AlertBanner type="warning"
                message="One or more results are far outside the normal range. Contact your doctor promptly, or call 911 if you feel very unwell." />
            )}
            {summary.tests_tracked === 0 ? (
              <p>No results yet. Upload a PDF or add results to see what is in and out of range.</p>
            ) : summary.needs_attention.length === 0 ? (
              <p className="notice success">All of your latest results are within their normal ranges.</p>
            ) : (
              <div className="lab-attention">
                {summary.needs_attention.map((r) => (
                  <article key={r.result_id} className={`lab-card ${r.flag ?? ""}`}>
                    <header>
                      <div>
                        <h3>{r.test_name}</h3>
                        <p className="shared-sub">{dateLabel(r.collected_date)}{r.panel && ` · ${r.panel}`}</p>
                      </div>
                      <div className="lab-value">
                        <strong>{valueLabel(r)}</strong>
                        <FlagBadge flag={r.flag} />
                      </div>
                    </header>
                    <RangeMeter r={r} />
                    <p className="lab-range">
                      Normal range: {rangeLabel(r)}
                      {r.range_source === "catalog" && " (typical; your lab's range may differ)"}
                      {r.percent_outside != null && r.percent_outside > 0 &&
                        ` · ${r.percent_outside}% ${r.flag === "low" || r.flag === "critical_low" ? "below the bottom" : "above the top"} of the range`}
                    </p>
                    {trendText(r) && <p className="lab-trend">{trendText(r)}</p>}
                    <p className="lab-advice"><strong>What it means:</strong> {r.advice}</p>
                  </article>
                ))}
              </div>
            )}

            {summary.latest.some((r) => r.flag === "normal" || r.flag == null) && (
              <>
                <h3 className="lab-subhead">Other latest results</h3>
                <div className="table-scroll">
                  <table className="access-log lab-table">
                    <thead><tr><th>Test</th><th>Result</th><th>Normal range</th><th>Status</th><th>Date</th></tr></thead>
                    <tbody>
                      {summary.latest.filter((r) => r.flag === "normal" || r.flag == null).map((r) => (
                        <tr key={r.result_id}>
                          <td>{r.test_name}</td><td>{valueLabel(r)}</td><td>{rangeLabel(r)}</td>
                          <td><FlagBadge flag={r.flag} /></td><td>{dateLabel(r.collected_date)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            <p className="form-hint">This explains results in general terms only. Your doctor can tell you what they mean for you.</p>
          </section>
        )}

        {/* ---------- add results ---------- */}
        {!loading && tab === "add" && (
          <section id="panel-add" role="tabpanel" aria-labelledby="tab-add">
            <form className="med-add lab-add" onSubmit={saveResults} noValidate>
              <h3>Add lab results</h3>
              <p className="form-hint">Copy the numbers from your report. Leave the range blank to use the typical range, or type the range printed on your report.</p>
              <div className="med-add-grid">
                <label>Date sample was taken *<input type="date" value={collected} onChange={(e) => setCollected(e.target.value)} /></label>
                <label>From PDF report
                  <select value={reportFor} onChange={(e) => setReportFor(e.target.value)}>
                    <option value="">None</option>
                    {reports.map((r) => <option key={r.report_id} value={r.report_id}>{r.title}{r.report_date ? ` (${dateLabel(r.report_date)})` : ""}</option>)}
                  </select>
                </label>
                <label>Fill in a whole panel
                  <select value="" onChange={(e) => fillPanel(e.target.value)}>
                    <option value="">Choose a panel…</option>
                    {panels.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </label>
              </div>

              <div className="table-scroll">
                <table className="lab-entry">
                  <thead>
                    <tr><th>Test</th><th>Result</th><th>Unit</th><th>Range low</th><th>Range high</th><th>Status</th><th><span className="sr-only">Remove</span></th></tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => {
                      const t = r.test_code && r.test_code !== OTHER ? testOf(r.test_code) : undefined;
                      return (
                        <tr key={i}>
                          <td>
                            <select aria-label={`Test ${i + 1}`} value={r.test_code} onChange={(e) => pickTest(i, e.target.value)}>
                              <option value="">Choose…</option>
                              {panels.map((p) => (
                                <optgroup key={p} label={p}>
                                  {catalog.filter((c) => c.panel === p).map((c) => <option key={c.test_code} value={c.test_code}>{c.display_name}</option>)}
                                </optgroup>
                              ))}
                              <option value={OTHER}>Other (type the name)</option>
                            </select>
                            {r.test_code === OTHER && (
                              <input aria-label={`Test ${i + 1} name`} placeholder="Test name" value={r.test_name}
                                onChange={(e) => setRow(i, { test_name: e.target.value })} />
                            )}
                          </td>
                          <td><input aria-label={`Result ${i + 1}`} inputMode="decimal" value={r.value} onChange={(e) => setRow(i, { value: e.target.value })} placeholder={t ? "e.g. 98" : "value"} /></td>
                          <td><input aria-label={`Unit ${i + 1}`} value={r.unit} onChange={(e) => setRow(i, { unit: e.target.value })} className="lab-unit" /></td>
                          <td><input aria-label={`Range low ${i + 1}`} inputMode="decimal" value={r.ref_low} onChange={(e) => setRow(i, { ref_low: e.target.value })}
                            placeholder={t && t.ref_low != null ? fmt(t.ref_low) : ""} className="lab-num" /></td>
                          <td><input aria-label={`Range high ${i + 1}`} inputMode="decimal" value={r.ref_high} onChange={(e) => setRow(i, { ref_high: e.target.value })}
                            placeholder={t && t.ref_high != null ? fmt(t.ref_high) : ""} className="lab-num" /></td>
                          <td>{r.value.trim() ? <FlagBadge flag={previewFlag(r)} /> : null}</td>
                          <td>
                            {rows.length > 1 && (
                              <button type="button" className="text-button med-link danger" aria-label={`Remove row ${i + 1}`}
                                onClick={() => setRows((rs) => rs.filter((_, k) => k !== i))}>✕</button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <button type="button" className="text-button hh-add" onClick={() => setRows((rs) => [...rs, emptyRow()])}>+ Add another test</button>
              <div>
                <button className="primary-button" type="submit" disabled={busy}>{busy ? "Saving…" : "Save Results"}</button>
              </div>
            </form>
          </section>
        )}

        {/* ---------- all results ---------- */}
        {!loading && tab === "all" && (
          <section id="panel-all" role="tabpanel" aria-labelledby="tab-all">
            <div className="med-toolbar">
              <label className="med-filter">Test
                <select value={testFilter} onChange={(e) => setTestFilter(e.target.value)}>
                  <option value="">All tests</option>
                  {testNames.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              <label className="med-filter"><input type="checkbox" checked={onlyOut} onChange={(e) => setOnlyOut(e.target.checked)} /> Only out of range</label>
            </div>
            {shown.length === 0 ? <p>{results.length ? "No results match." : "No results yet."}</p> : (
              <div className="table-scroll">
                <table className="access-log lab-table">
                  <thead><tr><th>Date</th><th>Test</th><th>Result</th><th>Normal range</th><th>Status</th><th>Actions</th></tr></thead>
                  <tbody>
                    {shown.map((r) => (
                      <tr key={r.result_id}>
                        {editId === r.result_id ? (
                          <>
                            <td><input type="date" aria-label="Date" value={editDate} onChange={(e) => setEditDate(e.target.value)} /></td>
                            <td>{r.test_name}</td>
                            <td><input aria-label="Result" className="lab-num" value={editValue} onChange={(e) => setEditValue(e.target.value)} /> {r.unit}</td>
                            <td>{rangeLabel(r)}</td>
                            <td />
                            <td>
                              <button type="button" className="text-button med-link" disabled={busy} onClick={() => saveEdit(r)}>Save</button>
                              <button type="button" className="text-button med-link" onClick={() => setEditId(null)}>Cancel</button>
                            </td>
                          </>
                        ) : (
                          <>
                            <td>{dateLabel(r.collected_date)}</td>
                            <td>{r.test_name}</td>
                            <td>{valueLabel(r)}</td>
                            <td>{rangeLabel(r)}</td>
                            <td><FlagBadge flag={r.flag} /></td>
                            <td>
                              <button type="button" className="text-button med-link" onClick={() => startEdit(r)}>Edit</button>
                              <button type="button" className="text-button med-link danger" disabled={busy} onClick={() => removeResult(r)}>Delete</button>
                            </td>
                          </>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {/* ---------- PDF reports ---------- */}
        {!loading && tab === "reports" && (
          <section id="panel-reports" role="tabpanel" aria-labelledby="tab-reports">
            <form className="med-add" onSubmit={upload} noValidate>
              <h3>Upload a lab report (PDF)</h3>
              <div className="med-add-grid">
                <label className="med-wide">PDF file (up to 8 MB) *
                  <input key={fileInputKey} type="file" accept="application/pdf,.pdf" onChange={chooseFile} />
                </label>
                <label>Title<input value={upTitle} onChange={(e) => setUpTitle(e.target.value)} placeholder="e.g. Annual bloodwork" /></label>
                <label>Report date<input type="date" value={upDate} onChange={(e) => setUpDate(e.target.value)} /></label>
                <label>Lab<input value={upLab} onChange={(e) => setUpLab(e.target.value)} placeholder="e.g. Quest Diagnostics" /></label>
                <label>Ordered by<input value={upOrdered} onChange={(e) => setUpOrdered(e.target.value)} placeholder="e.g. Dr. Smith" /></label>
              </div>
              <button className="primary-button" type="submit" disabled={busy || !file}>{busy ? "Uploading…" : "Upload PDF"}</button>
            </form>

            {reports.length === 0 ? <p>No PDFs uploaded yet.</p> : (
              <div className="med-list">
                {reports.map((rep) => (
                  <article key={rep.report_id} className="med-card lab-report">
                    <div className="med-main">
                      <div>
                        <h3>{rep.title}</h3>
                        <p>{[rep.report_date && dateLabel(rep.report_date), rep.lab_name, rep.ordered_by && `ordered by ${rep.ordered_by}`].filter(Boolean).join(" · ") || "No date"}</p>
                        <p className="shared-sub">
                          {rep.file_name} · {(rep.file_size / 1024).toFixed(0)} KB ·{" "}
                          {rep.result_count ? `${rep.result_count} result${rep.result_count === 1 ? "" : "s"} entered` : "no results entered yet"}
                          {rep.out_of_range_count > 0 && ` (${rep.out_of_range_count} out of range)`}
                        </p>
                      </div>
                    </div>
                    <div className="med-actions">
                      <button type="button" className="primary-button" onClick={() => view(rep)}>{viewing?.id === rep.report_id ? "Close" : "View PDF"}</button>
                      <button type="button" className="secondary-button" onClick={() => openInTab(rep)}>Open in new tab</button>
                      <button type="button" className="secondary-button" onClick={() => addFromReport(rep)}>Add results from this PDF</button>
                      <button type="button" className="text-button med-link danger" disabled={busy} onClick={() => removeReport(rep)}>Delete</button>
                    </div>
                    {viewing?.id === rep.report_id && (
                      <iframe className="lab-pdf" src={viewing.url} title={`PDF: ${rep.title}`} />
                    )}
                  </article>
                ))}
              </div>
            )}
          </section>
        )}
      </main>
    </>
  );
}

export default LabResults;
