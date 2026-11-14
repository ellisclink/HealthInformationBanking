// main.js — Cloud Code entry point for Back4app (Parse Server).
//
// The website calls ONE Cloud Function, `api`, with the same paths the old Node server
// had (see lib/router.js). All data classes are locked to the master key (lib/setup.js),
// so the only way in is through this function, which checks the session first.
//
// Other functions (run them from the Back4app dashboard > API Console with the Master Key):
//   makePhysician {"email": "...", "npi": "..."}   turn an account into a physician
//   setup                                          re-apply the class permissions
//   verifyLocked                                   check that every class is locked (expects {ok: true})
//   seedDemo                                       create the demo patient + doctor (made-up data)
// Job (the Back4app job "sendReminders" runs every 15 minutes: schedule it in the dashboard under Jobs;
// the local server's own timer runs it every 5 minutes):
//   sendReminders                                  create due reminder/alert notifications and send the emails

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
const PUBLIC = new Set(["/register", "/login", "/verify-2fa", "/forget", "/reset", "/logout"]);

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
// Parse.Cloud.beforeLogin(auth ? auth.beforeLogin : () => { throw new Parse.Error(Parse.Error.OTHER_CAUSE, "The server is starting up or has a problem; please try again shortly."); });
// Only Cloud Code may create or change accounts (no making yourself a physician)
// Parse.Cloud.beforeSave(Parse.User, auth ? auth.beforeSaveUser : (request) => { if (!request.master) throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, "Accounts are changed through the app."); });

Parse.Cloud.define("makePhysician", (request) => { if (!auth) throw new Error("auth did not load; see ping"); return auth.makePhysician(request.params || {}); }, { requireMaster: true });
// Shows what the server sees for a request: call it (master key) with a made-up X-Forwarded-For header to find your TRUSTED_PROXY_HOPS number (see lib/clientip.js)
Parse.Cloud.define("debugClientIp", (request) => ({ request_ip: request.ip || null, x_forwarded_for: (request.headers && request.headers["x-forwarded-for"]) || null, chosen: clientIp(request), hops: Number(process.env.TRUSTED_PROXY_HOPS || 0) }), { requireMaster: true });
Parse.Cloud.define("setup", () => ensureSetup(true), { requireMaster: true });
// Lists every class that is NOT locked to the master key ({ok: true, problems: []} means all are locked). Run it after setup and after every deploy.
Parse.Cloud.define("verifyLocked", () => require("./lib/setup").auditLocks(), { requireMaster: true });
Parse.Cloud.define("seedDemo", () => require("./lib/seed").seedDemo(), { requireMaster: true });

// Reminders and alerts: run every 15 minutes on Back4app (a scheduled job); local-server.js runs it on a 5-minute timer.
// Creates due notifications, sends the emails people asked for, and clears out old read ones.
Parse.Cloud.job("sendReminders", () => require("./lib/notifications").runAll());

// Account deletion (7-4): erases accounts whose 7-day waiting period is over, plus expired PDF auto-fill drafts (7-2).
// Schedule it daily in the Back4app dashboard under Jobs.
Parse.Cloud.job("processAccountDeletions", async () => {
  const deleted = await require("./lib/account").processDeletions();
  const drafts = await require("./lib/autofill").purgeExpired();
  return { ...deleted, expired_drafts: drafts };
});

// Back4app web hosting: serve the built website (see app.js)
try { require("./app"); } catch (err) { if (err.code !== "MODULE_NOT_FOUND") throw err; }
