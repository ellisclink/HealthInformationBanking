// records.js — the patient's record (Health History form), share codes, read-only shared
// views, and the patient-visible access log.
//
// Everything a share code shows is READ-ONLY: shared views are read-only, and only the
// patient can write to their own record.
//
// A code opens for anyone who has it (no account needed), but the viewer must give their name (read-only).
// Every open is written to AccessLog, which the patient can see.
// Legacy: codes used to be "provider" (opened only by a physician account) or "family". Physician accounts are gone
// (2026-11-06), so new codes are always "family", and an old "provider" code is refused with 410 (OLD_PROVIDER_CODE).

//
// The Health History form itself (MedicalRecord.data) is read and saved by the website with the Parse SDK
// (Vite/src/data/records.ts), guarded by RULES.MedicalRecord in access.js with the rules below (recordProblem /
// recordValues = the old PUT /records checks): one row per user (a second create is refused, parallel creates are
// removed again after the save, the oldest is kept), only `data` may be sent (user_id, the legacy verified_* fields and
// everything else are refused), and after every browser save recordAfterSave copies the form's allergies to the
// Allergy list (safety.syncAllergiesFromRecord, master key), which the old route's hook did. getRecord / putRecord stay
// for the server's own callers (the PDF auto-fill and the C-CDA import, which pass the same hook).

const { M, findAll, findOne, oldestRow, keepOldest, create, save, audit, toRow } = require("./db");
const sec = require("./security");
const safety = require("./safety");   // syncAllergiesFromRecord (safety.js does not load this file)

const SHARE_AUDIENCES = ["family"];
const SHARE_SECTIONS = ["record", "medications", "vitals", "diary"];
const SHARE_TTL_HOURS_DEFAULT = 24;
const SHARE_TTL_HOURS_MAX = 24 * 7;
const DIARY_ENTRIES_SHOWN = 50;
const LOOKUP_LIMIT = 20;                 // failed code lookups per device per 15 minutes
const MIN15 = 15 * 60 * 1000;
const TOO_MANY = { status: 429, error: "too many invalid codes from this device — try again in 15 minutes" };
const BAD_CODE = { status: 404, error: "invalid, expired, or revoked code" };
const OLD_PROVIDER_CODE = { status: 410, error: "This code no longer works. Ask the patient for a new sharing code." };

const iso = (d) => (d instanceof Date ? d.toISOString() : d ?? null);

const RECORD_MAX = 500000;   // characters of JSON.stringify(data)
const DATA_REQUIRED = "data object required";
const TOO_LARGE = "record is too large";
const RECORD_EXISTS = "Your health history is already saved";
const NOT_REMOVABLE = "Your health history can't be removed. Clear the form and save it instead.";

// the user's record (the oldest row, the one a second create would duplicate); made empty when there is none. After
// that create the extra rows are removed again (keepOldest), so a browser save or a second server call at the same
// moment cannot leave a lasting second row; the kept (oldest) row is returned.
async function getRecordObject(userId) {
  const rec = await oldestRow("MedicalRecord", userId);
  if (rec) return rec;
  await create("MedicalRecord", { user_id: userId, data: {} });
  return keepOldest("MedicalRecord", userId, { row: recordAuditRow });
}
const recordView = (rec) => ({
  data: rec.get("data") || {},
  updated_at: iso(rec.updatedAt),
});

// the record (the PDF auto-fill and the C-CDA import; the website reads its row itself)
async function getRecord(user) {
  return { status: 200, ...recordView(await getRecordObject(user.user_id)) };
}

const dataProblem = (data) => {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return DATA_REQUIRED;
  if (JSON.stringify(data).length > RECORD_MAX) return TOO_LARGE;
  return null;
};

// ---- browser saves (access.js RULES.MedicalRecord) ----
const RECORD_BROWSER_FIELDS = ["data"];
// what the audit rows hold: the form data, as the old route's record_updated rows did
const recordAuditRow = (o) => o.get("data") || {};
async function recordProblem(body, { user, original }) {
  if (!original || "data" in body) {
    const problem = dataProblem(body.data);
    if (problem) return problem;
  }
  if (!original && await oldestRow("MedicalRecord", user.id)) return RECORD_EXISTS;
  return null;
}
const recordValues = (body) => ("data" in body ? { data: body.data } : {});
// an edit of the form keeps the old audit event name
const recordAuditEvent = () => "record_updated";
const recordDeleteProblem = () => NOT_REMOVABLE;
// The allergy copy, one at a time per user (in this process), always from the record as it is stored when the copy
// runs: two saves at the same moment (two tabs, or parallel creates where one is removed again) can't interleave their
// creates and removals, and the last copy always matches the row that is kept.
const syncing = new Map();   // userId -> the copy running or queued
function syncKeptRecord(userId) {
  const run = (syncing.get(userId) || Promise.resolve()).then(async () => {
    const kept = await oldestRow("MedicalRecord", userId);
    await safety.syncAllergiesFromRecord(userId, (kept && kept.get("data")) || {});
  });
  const done = run.catch(() => {});
  syncing.set(userId, done);
  done.then(() => { if (syncing.get(userId) === done) syncing.delete(userId); });
  return run;
}
// After every browser save (once): a create first removes parallel duplicates (the oldest row is kept; a removed
// duplicate copies nothing); then the kept row's allergies are copied to the Allergy list.
async function recordAfterSave(obj, { original, ip }) {
  const userId = obj.get("user_id");
  if (!original) {
    const kept = await keepOldest("MedicalRecord", userId, { ip, row: recordAuditRow });
    if (kept && kept.id !== obj.id) return;
  }
  await syncKeptRecord(userId);
}

// the record save of the server's own callers (the PDF auto-fill and the C-CDA import) {data}
async function putRecord(body, user, ctx, hooks) {
  const { data } = body;
  const problem = dataProblem(data);
  if (problem) return { status: 400, error: problem };
  const rec = await getRecordObject(user.user_id);
  const old = rec.get("data") || {};
  await save(rec, { data });
  await audit({ userId: user.user_id, event: "record_updated", ip: ctx.ip, targetClass: "MedicalRecord", targetId: rec.id,
    oldData: old, newData: data });
  // keep the structured allergy list (used by medication safety checks) in step with the form
  if (hooks && hooks.afterRecordSaved) await hooks.afterRecordSaved(user.user_id, data);
  return { status: 200, ok: true };
}

// ---------- share codes ----------
const lookupKey = (ctx) => `share-lookup:${ctx.ip}`;

async function findLiveShare(code) {
  const share = await findOne("ShareCode", { share_code: String(code || "").trim().toUpperCase() });
  if (!share || share.get("revoked") || share.get("expires_at") <= new Date()) return null;
  return share;
}

async function logAccess(ctx, share, action, viewer) {
  await create("AccessLog", {
    patient_user_id: share.get("user_id"), share_code: share.get("share_code"), audience: share.get("audience"),
    action, viewer_user_id: viewer.user_id || null, viewer_name: viewer.name,
    ip_address: String(ctx.ip || "").slice(0, 64), user_agent: String(ctx.userAgent || "").slice(0, 500),
    sections: share.get("sections"), accessed_at: new Date(),
  });
}

// Read-only data for the sections a code allows
async function sharedSections(userId, sections, mods) {
  const out = {};
  const meds = await findAll("Medication", { user_id: userId });
  const medRow = (m) => ({
    medication_name: m.get("medication_name"), medication_type: m.get("medication_type") || "prescription",
    brand_name: m.get("brand_name") ?? null, strength: m.get("strength") ?? null, strength_unit: m.get("strength_unit") ?? null,
    dosage_form: m.get("dosage_form") ?? null, route: m.get("route") ?? null, dose_amount: m.get("dose_amount") ?? null,
    dose_unit: m.get("dose_unit") ?? null, frequency: m.get("frequency") ?? null, instructions: m.get("instructions") ?? null,
    purpose: m.get("purpose") ?? null, status: m.get("status"), start_date: m.get("start_date") ?? null,
    end_date: m.get("end_date") ?? null, prescriber_name: m.get("prescriber_name") ?? null,
  });
  if (sections.includes("record")) {
    out.record = recordView(await getRecordObject(userId));
    // the form's medication lists come from the Medications tracker
    out.record.medications = meds.filter((m) => ["active", "paused"].includes(m.get("status")))
      .sort((a, b) => a.get("medication_name").localeCompare(b.get("medication_name")))
      .map((m) => {
        const r = medRow(m);
        return { medication_name: r.medication_name, medication_type: r.medication_type, strength: r.strength,
          strength_unit: r.strength_unit, dose_amount: r.dose_amount, dose_unit: r.dose_unit, frequency: r.frequency };
      });
  }
  if (sections.includes("medications")) {
    out.medications = meds.sort((a, b) => ((a.get("status") === "active") === (b.get("status") === "active")
      ? a.get("medication_name").localeCompare(b.get("medication_name")) : a.get("status") === "active" ? -1 : 1)).map(medRow);
  }
  if (sections.includes("vitals")) {
    const v = await mods.vitals.summary({ user_id: userId });
    out.vitals = v.status === 200 ? v.summary : [];
  }
  if (sections.includes("diary")) {
    const entries = await findAll("DiaryEntry", { user_id: userId });
    out.diary = entries
      .sort((a, b) => b.get("entry_date").localeCompare(a.get("entry_date")) || b.createdAt - a.createdAt)
      .slice(0, DIARY_ENTRIES_SHOWN)
      .map((e) => ({
        entry_date: e.get("entry_date"), category: e.get("category"), title: e.get("title"),
        description: e.get("description") ?? null, severity: e.get("severity") ?? null, mood: e.get("mood") ?? null,
        follow_up_needed: !!e.get("follow_up_needed"),
      }));
  }
  return out;
}

// POST /shared/:code {viewerName?} — open a shared record (read-only)
async function openShared(code, body, user, ctx, mods) {
  // Counted BEFORE the lookup (LOOKUP_LIMIT tries per device in 15 minutes), so many guesses sent at once can't all get
  // through; a real code gives its count back below.
  if ((await sec.take(lookupKey(ctx), MIN15)) > LOOKUP_LIMIT) return TOO_MANY;
  const share = await findLiveShare(code);
  if (!share) {
    await audit({ event: "share_code_invalid", ip: ctx.ip });
    return BAD_CODE;
  }
  await sec.refund(lookupKey(ctx));
  // an old provider code (only physician accounts could open those, and there are none now): refused, nothing logged as opened
  if (share.get("audience") !== "family") return OLD_PROVIDER_CODE;
  const typed = typeof body.viewerName === "string" ? body.viewerName.trim() : "";
  if (!typed && !user) return { status: 400, error: "enter your name to view this record" };
  if (typed.length > 100) return { status: 400, error: "name must be 100 characters or fewer" };
  const viewer = user ? { user_id: user.user_id, name: user.user_name } : { name: typed };
  const patient = await new Parse.Query(Parse.User).get(share.get("user_id"), M);
  await logAccess(ctx, share, "view", viewer);
  return {
    status: 200,
    patient_name: patient.get("name"),
    audience: share.get("audience"),
    sections: share.get("sections"),
    expires_at: iso(share.get("expires_at")),
    ...(await sharedSections(share.get("user_id"), share.get("sections"), mods)),
  };
}

// POST /share {expiresHours?, audience?, sections?, label?}
async function createShare(body, user, ctx) {
  let hours = SHARE_TTL_HOURS_DEFAULT;
  if (body.expiresHours !== undefined) {
    hours = Number(body.expiresHours);
    if (!Number.isInteger(hours) || hours < 1 || hours > SHARE_TTL_HOURS_MAX) {
      return { status: 400, error: `expiresHours must be a whole number from 1 to ${SHARE_TTL_HOURS_MAX}` };
    }
  }
  const audience = body.audience === undefined ? "family" : body.audience;
  if (!SHARE_AUDIENCES.includes(audience)) return { status: 400, error: `audience must be one of: ${SHARE_AUDIENCES.join(", ")}` };
  let sections = SHARE_SECTIONS;
  if (body.sections !== undefined) {
    if (!Array.isArray(body.sections) || body.sections.length === 0 || !body.sections.every((x) => SHARE_SECTIONS.includes(x))) {
      return { status: 400, error: `sections must be a non-empty list from: ${SHARE_SECTIONS.join(", ")}` };
    }
    sections = SHARE_SECTIONS.filter((x) => body.sections.includes(x));
  }
  let label = null;
  if (body.label !== undefined && body.label !== null) {
    if (typeof body.label !== "string" || body.label.trim().length > 100) return { status: 400, error: "label must be text of 100 characters or fewer" };
    label = body.label.trim() || null;
  }
  let code;
  do { code = sec.newShareCode(); } while (await findOne("ShareCode", { share_code: code }));
  await create("ShareCode", {
    share_code: code, user_id: user.user_id, expires_at: new Date(Date.now() + hours * 3600000),
    revoked: false, audience, sections, label,
  });
  await audit({ userId: user.user_id, event: "share_created", ip: ctx.ip, detail: { share_code: code, audience, sections, hours } });
  return { status: 201, shareCode: code, expiresInHours: hours, audience, sections, label };
}

// GET /share — your live codes
async function listShares(user) {
  const rows = (await findAll("ShareCode", { user_id: user.user_id }))
    .filter((s) => s.get("expires_at") > new Date())
    .sort((a, b) => b.get("expires_at") - a.get("expires_at"))
    .map((s) => ({
      share_code: s.get("share_code"), expires_at: iso(s.get("expires_at")), revoked: !!s.get("revoked"),
      created_at: iso(s.createdAt), audience: s.get("audience"), sections: s.get("sections"), label: s.get("label") ?? null,
    }));
  return { status: 200, shares: rows };
}

// GET /share/access-log — who opened your shared records, newest first
async function listAccessLog(user) {
  const shares = await findAll("ShareCode", { user_id: user.user_id });
  const labels = new Map(shares.map((s) => [s.get("share_code"), s.get("label") ?? null]));
  const entries = (await findAll("AccessLog", { patient_user_id: user.user_id }))
    .sort((a, b) => b.get("accessed_at") - a.get("accessed_at"))
    .slice(0, 200)
    .map((l) => ({
      accessed_at: iso(l.get("accessed_at")), action: l.get("action"), audience: l.get("audience"),
      share_code: l.get("share_code"), viewer_name: l.get("viewer_name"),
      viewer_npi: l.get("viewer_npi") ?? null,   // only on opens of old provider codes
      sections: l.get("sections"), label: labels.get(l.get("share_code")) ?? null,
    }));
  return { status: 200, entries };
}

// DELETE /share/:code — revoke (cuts off access immediately)
async function revokeShare(code, user, ctx) {
  const share = await findOne("ShareCode", { share_code: String(code).toUpperCase(), user_id: user.user_id });
  if (!share) return { status: 404, error: "code not found" };
  await save(share, { revoked: true });
  await audit({ userId: user.user_id, event: "share_revoked", ip: ctx.ip, detail: { share_code: share.get("share_code") } });
  return { status: 200, ok: true, revoked: share.get("share_code") };
}

module.exports = {
  getRecord, putRecord, openShared, createShare, listShares, listAccessLog, revokeShare, toRow,
  RECORD_BROWSER_FIELDS, recordProblem, recordValues, recordAuditEvent, recordDeleteProblem, recordAfterSave, recordAuditRow,
};
