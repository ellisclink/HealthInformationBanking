// test-email.js — send ONE test email using the app's own sendEmail (Parse/cloud/lib/security.js)
// to check that your SMTP settings work. Contains no health data.
//
//   cd Parse\local
//   $env:SMTP_USER = "you@gmail.com"      # PowerShell; use an app password for SMTP_PASS
//   $env:SMTP_PASS = "..."
//   node test-email.js you@example.com
//
// Optional: SMTP_HOST, SMTP_PORT, SMTP_SERVICE, SMTP_FROM (same as the app).

const path = require("path");
const Module = require("module");

const to = process.argv[2];
if (!to || !to.includes("@")) {
  console.error("Usage: node test-email.js <recipient-email>");
  console.error("Example: node test-email.js you@example.com");
  process.exit(1);
}

const missing = ["SMTP_USER", "SMTP_PASS"].filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing environment variable(s): ${missing.join(", ")}`);
  console.error("Set them in this terminal first (PowerShell: $env:SMTP_USER = \"...\"; $env:SMTP_PASS = \"...\").");
  process.exit(1);
}

// security.js lives in Parse/cloud/lib and does require("nodemailer"), which is installed in
// Parse/local/node_modules. Add that folder to Node's module search path so it resolves.
const localModules = path.join(__dirname, "node_modules");
process.env.NODE_PATH = [localModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();

const { sendEmail } = require("../cloud/lib/security");

sendEmail(
  to,
  "Health Information Banking: test email",
  "This is a test message from Health Information Banking. If you received it, email sending works.",
  "test email"
)
  .then(() => {
    console.log(`Sent. Check the inbox (and spam folder) of ${to}.`);
  })
  .catch((err) => {
    console.error(`Failed to send: ${err && err.message ? err.message : String(err)}`);
    process.exit(1);
  });
