// respiratory.ts — the only browser file that reads and writes RespiratoryDevice, DeviceSupply and RespiratoryLog (the
// Breathing Devices page; Reminders reads the devices and parts), with the Parse SDK. Cloud Code triggers (RULES in
// Parse/cloud/lib/access.js) guard every request: own rows only, patients only, the field rules of respiratory.js
// (setting ranges, serial number, dates not in the future, one entry a night on a pressure machine), a part or entry
// must be on one of your own devices, and the audit log. A new device gets its default parts list from the server; removing a
// device removes its parts and entries (server).
//   - never send user_id (the server sets it); never change a device's type or move a part / entry to another device
//   - send the owner ACL on create only (the server overwrites it); never on update (a changed ACL is refused)
//   - plain values only; numbers as numbers; clearing a field = unset
// The lists, the parts' due status and the 30-day summary are ported from the old respiratory.js routes, with the same
// answers (dates are UTC days, as on the server).
import Parse from "../parse";
import { run } from "./parseCall";
import { MAX_ROWS, ownerAcl, isBlank, textOrNull, iso } from "./common";

export type Device = {
  device_id: string; user_id: string | null; device_type: string; name: string; serial_last4: string | null;
  mask_type: string | null; start_date: string | null; notes: string | null;
  pressure_min: number | null; pressure_max: number | null; epap: number | null; ipap: number | null;
  flow_lpm: number | null; personal_best: number | null; is_active: boolean;
  created_at: string | null; updated_at: string | null;
};
export type Supply = {
  supply_id: string; user_id: string | null; device_id: string; part_name: string; last_replaced: string | null;
  interval_days: number; notes: string | null; created_at: string | null; updated_at: string | null;
  next_due: string | null; days_left: number | null; due_status: "overdue" | "due_soon" | "ok";
};
export type DueSupply = Supply & { device_name: string; device_type: string };
export type Log = {
  log_id: string; user_id: string | null; device_id: string; log_date: string; notes: string | null;
  hours_used: number | null; ahi: number | null; leak_lpm: number | null; spo2_avg: number | null; spo2_min: number | null;
  flow_lpm_avg: number | null; comfort: number | null; peak_flow: number | null; created_at: string | null; updated_at: string | null;
};
export type PapSummary = {
  days: number; nights_logged: number; nights_ok: number; percent: number; compliant: boolean; nights_needed: number;
  avg_hours: number | null; avg_ahi: number | null; avg_leak: number | null; ahi_high: boolean; leak_high: boolean;
};
export type OxygenSummary = { days_logged: number; avg_hours: number | null; avg_flow_lpm: number | null; avg_spo2: number | null; days_below_88: number };
export type PeakFlowSummary = {
  personal_best: number | null; personal_best_source: string | null; latest: number | null; latest_date: string | null;
  percent_of_best: number | null; zone: "green" | "yellow" | "red" | null; advice: string | null;
};
export type Summary = { pap: PapSummary | null; oxygen: OxygenSummary | null; peak_flow: PeakFlowSummary | null; supplies_due: DueSupply[] };

const DAY_MS = 24 * 60 * 60 * 1000;
const DUE_SOON_DAYS = 7;
const PAP_TYPES = ["cpap", "apap", "bipap"];
const DEVICE_NUMBERS = ["pressure_min", "pressure_max", "epap", "ipap", "flow_lpm", "personal_best"] as const;
const LOG_NUMBERS = ["hours_used", "ahi", "leak_lpm", "spo2_avg", "spo2_min", "flow_lpm_avg", "comfort", "peak_flow"] as const;

const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const todayUtc = () => new Date().toISOString().slice(0, 10);
const isDate = (v: unknown): v is string => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

// the old deviceRow / supplyRow / logRow (result.id, not result.get("objectId"))
function toDevice(o: Parse.Object): Device {
  const out = {
    device_id: o.id, user_id: textOrNull(o.get("user_id")), device_type: o.get("device_type") || "", name: o.get("name") || "",
    serial_last4: textOrNull(o.get("serial_last4")), mask_type: textOrNull(o.get("mask_type")), start_date: textOrNull(o.get("start_date")),
    notes: textOrNull(o.get("notes")), is_active: o.get("is_active") === true, created_at: iso(o.createdAt), updated_at: iso(o.updatedAt),
  } as Device;
  for (const f of DEVICE_NUMBERS) out[f] = numOrNull(o.get(f));
  return out;
}
function toSupplyRow(o: Parse.Object) {
  return {
    supply_id: o.id, user_id: textOrNull(o.get("user_id")), device_id: o.get("device_id") || "", part_name: o.get("part_name") || "",
    last_replaced: textOrNull(o.get("last_replaced")), interval_days: o.get("interval_days") as number, notes: textOrNull(o.get("notes")),
    created_at: iso(o.createdAt), updated_at: iso(o.updatedAt),
  };
}
function toLog(o: Parse.Object): Log {
  const out = {
    log_id: o.id, user_id: textOrNull(o.get("user_id")), device_id: o.get("device_id") || "", log_date: o.get("log_date") || "",
    notes: textOrNull(o.get("notes")), created_at: iso(o.createdAt), updated_at: iso(o.updatedAt),
  } as Log;
  for (const f of LOG_NUMBERS) out[f] = numOrNull(o.get(f));
  return out;
}

// supplyStatus(): next_due = last_replaced + interval_days; days_left < 0 overdue, 0 to 7 due_soon, else ok.
// No (valid) replacement date or interval: no due date, "ok".
export function supplyStatus(s: { last_replaced: string | null; interval_days: number }, today = todayUtc()) {
  if (!s.last_replaced || !isDate(s.last_replaced) || !Number.isFinite(s.interval_days)) {
    return { next_due: null, days_left: null, due_status: "ok" as const };
  }
  const dueMs = Date.parse(s.last_replaced) + s.interval_days * DAY_MS;
  const daysLeft = Math.round((dueMs - Date.parse(today)) / DAY_MS);
  const dueStatus = daysLeft < 0 ? "overdue" as const : daysLeft <= DUE_SOON_DAYS ? "due_soon" as const : "ok" as const;
  return { next_due: new Date(dueMs).toISOString().slice(0, 10), days_left: daysLeft, due_status: dueStatus };
}
const toSupply = (o: Parse.Object): Supply => { const r = toSupplyRow(o); return { ...r, ...supplyStatus(r) }; };

// a new row: blank fields are not sent; the owner ACL is
async function createRow(className: string, fields: Record<string, unknown>): Promise<Parse.Object> {
  const obj = new Parse.Object(className);
  for (const [k, v] of Object.entries(fields)) if (!isBlank(v)) obj.set(k, v);
  obj.setACL(ownerAcl());
  return obj.save();
}
// an edit: null or "" clears the field (unset); nothing else is sent
async function updateRow(className: string, id: string, fields: Record<string, unknown>): Promise<void> {
  const obj = new Parse.Object(className);
  obj.id = id;
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (v === null || v === "") obj.unset(k);
    else obj.set(k, v);
  }
  await obj.save();
}
async function destroyRow(className: string, id: string): Promise<void> {
  const obj = new Parse.Object(className);
  obj.id = id;
  await obj.destroy();
}

// ---- devices ----

// GET /respiratory/devices: oldest first
export function listDevices(): Promise<{ devices: Device[] }> {
  return run(async () => ({ devices: (await new Parse.Query("RespiratoryDevice").ascending("createdAt").limit(MAX_ROWS).find()).map(toDevice) }));
}

// POST /respiratory/devices: the server sets the name (the type's) when none is given, is_active and the default parts
export function addDevice(fields: Record<string, unknown>): Promise<{ message: string; device: Device }> {
  return run(async () => ({ message: "Device added", device: toDevice(await createRow("RespiratoryDevice", fields)) }));
}

// PUT /respiratory/devices/:id: only the fields sent change; device_type is never sent
export function updateDevice(id: string, fields: Record<string, unknown>): Promise<{ message: string }> {
  return run(async () => {
    const { device_type: _type, ...rest } = fields;
    void _type;
    await updateRow("RespiratoryDevice", id, rest);
    return { message: "Device updated" };
  });
}

// DELETE /respiratory/devices/:id: the server also removes the device's parts and entries
export function removeDevice(id: string): Promise<{ message: string }> {
  return run(async () => { await destroyRow("RespiratoryDevice", id); return { message: "Device removed" }; });
}

// ---- parts ----

// GET /respiratory/devices/:id/supplies: a device's parts with their due status, oldest first
export function listSupplies(deviceId: string): Promise<{ supplies: Supply[] }> {
  return run(async () => ({
    supplies: (await new Parse.Query("DeviceSupply").equalTo("device_id", deviceId).ascending("createdAt").limit(MAX_ROWS).find()).map(toSupply),
  }));
}

// POST /respiratory/supplies/:id/replaced: last_replaced = the date (today when not given; never in the future)
export function markReplaced(supplyId: string, date: string): Promise<{ message: string }> {
  return run(async () => { await updateRow("DeviceSupply", supplyId, { last_replaced: date }); return { message: "Part marked as replaced" }; });
}

// ---- entries ----

// GET /respiratory/logs?device_id=&from=&to=&limit=: newest night first (limit 1 to 1000, default 500)
export function listLogs(opts: { device_id?: string; from?: string; to?: string; limit?: number } = {}): Promise<{ logs: Log[]; count: number }> {
  return run(async () => {
    const { device_id: deviceId, from, to } = opts;
    if (from && !isDate(from)) throw new Error("from must be a date in the format YYYY-MM-DD");
    if (to && !isDate(to)) throw new Error("to must be a date in the format YYYY-MM-DD");
    if (from && to && to < from) throw new Error("to cannot be before from");
    const limit = opts.limit ?? 500;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("limit must be between 1 and 1000");
    const q = new Parse.Query("RespiratoryLog").descending("log_date").limit(MAX_ROWS);
    if (deviceId) q.equalTo("device_id", deviceId);
    let logs = (await q.find()).map(toLog);
    if (from) logs = logs.filter((l) => l.log_date >= from);
    if (to) logs = logs.filter((l) => l.log_date <= to);
    logs = logs.slice(0, limit);
    return { logs, count: logs.length };
  });
}

// POST /respiratory/logs {device_id, log_date, readings..., notes?}
export function addLog(fields: Record<string, unknown>): Promise<{ message: string }> {
  return run(async () => { await createRow("RespiratoryLog", fields); return { message: "Entry added" }; });
}

// PUT /respiratory/logs/:id: only the fields sent change; device_id is never sent
export function updateLog(id: string, fields: Record<string, unknown>): Promise<{ message: string }> {
  return run(async () => {
    const { device_id: _device, ...rest } = fields;
    void _device;
    await updateRow("RespiratoryLog", id, rest);
    return { message: "Entry updated" };
  });
}

export function removeLog(id: string): Promise<{ message: string }> {
  return run(async () => { await destroyRow("RespiratoryLog", id); return { message: "Entry removed" }; });
}

// ---- summary (Task 2.4) ----

const SUMMARY_DAYS = 30;
const PAP_NIGHT_HOURS = 4;        // a night counts when the machine ran at least this many hours
const PAP_TARGET_NIGHTS = 21;     // 70% of 30 nights
const AHI_LIMIT = 5;              // average AHI at or above this is flagged
const LEAK_LIMIT = 24;            // average leak above this (L/min) is flagged
const LOW_SPO2 = 88;
// The page shows the reading, the percent of the person's own best and the colour. It does not interpret the reading or tell anyone what
// medicine to use: that belongs to the asthma action plan their doctor gave them. (Task: keep this wording reviewed by a clinician.)
const NO_PLAN = " If you do not have an asthma action plan, ask your doctor for one.";
const PEAK_ZONES = {
  green: "This reading is in your green range. Keep following the asthma action plan your doctor gave you." + NO_PLAN,
  yellow: "This reading is in your yellow range. Follow the asthma action plan your doctor gave you for this range." + NO_PLAN,
  red: "This reading is in your red range. Follow the asthma action plan your doctor gave you for this range. If you are struggling to breathe, call your local emergency number." + NO_PLAN,
};

const round1 = (n: number) => Math.round(n * 10) / 10;
const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const meanOrNull = (values: number[]) => { const m = mean(values); return m === null ? null : round1(m); };
const numbers = (rows: Log[], field: (typeof LOG_NUMBERS)[number]) => rows.map((r) => r[field]).filter((v): v is number => typeof v === "number");

// Pressure machines over the window. A night with no entry counts as 0 hours. With several PAP devices, a night's
// hours are the most any one of them recorded, so a night is counted once. avg_hours is over the nights that have an entry.
function papSummary(logs: Log[]): PapSummary {
  const hoursByNight = new Map<string, number>();
  for (const l of logs) {
    if (typeof l.hours_used !== "number") continue;
    hoursByNight.set(l.log_date, Math.max(hoursByNight.get(l.log_date) ?? 0, l.hours_used));
  }
  const hours = [...hoursByNight.values()];
  const nightsOk = hours.filter((h) => h >= PAP_NIGHT_HOURS).length;
  const avgAhi = mean(numbers(logs, "ahi")), avgLeak = mean(numbers(logs, "leak_lpm"));
  return {
    days: SUMMARY_DAYS, nights_logged: hours.length, nights_ok: nightsOk, percent: round1(nightsOk / SUMMARY_DAYS * 100),
    compliant: nightsOk >= PAP_TARGET_NIGHTS, nights_needed: Math.max(0, PAP_TARGET_NIGHTS - nightsOk), avg_hours: meanOrNull(hours),
    avg_ahi: avgAhi === null ? null : round1(avgAhi), avg_leak: avgLeak === null ? null : round1(avgLeak),
    ahi_high: avgAhi !== null && avgAhi >= AHI_LIMIT, leak_high: avgLeak !== null && avgLeak > LEAK_LIMIT,
  };
}

// Oxygen over the window. A day is below 88% when its spo2_min is under 88 (spo2_avg is not used for this count).
function oxygenSummary(logs: Log[]): OxygenSummary {
  const lowDays = new Set(logs.filter((l) => typeof l.spo2_min === "number" && l.spo2_min < LOW_SPO2).map((l) => l.log_date));
  return {
    days_logged: new Set(logs.map((l) => l.log_date)).size, avg_hours: meanOrNull(numbers(logs, "hours_used")),
    avg_flow_lpm: meanOrNull(numbers(logs, "flow_lpm_avg")), avg_spo2: meanOrNull(numbers(logs, "spo2_avg")), days_below_88: lowDays.size,
  };
}

// Peak flow: best = the highest personal_best set on a peak flow meter, else the highest peak flow ever logged
// (all dates, because a personal best doesn't expire). latest = the newest peak flow in the window.
function peakFlowSummary(devices: Device[], windowLogs: Log[], allLogs: Log[]): PeakFlowSummary {
  const set = devices.map((d) => d.personal_best).filter((v): v is number => typeof v === "number");
  const logged = numbers(allLogs, "peak_flow");
  const best = set.length ? Math.max(...set) : logged.length ? Math.max(...logged) : null;
  const latestLog = windowLogs.filter((l) => typeof l.peak_flow === "number")
    .sort((a, b) => (a.log_date < b.log_date ? 1 : a.log_date > b.log_date ? -1 : 0))[0];
  const out: PeakFlowSummary = {
    personal_best: best, personal_best_source: set.length ? "device" : logged.length ? "logged" : null,
    latest: latestLog ? latestLog.peak_flow : null, latest_date: latestLog ? latestLog.log_date : null,
    percent_of_best: null, zone: null, advice: null,
  };
  if (best && latestLog) {
    // Cut (not rounded) to one decimal, so 79.96% shows as 79.9 and is yellow: a reading is never shown as, or put in,
    // a better zone than it reached. (Whole tenths are latest * 1000 / best; the tiny extra guards float error.)
    const tenths = Math.floor((latestLog.peak_flow as number) * 1000 / best + 1e-9);
    out.percent_of_best = tenths / 10;
    out.zone = tenths >= 800 ? "green" : tenths >= 500 ? "yellow" : "red";   // 80% and 50% belong to the better zone
    out.advice = PEAK_ZONES[out.zone];
  }
  return out;
}

// GET /respiratory/summary: the last 30 days (today, UTC, and the 29 days before it). A section is null when there is
// no device of that kind. Inactive devices still count in the sections; only active devices' parts are listed in
// supplies_due, overdue first.
export function respiratorySummary(today = todayUtc()): Promise<Summary> {
  return run(async () => {
    const [deviceRows, logRows, supplyRows] = await Promise.all([
      new Parse.Query("RespiratoryDevice").ascending("createdAt").limit(MAX_ROWS).find(),
      new Parse.Query("RespiratoryLog").descending("log_date").limit(MAX_ROWS).find(),
      new Parse.Query("DeviceSupply").ascending("createdAt").limit(MAX_ROWS).find(),
    ]);
    const devices = deviceRows.map(toDevice), allLogs = logRows.map(toLog);
    const from = new Date(Date.parse(today) - (SUMMARY_DAYS - 1) * DAY_MS).toISOString().slice(0, 10), to = today;
    function section<T>(types: string[], build: (mine: Device[], windowLogs: Log[], logs: Log[]) => T): T | null {
      const mine = devices.filter((d) => types.includes(d.device_type));
      if (!mine.length) return null;
      const ids = new Set(mine.map((d) => d.device_id));
      const logs = allLogs.filter((l) => ids.has(l.device_id));
      return build(mine, logs.filter((l) => l.log_date >= from && l.log_date <= to), logs);
    }
    const active = new Map(devices.filter((d) => d.is_active).map((d) => [d.device_id, d]));
    const due: DueSupply[] = [];
    for (const o of supplyRows) {
      const row = toSupplyRow(o), device = active.get(row.device_id);
      if (!device) continue;
      const status = supplyStatus(row, today);
      if (status.due_status === "ok") continue;
      due.push({ ...row, ...status, device_name: device.name, device_type: device.device_type });
    }
    due.sort((a, b) => (a.days_left as number) - (b.days_left as number));
    return {
      pap: section(PAP_TYPES, (_d, logs) => papSummary(logs)),
      oxygen: section(["oxygen_concentrator", "portable_oxygen"], (_d, logs) => oxygenSummary(logs)),
      peak_flow: section(["peak_flow_meter"], (mine, logs, all) => peakFlowSummary(mine, logs, all)),
      supplies_due: due,
    };
  });
}
