// labs.js — Lab results (Tasks 5.1 / 5.2), on Parse.
//   GET    /labs/catalog                 common tests with units, normal ranges, advice
//   GET    /labs/summary                 latest value per test + what is out of range
//   GET    /labs/results                 list (test, flag=abnormal|high|low|..., from, to, report_id)
//   POST   /labs/results                 add one result, or {results:[...]} for a whole panel
//   GET    /labs/results/:id, PUT /labs/results/:id (flag re-checked), DELETE /labs/results/:id
//   GET    /labs/reports                 uploaded PDFs (no file data)
//   POST   /labs/reports                 upload a PDF: {file_base64, title?, report_date?, lab_name?, ordered_by?, notes?, file_name?}
//   GET    /labs/reports/:id             one report + the results linked to it
//   GET    /labs/reports/:id/file        the PDF, as {file_base64, file_name}
//   PUT    /labs/reports/:id, DELETE /labs/reports/:id (its results stay, unlinked)
// Classes: LabReport (the PDF is stored inside the object, encrypted with ENCRYPTION_KEY,
// so it never gets a public file URL), LabResult. The test catalog is in reference.js.

const crypto = require("crypto");
const { M, isId, isDate, toRow, findAll, findOne, getOwned, save, create, audit, param } = require("./db");
const sec = require("./security");
const { LAB_TESTS } = require("./reference");

const MAX_PDF_BYTES = 8 * 2 ** 20;   // 8 MB (the PDF is stored inside the database object)
const FLAGS = ["normal", "low", "high", "critical_low", "critical_high", "abnormal"];
const SOURCES = ["manual_entry", "document_upload", "provider_entered"];
const MAX_PANEL = 50;
const OUT_OF_RANGE = ["low", "high", "critical_low", "critical_high", "abnormal"];
const RESULT_FIELDS = ["user_id", "report_id", "test_code", "test_name", "panel", "value_numeric", "value_text", "unit", "ref_low", "ref_high",
  "ref_text", "range_source", "flag", "collected_date", "notes", "source"];
const REPORT_FIELDS = ["user_id", "title", "report_date", "lab_name", "ordered_by", "notes", "file_name", "content_type", "file_size", "is_encrypted"];
const INSERT_FIELDS = RESULT_FIELDS.slice(1);
const catalog = LAB_TESTS;
const resultRow = (o) => toRow(o, "result_id", RESULT_FIELDS);
const reportRow = (o) => toRow(o, "report_id", REPORT_FIELDS);
const isHighFlag = (f) => f === "high" || f === "critical_high";
const isLowFlag = (f) => f === "low" || f === "critical_low";

function text(value, max) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.length > max ? undefined : s;   // undefined = too long
}

// a finite number from a number or a numeric string, else null
function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const s = String(value).trim().replace(/,/g, "");
  return /^[-+]?(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : null;
}

const sameUnit = (a, b) =>
  String(a || "").trim().toLowerCase().replace(/\s+/g, "") === String(b || "").trim().toLowerCase().replace(/\s+/g, "");

// find a catalog test by code, or by name / alias ("LDL-C" -> ldl)
function findTest(catalog, code, name) {
  if (code) return catalog.find((c) => c.test_code === code) || null;
  const n = String(name || "").trim().toLowerCase();
  if (!n) return null;
  return catalog.find((c) => c.display_name.toLowerCase() === n || c.aliases.includes(n)) || null;
}

// ---------- flagging ----------
// Decide normal / low / high / critical from the value and the range on the row.
// Critical limits come from the catalog and only apply when the units match it.
function computeFlag(row, test) {
  const v = row.value_numeric;
  if (v !== null && v !== undefined) {
    const useCritical = test && sameUnit(row.unit, test.default_unit);
    if (useCritical && test.critical_low !== null && v < test.critical_low) return "critical_low";
    if (useCritical && test.critical_high !== null && v > test.critical_high) return "critical_high";
    if (row.ref_low === null && row.ref_high === null) return null;   // nothing to compare to
    if (row.ref_low !== null && v < row.ref_low) return "low";
    if (row.ref_high !== null && v > row.ref_high) return "high";
    return "normal";
  }
  // text result ("Negative", "Positive"): compare to the expected text if there is one
  if (row.ref_text && row.value_text) {
    return row.ref_text.trim().toLowerCase() === row.value_text.trim().toLowerCase() ? "normal" : "abnormal";
  }
  return row.manual_flag || null;
}

// Fill unit / range from the catalog when the patient didn't give a range.
// The range printed on their report always wins; the catalog range is only used
// when the units match (a glucose in mmol/L can't be compared to a mg/dL range).
function resolveRange(row, test, explicitRange) {
  if (explicitRange) {
    row.range_source = row.ref_low !== null || row.ref_high !== null || row.ref_text ? "report" : "none";
    return;
  }
  if (test && !row.unit) row.unit = test.default_unit;
  if (test && sameUnit(row.unit, test.default_unit) && (test.ref_low !== null || test.ref_high !== null)) {
    row.ref_low = test.ref_low;
    row.ref_high = test.ref_high;
    row.ref_text = null;
    row.range_source = "catalog";
  } else {
    row.ref_low = null; row.ref_high = null; row.ref_text = null;
    row.range_source = "none";
  }
}

// Validate one incoming result and turn it into a row. `base` is the existing row on update.
// Returns { row, test } or { error }.
function buildResultRow(body, catalog, base = null) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "each result must be an object" };
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  const row = base ? {
    test_code: base.test_code, test_name: base.test_name, panel: base.panel,
    value_numeric: base.value_numeric, value_text: base.value_text, unit: base.unit,
    ref_low: base.ref_low, ref_high: base.ref_high, ref_text: base.ref_text, range_source: base.range_source,
    collected_date: base.collected_date, notes: base.notes, source: base.source, report_id: base.report_id,
    manual_flag: base.flag === "abnormal" || (base.value_numeric === null && base.flag === "normal") ? base.flag : null,
  } : { source: "manual_entry", report_id: null, manual_flag: null };

  // which test
  if (has("test_code") || has("test_name") || !base) {
    const code = body.test_code == null || body.test_code === "" ? null : String(body.test_code);
    const test = findTest(catalog, code, body.test_name);
    if (code && !test) return { error: `unknown test_code "${code}" — see GET /api/labs/catalog` };
    const name = text(body.test_name, 120);
    if (name === undefined) return { error: "test_name is too long (max 120)" };
    if (!test && !name) return { error: "test_name (or a test_code from the catalog) is required" };
    row.test_code = test ? test.test_code : null;
    row.test_name = name || test.display_name;
    if (!has("panel")) row.panel = test ? test.panel : row.panel ?? null;
  }
  const test = row.test_code ? catalog.find((c) => c.test_code === row.test_code) : null;
  if (has("panel")) {
    const p = text(body.panel, 60);
    if (p === undefined) return { error: "panel is too long (max 60)" };
    row.panel = p;
  }

  // the value: `value` is a shortcut — a number goes to value_numeric, anything else to value_text
  if (has("value") || has("value_numeric") || has("value_text") || !base) {
    let numeric = null, txt = null;
    if (has("value") && body.value !== null && body.value !== "") {
      numeric = toNumber(body.value);
      if (numeric === null) txt = text(body.value, 100);
    }
    if (has("value_numeric") && body.value_numeric !== null && body.value_numeric !== "") {
      numeric = toNumber(body.value_numeric);
      if (numeric === null) return { error: "value_numeric must be a number" };
    }
    if (has("value_text")) {
      const t = text(body.value_text, 100);
      if (t !== null) txt = t;
    }
    if (txt === undefined) return { error: "value_text is too long (max 100)" };
    if (numeric === null && !txt) return { error: `enter a value for ${row.test_name}` };
    if (numeric !== null && Math.abs(numeric) >= 1e10) return { error: "value is too large" };
    row.value_numeric = numeric;
    row.value_text = numeric === null ? txt : (txt || null);
  }

  if (has("unit")) {
    const u = text(body.unit, 30);
    if (u === undefined) return { error: "unit is too long (max 30)" };
    row.unit = u;
  }

  // range
  const explicitRange = has("ref_low") || has("ref_high") || has("ref_text");
  if (explicitRange) {
    for (const k of ["ref_low", "ref_high"]) {
      if (!has(k)) continue;
      if (body[k] === null || body[k] === "") { row[k] = null; continue; }
      const n = toNumber(body[k]);
      if (n === null) return { error: `${k} must be a number` };
      row[k] = n;
    }
    if (has("ref_text")) {
      const t = text(body.ref_text, 100);
      if (t === undefined) return { error: "ref_text is too long (max 100)" };
      row.ref_text = t;
    }
    if (row.ref_low !== null && row.ref_high !== null && row.ref_low > row.ref_high) {
      return { error: "ref_low cannot be more than ref_high" };
    }
  }
  // A range the patient typed is kept; a catalog range (or none) is looked up again,
  // so changing the test or unit on an edit re-checks it.
  if (explicitRange || !base || row.range_source !== "report") resolveRange(row, test, explicitRange);

  if (has("flag")) {
    // only meaningful for text results with no expected text (e.g. a lab marked it "A")
    if (body.flag !== null && !["normal", "abnormal"].includes(body.flag)) {
      return { error: "flag can only be set to normal or abnormal (number results are flagged from the range)" };
    }
    row.manual_flag = body.flag;
  }

  if (has("collected_date") || !base) {
    if (!isDate(body.collected_date)) return { error: "collected_date is required (YYYY-MM-DD)" };
    row.collected_date = body.collected_date;
  }
  if (has("notes")) {
    const t = text(body.notes, 2000);
    if (t === undefined) return { error: "notes are too long (max 2000)" };
    row.notes = t;
  }
  if (has("source")) {
    if (!SOURCES.includes(body.source)) return { error: `source must be one of: ${SOURCES.join(", ")}` };
    row.source = body.source;
  }
  if (has("report_id")) {
    if (body.report_id === null || body.report_id === "") row.report_id = null;
    else {
      if (!isId(String(body.report_id))) return { error: "report_id must be a valid id" };
      row.report_id = String(body.report_id);
    }
  }

  row.flag = computeFlag(row, test);
  return { row, test };
}

async function reportBelongsToUser(reportId, userId) {
  if (reportId === null) return true;
  return !!(await getOwned("LabReport", reportId, userId, { exclude: ["file_data"] }));
}
const resultValues = (row) => Object.fromEntries(INSERT_FIELDS.map((f) => [f, row[f] === undefined ? null : row[f]]));

// GET /labs/catalog
const getCatalog = () => ({ status: 200, tests: catalog.map(({ sort_order, ...t }) => t) });

// GET /labs/summary
async function summary(user) {
  const rows = (await findAll("LabResult", { user_id: user.user_id })).map(resultRow)
    .sort((a, b) => b.collected_date.localeCompare(a.collected_date) || b.created_at.localeCompare(a.created_at));
  const groups = new Map();
  for (const r of rows) {
    const key = r.test_code || `name:${r.test_name.toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const latest = [], needsAttention = [];
  for (const [, results] of groups) {
    const current = results[0];
    const previous = results.slice(1).find((r) => r.value_numeric !== null && sameUnit(r.unit, current.unit)) || null;
    const test = current.test_code ? catalog.find((c) => c.test_code === current.test_code) : null;
    let change = null;
    if (previous && current.value_numeric !== null) {
      const delta = Number((current.value_numeric - previous.value_numeric).toFixed(4));
      const direction = delta === 0 ? "same" : delta > 0 ? "up" : "down";
      let trend = null;
      if (isHighFlag(current.flag)) trend = delta < 0 ? "improving" : delta > 0 ? "worsening" : "no change";
      else if (isLowFlag(current.flag)) trend = delta > 0 ? "improving" : delta < 0 ? "worsening" : "no change";
      change = { previous_value: previous.value_numeric, previous_date: previous.collected_date, delta, direction, trend };
    }
    const item = { ...current, result_count: results.length, change, about: test ? test.about : null };
    latest.push(item);
    if (OUT_OF_RANGE.includes(current.flag)) {
      let percent_outside = null;
      if (current.value_numeric !== null) {
        if (isHighFlag(current.flag) && current.ref_high) percent_outside = Math.round(((current.value_numeric - current.ref_high) / Math.abs(current.ref_high)) * 100);
        else if (isLowFlag(current.flag) && current.ref_low) percent_outside = Math.round(((current.ref_low - current.value_numeric) / Math.abs(current.ref_low)) * 100);
      }
      const advice = test ? (isHighFlag(current.flag) ? test.advice_high : isLowFlag(current.flag) ? test.advice_low : null) : null;
      needsAttention.push({ ...item, percent_outside, urgent: current.flag === "critical_low" || current.flag === "critical_high",
        advice: advice || "This result is outside the normal range. Ask your doctor what it means for you." });
    }
  }
  const rank = (f) => (f === "critical_high" || f === "critical_low" ? 0 : 1);
  needsAttention.sort((a, b) => rank(a.flag) - rank(b.flag) || b.collected_date.localeCompare(a.collected_date) || (b.percent_outside ?? -1) - (a.percent_outside ?? -1));
  latest.sort((a, b) => b.collected_date.localeCompare(a.collected_date) || a.test_name.localeCompare(b.test_name));
  const reports = await findAll("LabReport", { user_id: user.user_id }, { select: ["title"] });
  return {
    status: 200, tests_tracked: latest.length, out_of_range_count: needsAttention.length,
    urgent_count: needsAttention.filter((x) => x.urgent).length, in_range_count: latest.filter((x) => x.flag === "normal").length,
    report_count: reports.length, needs_attention: needsAttention, latest,
  };
}

// GET /labs/results?test=&flag=&from=&to=&report_id=
async function listResults(query, user) {
  let rows = (await findAll("LabResult", { user_id: user.user_id })).map(resultRow);
  const test = param(query, "test");
  if (test) rows = rows.filter((r) => r.test_code === test || r.test_name.toLowerCase() === String(test).trim().toLowerCase());
  const flag = param(query, "flag");
  if (flag) {
    if (flag === "abnormal") rows = rows.filter((r) => OUT_OF_RANGE.includes(r.flag));
    else if (FLAGS.includes(flag)) rows = rows.filter((r) => r.flag === flag);
    else return { status: 400, error: `flag must be abnormal or one of: ${FLAGS.join(", ")}` };
  }
  for (const [k, cmp] of [["from", (a, b) => a >= b], ["to", (a, b) => a <= b]]) {
    const v = param(query, k);
    if (!v) continue;
    if (!isDate(v)) return { status: 400, error: `${k} must be a date (YYYY-MM-DD)` };
    rows = rows.filter((r) => cmp(r.collected_date, v));
  }
  const reportParam = param(query, "report_id");
  if (reportParam) {
    if (!isId(reportParam)) return { status: 400, error: "report_id must be a valid id" };
    rows = rows.filter((r) => r.report_id === reportParam);
  }
  rows.sort((a, b) => b.collected_date.localeCompare(a.collected_date) || a.test_name.localeCompare(b.test_name) || b.created_at.localeCompare(a.created_at));
  rows = rows.slice(0, 1000);
  return { status: 200, results: rows, count: rows.length };
}

async function getResult(id, user) {
  if (!isId(id)) return { status: 400, error: "Invalid result ID" };
  const r = await getOwned("LabResult", id, user.user_id);
  return r ? { status: 200, result: resultRow(r) } : { status: 404, error: "Lab result not found" };
}

// POST /labs/results — one result, or {results:[...]} (collected_date/report_id/source/panel at the top apply to all)
async function createResults(body, user) {
  if (!body || typeof body !== "object") return { status: 400, error: "Request body required" };
  let items;
  if (Array.isArray(body.results)) {
    if (!body.results.length) return { status: 400, error: "results is empty" };
    if (body.results.length > MAX_PANEL) return { status: 400, error: `at most ${MAX_PANEL} results at once` };
    const shared = {};
    for (const k of ["collected_date", "report_id", "source", "panel"]) if (k in body) shared[k] = body[k];
    items = body.results.map((r) => (r && typeof r === "object" && !Array.isArray(r) ? { ...shared, ...r } : r));
  } else items = [body];

  const rows = [];
  for (let i = 0; i < items.length; i++) {
    const { row, error } = buildResultRow(items[i], catalog);
    if (error) return { status: 400, error: items.length > 1 ? `result ${i + 1}: ${error}` : error };
    if (!(await reportBelongsToUser(row.report_id, user.user_id))) return { status: 400, error: "report_id does not match one of your lab reports" };
    rows.push(row);
  }
  // everything is checked first, then saved together
  const objs = rows.map((row) => {
    const o = new Parse.Object("LabResult");
    for (const [k, v] of Object.entries({ ...resultValues(row), user_id: user.user_id })) if (v !== null) o.set(k, v);
    return o;
  });
  await Parse.Object.saveAll(objs, M);
  const saved = objs.map(resultRow);
  for (const r of saved) await audit({ userId: user.user_id, event: "INSERT", targetClass: "LabResult", targetId: r.result_id, newData: r });
  const flagged = saved.filter((r) => OUT_OF_RANGE.includes(r.flag));
  return {
    status: 201, ...(Array.isArray(body.results) ? { results: saved } : { result: saved[0] }), count: saved.length,
    out_of_range: flagged.map((r) => ({ result_id: r.result_id, test_name: r.test_name, flag: r.flag })),
    message: `${saved.length} result${saved.length === 1 ? "" : "s"} saved` + (flagged.length ? ` · ${flagged.length} outside the normal range` : ""),
  };
}

async function updateResult(id, body, user) {
  if (!isId(id)) return { status: 400, error: "Invalid result ID" };
  if (!body || typeof body !== "object" || !Object.keys(body).length) return { status: 400, error: "Nothing to update" };
  const r = await getOwned("LabResult", id, user.user_id);
  if (!r) return { status: 404, error: "Lab result not found" };
  const before = resultRow(r);
  const { row, error } = buildResultRow(body, catalog, before);
  if (error) return { status: 400, error };
  if (!(await reportBelongsToUser(row.report_id, user.user_id))) return { status: 400, error: "report_id does not match one of your lab reports" };
  await save(r, resultValues(row));
  const after = resultRow(r);
  await audit({ userId: user.user_id, event: "UPDATE", targetClass: "LabResult", targetId: r.id, oldData: before, newData: after });
  return { status: 200, result: after };
}

async function deleteResult(id, user) {
  if (!isId(id)) return { status: 400, error: "Invalid result ID" };
  const r = await getOwned("LabResult", id, user.user_id);
  if (!r) return { status: 404, error: "Lab result not found" };
  const old = resultRow(r);
  await r.destroy(M);
  await audit({ userId: user.user_id, event: "DELETE", targetClass: "LabResult", targetId: id, oldData: old });
  return { status: 200, message: "Lab result deleted", result_id: id };
}

// ---------- reports (PDF files) ----------
function cleanFileName(raw) {
  let name = String(raw || "").split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f"<>|*?:]/g, "").trim();
  if (!name) name = "lab-report.pdf";
  if (!/\.pdf$/i.test(name)) name += ".pdf";
  if (name.length > 255) name = name.slice(0, 251) + ".pdf";
  return name;
}
function reportFields(source, partial) {
  const out = {};
  const has = (k) => (source[k] !== undefined && source[k] !== null) || (partial && k in source);
  for (const [k, max] of [["title", 200], ["lab_name", 200], ["ordered_by", 200], ["notes", 2000]]) {
    if (!has(k)) continue;
    const t = text(source[k], max);
    if (t === undefined) return { error: `${k} is too long (max ${max})` };
    out[k] = t;
  }
  if (partial && "title" in out && !out.title) return { error: "title cannot be empty" };
  if (has("report_date")) {
    const d = source.report_date;
    if (d === null || d === "") out.report_date = null;
    else if (!isDate(d)) return { error: "report_date must be a date (YYYY-MM-DD)" };
    else out.report_date = d;
  }
  return { fields: out };
}

// POST /labs/reports {file_base64, title?, report_date?, lab_name?, ordered_by?, notes?, file_name?}
async function uploadReport(body, user) {
  // A key that is set but wrong would silently store the PDF as plain text, so refuse instead (no key at all is fine)
  const blocked = sec.uploadBlock();
  if (blocked) return { status: 503, error: blocked };
  if (!body || typeof body.file_base64 !== "string" || !body.file_base64) return { status: 400, error: "Choose a PDF file to upload" };
  if (body.file_base64.length > Math.ceil((MAX_PDF_BYTES * 4) / 3) + 16) return { status: 413, error: "PDF is too large (max 8 MB)" };
  const file = Buffer.from(body.file_base64, "base64");
  if (!file.length) return { status: 400, error: "Choose a PDF file to upload" };
  if (file.length > MAX_PDF_BYTES) return { status: 413, error: "PDF is too large (max 8 MB)" };
  // every real PDF starts with "%PDF-" — don't trust the name or type
  if (file.subarray(0, 5).toString("latin1") !== "%PDF-") return { status: 400, error: "That file is not a PDF" };
  const fileName = cleanFileName(body.file_name);
  const { fields, error } = reportFields(body, false);
  if (error) return { status: 400, error };
  if (!fields.title) fields.title = fileName.replace(/\.pdf$/i, "").slice(0, 200) || "Lab report";
  const sha256 = crypto.createHash("sha256").update(file).digest("hex");
  const dup = await findOne("LabReport", { user_id: user.user_id, file_sha256: sha256 }, { select: ["title"] });
  if (dup) return { status: 409, error: `You already uploaded this PDF ("${dup.get("title")}")`, report_id: dup.id };
  const key = sec.fileKey();
  const stored = key ? sec.encrypt(key, file) : file;
  const rep = await create("LabReport", {
    user_id: user.user_id, ...fields, file_name: fileName, content_type: "application/pdf", file_size: file.length,
    file_sha256: sha256, file_data: stored.toString("base64"), is_encrypted: !!key,
  });
  const data = reportRow(rep);
  await audit({ userId: user.user_id, event: "INSERT", targetClass: "LabReport", targetId: rep.id, newData: { ...data, file_sha256: sha256 } });
  return { status: 201, report: data, message: "PDF uploaded" };
}

async function listReports(user) {
  const reports = await findAll("LabReport", { user_id: user.user_id }, { exclude: ["file_data"] });
  const results = await findAll("LabResult", { user_id: user.user_id }, { select: ["report_id", "flag"] });
  const rows = reports.map((rep) => {
    const linked = results.filter((r) => r.get("report_id") === rep.id);
    return { ...reportRow(rep), result_count: linked.length, out_of_range_count: linked.filter((r) => OUT_OF_RANGE.includes(r.get("flag"))).length };
  }).sort((a, b) => (b.report_date || "").localeCompare(a.report_date || "") || b.created_at.localeCompare(a.created_at));
  return { status: 200, reports: rows, count: rows.length };
}

async function getReport(id, user) {
  if (!isId(id)) return { status: 400, error: "Invalid report ID" };
  const rep = await getOwned("LabReport", id, user.user_id, { exclude: ["file_data"] });
  if (!rep) return { status: 404, error: "Lab report not found" };
  const results = (await findAll("LabResult", { user_id: user.user_id, report_id: rep.id })).map(resultRow).sort((a, b) => a.test_name.localeCompare(b.test_name));
  return { status: 200, report: reportRow(rep), results };
}

// GET /labs/reports/:id/file — every opening is logged
async function getReportFile(id, user) {
  if (!isId(id)) return { status: 400, error: "Invalid report ID" };
  const rep = await getOwned("LabReport", id, user.user_id);
  if (!rep) return { status: 404, error: "Lab report not found" };
  let file = Buffer.from(rep.get("file_data"), "base64");
  if (rep.get("is_encrypted")) {
    if (sec.keyIsInvalid()) return { status: 503, error: sec.KEY_INVALID };
    const key = sec.fileKey();
    if (!key) return { status: 503, error: "This PDF was stored encrypted; set the same ENCRYPTION_KEY to open it" };
    try { file = sec.decrypt(key, file); }
    catch { return { status: 503, error: "This PDF can't be decrypted — ENCRYPTION_KEY was changed after it was uploaded" }; }
  }
  await audit({ userId: user.user_id, event: "VIEW_FILE", targetClass: "LabReport", targetId: rep.id });
  return { status: 200, file_base64: file.toString("base64"), file_name: rep.get("file_name"), content_type: "application/pdf" };
}

async function updateReport(id, body, user) {
  if (!isId(id)) return { status: 400, error: "Invalid report ID" };
  if (!body || typeof body !== "object") return { status: 400, error: "Request body required" };
  const { fields, error } = reportFields(body, true);
  if (error) return { status: 400, error };
  if (!Object.keys(fields).length) return { status: 400, error: "Nothing to update (title, report_date, lab_name, ordered_by, notes)" };
  const rep = await getOwned("LabReport", id, user.user_id, { exclude: ["file_data"] });
  if (!rep) return { status: 404, error: "Lab report not found" };
  const old = reportRow(rep);
  await save(rep, fields);
  const data = reportRow(rep);
  await audit({ userId: user.user_id, event: "UPDATE", targetClass: "LabReport", targetId: rep.id, oldData: old, newData: data });
  return { status: 200, report: data };
}

async function deleteReport(id, user) {
  if (!isId(id)) return { status: 400, error: "Invalid report ID" };
  const rep = await getOwned("LabReport", id, user.user_id, { exclude: ["file_data"] });
  if (!rep) return { status: 404, error: "Lab report not found" };
  const old = reportRow(rep);
  for (const r of await findAll("LabResult", { user_id: user.user_id, report_id: rep.id })) {
    r.unset("report_id");
    await r.save(null, M);
  }
  await rep.destroy(M);
  await audit({ userId: user.user_id, event: "DELETE", targetClass: "LabReport", targetId: id, oldData: old });
  return { status: 200, message: "PDF deleted. Results you typed in from it were kept.", report_id: id };
}

module.exports = {
  MAX_PDF_BYTES, computeFlag, getCatalog, summary, listResults, getResult, createResults, updateResult, deleteResult,
  uploadReport, listReports, getReport, getReportFile, updateReport, deleteReport,
};
