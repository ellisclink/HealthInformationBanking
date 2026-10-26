// documents.js — Health documents (Task 6-2): upload, store encrypted, view and manage.
//   GET    /documents              list (filter: category, search); also returns storage used
//   POST   /documents              upload a PDF, JPG or PNG (file_base64; details in the query string)
//   GET    /documents/:id          one document's details (never the file)
//   PUT    /documents/:id          edit the details
//   DELETE /documents/:id          delete a document
//   GET    /documents/:id/file     the file, for viewing or downloading (logged as VIEW_FILE)
// Class: HealthDocument

const crypto = require("crypto");
const { isId, isDate, toRow, findAll, getOwned, save, create, destroy, audit, param, optText, maxDate, fail } = require("./db");
const sec = require("./security");

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_STORAGE_BYTES = 100 * 1024 * 1024;
const MAX_TAGS = 10;
const CATEGORIES = ["insurance", "visit_summary", "imaging", "lab_report", "vaccination", "prescription",
  "referral", "hospital_discharge", "advance_directive", "billing", "other", "health_record"];
const DOC_FIELDS = ["user_id", "title", "category", "provider", "document_date", "notes", "tags",
  "file_name", "content_type", "file_size", "file_sha256", "is_encrypted"];
const docRow = (o) => toRow(o, "document_id", DOC_FIELDS);

// The real type comes from the first bytes of the file, never from its name
const KINDS = [
  { ext: "pdf", type: "application/pdf", match: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
  { ext: "jpg", type: "image/jpeg", match: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
   { ext: "xml", type: "application/xml",
     match: (b) => /^\s*(<\?xml|<ClinicalDocument)/.test(b.subarray(0, 200).toString("utf8").replace(/^\uFEFF/, "")) },
  { ext: "png", type: "image/png", match: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
];
const kindOf = (buf) => KINDS.find((k) => k.match(buf)) || null;

// "scan 1.JPEG" -> "scan 1" (no folders, no odd characters, no extension)
const baseName = (name) => String(name || "")
  .split(/[\\/]/).pop()
  .replace(/[\u0000-\u001f<>:"|?*]/g, "")
  .replace(/\.[^.]*$/, "")
  .trim()
  .slice(0, 120);

// Stored file name with the extension that matches the real file type
const fileNameFor = (name, ext) => `${baseName(name) || "document"}.${ext}`;

const storageInfo =(used) => ({ used_bytes: used, limit_bytes: MAX_STORAGE_BYTES });

// tags: up to 10 lowercase, unique, at most 40 characters each. Accepts a list or "a, b, c".
function cleanTags(value) {
  if (value === undefined || value === null || value === "") return { tags: [] };
  const list = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(list)) return { error: "Tags must be a list" };
  const out = [];
  for (const raw of list) {
    if (typeof raw !== "string") return { error: "Each tag must be text" };
    const t = raw.trim().toLowerCase();
    if (!t || out.includes(t)) continue;
    if (t.length > 40) return { error: "Each tag must be 40 characters or fewer" };
    out.push(t);
  }
  if (out.length > MAX_TAGS) return { error: `Use at most ${MAX_TAGS} tags` };
  return { tags: out };
}

// Checks the details. On upload (partial false) the title is required. On edit (partial true)
// only the fields that were sent are checked and changed.
function detailValues(body, partial) {
  const v = {};
  const has = (k) => body[k] !== undefined;

  if (!partial || has("title")) {
    const title = optText(body.title, 200, "Title");
    if (title.error) return title;
    if (!title.value) return { error: "Give the document a title" };
    v.title = title.value;
  }
  if (!partial || has("category")) {
    const category = body.category || "other";
    if (!CATEGORIES.includes(category)) return { error: "Choose a document type from the list" };
    v.category = category;
  }
  for (const [key, label, max] of [["provider", "Provider", 200], ["notes", "Notes", 2000]]) {
    if (!partial || has(key)) {
      const r = optText(body[key], max, label);
      if (r.error) return r;
      v[key] = r.value;
    }
  }
  if (!partial || has("document_date")) {
    const d = body.document_date;
    if (d === undefined || d === null || d === "") v.document_date = null;
    else if (!isDate(d)) return { error: "Use the date format YYYY-MM-DD" };
    else if (d > maxDate()) return { error: "The document date can't be in the future" };
    else v.document_date = d;
  }
  if (!partial || has("tags")) {
    const t = cleanTags(body.tags);
    if (t.error) return t;
    v.tags = t.tags;
  }
  return { values: v };
}

// GET /documents?category=&search=
async function list(query, user) {
  const category = param(query, "category");
  if (category && category !== "all" && !CATEGORIES.includes(category)) return fail(400, "Unknown document type");
  const search = String(param(query, "search") || "").trim().toLowerCase().slice(0, 100);

  const docs = (await findAll("HealthDocument", { user_id: user.user_id }, { exclude: ["file_data"], descending: "document_date" })).map(docRow);
  const used = docs.reduce((sum, d) => sum + (Number(d.file_size) || 0), 0);

  let rows = docs;
  if (category && category !== "all") rows = rows.filter((d) => d.category === category);
  if (search) {
    rows = rows.filter((d) => [d.title, d.provider, d.notes, d.file_name, ...(d.tags || [])]
      .some((v) => String(v || "").toLowerCase().includes(search)));
  }
  return { status: 200, documents: rows, storage: storageInfo(used) };
}

// POST /documents — details (title, category, provider, document_date, notes, tags) come in the query string
async function upload(body, user, ctx) {
  // A key that is set but wrong would silently store the file as plain text, so refuse instead (no key at all is fine)
  const blocked = sec.uploadBlock();
  if (blocked) return fail(503, blocked);
  if (typeof body.file_base64 !== "string" || !body.file_base64) return fail(400, "Choose a PDF, JPG or PNG file to upload");
  // Line breaks and spaces (a wrapped base64 text) don't count toward the size or the decode
  const base64 = body.file_base64.replace(/\s+/g, "");
  if (!base64) return fail(400, "Choose a PDF, JPG or PNG file to upload");
  if (base64.length > Math.ceil((MAX_FILE_BYTES * 4) / 3) + 16) return fail(413, "That file is too large (8 MB max)");
  const file = Buffer.from(base64, "base64");
  if (!file.length) return fail(400, "Choose a PDF, JPG or PNG file to upload");
  if (file.length > MAX_FILE_BYTES) return fail(413, "That file is too large (8 MB max)");

  const kind = kindOf(file);
  if (!kind) return fail(400, "That file isn't a PDF, JPG or PNG");

  const details = detailValues({ ...body, title: body.title || baseName(body.file_name) }, false);
  if (details.error) return fail(400, details.error);

  const existing = await findAll("HealthDocument", { user_id: user.user_id }, { select: ["title", "file_size", "file_sha256"] });
  const used = existing.reduce((sum, d) => sum + (Number(d.get("file_size")) || 0), 0);

  // A repeat of a saved file is a duplicate (409) even when storage is full, so check it before the quota
  const sha256 = crypto.createHash("sha256").update(file).digest("hex");
  const dup = existing.find((d) => d.get("file_sha256") === sha256);
  if (dup) return fail(409, `You already saved this file ("${dup.get("title")}")`);
  if (used + file.length > MAX_STORAGE_BYTES) return fail(413, "Your document storage is full (100 MB). Delete something to make room.");

  const key = sec.fileKey();
  const stored = key ? sec.encrypt(key, file) : file;
  const doc = await create("HealthDocument", {
    user_id: user.user_id, ...details.values,
    file_name: fileNameFor(body.file_name, kind.ext), content_type: kind.type, file_size: file.length,
    file_sha256: sha256, file_data: stored.toString("base64"), is_encrypted: !!key,
  });
  const row = docRow(doc);
  await audit({ userId: user.user_id, event: "INSERT", targetClass: "HealthDocument", targetId: doc.id, newData: { ...row, file_sha256: sha256 }, ip: ctx.ip });
  return { status: 201, message: "Document saved", document: row, storage: storageInfo(used + file.length) };
}

// GET /documents/:id
async function getById(id, user) {
  if (!isId(id)) return fail(400, "Invalid document ID");
  const doc = await getOwned("HealthDocument", id, user.user_id, { exclude: ["file_data"] });
  if (!doc) return fail(404, "Document not found");
  return { status: 200, document: docRow(doc) };
}

// PUT /documents/:id — details only; the file itself can't change
async function update(id, body, user, ctx) {
  if (!isId(id)) return fail(400, "Invalid document ID");
  const doc = await getOwned("HealthDocument", id, user.user_id, { exclude: ["file_data"] });
  if (!doc) return fail(404, "Document not found");
  const details = detailValues(body, true);
  if (details.error) return fail(400, details.error);
  if (!Object.keys(details.values).length) return fail(400, "Nothing to change");

  const oldData = docRow(doc);
  await save(doc, details.values);
  const row = docRow(doc);
  await audit({ userId: user.user_id, event: "UPDATE", targetClass: "HealthDocument", targetId: doc.id, oldData, newData: row, ip: ctx.ip });
  return { status: 200, message: "Document updated", document: row };
}

// DELETE /documents/:id
async function remove(id, user, ctx) {
  if (!isId(id)) return fail(400, "Invalid document ID");
  const doc = await getOwned("HealthDocument", id, user.user_id, { exclude: ["file_data"] });
  if (!doc) return fail(404, "Document not found");
  const oldData = docRow(doc);
  await destroy(doc);
  await audit({ userId: user.user_id, event: "DELETE", targetClass: "HealthDocument", targetId: id, oldData, ip: ctx.ip });
  return { status: 200, message: "Document deleted" };
}

// GET /documents/:id/file — decrypts and returns the file as base64, logged as VIEW_FILE
async function getFile(id, user, ctx) {
  if (!isId(id)) return fail(400, "Invalid document ID");
  const doc = await getOwned("HealthDocument", id, user.user_id);
  if (!doc) return fail(404, "Document not found");

  let file = Buffer.from(doc.get("file_data") || "", "base64");
  if (doc.get("is_encrypted")) {
    if (sec.keyIsInvalid()) return fail(503, sec.KEY_INVALID);
    const key = sec.fileKey();
    if (!key) return fail(503, "This file was stored encrypted; set the same ENCRYPTION_KEY to open it");
    try { file = sec.decrypt(key, file); }
    catch { return fail(503, "This file can't be decrypted — ENCRYPTION_KEY was changed after it was uploaded"); }
  }
  await audit({ userId: user.user_id, event: "VIEW_FILE", targetClass: "HealthDocument", targetId: doc.id, ip: ctx.ip });
  return {
    status: 200,
    file_base64: file.toString("base64"),
    file_name: doc.get("file_name"),
    content_type: doc.get("content_type") || "application/octet-stream",
  };
}

module.exports = { list, upload, getById, update, remove, getFile, CATEGORIES, MAX_STORAGE_BYTES, kindOf, cleanTags, detailValues, fileNameFor };
