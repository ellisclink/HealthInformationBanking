// respiratory.js — Breathing devices, their replaceable parts and daily/nightly entries (Tasks 2.1–2.4), on Parse.
// Classes: RespiratoryDevice, DeviceSupply, RespiratoryLog (parts and entries have device_id; they go with their device).
// The Breathing Devices page reads and saves all three with the Parse SDK (Vite/src/data/respiratory.ts: devices, parts
// with their due status, entries, the 30-day summary). The owner-only rules in access.js (RULES.RespiratoryDevice /
// DeviceSupply / RespiratoryLog) use the field rules here: deviceProblem/deviceValues, supplyProblem/supplyValues,
// logProblem/logValues, and afterDeviceSave (a new device gets its default parts list). There is no /respiratory api
// route any more. "Mark replaced" is a browser update of last_replaced.
// Still used on the server: createDevice and createLog (seed), supplyRow and supplyStatus (notifications: parts due).
// Every part shown carries next_due, days_left and due_status (overdue | due_soon | ok), see supplyStatus (Task 2.2).

const { isId, isDate, today, toRow, findAll, getOwned, create, audit, optText, maxDate, fail } = require("./db");

// The eight kinds of device, exactly as the spec lists them. "cpap", "apap" and "bipap" are pressure (PAP) machines.
const DEVICE_TYPES = ["cpap", "apap", "bipap", "oxygen_concentrator", "portable_oxygen", "nebulizer", "peak_flow_meter", "other"];
const MASK_TYPES = ["full_face", "nasal", "nasal_pillows", "hybrid", "oral", "other"];

const PAP_SUPPLIES = [
  { part_name: "Mask cushion", interval_days: 14 },
  { part_name: "Disposable filter", interval_days: 14 },
  { part_name: "Tubing", interval_days: 90 },
  { part_name: "Mask", interval_days: 90 },
  { part_name: "Headgear", interval_days: 180 },
  { part_name: "Reusable filter", interval_days: 180 },
  { part_name: "Water chamber", interval_days: 180 },
];
const OXYGEN_SUPPLIES = [
  { part_name: "Nasal cannula", interval_days: 14 },
  { part_name: "Tubing", interval_days: 90 },
];
// Replacement schedule created with a new device, keyed by device type. Days between replacements.
const DEFAULT_SUPPLIES = {
  cpap: PAP_SUPPLIES,
  apap: PAP_SUPPLIES,
  bipap: PAP_SUPPLIES,
  oxygen_concentrator: OXYGEN_SUPPLIES,
  portable_oxygen: OXYGEN_SUPPLIES,
  nebulizer: [{ part_name: "Nebulizer kit", interval_days: 90 }],
  peak_flow_meter: [],
  other: [],
};

// Number ranges for the settings a person can enter
const SETTING_RANGES = {
  pressure_min: { min: 3, max: 30, label: "Minimum pressure", unit: "cm H2O" },
  pressure_max: { min: 3, max: 30, label: "Maximum pressure", unit: "cm H2O" },
  epap: { min: 3, max: 30, label: "EPAP", unit: "cm H2O" },
  ipap: { min: 3, max: 30, label: "IPAP", unit: "cm H2O" },
  flow_lpm: { min: 0.25, max: 15, label: "Oxygen flow", unit: "L/min" },
  personal_best: { min: 1, max: 1000, label: "Personal best", unit: "L/min" },
};

const DEVICE_FIELDS = ["user_id", "device_type", "name", "serial_last4", "mask_type", "start_date", "notes",
  "pressure_min", "pressure_max", "epap", "ipap", "flow_lpm", "personal_best", "is_active"];
const SUPPLY_FIELDS = ["user_id", "device_id", "part_name", "last_replaced", "interval_days", "notes"];
const LOG_FIELDS = ["user_id", "device_id", "log_date", "notes", "hours_used", "ahi", "leak_lpm", "spo2_avg", "spo2_min", "flow_lpm_avg", "comfort", "peak_flow"];
const logRow = (o) => toRow(o, "log_id", LOG_FIELDS);
const deviceRow = (o) => toRow(o, "device_id", DEVICE_FIELDS);
const supplyRow = (o) => toRow(o, "supply_id", SUPPLY_FIELDS);

const DAY_MS = 24 * 60 * 60 * 1000;
const DUE_SOON_DAYS = 7;

// When a part is next due. next_due = last_replaced + interval_days; days_left = next_due - today (whole days).
// days_left < 0 is "overdue", 0 to 7 is "due_soon", more is "ok". A part with no replacement date has no due date
// and is reported "ok" (nothing to count from). `todayDate` is a YYYY-MM-DD string and defaults to today.
function supplyStatus(supply, todayDate = today()) {
  // No (valid) replacement date or interval, e.g. an old stored row with the interval missing: nothing to count from
  if (!supply.last_replaced || !isDate(supply.last_replaced) || !Number.isFinite(supply.interval_days)) {
    return { next_due: null, days_left: null, due_status: "ok" };
  }
  // Dates are whole days in UTC, so adding days never drifts across daylight-saving changes
  const dueMs = Date.parse(supply.last_replaced) + supply.interval_days * DAY_MS;
  const daysLeft = Math.round((dueMs - Date.parse(todayDate)) / DAY_MS);
  const dueStatus = daysLeft < 0 ? "overdue" : daysLeft <= DUE_SOON_DAYS ? "due_soon" : "ok";
  return { next_due: new Date(dueMs).toISOString().slice(0, 10), days_left: daysLeft, due_status: dueStatus };
}
// A part with its due status (createDevice). Audit rows keep the stored fields only.
const withStatus = (row) => ({ ...row, ...supplyStatus(row) });

const has = (body, k) => Object.prototype.hasOwnProperty.call(body, k);
const blank = (v) => v === undefined || v === null || v === "";
const TYPE_LABEL = { cpap: "CPAP", apap: "APAP", bipap: "BiPAP", oxygen_concentrator: "Oxygen concentrator", portable_oxygen: "Portable oxygen", nebulizer: "Nebulizer", peak_flow_meter: "Peak flow meter", other: "Other device" };

// A plain number (4, "4", "4.5", "-2") or NaN. Booleans, hex ("0x10"), exponents ("1e1"), arrays and objects are not numbers here.
function plainNumber(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value.trim());
  return NaN;
}

// A number in a range, or null when blank
function readNumber(value, { min, max, label, unit }) {
  if (blank(value)) return { value: null };
  const n = plainNumber(value);
  if (!Number.isFinite(n)) return { error: `${label} must be a number` };
  if (n < min || n > max) return { error: `${label} must be from ${min} to ${max} ${unit}` };
  return { value: n };
}

// Serial numbers are kept short on purpose: only the last 6 characters are stored, and at least 4 are needed.
function readSerial(value) {
  if (blank(value)) return { value: null };
  if (typeof value !== "string") return { error: "Serial number must be text" };
  const s = value.replace(/\s+/g, "");
  if (s.length < 4) return { error: "Enter the last 4 to 6 characters of the serial number" };
  return { value: s.slice(-6) };
}

// Checks the fields present in `body` and returns the values to store. `current` holds the stored
// device values, so a change to one pressure is checked against the other.
function readDeviceFields(body, current) {
  const out = {};

  if (has(body, "name")) {
    const name = optText(body.name, 100, "Name");
    if (name.error) return { error: name.error };
    out.name = name.value;
  }
  if (has(body, "notes")) {
    const notes = optText(body.notes, 500, "Notes");
    if (notes.error) return { error: notes.error };
    out.notes = notes.value;
  }
  if (has(body, "serial_last4")) {
    const serial = readSerial(body.serial_last4);
    if (serial.error) return { error: serial.error };
    out.serial_last4 = serial.value;
  }
  if (has(body, "mask_type")) {
    if (blank(body.mask_type)) out.mask_type = null;
    else if (!MASK_TYPES.includes(body.mask_type)) return { error: `Mask type must be one of: ${MASK_TYPES.join(", ")}` };
    else out.mask_type = body.mask_type;
  }
  if (has(body, "start_date")) {
    if (blank(body.start_date)) out.start_date = null;
    else if (!isDate(body.start_date)) return { error: "Use the date format YYYY-MM-DD" };
    else if (body.start_date > maxDate()) return { error: "The start date can't be in the future" };
    else out.start_date = body.start_date;
  }
  if (has(body, "is_active")) {
    if (typeof body.is_active !== "boolean") return { error: "Active must be true or false" };
    out.is_active = body.is_active;
  }
  for (const [field, range] of Object.entries(SETTING_RANGES)) {
    if (!has(body, field)) continue;
    const n = readNumber(body[field], range);
    if (n.error) return { error: n.error };
    out[field] = n.value;
  }

  const merged = { ...current, ...out };
  if (merged.pressure_min != null && merged.pressure_max != null && merged.pressure_min > merged.pressure_max) {
    return { error: "Minimum pressure can't be higher than maximum pressure" };
  }
  if (merged.epap != null && merged.ipap != null && merged.epap > merged.ipap) {
    return { error: "EPAP can't be higher than IPAP" };
  }
  return { values: out };
}

// createLog: the device must exist and belong to the caller
async function ownedDevice(id, user) {
  if (!isId(id)) return { res: fail(400, "Invalid device ID") };
  const device = await getOwned("RespiratoryDevice", id, user.user_id);
  if (!device) return { res: fail(404, "Device not found") };
  return { device };
}
// A device made by the server (seed; the website saves through the Parse SDK) {device_type, name?, serial_last4?, ...}
async function createDevice(body, user, ctx) {
  body = body || {};
  if (!DEVICE_TYPES.includes(body.device_type)) return fail(400, `Device type must be one of: ${DEVICE_TYPES.join(", ")}`);
  const fields = readDeviceFields(body, {});
  if (fields.error) return fail(400, fields.error);

  const device = await create("RespiratoryDevice", {
    user_id: user.user_id,
    device_type: body.device_type,
    is_active: true,
    ...fields.values,
    name: fields.values.name || TYPE_LABEL[body.device_type],
  });
  const row = deviceRow(device);
  await audit({ userId: user.user_id, event: "INSERT", targetClass: "RespiratoryDevice", targetId: device.id, newData: row, ip: ctx.ip });

  const supplies = await addDefaultSupplies(device, user.user_id, ctx.ip);
  return { status: 201, message: "Device added", device: row, supplies };
}

// The default parts list for a new device (DEFAULT_SUPPLIES), each audited. The replacement clock starts today: the
// app can't know when earlier parts were last changed. Used by createDevice and by a browser create (afterDeviceSave).
async function addDefaultSupplies(device, userId, ip) {
  const supplies = [];
  for (const s of DEFAULT_SUPPLIES[device.get("device_type")] || []) {
    const supply = await create("DeviceSupply", { user_id: userId, device_id: device.id, part_name: s.part_name, interval_days: s.interval_days, last_replaced: today() });
    const srow = supplyRow(supply);
    await audit({ userId, event: "INSERT", targetClass: "DeviceSupply", targetId: supply.id, newData: srow, ip });
    supplies.push(withStatus(srow));
  }
  return supplies;
}

// Part fields from a request. On create both name and interval are required.
function readSupplyFields(body, isNew) {
  const out = {};
  if (isNew || has(body, "part_name")) {
    const name = typeof body.part_name === "string" ? body.part_name.trim() : "";
    if (!name) return { error: "Enter the name of the part" };
    if (name.length > 100) return { error: "Part name must be 100 characters or fewer" };
    out.part_name = name;
  }
  if (isNew || has(body, "interval_days")) {
    const n = plainNumber(body.interval_days);
    if (blank(body.interval_days) || !Number.isInteger(n) || n < 1 || n > 1000) return { error: "Days between replacements must be a whole number from 1 to 1,000" };
    out.interval_days = n;
  }
  if (has(body, "last_replaced")) {
    if (blank(body.last_replaced)) out.last_replaced = null;
    else if (!isDate(body.last_replaced)) return { error: "Use the date format YYYY-MM-DD" };
    else if (body.last_replaced > maxDate()) return { error: "The replacement date can't be in the future" };
    else out.last_replaced = body.last_replaced;
  }
  if (has(body, "notes")) {
    const notes = optText(body.notes, 500, "Notes");
    if (notes.error) return { error: notes.error };
    out.notes = notes.value;
  }
  return { values: out };
}

// --- Logs (Task 2.3) -------------------------------------------------------------------------

// Pressure machines record one night at a time, so they allow one entry per date.
const PAP_TYPES = ["cpap", "apap", "bipap"];

// Number ranges for the readings in an entry. leak_lpm, flow_lpm_avg and peak_flow only have ">= 0" in the spec;
// their upper bounds here just catch typing slips (200 L/min leak, 15 L/min oxygen like the device setting,
// 1000 L/min peak flow like personal_best).
const LOG_RANGES = {
  hours_used: { min: 0, max: 24, label: "Hours used", unit: "hours" },
  ahi: { min: 0, max: 150, label: "AHI", unit: "events per hour" },
  leak_lpm: { min: 0, max: 200, label: "Leak", unit: "L/min" },
  spo2_avg: { min: 40, max: 100, label: "Average oxygen level", unit: "%" },
  spo2_min: { min: 40, max: 100, label: "Lowest oxygen level", unit: "%" },
  flow_lpm_avg: { min: 0, max: 15, label: "Average oxygen flow", unit: "L/min" },
  peak_flow: { min: 0, max: 1000, label: "Peak flow", unit: "L/min" },
};
const READING_FIELDS = [...Object.keys(LOG_RANGES), "comfort"];

// Checks the fields present in `body` and returns the values to store. `current` holds the stored values of an
// entry being edited, so spo2_min is checked against a stored spo2_avg and an entry can't lose its last reading.
function readLogFields(body, current) {
  const out = {};

  if (has(body, "log_date")) {
    if (!isDate(body.log_date)) return { error: "Use the date format YYYY-MM-DD" };
    if (body.log_date > maxDate()) return { error: "The date can't be in the future" };
    out.log_date = body.log_date;
  }
  if (has(body, "notes")) {
    const notes = optText(body.notes, 500, "Notes");
    if (notes.error) return { error: notes.error };
    out.notes = notes.value;
  }
  for (const [field, range] of Object.entries(LOG_RANGES)) {
    if (!has(body, field)) continue;
    const n = readNumber(body[field], range);
    if (n.error) return { error: n.error };
    out[field] = n.value;
  }
  if (has(body, "comfort")) {
    if (blank(body.comfort)) out.comfort = null;
    else {
      const n = plainNumber(body.comfort);
      if (!Number.isInteger(n) || n < 1 || n > 5) return { error: "Comfort must be a whole number from 1 to 5" };
      out.comfort = n;
    }
  }

  const merged = { ...current, ...out };
  if (merged.spo2_min != null && merged.spo2_avg != null && merged.spo2_min > merged.spo2_avg) {
    return { error: "Lowest oxygen level can't be higher than the average" };
  }
  if (!READING_FIELDS.some((f) => merged[f] != null)) return { error: "Enter at least one reading" };
  return { values: out };
}

// True when another entry already holds this night on this device
async function nightTaken(user, deviceId, date, exceptId) {
  const same = await findAll("RespiratoryLog", { user_id: user.user_id, device_id: deviceId, log_date: date });
  return same.some((l) => l.id !== exceptId);
}
const TAKEN = "There is already an entry for that night on this device. Edit it instead";

// An entry made by the server (seed; the website saves through the Parse SDK) {device_id, log_date, readings..., notes?}
async function createLog(body, user, ctx) {
  if (!body || typeof body !== "object") return fail(400, "Missing entry details");
  const { device, res } = await ownedDevice(body.device_id, user);
  if (res) return res;
  if (!isDate(body.log_date)) return fail(400, "Use the date format YYYY-MM-DD for the date");
  const fields = readLogFields(body, {});
  if (fields.error) return fail(400, fields.error);
  // The device type comes from the stored device row (never from the request)
  if (PAP_TYPES.includes(device.get("device_type")) && await nightTaken(user, device.id, fields.values.log_date, null)) {
    return fail(409, TAKEN);
  }
  const log = await create("RespiratoryLog", { user_id: user.user_id, device_id: device.id, ...fields.values });
  const row = logRow(log);
  await audit({ userId: user.user_id, event: "INSERT", targetClass: "RespiratoryLog", targetId: log.id, newData: row, ip: ctx.ip });
  return { status: 201, message: "Entry added", log: row };
}

// --- Browser saves (access.js RULES; the values are already type-checked: numbers are numbers, text is text) ---
// body = the fields sent (a removed field is null); original = the stored row on an edit, else null.

// RespiratoryDevice: createDevice() / the old PUT /respiratory/devices/:id rules
function deviceProblem(body, original) {
  if (!original) {
    if (!DEVICE_TYPES.includes(body.device_type)) return `Device type must be one of: ${DEVICE_TYPES.join(", ")}`;
  } else if (has(body, "device_type") && body.device_type !== original.get("device_type")) {
    return "A device's type can't be changed. Add a new device instead";
  }
  return readDeviceFields(body, original ? deviceRow(original) : {}).error || null;
}
// the values to store: a new device is active and gets the type's name when none is given (an edit that clears the
// name gets it back); the serial number keeps its last 6 characters
function deviceValues(body, original) {
  const { values } = readDeviceFields(body, original ? deviceRow(original) : {});
  if (!original) return { device_type: body.device_type, is_active: true, ...values, name: values.name || TYPE_LABEL[body.device_type] };
  if (has(values, "name") && !values.name) values.name = TYPE_LABEL[original.get("device_type")];
  return values;
}
// a new device gets its default parts list (master key, audited), as createDevice did
async function afterDeviceSave(device, { original, ip }) {
  if (!original) await addDefaultSupplies(device, device.get("user_id"), ip);
}

// DeviceSupply: the old POST /respiratory/devices/:id/supplies, PUT /respiratory/supplies/:id and
// POST /respiratory/supplies/:id/replaced rules ("replaced" = an edit of last_replaced: a date, not in the future)
function supplyProblem(body, original) {
  if (original && has(body, "device_id") && body.device_id !== original.get("device_id")) return "A part can't be moved to another device. Add a new part instead";
  return readSupplyFields(body, !original).error || null;
}
// a new part's replacement clock starts today unless a date is given
function supplyValues(body, original) {
  const { values } = readSupplyFields(body, !original);
  return original ? values : { device_id: body.device_id, last_replaced: today(), ...values };
}

// RespiratoryLog: createLog() / the old PUT /respiratory/logs/:id rules, with the one-entry-a-night rule for pressure
// machines (the device type comes from the stored device row, never from the request)
async function logProblem(body, { user, original }) {
  if (!original) {
    if (!isDate(body.log_date)) return "Use the date format YYYY-MM-DD for the date";
  } else if (has(body, "device_id") && body.device_id !== original.get("device_id")) {
    return "An entry can't be moved to another device. Add a new entry instead";
  }
  const fields = readLogFields(body, original ? logRow(original) : {});
  if (fields.error) return fields.error;
  const date = fields.values.log_date;
  if (date && (!original || date !== original.get("log_date"))) {
    const deviceId = original ? original.get("device_id") : body.device_id;
    // not the caller's device: access.js answers 101 (parent check) after this
    const device = await getOwned("RespiratoryDevice", deviceId, user.id);
    if (device && PAP_TYPES.includes(device.get("device_type")) && await nightTaken({ user_id: user.id }, deviceId, date, original ? original.id : null)) return TAKEN;
  }
  return null;
}
function logValues(body, original) {
  const { values } = readLogFields(body, original ? logRow(original) : {});
  return original ? values : { device_id: body.device_id, ...values };
}

module.exports = {
  createDevice, createLog,
  deviceProblem, deviceValues, afterDeviceSave, supplyProblem, supplyValues, logProblem, logValues,
  DEVICE_TYPES, MASK_TYPES, DEFAULT_SUPPLIES, LOG_RANGES, SETTING_RANGES, DEVICE_FIELDS, SUPPLY_FIELDS, LOG_FIELDS,
  deviceRow, supplyRow, logRow, supplyStatus,
};
