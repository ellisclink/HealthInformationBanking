// seed-demo.js — fill the LOCAL app with the demo patient + doctor (all made-up data).
//
//   (with local-server.js running in another window)
//   node seed-demo.js
//
// It runs the "seedDemo" Cloud Function (Parse/cloud/lib/seed.js) with the local master key.
// On Back4app, run "seedDemo" from the dashboard's API Console instead (never put the
// Back4app Master Key in a file).

const PORT = Number(process.env.PORT) || 1337;
const MASTER_KEY = process.env.PARSE_MASTER_KEY || "mib-local-master-key";

async function main() {
  console.log("Building the demo accounts (all data is made up)...\n");
  const res = await fetch(`http://127.0.0.1:${PORT}/parse/functions/seedDemo`, {
    method: "POST",
    headers: { "X-Parse-Application-Id": "mib-local", "X-Parse-Master-Key": MASTER_KEY, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error);
  const { results, logins, shareCodes } = body.result;
  console.log(results.map((r) => "  " + r).join("\n"));
  console.log(`
Log in at http://127.0.0.1:${PORT}
  Patient:  ${logins.patient}
  Doctor:   ${logins.doctor}
  (login codes print in the local-server.js window)
${shareCodes.provider ? `
Share codes (good for 7 days):
  Provider: ${shareCodes.provider}  – log in as the doctor, enter it on the Physician Dashboard
  Family:   ${shareCodes.family}  – open http://127.0.0.1:${PORT}/view, enter it and any name` : ""}
`);
}

main().catch((err) => {
  console.error("Seeding failed:", err.cause?.code === "ECONNREFUSED" ? "start local-server.js first" : err.message);
  process.exitCode = 1;
});
