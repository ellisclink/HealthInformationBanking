// account.js — Data export and account deletion (Task 7-4).
//
//   POST   /account/export          {password, include_files?}   everything the account holds, as one JSON download
//   GET    /account/deletion        is a deletion scheduled?
//   POST   /account/deletion        {password, confirm: "DELETE MY ACCOUNT", immediate?}   schedule deletion (7 days) or delete now
//   DELETE /account/deletion        cancel a scheduled deletion
//   job    processAccountDeletions  erases accounts whose waiting period is over (main.js)
//
// Both actions need the password again, so a stolen open session can't take or erase someone's records.
// Deletion erases every row the account owns (all classes in setup.js that have a user_id), the audit
// entries that held copies of record data, share codes, calendar links, sessions and the login itself.
// What remains is one anonymous line in the audit log ("an account was deleted", with a one-way hash of the id)
// and the DeletionRequest row, which holds no health data. Backups outside this database are not touched here.
// Class: DeletionRequest.

const crypto = require("crypto");
const sec = require("./security");
const auth = require("./auth");
const { SCHEMA } = require("./setup");
const { M, findAll, create, save, destroyAll, audit, fail } = require("./db");

const GRACE_DAYS = 7;
const CONFIRM_PHRASE = "DELETE MY ACCOUNT";
const EXPORT_FORMAT = "mib-export-v1";
const MAX_EXPORT_FILE_BYTES = 20 * 1024 * 1024;     // files inside the export; larger sets are listed as skipped
const HOUR = 60 * 60 * 1000, MIN15 = 15 * 60 * 1000, DAY = 24 * HOUR;
const EXPORTS_PER_HOUR = 5;
const PASSWORD_FAILS = 5;                            // wrong passwords per 15 minutes

// never exported: they are login machinery, not the person's data
const NOT_EXPORTED = new Set(["LoginChallenge", "PasswordReset", "RateLimit", "SessionActivity", "UsedFeedHash", "DeletionRequest", "AutofillDraft"]);
// fields left out of an export (secrets, hashes and the file bytes, which are handled separately)
const HIDDEN_FIELDS = new Set(["token_hash", "code_hash", "file_data"]);
const FILE_CLASSES = { HealthDocument: "document", LabReport: "lab_report" };
const iso = (v) => (v instanceof Date ? v.toISOString() : v === undefined ? null : v);

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const ownedClasses = () => Object.keys(SCHEMA).filter((c) => SCHEMA[c].user_id);

// re-checks the password without starting a session; wrong tries are limited
async function checkPassword(user, password, ctx) {
  const key = `account-password:${user.user_id}`;
  if (await sec.blocked(key, PASSWORD_FAILS)) return fail(429, `too many wrong passwords — try again in ${await sec.minutesLeft(key)} minute(s)`);
  if (typeof password !== "string" || !password) return fail(400, "Enter your password to continue");
  try { await Parse.User.verifyPassword(user.user_email, password); }
  catch {
    await sec.hit(key, MIN15);
    await audit({ userId: user.user_id, event: "account_password_failed", ip: ctx.ip });
    return fail(403, "That password isn't correct");
  }
  await sec.resetLimit(key);
  return null;
}

// ---------- export ----------
const plainRow = (obj, className) => {
  const row = { id: obj.id };
  for (const f of Object.keys(SCHEMA[className])) if (!HIDDEN_FIELDS.has(f)) row[f] = iso(obj.get(f));
  row.created_at = iso(obj.createdAt);
  row.updated_at = iso(obj.updatedAt);
  return row;
};

// the file bytes of one document or lab report, decrypted
function fileOf(obj) {
  let bytes = Buffer.from(obj.get("file_data") || "", "base64");
  if (obj.get("is_encrypted")) {
    const key = sec.fileKey();
    if (!key) throw new Error("no key");
    bytes = sec.decrypt(key, bytes);
  }
  return bytes;
}

// POST /account/export
async function exportData(body, user, ctx) {
  body = body && typeof body === "object" ? body : {};
  const bad = await checkPassword(user, body.password, ctx);
  if (bad) return bad;
  const rateKey = `account-export:${user.user_id}`;
  if (await sec.blocked(rateKey, EXPORTS_PER_HOUR)) return fail(429, `you can export ${EXPORTS_PER_HOUR} times an hour — try again in ${await sec.minutesLeft(rateKey)} minute(s)`);
  await sec.hit(rateKey, HOUR);
  if (body.include_files !== undefined && typeof body.include_files !== "boolean") return fail(400, "include_files must be true or false");
  const includeFiles = body.include_files === true;
  if (includeFiles && sec.keyIsInvalid()) return fail(503, sec.KEY_INVALID);

  const data = {}, counts = {}, files = [], filesSkipped = [];
  let fileBytes = 0;
  for (const className of Object.keys(SCHEMA)) {
    if (NOT_EXPORTED.has(className)) continue;
    const where = className === "AccessLog" ? { patient_user_id: user.user_id } : SCHEMA[className].user_id ? { user_id: user.user_id } : null;
    if (!where) continue;
    const objs = await findAll(className, where, FILE_CLASSES[className] && !includeFiles ? { exclude: ["file_data"] } : {});
    data[className] = objs.map((o) => plainRow(o, className));
    counts[className] = objs.length;
    if (includeFiles && FILE_CLASSES[className]) {
      for (const o of objs) {
        const meta = { kind: FILE_CLASSES[className], id: o.id, title: o.get("title"), file_name: o.get("file_name"), content_type: o.get("content_type"), size: o.get("file_size") || 0 };
        if (fileBytes + meta.size > MAX_EXPORT_FILE_BYTES) { filesSkipped.push({ ...meta, reason: "Download this file from the Documents or Labs page" }); continue; }
        try { files.push({ ...meta, file_base64: fileOf(o).toString("base64") }); fileBytes += meta.size; }
        catch { filesSkipped.push({ ...meta, reason: "Could not be decrypted with the current ENCRYPTION_KEY" }); }
      }
    }
  }
  await audit({ userId: user.user_id, event: "ACCOUNT_EXPORT", newData: { counts, files: files.length, include_files: includeFiles }, ip: ctx.ip });
  return {
    status: 200, format: EXPORT_FORMAT, exported_at: new Date().toISOString(),
    file_name: `mib-export-${new Date().toISOString().slice(0, 10)}.json`,
    account: { email: user.user_email, name: user.user_name, role: user.role, ...(user.role === "physician" ? { npi: user.npi } : {}) },
    counts, data, ...(includeFiles ? { files, files_skipped: filesSkipped } : { files_included: false }),
    note: includeFiles ? undefined : "Uploaded files (PDFs, images) are not in this export. Ask for include_files to add them.",
  };
}

// ---------- deletion ----------
const pendingRequest = async (userId) => (await findAll("DeletionRequest", { user_id: userId })).find((r) => r.get("status") === "pending") || null;
const requestView = (r) => (r ? {
  pending: true, requested_at: iso(r.get("requested_at")), scheduled_for: iso(r.get("scheduled_for")),
  days_left: Math.max(0, Math.ceil((r.get("scheduled_for") - new Date()) / DAY)),
} : { pending: false });

// GET /account/deletion
async function deletionStatus(user) {
  return { status: 200, ...requestView(await pendingRequest(user.user_id)), grace_days: GRACE_DAYS, confirm_phrase: CONFIRM_PHRASE };
}

// POST /account/deletion {password, confirm, immediate?}
async function requestDeletion(body, user, ctx) {
  body = body && typeof body === "object" ? body : {};
  if (body.confirm !== CONFIRM_PHRASE) return fail(400, `Type ${CONFIRM_PHRASE} to confirm`);
  if (body.immediate !== undefined && typeof body.immediate !== "boolean") return fail(400, "immediate must be true or false");
  const bad = await checkPassword(user, body.password, ctx);
  if (bad) return bad;

  if (body.immediate === true) {
    await audit({ userId: user.user_id, event: "ACCOUNT_DELETE_IMMEDIATE", ip: ctx.ip });
    await purgeUser(user.user_id);
    await create("DeletionRequest", { user_id: sha(user.user_id), status: "completed", requested_at: new Date(), scheduled_for: new Date(), completed_at: new Date(), immediate: true });
    return { status: 200, deleted: true, message: "Your account and all its data have been deleted." };
  }

  const existing = await pendingRequest(user.user_id);
  if (existing) return { status: 200, ...requestView(existing), message: "Your account is already scheduled for deletion" };
  const now = new Date();
  const req = await create("DeletionRequest", { user_id: user.user_id, status: "pending", requested_at: now, scheduled_for: new Date(now.getTime() + GRACE_DAYS * DAY), immediate: false });
  await audit({ userId: user.user_id, event: "ACCOUNT_DELETE_SCHEDULED", targetClass: "DeletionRequest", targetId: req.id, ip: ctx.ip });
  try {
    await sec.sendEmail(user.user_email, "Your MIB account is scheduled for deletion",
      `Your MIB account and all of its data will be permanently deleted on ${req.get("scheduled_for").toISOString().slice(0, 10)}.\n`
      + "To keep it, log in before then and cancel the deletion. If you didn't ask for this, log in and cancel it now, then change your password.", "deletion notice");
  } catch (err) { console.error("deletion email failed:", err && err.message ? err.message : "error"); }
  return { status: 201, ...requestView(req), message: `Your account will be deleted in ${GRACE_DAYS} days. You can cancel until then.`, export_recommended: true };
}

// DELETE /account/deletion
async function cancelDeletion(user, ctx) {
  const req = await pendingRequest(user.user_id);
  if (!req) return fail(404, "No deletion is scheduled");
  await save(req, { status: "cancelled", cancelled_at: new Date() });
  await audit({ userId: user.user_id, event: "ACCOUNT_DELETE_CANCELLED", targetClass: "DeletionRequest", targetId: req.id, ip: ctx.ip });
  return { status: 200, pending: false, message: "Deletion cancelled. Your account is staying." };
}

// Erases everything for one user. Safe to run again after a failure: the login is removed last.
async function purgeUser(userId) {
  await auth.endAllSessions(userId, "account_deleted");        // sessions, subscribe links
  for (const className of ownedClasses()) {
    if (className === "DeletionRequest") continue;             // keeps its (data-free) record of what happened
    await destroyAll(await findAll(className, { user_id: userId }));
  }
  await destroyAll(await findAll("AccessLog", { patient_user_id: userId }));
  // a physician's name stays on the patients' logs (the patient is entitled to know who looked) but is cut loose from the account
  for (const l of await findAll("AccessLog", { viewer_user_id: userId })) { l.unset("viewer_user_id"); await l.save(null, M); }
  await create("AuditLog", { event: "account_deleted", detail: { user_hash: sha(userId) } });
  try {
    const u = await new Parse.Query(Parse.User).get(userId, M);
    if (u) await u.destroy(M);
  } catch (err) {
    if (err && err.code !== Parse.Error.OBJECT_NOT_FOUND) throw err;
  }
}

// the job: erase accounts whose waiting period has ended
async function processDeletions() {
  const due = (await findAll("DeletionRequest", { status: "pending" })).filter((r) => r.get("scheduled_for") <= new Date());
  const done = [], failed = [];
  for (const r of due) {
    const userId = r.get("user_id");
    try {
      await purgeUser(userId);
      await save(r, { status: "completed", completed_at: new Date(), user_id: sha(userId) });
      done.push(sha(userId).slice(0, 8));
    } catch (err) {
      failed.push(sha(userId).slice(0, 8));                    // stays pending; tried again on the next run
      console.error("account deletion failed:", err && err.message ? err.message : "error");
    }
  }
  return { processed: done.length, failed: failed.length };
}

module.exports = { exportData, deletionStatus, requestDeletion, cancelDeletion, processDeletions, purgeUser, GRACE_DAYS, CONFIRM_PHRASE };
