// links.js — Personal Link Repository (Task 5.4), on Parse. Class: PersonalLink
//   The My Links page reads and saves with the Parse SDK (Vite/src/data/links.ts); the owner-only rules in access.js
//   (RULES.PersonalLink) use fields/row from here. There are no /links routes any more. create() is used by seed.
// Links and phone numbers only. URLs with a username/password are refused, and only
// http/https links are allowed (a "javascript:" link would run code when clicked).

const { toRow, findAll, create, audit } = require("./db");

const CATEGORIES = ["insurance", "pharmacy", "patient_portal", "lab_results", "device_app", "telehealth", "provider", "other"];
const FIELDS = ["user_id", "title", "url", "category", "organization", "phone", "member_id_hint", "notes", "is_favorite", "open_count", "last_opened_at"];
const MAX_LINKS = 200;
const PHONE = /^[0-9+().\-\s]{7,30}(\s*(x|ext\.?)\s*\d{1,6})?$/i;
const row = (o) => toRow(o, "link_id", FIELDS);

function cleanUrl(raw) {
  let s = String(raw == null ? "" : raw).trim();
  if (!s) return { error: "url is required" };
  if (s.length > 2048) return { error: "url is too long" };
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { return { error: "that doesn't look like a web address" }; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { error: "only http:// and https:// links can be saved" };
  if (u.username || u.password) return { error: "remove the username/password from the link — don't store passwords here" };
  if (!u.hostname.includes(".") && u.hostname !== "localhost") return { error: "that doesn't look like a web address" };
  return { url: u.toString() };
}

// Field rules for create (title and url required) and update (partial: only what was sent). Returns { values } or { error }.
function fields(body, partial) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  if (has("title") || !partial) {
    const t = String(body.title == null ? "" : body.title).trim();
    if (!t) return { error: "title is required" };
    if (t.length > 120) return { error: "title is too long (max 120)" };
    out.title = t;
  }
  if (has("url") || !partial) {
    const { url, error } = cleanUrl(body.url);
    if (error) return { error };
    out.url = url;
  }
  if (has("category")) {
    if (!CATEGORIES.includes(body.category)) return { error: `category must be one of: ${CATEGORIES.join(", ")}` };
    out.category = body.category;
  }
  for (const [k, max] of [["organization", 200], ["notes", 1000]]) {
    if (!has(k)) continue;
    const v = body[k] == null ? "" : String(body[k]).trim();
    if (v.length > max) return { error: `${k} is too long (max ${max})` };
    out[k] = v || null;
  }
  if (has("phone")) {
    const v = body.phone == null ? "" : String(body.phone).trim();
    if (v && !PHONE.test(v)) return { error: "phone should look like (561) 555-0100" };
    out.phone = v || null;
  }
  if (has("member_id_hint")) {
    const v = body.member_id_hint == null ? "" : String(body.member_id_hint).trim();
    if (v.length > 6) return { error: "member_id_hint is only for the last 4-6 characters of an ID, never the full number" };
    out.member_id_hint = v || null;
  }
  if (has("is_favorite")) {
    if (typeof body.is_favorite !== "boolean") return { error: "is_favorite must be true or false" };
    out.is_favorite = body.is_favorite;
  }
  return { values: out };
}

const duplicateMessage = (title) => `You already saved this link as "${title}"`;

async function createLink(body, user) {
  if (!body || typeof body !== "object") return { status: 400, error: "Request body required" };
  const { values, error } = fields(body, false);
  if (error) return { status: 400, error };
  const existing = await findAll("PersonalLink", { user_id: user.user_id }, { select: ["url", "title"] });
  if (existing.length >= MAX_LINKS) return { status: 400, error: `You can save up to ${MAX_LINKS} links` };
  const dup = existing.find((l) => l.get("url") === values.url);
  if (dup) return { status: 409, error: duplicateMessage(dup.get("title")), link_id: dup.id };
  const l = await create("PersonalLink", { category: "other", is_favorite: false, open_count: 0, ...values, user_id: user.user_id });
  const data = row(l);
  await audit({ userId: user.user_id, event: "INSERT", targetClass: "PersonalLink", targetId: l.id, newData: data });
  return { status: 201, link: data };
}

// fields, row, FIELDS, CATEGORIES, MAX_LINKS and duplicateMessage are also used by access.js (RULES.PersonalLink: the
// browser saves PersonalLink directly with the same rules); create is used by seed and the tests.
module.exports = { create: createLink, fields, cleanUrl, duplicateMessage, row, FIELDS, CATEGORIES, MAX_LINKS };
