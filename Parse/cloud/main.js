// main.js — Cloud Code entry point for Back4app (Parse Server).
//
// The website calls ONE Cloud Function, `api`, with the same paths the old Node server
// had (see lib/router.js). All data classes are locked to the master key (lib/setup.js),
// so the only way in is through this function, which checks the session first.
// EXCEPTION: the owner classes (OWNER_CLASSES in lib/setup.js: Medication, DoseLog, Refill, DiaryEntry, Condition,
// ConditionNote, ConditionTarget, ccda_object, PersonalLink, NutritionLog, VitalReading, RespiratoryDevice,
// DeviceSupply, RespiratoryLog, Reminder, Notification, NotificationPrefs, CalendarEvent, LabResult, Allergy, SafetyAlert, DisposalLog, MedicalRecord, EmergencyProfile) are open to logged-in users (OWNER_CLP); the browser reads and writes them directly,
// and the triggers in lib/access.js keep each patient to their own rows.
//
// Other functions (run them from the Back4app dashboard > API Console with the Master Key):
//   setup                                          re-apply the class permissions
//   verifyLocked                                   check that every class is locked (expects {ok: true})
//   verifySettings                                 check account lockout, password policy and session settings (expects {ok: true})
//   seedDemo                                       create the demo patient (made-up data)
// Job (the Back4app job "sendReminders" runs every 15 minutes: schedule it in the dashboard under Jobs;
// the local server's own timer runs it every 5 minutes):
//   sendReminders                                  create due reminder/alert notifications and send the emails
// Job (run once from the dashboard after deploying; safe to repeat):
//   backfillOwnerAcls                              give every row of every owner class (setup.js OWNER_CLASSES) the owner-only ACL
//   convertPhysicians                              make every old physician account a patient (there are no physician accounts)

// Each file is loaded inside its own try/catch. If one of them fails (a missing library, an old Node version, a typo), the Cloud Code still
// STARTS, the failure is written to the log ("Cloud Code: failed to load ...") and the `ping` function says which file failed.
// Without this, one broken file can leave EVERY function hanging with no error to read.
const loadErrors = {};
function safeRequire(name) {
  try { return require("./lib/" + name); }
  catch (err) { loadErrors[name] = String((err && err.message) || err).split("\n")[0].slice(0, 200); console.error("Cloud Code: failed to load lib/" + name + ":", err && err.stack ? err.stack : err); return null; }
}
const auth = safeRequire("auth");
const router = safeRequire("router");
const setupLib = safeRequire("setup");
const clientip = safeRequire("clientip");
const route = router && router.route;
const ensureSetup = setupLib && setupLib.ensureSetup;
const clientIp = clientip ? clientip.clientIp : (request) => (request && request.ip) || "unknown";
const ready = () => !!(auth && route && ensureSetup);
console.log("Cloud Code starting on Node " + process.version + (ready() ? "" : " (NOT READY: " + Object.keys(loadErrors).join(", ") + ")"));

// ping: answers instantly, needs no login. Anyone can see { ok }; with the master key it also shows the Node version and what failed to load.
Parse.Cloud.define("ping", (request) => ({ ok: ready(), ...(request.master ? { node: process.version, load_errors: loadErrors } : {}) }));

// public routes that work without a session (an expired session is treated as logged out)
const PUBLIC = new Set(["/login", "/verify-2fa", "/forget", "/reset", "/logout"]);

Parse.Cloud.define("api", async (request) => {
  if (!ready()) return { status: 503, error: "the server is starting up or has a problem; please try again shortly" };
  await ensureSetup();
  const params = request.params || {};
  const path = String(params.path || "");
  const sessionToken = request.user ? request.user.getSessionToken() : null;
  const user = request.user ? await auth.checkSession(request.user, sessionToken) : null;
  if (request.user && !user && !PUBLIC.has(path) && !path.startsWith("/shared/") && !path.startsWith("/emergency-access/")) {
    return { status: 401, error: "your session has ended — please log in again" };
  }
  const ctx = {
    user, sessionToken, ip: clientIp(request),
    userAgent: (request.headers && request.headers["user-agent"]) || "",
  };
  try {
    return await route(params, ctx);
  } catch (err) {
    console.error("API error:", path, err);
    return { status: 500, error: "server error" };
  }
});

// Step 3 of login: only allowed right after the emailed code was entered
// if auth failed to load, fail SAFE: refuse every login and every account change that is not from Cloud Code
Parse.Cloud.beforeLogin(auth ? auth.beforeLogin : () => { throw new Parse.Error(Parse.Error.OTHER_CAUSE, "The server is starting up or has a problem; please try again shortly."); });
// A browser may only sign up (Parse's signUp, checked by auth.beforeSaveUser: patient, terms, password rules, 10 an hour);
// only Cloud Code may change accounts. If auth failed to load, every browser sign-up and account change is refused.
Parse.Cloud.beforeSave(Parse.User, auth ? auth.beforeSaveUser : (request) => { if (!request.master) throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, "Accounts are changed through the app."); });
if (auth) {
  // after a browser sign-up: revoke the session signUp returned (log in with the emailed code next), record, audit rows
  Parse.Cloud.afterSave(Parse.User, auth.afterSaveUser);
  // Parse.User.logOut(): the "logout" audit row and the end of SessionActivity for that session.
  // (Guarded so an older Parse Server without afterLogout cannot stop the rest of this file, the fail-closed parts, loading.)
  // After Parse.User.logIn: makes the SessionActivity row for the new session. checkSession refuses every session that has
  // none, so sessions only start through login (never through Parse's public POST /sessions). Without it nobody can log in.
  if (typeof Parse.Cloud.afterLogin === "function") Parse.Cloud.afterLogin(auth.afterLogin);
  else console.error("Cloud Code: this Parse Server has no afterLogin trigger; every session will be refused");
  if (typeof Parse.Cloud.afterLogout === "function") Parse.Cloud.afterLogout(auth.afterLogout);
  else console.error("Cloud Code: this Parse Server has no afterLogout trigger; logouts are not written to the audit log");
}

// The owner classes (setup.js OWNER_CLASSES: Medication, DoseLog, Refill, DiaryEntry, Condition, ConditionNote,
// ConditionTarget, ccda_object, PersonalLink, NutritionLog, VitalReading, RespiratoryDevice,
// DeviceSupply, RespiratoryLog, Reminder, Notification, NotificationPrefs, CalendarEvent, LabResult, Allergy, SafetyAlert, DisposalLog, MedicalRecord, EmergencyProfile) are open to logged-in users (OWNER_CLP); access.js keeps each patient to their own rows.
// If access.js failed to load, fail SAFE: the browser is refused on all of them (Cloud Code with the master key still works).
const access = safeRequire("access");
if (access) access.register(Parse);
else {
  const failclosed = require("./lib/failclosed");   // a 15-line file with no dependencies
  failclosed.registerFailClosed(Parse, failclosed.OWNER_CLASSES);
}

// Shows what the server sees for a request: call it (master key) with a made-up X-Forwarded-For header to find your TRUSTED_PROXY_HOPS number (see lib/clientip.js)
Parse.Cloud.define("debugClientIp", (request) => ({ request_ip: request.ip || null, x_forwarded_for: (request.headers && request.headers["x-forwarded-for"]) || null, chosen: clientIp(request), hops: Number(process.env.TRUSTED_PROXY_HOPS || 0) }), { requireMaster: true });
Parse.Cloud.define("setup", () => ensureSetup(true), { requireMaster: true });
// Lists every class that is NOT locked to the master key ({ok: true, problems: []} means all are locked). Run it after setup and after every deploy.
Parse.Cloud.define("verifyLocked", () => require("./lib/setup").auditLocks(), { requireMaster: true });
// Compares Parse's own security settings (account lockout, password policy, sessions) with lib/serverSettings.js EXPECTED.
// {ok: true, problems: []} means they match. Run it after changing Parse Server Options on Back4app.
Parse.Cloud.define("verifySettings", () => require("./lib/serverSettings").checkSettings(), { requireMaster: true });
Parse.Cloud.define("seedDemo", () => require("./lib/seed").seedDemo(), { requireMaster: true });

// Reminders and alerts: run every 15 minutes on Back4app (a scheduled job); local-server.js runs it on a 5-minute timer.
// Creates due notifications, sends the emails people asked for, and clears out old read ones.
Parse.Cloud.job("sendReminders", () => require("./lib/notifications").runAll());

// Owner-only ACL on every row of the owner classes (setup.js OWNER_CLASSES) that does not have one yet (rows made before ACLs, or with
// a different ACL). Safe to run again; the result says how many rows were fixed per class. Fails if access.js did not load.
Parse.Cloud.job("backfillOwnerAcls", async (request) => {
  if (!access) throw new Error("access.js did not load: " + (loadErrors.access || "unknown error"));
  const fixed = await access.backfillOwnerAcls();
  if (request && typeof request.message === "function") request.message(JSON.stringify(fixed));   // shown as the job's message
  return fixed;
});

// There are no physician accounts any more (2026-11-06): every account that is not a plain patient becomes one and loses
// its npi. Run once after deploying; safe to repeat. The result says how many accounts were changed.
Parse.Cloud.job("convertPhysicians", async (request) => {
  if (!auth) throw new Error("auth.js did not load: " + (loadErrors.auth || "unknown error"));
  const counts = await auth.convertPhysicians();
  if (request && typeof request.message === "function") request.message(JSON.stringify(counts));   // shown as the job's message
  return counts;
});

// Account deletion (7-4): erases accounts whose 7-day waiting period is over, plus expired PDF auto-fill drafts (7-2).
// Schedule it daily in the Back4app dashboard under Jobs.
Parse.Cloud.job("processAccountDeletions", async () => {
  const deleted = await require("./lib/account").processDeletions();
  const drafts = await require("./lib/autofill").purgeExpired();
  return { ...deleted, expired_drafts: drafts };
});

// Back4app web hosting: serve the built website (see app.js)
try { require("./app"); } catch (err) { if (err.code !== "MODULE_NOT_FOUND") throw err; }
