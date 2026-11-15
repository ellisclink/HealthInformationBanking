// diary.js — server-side helpers for the Health Diary. Class: DiaryEntry
//   The Diary page reads and saves with the Parse SDK (Vite/src/data/diary.ts); the owner-only rules in access.js (RULES) use
//   validate/clean/row from here. There are no /diary-entries routes any more. Also used by seed and autofill.
// (Appointments are not diary entries; they belong in the calendar.)

const { isDate, toRow, create, audit } = require("./db");

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
async function createEntry(body, user) {
  const err = validate(body || {}, false);
  if (err) return { status: 400, error: err };
  const e = await create("DiaryEntry", { follow_up_needed: false, ...clean(body), user_id: user.user_id });
  const data = row(e);
  await audit({ userId: user.user_id, event: "INSERT", targetClass: "DiaryEntry", targetId: e.id, newData: data });
  return { status: 201, message: "Diary entry created", entry: data };
}

// validate, clean, row and FIELDS are also used by access.js (the browser saves DiaryEntry directly with the same rules)
module.exports = { create: createEntry, validate, clean, row, FIELDS };
