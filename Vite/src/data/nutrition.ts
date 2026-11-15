// nutrition.ts — the only browser file that reads and writes NutritionLog (the Nutrition page's food log), with the
// Parse SDK. Cloud Code triggers (RULES.NutritionLog in Parse/cloud/lib/access.js) guard every request: own rows only,
// patients only, the field rules of nutrition.js validate (food name, serving size above 0 and unit required, numbers
// 0 or more), the server sets source (usda_api / manual), and the audit log.
// The USDA food search is NOT here: it stays the api route POST /nutrition/search (it needs the server's USDA key).
//   - never send user_id or source (the server sets them)
//   - send the owner ACL on create only (the server overwrites it); never on update (a changed ACL is refused)
//   - plain values only; numbers as numbers, logged_at as a Date; clearing a field = unset
// logs() and summary() are ported from the old nutrition.js routes: a log's day is its local calendar day in tz.
import Parse from "../parse";
import { run } from "./parseCall";
import { MAX_ROWS, ownerAcl, isBlank, textOrNull, isoOrText } from "./common";

// a food entry as the page shows it (the old /nutrition/logs row; log_id is the Parse objectId)
export type LogRow = {
  log_id: string; food_name: string; usda_fdc_id: string | null; serving_size: number | null; serving_unit: string | null;
  logged_at: string; calories: number | null; protein_g: number | null; carbs_g: number | null; fat_g: number | null;
  fiber_g: number | null; sugar_g: number | null; sodium_mg: number | null; source: string | null; confidence: number | null;
  notes: string | null; created_at: string | null; updated_at: string | null;
};
// the old /nutrition/summary answer
export type Summary = {
  date: string; meal_count: number; total_calories: number; total_protein: number; total_carbs: number;
  total_fat: number; total_fiber: number; total_sugar: number; total_sodium: number;
};
// what the page sends, with the old API's camelCase names (null or "" = not set / clear)
export type NutritionInput = Partial<{
  foodName: string; usdaFdcId: string; servingUnit: string; notes: string; loggedAt: Date;
  servingSize: number | null; calories: number | null; proteinG: number | null; carbsG: number | null; fatG: number | null;
  fiberG: number | null; sugarG: number | null; sodiumMg: number | null; confidence: number | null;
}>;

const COLUMNS: Record<keyof NutritionInput, string> = {
  foodName: "food_name", usdaFdcId: "usda_fdc_id", servingSize: "serving_size", servingUnit: "serving_unit", calories: "calories",
  proteinG: "protein_g", carbsG: "carbs_g", fatG: "fat_g", fiberG: "fiber_g", sugarG: "sugar_g", sodiumMg: "sodium_mg",
  confidence: "confidence", notes: "notes", loggedAt: "logged_at",
};

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_FORMAT_ERROR = "Use the date format YYYY-MM-DD";

const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

// result.id, not result.get("objectId") (undefined: the id is not an attribute)
function toRow(o: Parse.Object): LogRow {
  return {
    log_id: o.id, food_name: o.get("food_name") || "", usda_fdc_id: textOrNull(o.get("usda_fdc_id")),
    serving_size: numOrNull(o.get("serving_size")), serving_unit: textOrNull(o.get("serving_unit")), logged_at: isoOrText(o.get("logged_at")) || "",
    calories: numOrNull(o.get("calories")), protein_g: numOrNull(o.get("protein_g")), carbs_g: numOrNull(o.get("carbs_g")),
    fat_g: numOrNull(o.get("fat_g")), fiber_g: numOrNull(o.get("fiber_g")), sugar_g: numOrNull(o.get("sugar_g")),
    sodium_mg: numOrNull(o.get("sodium_mg")), source: textOrNull(o.get("source")), confidence: numOrNull(o.get("confidence")),
    notes: textOrNull(o.get("notes")), created_at: isoOrText(o.createdAt), updated_at: isoOrText(o.updatedAt),
  };
}

// ---- local days (the same rules as the server's reminders.localDate / addDays / validZone) ----

function validZone(tz: string): boolean {
  if (!tz.trim()) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}
function checkZone(tz: string) {
  if (!validZone(tz)) throw new Error("Unknown time zone");
}
// a real calendar date written YYYY-MM-DD
function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
// the calendar day (YYYY-MM-DD) of a moment in time zone tz
export function localDay(date: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year").padStart(4, "0")}-${get("month")}-${get("day")}`;
}
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

// The caller's entries whose local day in tz is between first and last (inclusive), newest first. The query is narrowed
// to a UTC window one day wider on each side (every zone is within a day of UTC); the exact day test is done here.
async function rowsBetween(first: string, last: string, tz: string): Promise<LogRow[]> {
  const results = await new Parse.Query("NutritionLog")
    .greaterThanOrEqualTo("logged_at", new Date(Date.parse(`${first}T00:00:00Z`) - DAY_MS))
    .lessThan("logged_at", new Date(Date.parse(`${last}T00:00:00Z`) + 2 * DAY_MS))
    .limit(MAX_ROWS).find();
  return results.map(toRow)
    .filter((r) => { if (!r.logged_at) return false; const d = localDay(new Date(r.logged_at), tz); return d >= first && d <= last; })
    .sort((a, b) => b.logged_at.localeCompare(a.logged_at));
}

// the old GET /nutrition/logs: startDate..endDate are local days in tz (default: the last 30 days)
export function listLogs(opts: { startDate?: string; endDate?: string; tz?: string } = {}): Promise<LogRow[]> {
  const tz = opts.tz || "UTC";
  return run(async () => {
    checkZone(tz);
    const today = localDay(new Date(), tz);
    const startDate = opts.startDate || addDays(today, -30);
    const endDate = opts.endDate || today;
    if (!isDate(startDate) || !isDate(endDate)) throw new Error(DATE_FORMAT_ERROR);
    return rowsBetween(startDate, endDate, tz);
  });
}

// the old GET /nutrition/summary: one local day's totals (2 decimal places)
export function daySummary(opts: { date?: string; tz?: string } = {}): Promise<Summary> {
  const tz = opts.tz || "UTC";
  return run(async () => {
    checkZone(tz);
    const day = opts.date || localDay(new Date(), tz);
    if (!isDate(day)) throw new Error(DATE_FORMAT_ERROR);
    return summarize(day, await rowsBetween(day, day, tz));
  });
}

export function summarize(day: string, rows: LogRow[]): Summary {
  const sum = (k: keyof LogRow) => Number(rows.reduce((s, r) => s + (Number(r[k]) || 0), 0).toFixed(2));
  return { date: day, meal_count: rows.length, total_calories: sum("calories"), total_protein: sum("protein_g"),
    total_carbs: sum("carbs_g"), total_fat: sum("fat_g"), total_fiber: sum("fiber_g"), total_sugar: sum("sugar_g"), total_sodium: sum("sodium_mg") };
}

// the old POST /nutrition/log: blank fields are not sent; the server sets user_id, the ACL, source, logged_at (now) and confidence
export function addLog(input: NutritionInput): Promise<void> {
  return run(async () => {
    const obj = new Parse.Object("NutritionLog");
    for (const [k, v] of Object.entries(input)) if (!isBlank(v)) obj.set(COLUMNS[k as keyof NutritionInput], v);
    obj.setACL(ownerAcl());
    await obj.save();
  });
}

// the old PUT /nutrition/log/:id: only the fields given; null or "" clears the field (unset)
export function updateLog(id: string, input: NutritionInput): Promise<void> {
  return run(async () => {
    const obj = new Parse.Object("NutritionLog");
    obj.id = id;
    for (const [k, v] of Object.entries(input)) {
      if (v === undefined) continue;
      const column = COLUMNS[k as keyof NutritionInput];
      if (v === null || v === "") obj.unset(column);
      else obj.set(column, v);
    }
    await obj.save();
  });
}

// the old DELETE /nutrition/log/:id
export function deleteLog(id: string): Promise<void> {
  return run(async () => {
    const obj = new Parse.Object("NutritionLog");
    obj.id = id;
    await obj.destroy();
  });
}
