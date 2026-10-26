// records.js — the patient's record (Health History form), share codes, read-only shared
// views, and the patient-visible access log.
//
// Everything a share code shows is READ-ONLY: shared views are read-only, and only the
// patient can write to their own record.
//
// Two kinds of code, picked by the patient:
//   provider  opens only for a logged-in physician account (read-only)
//   family    opens for anyone with the code (no account needed), but the viewer must give
//             their name (read-only)
// Every open is written to AccessLog, which the patient can see.

const { M, findAll, findOne, create, save, audit, toRow } = require("./db");
const sec = require("./security");

const SHARE_AUDIENCES = ["provider", "family"];
const SHARE_SECTIONS = ["record", "medications", "vitals", "diary"];
const SHARE_TTL_HOURS_DEFAULT = 24;
const SHARE_TTL_HOURS_MAX = 24 * 7;
const DIARY_ENTRIES_SHOWN = 50;
const LOOKUP_LIMIT = 20;                 // failed code lookups per device per 15 minutes
const MIN15 = 15 * 60 * 1000;
const TOO_MANY = { status: 429, error: "too many invalid codes from this device — try again in 15 minutes" };
const BAD_CODE = { status: 404, error: "invalid, expired, or revoked code" };

const iso = (d) => (d instanceof Date ? d.toISOString() : d ?? null);

async function getRecordObject(userId) {
  let rec = await findOne("MedicalRecord", { user_id: userId });
  if (!rec) rec = await create("MedicalRecord", { user_id: userId, data: {} });
  return rec;
}
const recordView = (rec) => ({
  data: rec.get("data") || {},
  updated_at: iso(rec.updatedAt),
});

// GET /records
async function getRecord(user) {
  return { status: 200, ...recordView(await getRecordObject(user.user_id)) };
}

// PUT /records {data}
async function putRecord(body, user, ctx, hooks) {
  const { data } = body;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return { status: 400, error: "data object required" };
  if (JSON.stringify(data).length > 500000) return { status: 400, error: "record is too large" };
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
    action, viewer_user_id: viewer.user_id || null, viewer_name: viewer.name, viewer_npi: viewer.npi || null,
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
  let viewer;
  if (share.get("audience") === "provider") {
    if (!user) return { status: 401, error: "this code is for a healthcare provider — log in with a physician account to open it" };
    if (user.role !== "physician") return { status: 403, error: "this code is for a healthcare provider; only physician accounts can open it" };
    viewer = { user_id: user.user_id, name: user.user_name, npi: user.npi };
  } else {
    const typed = typeof body.viewerName === "string" ? body.viewerName.trim() : "";
    if (!typed && !user) return { status: 400, error: "enter your name to view this record" };
    if (typed.length > 100) return { status: 400, error: "name must be 100 characters or fewer" };
    viewer = user ? { user_id: user.user_id, name: user.user_name } : { name: typed };
  }
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
  const audience = body.audience === undefined ? "provider" : body.audience;
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
      share_code: l.get("share_code"), viewer_name: l.get("viewer_name"), viewer_npi: l.get("viewer_npi") ?? null,
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

module.exports = { getRecord, putRecord, openShared, createShare, listShares, listAccessLog, revokeShare, toRow };
