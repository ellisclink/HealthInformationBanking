// local-server.js — run the whole app on your own computer with a local Parse Server,
// using the same Cloud Code that runs on Back4app. Nothing here is used on Back4app.
//
//   cd Parse/local
//   npm install
//   node local-server.js
//   open http://127.0.0.1:1337
//
// Database: your local Postgres (database "mib_parse", created once with
//   psql -U postgres -c "CREATE DATABASE mib_parse;"). Change it with PARSE_DATABASE_URI.
// Login codes print in this window (no email setup needed locally).
//
// Settings (environment variables, all optional):
//   PARSE_DATABASE_URI  postgres://postgres:1234@localhost:5432/mib_parse  (or a mongodb:// URI)
//   PORT                1337
//   ENCRYPTION_KEY      encrypts uploaded lab PDFs (64 hex characters)

const path = require("path");
const fs = require("fs");
const express = require("express");
const { ParseServer } = require("parse-server");

// Your own computer has no mail server, so let login codes print in this window (see Parse/cloud/lib/security.js: without
// this, sending a code fails instead of writing it to the log). It must be set before the Cloud Code loads.
// Do not set MIB_DEV_MODE on a site with real users.
if (process.env.MIB_DEV_MODE === undefined) process.env.MIB_DEV_MODE = "true";

const PORT = Number(process.env.PORT) || 1337;
const SERVER_URL = `http://127.0.0.1:${PORT}/parse`;
const DATABASE_URI = process.env.PARSE_DATABASE_URI || "postgres://postgres:1234@localhost:5432/mib_parse";
const WEBSITE = path.resolve(__dirname, "..", "..", "Vite", "dist");

// Back4app runs the sendReminders job (cloud/main.js) on its own schedule; locally a timer does the same work.
// It calls the same function the job does, and skips a run if the last one is still going.
const REMINDER_INTERVAL_MS = 5 * 60 * 1000;
function startReminderTimer() {
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await require("../cloud/lib/notifications").runAll();
      // same timer also runs the processAccountDeletions job (account deletions whose waiting period is over, old auto-fill drafts)
      await require("../cloud/lib/account").processDeletions();
      await require("../cloud/lib/autofill").purgeExpired();
    } catch (err) {
      console.error("sendReminders failed:", err.message);
    } finally {
      running = false;
    }
  }, REMINDER_INTERVAL_MS);
}

async function main() {
  const server = new ParseServer({
    databaseURI: DATABASE_URI,
    cloud: path.resolve(__dirname, "..", "cloud", "main.js"),
    appId: "mib-local",
    javascriptKey: "mib-local-js",
    masterKey: process.env.PARSE_MASTER_KEY || "mib-local-master-key",
    masterKeyIps: ["127.0.0.1", "::1"],
    serverURL: SERVER_URL,
    allowClientClassCreation: false,
    enforcePrivateUsers: true,
    sessionLength: 12 * 60 * 60,           // 12 hours (the app also ends idle sessions after 30 minutes)
    maxUploadSize: "20mb",
    silent: true,
    // Don't write successful Cloud Function results to the log files: they hold health data and the calendar link
    // token, which is shown to the patient once (D-016). Errors are still logged.
    logLevels: { cloudFunctionSuccess: "silent" },
    encodeParseObjectInCloudFunction: true,
    enableInsecureAuthAdapters: false,
    // Locks an account for 15 minutes after 5 wrong passwords. This also covers calls made straight to Parse's /login,
    // which the app's own rate limits (cloud/lib/security.js) never see. On Back4app turn on the same setting (README).
    accountLockout: { duration: 15, threshold: 5, unlockOnPasswordReset: true },
  });
  await server.start();

  const app = express();
  app.set("trust proxy", 1);   // one proxy hop at most (the local dev case); `true` would believe any X-Forwarded-For
  app.use("/parse", server.app);
  // Calendar subscribe feed (D-016), the same handler Back4app uses (cloud/app.js). Registered before the website's
  // catch-all so index.html doesn't answer it. There is no request logger here: the path holds the private token.
  const calendarFeed = require("../cloud/lib/calendarFeed");
  // (mount also adds an error handler so a badly encoded feed path is a plain 404 and is never printed)
  calendarFeed.mount(app, { clientIp: (req) => req.ip || null });
  if (fs.existsSync(path.join(WEBSITE, "index.html"))) {
    app.use(express.static(WEBSITE));
    app.get("*", (req, res) => res.sendFile(path.join(WEBSITE, "index.html")));
  } else {
    app.get("/", (req, res) => res.send("Build the website first: cd Vite && npm run build"));
  }
  app.listen(PORT, () => {
    console.log(`Health Information Banking running at http://127.0.0.1:${PORT}  (Parse API at ${SERVER_URL})`);
    console.log("Login codes will print here.");
    console.log("Reminders and alerts run every 5 minutes (the sendReminders job).");
    startReminderTimer();
  });
}

main().catch((err) => {
  console.error("Could not start:", err.message);
  if (/does not exist/.test(err.message)) console.error('Create the database first:  psql -U postgres -c "CREATE DATABASE mib_parse;"');
  process.exit(1);
});
