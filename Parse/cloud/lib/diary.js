// diary.js — Health Diary (Tasks 2.1 / 2.2), on Parse. Class: DiaryEntry
//   GET /diary-entries, GET /diary-entries/:id, POST /diary-entries, PUT /diary-entries/:id, DELETE /diary-entries/:id
// (Appointments are not diary entries; they belong in the calendar.)

const { M, isId, isDate, toRow, findAll, getOwned, save, create, audit } = require("./db");

const FIELDS = ["user_id", "entry_date", "category", "title", "description", "severity", "mood", "follow_up_needed"];
const CATEGORIES = ["symptom", "medication", "general"];
const row = (o) => toRow(o, "entry_id", FIELDS);

// Field rules for create (all) and update (only what was sent). Returns error or null.
function validate(body, partial) {
  const has = (k) => body[k] !== undefined;
  if (!partial || has("entry_date")) if (!isDate(body.entry_date)) return partial ? "entry_date must be a date (YYYY-MM-DD)" : "Missing required fields: entry_date, category, title";
  if (!partial || has("category")) if (!CATEGORIES.includes(body.category)) return body.category ? `Invalid category. Must be one of: ${CATEGORIES.join(", ")}` : "Missing required fields: entry_date, category, title";
  if (!partial || has("title")) {
    const t = typeof body.title === "string" ? body.title.trim() : "";
    if (!t) return partial ? "title cannot be empty" : "Missing required fields: entry_date, category, title";
    if (t.length > 255) return "title is too long (max 255)";
  }
  if (has("severity") && body.severity !== null) {
    const n = Number(body.severity);
    if (!Number.isInteger(n) || n < 1 || n > 10) return "Severity must be between 1 and 10";
  }
  if (has("description") && body.description !== null && String(body.description).length > 5000) return "description is too long";
  if (has("mood") && body.mood !== null && String(body.mood).length > 50) return "mood is too long";
  if (has("follow_up_needed") && typeof body.follow_up_needed !== "boolean") return "follow_up_needed must be true or false";
  return null;
}
const clean = (body) => {
  const out = {};
  for (const f of FIELDS.slice(1)) {
    if (body[f] === undefined) continue;
    if (f === "severity") out[f] = body[f] === null ? null : Number(body[f]);
    else if (f === "follow_up_needed") out[f] = body[f];
    else out[f] = body[f] === null || String(body[f]).trim() === "" ? null : String(body[f]).trim();
  }
  return out;
};
const sortEntries = (rows) => rows.sort((a, b) => b.entry_date.localeCompare(a.entry_date) || b.created_at.localeCompare(a.created_at));

async function list(user) {
  return { status: 200, entries: sortEntries((await findAll("DiaryEntry", { user_id: user.user_id })).map(row)) };
}
async function getById(id, user) {
  if (!isId(id)) return { status: 400, error: "Invalid entry ID" };
  const e = await getOwned("DiaryEntry", id, user.user_id);
  return e ? { status: 200, entry: row(e) } : { status: 404, error: "Entry not found" };
}
async function createEntry(body, user) {
  const err = validate(body || {}, false);
  if (err) return { status: 400, error: err };
  const e = await create("DiaryEntry", { follow_up_needed: false, ...clean(body), user_id: user.user_id });
  const data = row(e);
  await audit({ userId: user.user_id, event: "INSERT", targetClass: "DiaryEntry", targetId: e.id, newData: data });
  return { status: 201, message: "Diary entry created", entry: data };
}
async function update(id, body, user) {
  if (!isId(id)) return { status: 400, error: "Invalid entry ID" };
  if (!body || Object.keys(body).length === 0) return { status: 400, error: "No fields to update" };
  const err = validate(body, true);
  if (err) return { status: 400, error: err };
  const e = await getOwned("DiaryEntry", id, user.user_id);
  if (!e) return { status: 404, error: "Entry not found" };
  const oldData = row(e);
  await save(e, clean(body));
  const data = row(e);
  await audit({ userId: user.user_id, event: "UPDATE", targetClass: "DiaryEntry", targetId: e.id, oldData, newData: data });
  return { status: 200, message: "Diary entry updated", entry: data };
}
async function remove(id, user) {
  if (!isId(id)) return { status: 400, error: "Invalid entry ID" };
  const e = await getOwned("DiaryEntry", id, user.user_id);
  if (!e) return { status: 404, error: "Entry not found" };
  const oldData = row(e);
  await e.destroy(M);
  await audit({ userId: user.user_id, event: "DELETE", targetClass: "DiaryEntry", targetId: id, oldData });
  return { status: 200, message: "Diary entry deleted" };
}

module.exports = { list, getById, create: createEntry, update, remove };
