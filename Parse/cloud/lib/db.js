// db.js — small helpers over the Parse SDK so the feature modules read like the old SQL code.
//
// Every class here is locked to the master key (see setup.js), so browsers can't read or
// write them directly; all access goes through the `api` Cloud Function, which checks who
// is asking. That's why every query below runs with { useMasterKey: true } and filters by
// user_id itself.

const M = { useMasterKey: true };
const MAX_ROWS = 10000;

// ids are Parse objectIds (10 letters/digits). Anything else is rejected before querying.
const isId = (v) => typeof v === "string" && /^[A-Za-z0-9]{1,32}$/.test(v);

// "YYYY-MM-DD" that is a real date
function isDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
// any date/time string JavaScript can read
const isDateTime = (v) => typeof v === "string" && v.length > 0 && !isNaN(new Date(v).getTime());
const today = () => new Date().toISOString().slice(0, 10);

// A Parse object -> plain row with the old column names. `fields` fixes the shape, so a
// field that was never set comes back as null (like an empty SQL column).
function toRow(obj, idField, fields) {
  if (!obj) return null;
  const out = { [idField]: obj.id };
  for (const f of fields) {
    const v = obj.get(f);
    out[f] = v === undefined ? null : v instanceof Date ? v.toISOString() : v;
  }
  out.created_at = obj.createdAt ? obj.createdAt.toISOString() : null;
  out.updated_at = obj.updatedAt ? obj.updatedAt.toISOString() : null;
  return out;
}

// All of a user's objects in a class (patient data is small enough to filter in JS)
async function findAll(className, where = {}, opts = {}) {
  const q = new Parse.Query(className);
  for (const [k, v] of Object.entries(where)) {
    if (Array.isArray(v)) q.containedIn(k, v);
    else q.equalTo(k, v);
  }
  if (opts.exclude) q.exclude(...opts.exclude);
  if (opts.select) q.select(...opts.select);
  if (opts.descending) q.descending(opts.descending);
  if (opts.ascending) q.ascending(opts.ascending);
  q.limit(opts.limit || MAX_ROWS);
  return q.find(M);
}

async function findOne(className, where = {}, opts = {}) {
  const rows = await findAll(className, where, { ...opts, limit: 1 });
  return rows[0] || null;
}

// One object by id, only if it belongs to `userId`
async function getOwned(className, id, userId, opts = {}) {
  if (!isId(id)) return null;
  const q = new Parse.Query(className);
  q.equalTo("objectId", id);
  q.equalTo("user_id", userId);
  if (opts.exclude) q.exclude(...opts.exclude);
  return q.first(M);
}

// Create or update with a plain object of values (null clears a field)
async function save(obj, values) {
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) continue;
    if (v === null) obj.unset(k);
    else obj.set(k, v);
  }
  return obj.save(null, M);
}
const create = (className, values) => save(new Parse.Object(className), values);
const destroy = (obj) => obj.destroy(M);
async function destroyAll(objs) {
  if (objs.length) await Parse.Object.destroyAll(objs, M);
}

// Append-only audit trail (one class for every module; was a table per module)
async function audit({ userId = null, event, targetClass = null, targetId = null, oldData = null, newData = null, ip = null, detail = null }) {
  try {
    await create("AuditLog", {
      user_id: userId, event, target_class: targetClass, target_id: targetId,
      old_data: oldData, new_data: newData, ip_address: ip ? String(ip).slice(0, 64) : null, detail,
    });
  } catch (err) {
    console.error("audit write failed:", err.message);   // never fail the request over the log
  }
}

// Query string values may come as strings or arrays; take the first
const param = (query, k) => {
  if (!query) return null;
  const v = query[k];
  if (Array.isArray(v)) return v[0] ?? null;
  return v === undefined || v === "" ? null : v;
};

// Optional text field: blank becomes null; too long or not text is an error
function optText(value, max, label) {
  if (value === undefined || value === null || value === "") return { value: null };
  if (typeof value !== "string") return { error: `${label} must be text` };
  const s = value.trim();
  if (s.length > max) return { error: `${label} must be ${max} characters or fewer` };
  return { value: s || null };
}

// The latest date a user may enter. One day past UTC today, so a user ahead of UTC isn't refused.
const maxDate = () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

// Error reply in the {status, error} shape the website expects
const fail = (status, error) => ({ status, error });

module.exports = { M, isId, isDate, isDateTime, today, toRow, findAll, findOne, getOwned, save, create, destroy, destroyAll, audit, param, optText, maxDate, fail };
