// main.js — Cloud Code entry point for Back4app (Parse Server).
//
// The website calls ONE Cloud Function, `api`, with the same paths the old Node server
// had (see lib/router.js). All data classes are locked to the master key (lib/setup.js),
// so the only way in is through this function, which checks the session first.
//
// Other functions (run them from the Back4app dashboard > API Console with the Master Key):
//   makePhysician {"email": "...", "npi": "..."}   turn an account into a physician
//   setup                                          re-apply the class permissions
//   seedDemo                                       create the demo patient + doctor (made-up data)
// Job (the Back4app job "sendReminders" runs every 15 minutes: schedule it in the dashboard under Jobs;
// the local server's own timer runs it every 5 minutes):
//   sendReminders                                  create due reminder/alert notifications and send the emails

const auth = require("./lib/auth");
const { route } = require("./lib/router");
const { ensureSetup } = require("./lib/setup");

// public routes that work without a session (an expired session is treated as logged out)
const PUBLIC = new Set(["/register", "/login", "/verify-2fa", "/forget", "/reset", "/logout"]);

Parse.Cloud.define("api", async (request) => {
  await ensureSetup();
  const params = request.params || {};
  const path = String(params.path || "");
  const sessionToken = request.user ? request.user.getSessionToken() : null;
  const user = request.user ? await auth.checkSession(request.user, sessionToken) : null;
  if (request.user && !user && !PUBLIC.has(path) && !path.startsWith("/shared/") && !path.startsWith("/emergency-access/")) {
    return { status: 401, error: "your session has ended — please log in again" };
  }
  const ctx = {
    user, sessionToken, ip: request.ip || "unknown",
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
Parse.Cloud.beforeLogin(auth.beforeLogin);
// Only Cloud Code may create or change accounts (no making yourself a physician)
Parse.Cloud.beforeSave(Parse.User, auth.beforeSaveUser);

Parse.Cloud.define("makePhysician", (request) => auth.makePhysician(request.params || {}), { requireMaster: true });
Parse.Cloud.define("setup", () => ensureSetup(true), { requireMaster: true });
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
