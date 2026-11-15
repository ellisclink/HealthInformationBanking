// labs.ts — the only browser file that reads and writes LabResult (the Lab Results page), with the Parse SDK.
// Cloud Code triggers (RULES.LabResult in Parse/cloud/lib/access.js) guard every request: own rows only, patients only,
// the field rules of labs.js (buildResultRow), and the audit log. The server fills in the test name, panel, unit and
// range from the catalog and decides flag and range_source; a report_id must be one of your own PDF reports.
//   - never send user_id or range_source (the server refuses them); flag only as the manual flag of a text result
//   - send the owner ACL on create only (the server overwrites it); never on update (a changed ACL is refused)
//   - plain values only; numbers as numbers; clearing a field = unset
// The PDFs (LabReport) stay on the server: the page still uses the api for /labs/reports.
// list / get / summary / add / edit / delete are ported from the old labs.js routes, with the same answers.
import Parse from "../parse";
import { run } from "./parseCall";
import { LAB_TESTS, labTestOf, labCatalog, type LabTest } from "./labCatalog";
import { MAX_ROWS, ownerAcl, textOrNull, iso } from "./common";

export { labCatalog };

export type Flag = "normal" | "low" | "high" | "critical_low" | "critical_high" | "abnormal" | null;
// a result as the old routes answered it (result_id is the Parse objectId)
export type LabResultRow = {
  result_id: string; user_id: string | null; report_id: string | null; test_code: string | null; test_name: string; panel: string | null;
  value_numeric: number | null; value_text: string | null; unit: string | null; ref_low: number | null; ref_high: number | null;
  ref_text: string | null; range_source: "report" | "catalog" | "none"; flag: Flag; collected_date: string; notes: string | null;
  source: string | null; created_at: string; updated_at: string | null;
};
export type Change = { previous_value: number; previous_date: string; delta: number; direction: string; trend: string | null };
export type SummaryItem = LabResultRow & { change: Change | null; about: string | null; result_count: number };
export type AttentionItem = SummaryItem & { percent_outside: number | null; urgent: boolean; advice: string };
export type LabSummary = {
  tests_tracked: number; out_of_range_count: number; urgent_count: number; in_range_count: number; report_count: number;
  needs_attention: AttentionItem[]; latest: SummaryItem[];
};
// one result as the old POST / PUT bodies took it ("value" = a number goes to value_numeric, anything else to value_text)
export type ResultInput = Partial<{
  test_code: string | null; test_name: string | null; panel: string | null; value: string | number | null;
  value_numeric: number | string | null; value_text: string | null; unit: string | null;
  ref_low: number | string | null; ref_high: number | string | null; ref_text: string | null; flag: string | null;
  collected_date: string | null; notes: string | null; source: string | null; report_id: string | null;
}>;
export type PanelInput = ResultInput & { results?: ResultInput[] };

const MAX_PANEL = 50;
const FLAGS = ["normal", "low", "high", "critical_low", "critical_high", "abnormal"];
const SOURCES = ["manual_entry", "document_upload", "provider_entered"];
const OUT_OF_RANGE = ["low", "high", "critical_low", "critical_high", "abnormal"];
const isHighFlag = (f: Flag) => f === "high" || f === "critical_high";
const isLowFlag = (f: Flag) => f === "low" || f === "critical_low";

const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const isId = (v: string) => /^[A-Za-z0-9]{1,32}$/.test(v);
const isDate = (v: unknown): v is string => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

// labs.js resultRow()
function toResult(o: Parse.Object): LabResultRow {
  return {
    result_id: o.id, user_id: textOrNull(o.get("user_id")), report_id: textOrNull(o.get("report_id")), test_code: textOrNull(o.get("test_code")),
    test_name: o.get("test_name") || "", panel: textOrNull(o.get("panel")), value_numeric: numOrNull(o.get("value_numeric")),
    value_text: textOrNull(o.get("value_text")), unit: textOrNull(o.get("unit")), ref_low: numOrNull(o.get("ref_low")),
    ref_high: numOrNull(o.get("ref_high")), ref_text: textOrNull(o.get("ref_text")), range_source: o.get("range_source") || "none",
    flag: (textOrNull(o.get("flag")) as Flag) ?? null, collected_date: o.get("collected_date") || "", notes: textOrNull(o.get("notes")),
    source: textOrNull(o.get("source")), created_at: iso(o.createdAt) || "", updated_at: iso(o.updatedAt),
  };
}

// ---- the old route's field rules (labs.js buildResultRow, for a new result), so a whole panel is checked first ----
function text(value: unknown, max: number): string | null | undefined {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.length > max ? undefined : s;   // undefined = too long
}
// a finite number from a number or a numeric string, else null
function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const s = String(value).trim().replace(/,/g, "");
  return /^[-+]?(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : null;
}
function findTest(code: string | null, name: unknown): LabTest | null {
  if (code) return labTestOf(code);
  const n = String(name || "").trim().toLowerCase();
  if (!n) return null;
  return LAB_TESTS.find((c) => c.display_name.toLowerCase() === n || c.aliases.includes(n)) || null;
}
// the "value" shortcut, as the old route split it: { value_numeric, value_text } or { error }
function splitValue(body: ResultInput, label: string): { value_numeric: number | null; value_text: string | null } | { error: string } {
  const has = (k: keyof ResultInput) => Object.prototype.hasOwnProperty.call(body, k);
  let numeric: number | null = null;
  let txt: string | null | undefined = null;
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
  if (numeric === null && !txt) return { error: `enter a value for ${label}` };
  if (numeric !== null && Math.abs(numeric) >= 1e10) return { error: "value is too large" };
  return { value_numeric: numeric, value_text: numeric === null ? txt : txt || null };
}
// A new result -> the columns to send ({ values }) or the old route's message ({ error }). The server checks it again
// and adds the name / panel / unit / range / flag; only what the caller gave is sent.
function newResult(body: ResultInput): { values: Record<string, unknown> } | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "each result must be an object" };
  const has = (k: keyof ResultInput) => Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined;
  const values: Record<string, unknown> = {};
  const code = body.test_code == null || body.test_code === "" ? null : String(body.test_code);
  const test = findTest(code, body.test_name);
  if (code && !test) return { error: `unknown test_code "${code}"` };
  const name = text(body.test_name, 120);
  if (name === undefined) return { error: "test_name is too long (max 120)" };
  if (!test && !name) return { error: "test_name (or a test_code from the catalog) is required" };
  if (code) values.test_code = code;
  if (name) values.test_name = name;
  if (has("panel")) {
    const p = text(body.panel, 60);
    if (p === undefined) return { error: "panel is too long (max 60)" };
    if (p !== null) values.panel = p;
  }
  const v = splitValue(body, name || (test as LabTest).display_name);
  if ("error" in v) return v;
  if (v.value_numeric !== null) values.value_numeric = v.value_numeric;
  if (v.value_text !== null) values.value_text = v.value_text;
  if (has("unit")) {
    const u = text(body.unit, 30);
    if (u === undefined) return { error: "unit is too long (max 30)" };
    if (u !== null) values.unit = u;
  }
  let low: number | null = null, high: number | null = null;
  for (const k of ["ref_low", "ref_high"] as const) {
    if (!has(k) || body[k] === null || body[k] === "") continue;
    const n = toNumber(body[k]);
    if (n === null) return { error: `${k} must be a number` };
    values[k] = n;
    if (k === "ref_low") low = n; else high = n;
  }
  if (has("ref_text")) {
    const t = text(body.ref_text, 100);
    if (t === undefined) return { error: "ref_text is too long (max 100)" };
    if (t !== null) values.ref_text = t;
  }
  if (low !== null && high !== null && low > high) return { error: "ref_low cannot be more than ref_high" };
  if (has("flag") && body.flag !== null) {
    if (!["normal", "abnormal"].includes(String(body.flag))) return { error: "flag can only be set to normal or abnormal (number results are flagged from the range)" };
    values.flag = body.flag;
  }
  if (!isDate(body.collected_date)) return { error: "collected_date is required (YYYY-MM-DD)" };
  values.collected_date = body.collected_date;
  if (has("notes")) {
    const t = text(body.notes, 2000);
    if (t === undefined) return { error: "notes are too long (max 2000)" };
    if (t !== null) values.notes = t;
  }
  if (has("source")) {
    if (!SOURCES.includes(String(body.source))) return { error: `source must be one of: ${SOURCES.join(", ")}` };
    values.source = body.source;
  }
  if (has("report_id") && body.report_id !== null && body.report_id !== "") {
    if (!isId(String(body.report_id))) return { error: "report_id must be a valid id" };
    values.report_id = String(body.report_id);
  }
  return { values };
}

// ---- reads ----

// every result of the caller (the triggers keep it to their own rows)
export function fetchResults(): Promise<LabResultRow[]> {
  return run(async () => (await new Parse.Query("LabResult").limit(MAX_ROWS).find()).map(toResult));
}

// GET /labs/results?test=&flag=&from=&to=&report_id= (filters the rows from fetchResults)
export function listResults(rows: LabResultRow[], query: { test?: string; flag?: string; from?: string; to?: string; report_id?: string } = {}):
  { results: LabResultRow[]; count: number } {
  let out = rows.slice();
  if (query.test) {
    const t = String(query.test);
    out = out.filter((r) => r.test_code === t || r.test_name.toLowerCase() === t.trim().toLowerCase());
  }
  if (query.flag) {
    if (query.flag === "abnormal") out = out.filter((r) => OUT_OF_RANGE.includes(String(r.flag)));
    else if (FLAGS.includes(query.flag)) out = out.filter((r) => r.flag === query.flag);
    else throw new Error(`flag must be abnormal or one of: ${FLAGS.join(", ")}`);
  }
  for (const k of ["from", "to"] as const) {
    const v = query[k];
    if (!v) continue;
    if (!isDate(v)) throw new Error(`${k} must be a date (YYYY-MM-DD)`);
    out = out.filter((r) => (k === "from" ? r.collected_date >= v : r.collected_date <= v));
  }
  if (query.report_id) {
    if (!isId(query.report_id)) throw new Error("report_id must be a valid id");
    out = out.filter((r) => r.report_id === query.report_id);
  }
  out.sort((a, b) => b.collected_date.localeCompare(a.collected_date) || a.test_name.localeCompare(b.test_name) || b.created_at.localeCompare(a.created_at));
  out = out.slice(0, 1000);
  return { results: out, count: out.length };
}

const sameUnit = (a: unknown, b: unknown) =>
  String(a || "").trim().toLowerCase().replace(/\s+/g, "") === String(b || "").trim().toLowerCase().replace(/\s+/g, "");

// GET /labs/summary: the latest value per test, what changed since the one before, and what is out of range.
// reportCount = how many PDF reports the caller has (from the /labs/reports list).
export function labSummary(all: LabResultRow[], reportCount: number): LabSummary {
  const rows = all.slice().sort((a, b) => b.collected_date.localeCompare(a.collected_date) || b.created_at.localeCompare(a.created_at));
  const groups = new Map<string, LabResultRow[]>();
  for (const r of rows) {
    const key = r.test_code || `name:${r.test_name.toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  const latest: SummaryItem[] = [], needsAttention: AttentionItem[] = [];
  for (const [, results] of groups) {
    const current = results[0];
    const previous = results.slice(1).find((r) => r.value_numeric !== null && sameUnit(r.unit, current.unit)) || null;
    const test = labTestOf(current.test_code);
    let change: Change | null = null;
    if (previous && current.value_numeric !== null) {
      const delta = Number((current.value_numeric - (previous.value_numeric as number)).toFixed(4));
      const direction = delta === 0 ? "same" : delta > 0 ? "up" : "down";
      let trend: string | null = null;
      if (isHighFlag(current.flag)) trend = delta < 0 ? "improving" : delta > 0 ? "worsening" : "no change";
      else if (isLowFlag(current.flag)) trend = delta > 0 ? "improving" : delta < 0 ? "worsening" : "no change";
      change = { previous_value: previous.value_numeric as number, previous_date: previous.collected_date, delta, direction, trend };
    }
    const item: SummaryItem = { ...current, result_count: results.length, change, about: test ? test.about : null };
    latest.push(item);
    if (OUT_OF_RANGE.includes(String(current.flag))) {
      let percent_outside: number | null = null;
      if (current.value_numeric !== null) {
        if (isHighFlag(current.flag) && current.ref_high) percent_outside = Math.round(((current.value_numeric - current.ref_high) / Math.abs(current.ref_high)) * 100);
        else if (isLowFlag(current.flag) && current.ref_low) percent_outside = Math.round(((current.ref_low - current.value_numeric) / Math.abs(current.ref_low)) * 100);
      }
      const advice = test ? (isHighFlag(current.flag) ? test.advice_high : isLowFlag(current.flag) ? test.advice_low : null) : null;
      needsAttention.push({ ...item, percent_outside, urgent: current.flag === "critical_low" || current.flag === "critical_high",
        advice: advice || "This result is outside the normal range. Ask your doctor what it means for you." });
    }
  }
  const rank = (f: Flag) => (f === "critical_high" || f === "critical_low" ? 0 : 1);
  needsAttention.sort((a, b) => rank(a.flag) - rank(b.flag) || b.collected_date.localeCompare(a.collected_date) || (b.percent_outside ?? -1) - (a.percent_outside ?? -1));
  latest.sort((a, b) => b.collected_date.localeCompare(a.collected_date) || a.test_name.localeCompare(b.test_name));
  return {
    tests_tracked: latest.length, out_of_range_count: needsAttention.length, urgent_count: needsAttention.filter((x) => x.urgent).length,
    in_range_count: latest.filter((x) => x.flag === "normal").length, report_count: reportCount, needs_attention: needsAttention, latest,
  };
}

// ---- writes ----

// POST /labs/results: one result, or { results: [...] } for a whole panel (collected_date / report_id / source / panel at
// the top apply to all). Every result is checked first, then they are saved together.
export function addResults(body: PanelInput): Promise<{
  results?: LabResultRow[]; result?: LabResultRow; count: number; message: string;
  out_of_range: { result_id: string; test_name: string; flag: Flag }[];
}> {
  return run(async () => {
    if (!body || typeof body !== "object") throw new Error("Request body required");
    let items: ResultInput[];
    const panel = Array.isArray(body.results);
    if (panel) {
      const list = body.results as ResultInput[];
      if (!list.length) throw new Error("results is empty");
      if (list.length > MAX_PANEL) throw new Error(`at most ${MAX_PANEL} results at once`);
      const shared: ResultInput = {};
      for (const k of ["collected_date", "report_id", "source", "panel"] as const) if (k in body) (shared as Record<string, unknown>)[k] = body[k];
      items = list.map((r) => (r && typeof r === "object" && !Array.isArray(r) ? { ...shared, ...r } : r));
    } else items = [body];
    const objs = items.map((item, i) => {
      const built = newResult(item);
      if ("error" in built) throw new Error(items.length > 1 ? `result ${i + 1}: ${built.error}` : built.error);
      const o = new Parse.Object("LabResult");
      o.set(built.values);
      o.setACL(ownerAcl());
      return o;
    });
    await Parse.Object.saveAll(objs);
    // the save answers carry the server's values (name, range, flag)
    const saved = objs.map(toResult);
    const flagged = saved.filter((r) => OUT_OF_RANGE.includes(String(r.flag)));
    return {
      ...(panel ? { results: saved } : { result: saved[0] }), count: saved.length,
      out_of_range: flagged.map((r) => ({ result_id: r.result_id, test_name: r.test_name, flag: r.flag })),
      message: `${saved.length} result${saved.length === 1 ? "" : "s"} saved` + (flagged.length ? ` · ${flagged.length} outside the normal range` : ""),
    };
  });
}

// PUT /labs/results/:id: only the fields sent change (null / "" clears one); the server re-checks the flag and range
export function updateResult(id: string, body: ResultInput): Promise<{ result: LabResultRow }> {
  return run(async () => {
    if (!body || typeof body !== "object" || !Object.keys(body).length) throw new Error("Nothing to update");
    const { value, ...rest } = body;
    const fields: Record<string, unknown> = { ...rest };
    if ("value" in body) {
      // the old shortcut: a number is value_numeric (value_text cleared), anything else value_text
      const n = toNumber(value);
      fields.value_numeric = n;
      fields.value_text = n === null ? (value === null || value === undefined ? null : String(value)) : null;
    }
    for (const k of ["value_numeric", "ref_low", "ref_high"]) {
      const v = fields[k];
      if (typeof v === "string" && v.trim() !== "") {
        const n = toNumber(v);
        if (n === null) throw new Error(`${k} must be a number`);
        fields[k] = n;
      }
    }
    const o = new Parse.Object("LabResult");
    o.id = id;
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      if (v === null || v === "") o.unset(k); else o.set(k, v);
    }
    await o.save();
    return { result: toResult(await new Parse.Query("LabResult").get(id)) };
  });
}

// DELETE /labs/results/:id
export function removeResult(id: string): Promise<{ message: string; result_id: string }> {
  return run(async () => {
    const o = new Parse.Object("LabResult");
    o.id = id;
    await o.destroy();
    return { message: "Lab result deleted", result_id: id };
  });
}
