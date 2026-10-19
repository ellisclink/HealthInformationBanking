// respiratory.js — Breathing devices and their replaceable parts (Task 2.1).
//   GET    /respiratory/devices                  the user's devices
//   POST   /respiratory/devices                  add a device; the default parts schedule is created with it
//   GET    /respiratory/devices/:id              one device with its parts
//   PUT    /respiratory/devices/:id              change a device's name, serial, mask or settings
//   DELETE /respiratory/devices/:id              remove a device, its parts and its entries
//   GET    /respiratory/devices/:id/supplies     parts to replace on a device
//   POST   /respiratory/devices/:id/supplies     add a part
//   PUT    /respiratory/supplies/:id             change a part
//   DELETE /respiratory/supplies/:id             remove a part
//   POST   /respiratory/supplies/:id/replaced    mark a part replaced (today, or a past date)
// Every part sent to the app carries next_due, days_left and due_status (overdue | due_soon | ok), see supplyStatus (Task 2.2).
//   GET    /respiratory/logs                     daily/nightly entries (?device_id=&from=&to=&limit=), newest first
//   POST   /respiratory/logs                     add an entry
//   PUT    /respiratory/logs/:id                 change an entry
//   DELETE /respiratory/logs/:id                 remove an entry
//   GET    /respiratory/summary                  last 30 days: PAP use, oxygen, peak flow zone, parts due (Task 2.4)
// Classes: RespiratoryDevice, DeviceSupply, RespiratoryLog (log rows are also removed with their device)

const { isId, isDate, today, toRow, findAll, getOwned, save, create, destroy, audit, optText, maxDate, param, fail } = require("./db");

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
// A part as sent to the app: its stored fields plus the status. Audit rows keep the stored fields only.
const withStatus = (row) => ({ ...row, ...supplyStatus(row) });
const supplyView = (o) => withStatus(supplyRow(o));

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

// Used by every supply route: the device must exist and belong to the caller
async function ownedDevice(id, user) {
  if (!isId(id)) return { res: fail(400, "Invalid device ID") };
  const device = await getOwned("RespiratoryDevice", id, user.user_id);
  if (!device) return { res: fail(404, "Device not found") };
  return { device };
}
async function ownedSupply(id, user) {
  if (!isId(id)) return { res: fail(400, "Invalid part ID") };
  const supply = await getOwned("DeviceSupply", id, user.user_id);
  if (!supply) return { res: fail(404, "Part not found") };
  return { supply };
}

const supplyList = async (deviceId, user) =>
  (await findAll("DeviceSupply", { user_id: user.user_id, device_id: deviceId }, { ascending: "createdAt" })).map(supplyView);

// GET /respiratory/devices
async function listDevices(user) {
  const devices = await findAll("RespiratoryDevice", { user_id: user.user_id }, { ascending: "createdAt" });
  return { status: 200, devices: devices.map(deviceRow) };
}

// POST /respiratory/devices {device_type, name?, serial_last4?, mask_type?, start_date?, notes?, settings...}
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

  // The replacement clock starts today: the app can't know when earlier parts were last changed.
  const supplies = [];
  for (const s of DEFAULT_SUPPLIES[body.device_type]) {
    const supply = await create("DeviceSupply", { user_id: user.user_id, device_id: device.id, part_name: s.part_name, interval_days: s.interval_days, last_replaced: today() });
    const srow = supplyRow(supply);
    await audit({ userId: user.user_id, event: "INSERT", targetClass: "DeviceSupply", targetId: supply.id, newData: srow, ip: ctx.ip });
    supplies.push(withStatus(srow));
  }
  return { status: 201, message: "Device added", device: row, supplies };
}

// GET /respiratory/devices/:id
async function getDevice(id, user) {
  const { device, res } = await ownedDevice(id, user);
  if (res) return res;
  return { status: 200, device: deviceRow(device), supplies: await supplyList(device.id, user) };
}

// PUT /respiratory/devices/:id — only the fields sent change; the device type can't
async function updateDevice(id, body, user, ctx) {
  body = body || {};
  const { device, res } = await ownedDevice(id, user);
  if (res) return res;
  if (has(body, "device_type") && body.device_type !== device.get("device_type")) {
    return fail(400, "A device's type can't be changed. Add a new device instead");
  }
  const oldData = deviceRow(device);
  const fields = readDeviceFields(body, oldData);
  if (fields.error) return fail(400, fields.error);
  if (has(fields.values, "name") && !fields.values.name) fields.values.name = TYPE_LABEL[oldData.device_type];
  await save(device, fields.values);
  const newData = deviceRow(device);
  await audit({ userId: user.user_id, event: "UPDATE", targetClass: "RespiratoryDevice", targetId: device.id, oldData, newData, ip: ctx.ip });
  return { status: 200, message: "Device updated", device: newData };
}

// DELETE /respiratory/devices/:id — also removes the device's parts and daily entries
async function removeDevice(id, user, ctx) {
  const { device, res } = await ownedDevice(id, user);
  if (res) return res;
  const oldData = deviceRow(device);

  const supplies = await findAll("DeviceSupply", { user_id: user.user_id, device_id: device.id });
  for (const s of supplies) {
    const srow = supplyRow(s);
    await destroy(s);
    await audit({ userId: user.user_id, event: "DELETE", targetClass: "DeviceSupply", targetId: s.id, oldData: srow, ip: ctx.ip });
  }
  // findAll returns at most 10,000 rows (db.js MAX_ROWS); a device with more entries than that would need paging (backlog)
  const logs = await findAll("RespiratoryLog", { user_id: user.user_id, device_id: device.id });
  for (const l of logs) {
    const lrow = logRow(l);
    await destroy(l);
    await audit({ userId: user.user_id, event: "DELETE", targetClass: "RespiratoryLog", targetId: l.id, oldData: lrow, ip: ctx.ip });
  }

  await destroy(device);
  await audit({ userId: user.user_id, event: "DELETE", targetClass: "RespiratoryDevice", targetId: id, oldData, ip: ctx.ip,
    detail: `Also removed ${supplies.length} parts and ${logs.length} entries` });
  return { status: 200, message: "Device removed" };
}

// GET /respiratory/devices/:id/supplies
async function listSupplies(deviceId, user) {
  const { device, res } = await ownedDevice(deviceId, user);
  if (res) return res;
  return { status: 200, supplies: await supplyList(device.id, user) };
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

// POST /respiratory/devices/:id/supplies {part_name, interval_days, last_replaced?, notes?}
async function addSupply(deviceId, body, user, ctx) {
  body = body || {};
  const { device, res } = await ownedDevice(deviceId, user);
  if (res) return res;
  const fields = readSupplyFields(body, true);
  if (fields.error) return fail(400, fields.error);
  const supply = await create("DeviceSupply", {
    user_id: user.user_id, device_id: device.id, last_replaced: today(), ...fields.values,
  });
  const row = supplyRow(supply);
  await audit({ userId: user.user_id, event: "INSERT", targetClass: "DeviceSupply", targetId: supply.id, newData: row, ip: ctx.ip });
  return { status: 201, message: "Part added", supply: withStatus(row) };
}

// PUT /respiratory/supplies/:id
async function updateSupply(id, body, user, ctx) {
  body = body || {};
  const { supply, res } = await ownedSupply(id, user);
  if (res) return res;
  const fields = readSupplyFields(body, false);
  if (fields.error) return fail(400, fields.error);
  const oldData = supplyRow(supply);
  await save(supply, fields.values);
  const newData = supplyRow(supply);
  await audit({ userId: user.user_id, event: "UPDATE", targetClass: "DeviceSupply", targetId: supply.id, oldData, newData, ip: ctx.ip });
  return { status: 200, message: "Part updated", supply: withStatus(newData) };
}

// DELETE /respiratory/supplies/:id
async function removeSupply(id, user, ctx) {
  const { supply, res } = await ownedSupply(id, user);
  if (res) return res;
  const oldData = supplyRow(supply);
  await destroy(supply);
  await audit({ userId: user.user_id, event: "DELETE", targetClass: "DeviceSupply", targetId: id, oldData, ip: ctx.ip });
  return { status: 200, message: "Part removed" };
}

// POST /respiratory/supplies/:id/replaced {date?} — date defaults to today and can't be in the future
async function markReplaced(id, body, user, ctx) {
  body = body || {};
  const { supply, res } = await ownedSupply(id, user);
  if (res) return res;
  const date = blank(body.date) ? today() : body.date;
  if (!isDate(date)) return fail(400, "Use the date format YYYY-MM-DD");
  if (date > maxDate()) return fail(400, "The replacement date can't be in the future");
  const oldData = supplyRow(supply);
  await save(supply, { last_replaced: date });
  const newData = supplyRow(supply);
  await audit({ userId: user.user_id, event: "UPDATE", targetClass: "DeviceSupply", targetId: supply.id, oldData, newData, ip: ctx.ip });
  return { status: 200, message: "Part marked as replaced", supply: withStatus(newData) };
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

async function ownedLog(id, user) {
  if (!isId(id)) return { res: fail(400, "Invalid entry ID") };
  const log = await getOwned("RespiratoryLog", id, user.user_id);
  if (!log) return { res: fail(404, "Entry not found") };
  return { log };
}

// GET /respiratory/logs?device_id=&from=&to=&limit= — newest night first
async function listLogs(query, user) {
  const deviceId = param(query, "device_id"), from = param(query, "from"), to = param(query, "to"), limitRaw = param(query, "limit");
  if (deviceId && !isId(deviceId)) return fail(400, "Invalid device ID");
  if (from && !isDate(from)) return fail(400, "from must be a date in the format YYYY-MM-DD");
  if (to && !isDate(to)) return fail(400, "to must be a date in the format YYYY-MM-DD");
  if (from && to && to < from) return fail(400, "to cannot be before from");
  let limit = 500;
  if (limitRaw != null) {
    limit = plainNumber(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return fail(400, "limit must be between 1 and 1000");
  }
  const where = { user_id: user.user_id };
  if (deviceId) where.device_id = deviceId;
  let logs = (await findAll("RespiratoryLog", where, { descending: "log_date" })).map(logRow);
  if (from) logs = logs.filter((l) => l.log_date >= from);
  if (to) logs = logs.filter((l) => l.log_date <= to);
  logs = logs.slice(0, limit);
  return { status: 200, logs, count: logs.length };
}

// POST /respiratory/logs {device_id, log_date, readings..., notes?}
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

// PUT /respiratory/logs/:id — only the fields sent change; the device can't
async function updateLog(id, body, user, ctx) {
  body = body || {};
  const { log, res } = await ownedLog(id, user);
  if (res) return res;
  if (has(body, "device_id") && body.device_id !== log.get("device_id")) {
    return fail(400, "An entry can't be moved to another device. Add a new entry instead");
  }
  const oldData = logRow(log);
  const fields = readLogFields(body, oldData);
  if (fields.error) return fail(400, fields.error);
  // Nothing different from what is stored: no save and no audit row
  if (Object.entries(fields.values).every(([k, v]) => v === oldData[k])) return { status: 200, message: "Entry updated", log: oldData };
  if (has(fields.values, "log_date") && fields.values.log_date !== oldData.log_date) {
    const device = await getOwned("RespiratoryDevice", oldData.device_id, user.user_id);
    if (device && PAP_TYPES.includes(device.get("device_type")) && await nightTaken(user, oldData.device_id, fields.values.log_date, log.id)) {
      return fail(409, TAKEN);
    }
  }
  await save(log, fields.values);
  const newData = logRow(log);
  await audit({ userId: user.user_id, event: "UPDATE", targetClass: "RespiratoryLog", targetId: log.id, oldData, newData, ip: ctx.ip });
  return { status: 200, message: "Entry updated", log: newData };
}

// DELETE /respiratory/logs/:id
async function removeLog(id, user, ctx) {
  const { log, res } = await ownedLog(id, user);
  if (res) return res;
  const oldData = logRow(log);
  await destroy(log);
  await audit({ userId: user.user_id, event: "DELETE", targetClass: "RespiratoryLog", targetId: id, oldData, ip: ctx.ip });
  return { status: 200, message: "Entry removed" };
}

// --- Summary (Task 2.4) ----------------------------------------------------------------------

const SUMMARY_DAYS = 30;
const PAP_NIGHT_HOURS = 4;        // a night counts when the machine ran at least this many hours
const PAP_TARGET_NIGHTS = 21;     // 70% of 30 nights
const AHI_LIMIT = 5;              // average AHI at or above this is flagged
const LEAK_LIMIT = 24;            // average leak above this (L/min) is flagged
const LOW_SPO2 = 88;
const PEAK_ZONES = {
  green: "Your peak flow is in the green zone. Keep taking your medicines as planned.",
  yellow: "Your peak flow is in the yellow zone. Your airways may be narrowing. Follow your asthma action plan and call your care team if it stays low.",
  red: "Your peak flow is in the red zone. Use your quick-relief medicine now as your action plan says and get medical help right away if it doesn't improve.",
};

const round1 = (n) => Math.round(n * 10) / 10;
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const meanOrNull = (values) => { const m = mean(values); return m === null ? null : round1(m); };
const numbers = (rows, field) => rows.map((r) => r[field]).filter((v) => typeof v === "number");

// Last 30 days: `todayDate` and the 29 days before it
function summaryWindow(todayDate) {
  return { from: new Date(Date.parse(todayDate) - (SUMMARY_DAYS - 1) * DAY_MS).toISOString().slice(0, 10), to: todayDate };
}

// Pressure machines over the window. A night with no entry counts as 0 hours. With several PAP devices, a night's
// hours are the most any one of them recorded, so a night is counted once. avg_hours is over the nights that have an entry.
function papSummary(logs) {
  const hoursByNight = new Map();
  for (const l of logs) {
    if (typeof l.hours_used !== "number") continue;
    hoursByNight.set(l.log_date, Math.max(hoursByNight.get(l.log_date) ?? 0, l.hours_used));
  }
  const hours = [...hoursByNight.values()];
  const nightsOk = hours.filter((h) => h >= PAP_NIGHT_HOURS).length;
  const avgAhi = mean(numbers(logs, "ahi")), avgLeak = mean(numbers(logs, "leak_lpm"));
  return {
    days: SUMMARY_DAYS,
    nights_logged: hours.length,
    nights_ok: nightsOk,
    percent: round1(nightsOk / SUMMARY_DAYS * 100),
    compliant: nightsOk >= PAP_TARGET_NIGHTS,
    nights_needed: Math.max(0, PAP_TARGET_NIGHTS - nightsOk),
    avg_hours: meanOrNull(hours),
    avg_ahi: avgAhi === null ? null : round1(avgAhi),
    avg_leak: avgLeak === null ? null : round1(avgLeak),
    ahi_high: avgAhi !== null && avgAhi >= AHI_LIMIT,
    leak_high: avgLeak !== null && avgLeak > LEAK_LIMIT,
  };
}

// Oxygen over the window. A day is below 88% when its spo2_min is under 88 (spo2_avg is not used for this count).
function oxygenSummary(logs) {
  const lowDays = new Set(logs.filter((l) => typeof l.spo2_min === "number" && l.spo2_min < LOW_SPO2).map((l) => l.log_date));
  return {
    days_logged: new Set(logs.map((l) => l.log_date)).size,
    avg_hours: meanOrNull(numbers(logs, "hours_used")),
    avg_flow_lpm: meanOrNull(numbers(logs, "flow_lpm_avg")),
    avg_spo2: meanOrNull(numbers(logs, "spo2_avg")),
    days_below_88: lowDays.size,
  };
}

// Peak flow: best = the highest personal_best set on a peak flow meter, else the highest peak flow ever logged
// (all dates, because a personal best doesn't expire). latest = the newest peak flow in the window.
function peakFlowSummary(devices, windowLogs, allLogs) {
  const set = devices.map((d) => d.personal_best).filter((v) => typeof v === "number");
  const logged = numbers(allLogs, "peak_flow");
  const best = set.length ? Math.max(...set) : logged.length ? Math.max(...logged) : null;
  const latestLog = windowLogs.filter((l) => typeof l.peak_flow === "number")
    .sort((a, b) => (a.log_date < b.log_date ? 1 : a.log_date > b.log_date ? -1 : 0))[0];
  const out = {
    personal_best: best,
    personal_best_source: set.length ? "device" : logged.length ? "logged" : null,
    latest: latestLog ? latestLog.peak_flow : null,
    latest_date: latestLog ? latestLog.log_date : null,
    percent_of_best: null, zone: null, advice: null,
  };
  if (best && latestLog) {
    // The page shows this number, and the zone is read from the same number. It is cut (not rounded) to one decimal,
    // so 79.96% shows as 79.9 and is yellow: a reading is never shown as, or put in, a better zone than it reached.
    // (Whole tenths of a percent are counted as latest * 1000 / best; the tiny extra guards float error on exact values.)
    const tenths = Math.floor(latestLog.peak_flow * 1000 / best + 1e-9);
    out.percent_of_best = tenths / 10;
    out.zone = tenths >= 800 ? "green" : tenths >= 500 ? "yellow" : "red";   // 80% and 50% belong to the better zone
    out.advice = PEAK_ZONES[out.zone];
  }
  return out;
}

// GET /respiratory/summary — the last 30 days (`todayDate` and the 29 days before it). A section is null when the
// user has no device of that kind. Devices set to inactive still count in the sections (their entries are real
// history); only active devices' parts are listed in supplies_due, overdue first.
async function summary(user, todayDate = today()) {
  const devices = (await findAll("RespiratoryDevice", { user_id: user.user_id }, { ascending: "createdAt" })).map(deviceRow);
  const allLogs = (await findAll("RespiratoryLog", { user_id: user.user_id }, { descending: "log_date" })).map(logRow);
  const { from, to } = summaryWindow(todayDate);

  const section = (types, build) => {
    const mine = devices.filter((d) => types.includes(d.device_type));
    if (!mine.length) return null;
    const ids = new Set(mine.map((d) => d.device_id));
    const logs = allLogs.filter((l) => ids.has(l.device_id));
    return build(mine, logs.filter((l) => l.log_date >= from && l.log_date <= to), logs);
  };

  const supplies = await findAll("DeviceSupply", { user_id: user.user_id }, { ascending: "createdAt" });
  const active = new Map(devices.filter((d) => d.is_active).map((d) => [d.device_id, d]));
  const due = [];
  for (const s of supplies) {
    const row = supplyRow(s), device = active.get(row.device_id);
    if (!device) continue;
    const status = supplyStatus(row, todayDate);
    if (status.due_status === "ok") continue;
    due.push({ ...row, ...status, device_name: device.name, device_type: device.device_type });
  }
  due.sort((a, b) => a.days_left - b.days_left);

  return {
    pap: section(PAP_TYPES, (_d, logs) => papSummary(logs)),
    oxygen: section(["oxygen_concentrator", "portable_oxygen"], (_d, logs) => oxygenSummary(logs)),
    peak_flow: section(["peak_flow_meter"], (mine, logs, all) => peakFlowSummary(mine, logs, all)),
    supplies_due: due,
  };
}

module.exports = {
  summary,
  listDevices, createDevice, getDevice, updateDevice, removeDevice,
  listSupplies, addSupply, updateSupply, removeSupply, markReplaced,
  listLogs, createLog, updateLog, removeLog,
  DEVICE_TYPES, MASK_TYPES, DEFAULT_SUPPLIES, LOG_RANGES, deviceRow, supplyRow, logRow, supplyStatus,
};
