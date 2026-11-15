// vitals.ts — the only browser file that reads and writes VitalReading (the Vital Signs page), with the Parse SDK.
// Cloud Code triggers (RULES.VitalReading in Parse/cloud/lib/access.js) guard every request: own rows only, patients
// only, the field rules of vitals.js validate (known type, recordable ranges, a second value only for blood pressure,
// not in the future), a condition_id must be your own condition, and the audit log. The server fills in the unit
// (the type's default), the time (now) and the source (manual) when they are not sent.
// The automatic BMI stays on the server: saving or removing a weight or height makes / updates / removes the
// calculated BMI reading (source "calculated") right after the save. A calculated BMI can't be edited or removed here.
//   - never send user_id, source_reading_ids or source "calculated" (the server refuses them); never send source on an edit
//   - send the owner ACL on create only (the server overwrites it); never on update (a changed ACL is refused)
//   - plain values only; numbers as numbers, measured_at as a Date; clearing a field = unset
// list / getById / summary / trends / quickLook are ported from the old vitals.js routes, with the same answers.
import Parse from "../parse";
import { run } from "./parseCall";
import { getRecord } from "./records";
import { VITAL_TYPES, typeOf, type VitalTypeInfo } from "./vitalTypes";
import { MAX_ROWS, ownerAcl, isBlank, textOrNull, isoOrText } from "./common";

export type BmiInfo = { category: string | null; note: string | null; age: number | null };
// a reading as the old routes answered it (vital_log_id is the Parse objectId)
export type Reading = {
  vital_log_id: string; user_id: string | null; vital_type: string; value_numeric: number; value_secondary: number | null;
  unit: string | null; measured_at: string; measurement_context: string | null; body_position: string | null;
  device_name: string | null; source: string | null; condition_id: string | null; notes: string | null;
  source_reading_ids: string[] | null; created_at: string | null; updated_at: string | null; logged_at: string | null;
  bmi_info?: BmiInfo;
};
export type Range = { min: number | null; max: number | null; secondaryMin: number | null; secondaryMax: number | null; source: string };
export type Evaluation = { status: string; range: Range };
type Target = { target_min: number | null; target_max: number | null; secondary_min: number | null; secondary_max: number | null;
  set_by: string | null; condition_id: string };
// what the page sends ("" or null = not set / clear)
export type ReadingInput = Partial<{
  vital_type: string; value_numeric: number; value_secondary: number | null; unit: string | null; measured_at: Date;
  measurement_context: string | null; body_position: string | null; device_name: string | null;
  source: string | null; condition_id: string | null; notes: string | null;
}>;
export type BmiResult = { action: string; reason?: string; reading?: Reading };

const DAY_MS = 86400000;
const BMI_SOURCE = "calculated";
const BMI_WINDOW_DAYS = 365;

const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const isDate = (v: unknown): v is string => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
const isDateTime = (v: unknown) => typeof v === "string" && v.length > 0 && !isNaN(new Date(v).getTime());

// vitals.js row(): result.id, not result.get("objectId") (undefined: the id is not an attribute)
function toReading(o: Parse.Object): Reading {
  const ids = o.get("source_reading_ids");
  const created = isoOrText(o.createdAt);
  return {
    vital_log_id: o.id, user_id: textOrNull(o.get("user_id")), vital_type: o.get("vital_type") || "",
    value_numeric: numOrNull(o.get("value_numeric")) as number, value_secondary: numOrNull(o.get("value_secondary")), unit: textOrNull(o.get("unit")),
    measured_at: isoOrText(o.get("measured_at")) || "", measurement_context: textOrNull(o.get("measurement_context")),
    body_position: textOrNull(o.get("body_position")), device_name: textOrNull(o.get("device_name")), source: textOrNull(o.get("source")),
    condition_id: textOrNull(o.get("condition_id")), notes: textOrNull(o.get("notes")), source_reading_ids: Array.isArray(ids) ? ids : null,
    created_at: created, updated_at: isoOrText(o.updatedAt), logged_at: created,
  };
}

// readings(): the caller's readings (one type or all), newest first
async function readings(vitalType?: string | null): Promise<Reading[]> {
  const q = new Parse.Query("VitalReading").limit(MAX_ROWS);
  if (vitalType) q.equalTo("vital_type", vitalType);
  return (await q.find()).map(toReading).sort((a, b) => b.measured_at.localeCompare(a.measured_at));
}

// ---- BMI category (vitals.js ageOn / bmiCategory / dobOf) ----
const NOTE_UNDER_20 = "For children and teens, ask your doctor to compare BMI with growth charts for your age and sex.";
const NOTE_NO_DOB = "Add your date of birth in your Health History to see a BMI category.";

function ageOn(dob: string | null, measuredAt: string): number | null {
  if (!isDate(dob) || !isDateTime(String(measuredAt))) return null;
  const on = new Date(measuredAt).toISOString().slice(0, 10);
  let age = Number(on.slice(0, 4)) - Number(dob.slice(0, 4));
  if (on.slice(5) < dob.slice(5)) age--;
  return age >= 0 && age < 150 ? age : null;
}
function bmiCategory(bmi: number, age: number | null): BmiInfo {
  if (!Number.isInteger(age)) return { category: null, note: NOTE_NO_DOB, age: null };
  if ((age as number) < 20) return { category: null, note: NOTE_UNDER_20, age };
  const v = Number(bmi);
  const category = v < 18.5 ? "Underweight" : v < 25 ? "Normal weight" : v < 30 ? "Overweight" : "Obesity";
  return { category, note: null, age };
}
// the date of birth from the Health History form (MedicalRecord, data/records.ts)
async function dobOf(): Promise<string | null> {
  const rec = await getRecord();
  const data = rec && rec.data;
  if (!data || typeof data !== "object") return null;
  const patient = data.patient as Record<string, unknown> | undefined;
  const dob = patient && typeof patient === "object" && patient.dob ? patient.dob : data.dob;
  return typeof dob === "string" ? dob : null;
}
const bmiInfoFor = (r: { value_numeric: number; measured_at: string }, dob: string | null) => bmiCategory(r.value_numeric, ageOn(dob, r.measured_at));

// ---- ranges (vitals.js activeTarget / evaluate) ----
// the newest active condition target per vital type (ConditionTarget rows are the caller's own)
async function activeTargets(): Promise<Map<string, Target>> {
  const rows = await new Parse.Query("ConditionTarget").equalTo("active", true).descending("createdAt").limit(MAX_ROWS).find();
  const out = new Map<string, Target>();
  for (const t of rows) {
    const vt = t.get("vital_type");
    if (out.has(vt)) continue;
    out.set(vt, { target_min: t.get("target_min") ?? null, target_max: t.get("target_max") ?? null, secondary_min: t.get("secondary_min") ?? null,
      secondary_max: t.get("secondary_max") ?? null, set_by: t.get("set_by") ?? null, condition_id: t.get("condition_id") });
  }
  return out;
}

function evaluate(reading: { value_numeric: number | null; value_secondary?: number | null }, type: VitalTypeInfo, target: Target | null | undefined): Evaluation {
  const pick = (t: keyof Target, k: keyof VitalTypeInfo): number | null =>
    (target && target[t] != null ? Number(target[t]) : type[k] != null ? Number(type[k]) : null);
  const range: Range = {
    min: pick("target_min", "normal_min"), max: pick("target_max", "normal_max"),
    secondaryMin: pick("secondary_min", "secondary_min"), secondaryMax: pick("secondary_max", "secondary_max"),
    source: target ? "condition_target" : "reference_range",
  };
  if (range.min == null && range.max == null && range.secondaryMin == null && range.secondaryMax == null) return { status: "no_range", range };
  const v = Number(reading.value_numeric);
  const s = reading.value_secondary != null ? Number(reading.value_secondary) : null;
  const below = (range.min != null && v < range.min) || (s != null && range.secondaryMin != null && s < range.secondaryMin);
  const above = (range.max != null && v > range.max) || (s != null && range.secondaryMax != null && s > range.secondaryMax);
  return { status: above ? "above_range" : below ? "below_range" : "in_range", range };
}

const isFlagged = (status: string) => status === "above_range" || status === "below_range";

// ---- list / one reading ----

// GET /vitals?type=&startDate=&endDate=&limit= (limit: default 100, at most 500)
export function listReadings(opts: { type?: string; startDate?: string; endDate?: string; limit?: number } = {}): Promise<{ readings: Reading[]; count: number }> {
  return run(async () => {
    const { type, startDate, endDate } = opts;
    const limit = Number.isInteger(opts.limit) && (opts.limit as number) > 0 ? Math.min(opts.limit as number, 500) : 100;
    if (startDate && !isDateTime(startDate)) throw new Error("startDate is not a valid date");
    if (endDate && !isDateTime(endDate)) throw new Error("endDate is not a valid date");
    let rows = await readings(type);
    if (startDate) rows = rows.filter((r) => r.measured_at >= new Date(startDate).toISOString());
    if (endDate) rows = rows.filter((r) => r.measured_at < new Date(new Date(endDate.slice(0, 10)).getTime() + DAY_MS).toISOString());
    rows = rows.slice(0, limit);
    if (rows.some((r) => r.vital_type === "bmi")) {
      const dob = await dobOf();
      for (const r of rows) if (r.vital_type === "bmi") r.bmi_info = bmiInfoFor(r, dob);
    }
    return { readings: rows, count: rows.length };
  });
}

// ---- add / edit / remove ----

// computeBmi() from vitals.js, only to explain why no BMI was made (the server makes the BMI itself)
const LB_PER_KG = 2.20462;
const WEIGHT_TO_KG: Record<string, number> = { kg: 1, kgs: 1, kilogram: 1, kilograms: 1, lb: 1 / LB_PER_KG, lbs: 1 / LB_PER_KG, pound: 1 / LB_PER_KG, pounds: 1 / LB_PER_KG };
const HEIGHT_TO_M: Record<string, number> = { in: 0.0254, inch: 0.0254, inches: 0.0254, cm: 0.01, centimeter: 0.01, centimeters: 0.01, centimetre: 0.01,
  centimetres: 0.01, m: 1, meter: 1, meters: 1, metre: 1, metres: 1 };
const unitKey = (u: unknown) => (typeof u === "string" ? u.trim().toLowerCase().replace(/\.$/, "") : "");
function bmiReason(weight: Reading, height: Reading): string | null {
  const w = Number(weight.value_numeric), h = Number(height.value_numeric);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return "Weight and height must be numbers.";
  if (w <= 0 || h <= 0) return "Weight and height must be greater than zero.";
  const wf = WEIGHT_TO_KG[unitKey(weight.unit)], hf = HEIGHT_TO_M[unitKey(height.unit)];
  if (wf === undefined) return "The weight unit is missing or not recognised (use kg or lb), so BMI was not calculated.";
  if (hf === undefined) return "The height unit is missing or not recognised (use in, cm or m), so BMI was not calculated.";
  const bmi = Math.round(((w * wf) / ((h * hf) * (h * hf))) * 10) / 10;
  if (!Number.isFinite(bmi) || bmi < 5 || bmi > 100) return `The calculated BMI (${bmi}) is outside the recordable range, so it was not saved. Check the weight and height.`;
  return null;
}

// What the server's automatic BMI did after a weight or height was saved (the old POST /vitals "bmi" answer):
// the calculated BMI built from this reading, or why there is none.
async function bmiOutcome(saved: Reading): Promise<BmiResult | undefined> {
  if (saved.vital_type !== "weight" && saved.vital_type !== "height") return undefined;
  const made = await new Parse.Query("VitalReading").equalTo("vital_type", "bmi").equalTo("source", BMI_SOURCE)
    .containsAll("source_reading_ids", [saved.vital_log_id]).first();
  if (made) return { action: "created", reading: toReading(made) };
  const since = new Date(Date.now() - BMI_WINDOW_DAYS * DAY_MS).toISOString();
  const other = (await readings(saved.vital_type === "weight" ? "height" : "weight")).find((r) => r.measured_at >= since);
  if (!other) return { action: "none", reason: `A BMI needs both a weight and a height from the last ${BMI_WINDOW_DAYS} days.` };
  const reason = saved.vital_type === "weight" ? bmiReason(saved, other) : bmiReason(other, saved);
  return { action: "none", reason: reason || "BMI could not be calculated right now." };
}

// POST /vitals: blank fields are not sent; the answer has the reading, its evaluation and (weight/height) the BMI outcome
export function addReading(input: ReadingInput): Promise<{ reading: Reading; evaluation: Evaluation | null; bmi?: BmiResult }> {
  return run(async () => {
    const obj = new Parse.Object("VitalReading");
    for (const [k, v] of Object.entries(input)) if (!isBlank(v)) obj.set(k, v);
    obj.setACL(ownerAcl());
    await obj.save();
    const reading = toReading(obj);
    const type = typeOf(reading.vital_type);
    const evaluation = type ? evaluate(reading, type, (await activeTargets()).get(reading.vital_type)) : null;
    const bmi = await bmiOutcome(reading);
    return bmi ? { reading, evaluation, bmi } : { reading, evaluation };
  });
}

// DELETE /vitals/:id: removing a weight or height also removes its calculated BMI (the server does that)
export function removeReading(id: string): Promise<void> {
  return run(async () => {
    const obj = new Parse.Object("VitalReading");
    obj.id = id;
    await obj.destroy();
  });
}

// ---- summary / trends / quick-look ----

// GET /vitals/summary: the latest reading per type with its range check, in the types' order
export function vitalsSummary() {
  return run(async () => {
    const [all, targets] = await Promise.all([readings(), activeTargets()]);
    const latest = new Map<string, Reading>();
    for (const r of all) if (!latest.has(r.vital_type)) latest.set(r.vital_type, r);
    const since30 = new Date(Date.now() - 30 * DAY_MS).toISOString();
    const out = [];
    for (const [vt, r] of latest) {
      const type = typeOf(vt);
      if (!type) continue;
      const ofType = all.filter((x) => x.vital_type === vt);
      out.push({
        vital_type: vt, display_name: type.display_name, is_dual_value: type.is_dual_value, value_label: type.value_label,
        secondary_label: type.secondary_label, decimal_places: type.decimal_places,
        latest: { vital_log_id: r.vital_log_id, value_numeric: r.value_numeric, value_secondary: r.value_secondary, unit: r.unit,
          measured_at: r.measured_at, measurement_context: r.measurement_context, notes: r.notes },
        evaluation: evaluate(r, type, targets.get(vt)),
        total_readings: ofType.length, readings_last_30_days: ofType.filter((x) => x.measured_at >= since30).length,
        sort: type.sort_order,
      });
    }
    out.sort((a, b) => a.sort - b.sort);
    const summary = out.map(({ sort: _sort, ...s }) => { void _sort; return s; });
    return { summary, tracked_types: summary.length, flagged_count: summary.filter((s) => isFlagged(s.evaluation.status)).length };
  });
}

type Bucket = {
  bucket_start: string; reading_count: number; avg_value: number | null; min_value: number; max_value: number;
  avg_secondary: number | null; min_secondary: number | null; max_secondary: number | null;
};
// bucket start (UTC) for a timestamp
function bucketStart(at: string, size: string): string {
  const d = new Date(at);
  if (size === "day") return d.toISOString().slice(0, 10);
  if (size === "month") return `${d.toISOString().slice(0, 7)}-01`;
  // week: Monday (like Postgres date_trunc('week'))
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
}
const round2 = (n: number) => Number(n.toFixed(2));
function buckets(rows: Reading[], size: string): Bucket[] {
  const map = new Map<string, Reading[]>();
  for (const r of [...rows].sort((a, b) => a.measured_at.localeCompare(b.measured_at))) {
    const k = bucketStart(r.measured_at, size);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(r);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([start, list]) => {
    const vals = list.map((r) => Number(r.value_numeric));
    const secs = list.filter((r) => r.value_secondary != null).map((r) => Number(r.value_secondary));
    const avg = (a: number[]) => (a.length ? round2(a.reduce((s, x) => s + x, 0) / a.length) : null);
    return {
      bucket_start: start, reading_count: list.length, avg_value: avg(vals), min_value: Math.min(...vals), max_value: Math.max(...vals),
      avg_secondary: avg(secs), min_secondary: secs.length ? Math.min(...secs) : null, max_secondary: secs.length ? Math.max(...secs) : null,
    };
  });
}

function describeAge(seconds: number): string {
  if (seconds < 90) return "just now";
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo} month${mo === 1 ? "" : "s"} ago`;
  const y = (d / 365).toFixed(1);
  return `${y} year${y === "1.0" ? "" : "s"} ago`;
}

const RANGE_SPEC: Record<string, { bucket: string; days: number | null; label: string }> = {
  week: { bucket: "day", days: 7, label: "Past week" }, month: { bucket: "day", days: 30, label: "Past month" },
  year: { bucket: "month", days: 365, label: "Past year" }, all: { bucket: "month", days: null, label: "All time" },
};

export type QuickLookChange = {
  from: number | null; to: number | null; delta: number; percent: number | null; direction: string;
  secondary?: { from: number | null; to: number | null; delta: number };
};
export type QuickLookCard = {
  vital_type: string; display_name: string; unit: string; is_dual_value: boolean; value_label: string | null;
  secondary_label: string | null; decimal_places: number;
  today: {
    value: number; secondary: number | null; unit: string; measured_at: string; is_today: boolean; age_label: string;
    context: string | null; evaluation: Evaluation; source: string | null; bmi_info?: BmiInfo;
  } | null;
  series: { bucket_start: string; value: number; secondary: number | null; min: number; max: number; reading_count: number }[];
  change: QuickLookChange | null; buckets_out_of_range: number; range: Range | null;
};

// GET /vitals/quick-look?range=week|month|year|all&type=: one chart card per type that has readings
export function quickLook(rangeName = "month", onlyType?: string) {
  return run(async () => {
    const range = String(rangeName || "month").toLowerCase();
    const spec = RANGE_SPEC[range];
    if (!spec) throw new Error(`Invalid range. Must be one of: ${Object.keys(RANGE_SPEC).join(", ")}`);
    if (onlyType && !typeOf(onlyType)) throw new Error(`Unknown vital_type: ${onlyType}`);
    const [all, targets] = await Promise.all([readings(onlyType), activeTargets()]);
    const present = VITAL_TYPES.filter((t) => all.some((r) => r.vital_type === t.vital_type));
    const todayUtc = new Date().toISOString().slice(0, 10);
    const windowStart = spec.days ? new Date(Date.parse(`${todayUtc}T00:00:00Z`) - spec.days * DAY_MS).toISOString().slice(0, 10) : null;
    const cards: QuickLookCard[] = [];
    const bmiDob = present.some((t) => t.vital_type === "bmi") ? await dobOf() : null;
    for (const type of present) {
      const ofType = all.filter((r) => r.vital_type === type.vital_type);
      const series = buckets(ofType, spec.bucket).filter((b) => !windowStart || b.bucket_start >= windowStart);
      const latestRow = ofType[0];
      let change: QuickLookChange | null = null;
      if (series.length >= 2) {
        const first = series[0].avg_value as number, last = series[series.length - 1].avg_value as number;
        const delta = round2(last - first);
        change = { from: first, to: last, delta, percent: first !== 0 ? Number(((delta / first) * 100).toFixed(1)) : null,
          direction: Math.abs(delta) < Math.abs(first) * 0.03 ? "steady" : delta > 0 ? "up" : "down" };
        if (type.is_dual_value && series[0].avg_secondary != null) {
          const fs = series[0].avg_secondary, ls = series[series.length - 1].avg_secondary as number;
          change.secondary = { from: fs, to: ls, delta: round2(ls - fs) };
        }
      }
      const target = targets.get(type.vital_type);
      const evaluation = latestRow ? evaluate(latestRow, type, target) : null;
      let bucketsOut = 0;
      if (evaluation && evaluation.status !== "no_range") {
        for (const bk of series) {
          if (isFlagged(evaluate({ value_numeric: bk.avg_value, value_secondary: bk.avg_secondary }, type, target).status)) bucketsOut++;
        }
      }
      cards.push({
        vital_type: type.vital_type, display_name: type.display_name, unit: type.default_unit, is_dual_value: type.is_dual_value,
        value_label: type.value_label, secondary_label: type.secondary_label, decimal_places: type.decimal_places,
        today: latestRow && evaluation ? {
          value: Number(latestRow.value_numeric), secondary: latestRow.value_secondary != null ? Number(latestRow.value_secondary) : null,
          unit: latestRow.unit as string, measured_at: latestRow.measured_at, is_today: latestRow.measured_at.slice(0, 10) === todayUtc,
          age_label: describeAge(Math.max(0, (Date.now() - Date.parse(latestRow.measured_at)) / 1000)),
          context: latestRow.measurement_context, evaluation, source: latestRow.source,
          ...(type.vital_type === "bmi" ? { bmi_info: bmiInfoFor(latestRow, bmiDob) } : {}),
        } : null,
        series: series.map((bk) => ({ bucket_start: bk.bucket_start, value: bk.avg_value as number, secondary: bk.avg_secondary,
          min: bk.min_value, max: bk.max_value, reading_count: bk.reading_count })),
        change, buckets_out_of_range: bucketsOut, range: evaluation ? evaluation.range : null,
      });
    }
    return { range, range_label: spec.label, bucket_size: spec.bucket, source: "readings", cards };
  });
}
