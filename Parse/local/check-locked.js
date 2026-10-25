// check-locked.js — test from OUTSIDE that no data table can be read without logging in.
//
//   node check-locked.js                       the local server (http://127.0.0.1:1337)
//   node check-locked.js <parse-url> <appId> <jsKey>
//       e.g. node check-locked.js https://parseapi.back4app.com YOUR_APP_ID YOUR_JS_KEY
//
// It only READS, using the public App ID and JavaScript key that every visitor's browser has (never the master key).
// Every class must answer "permission denied". An empty list (200) is a FAIL: it means the class is open, or has not been created
// (so setup has not run). Run it after every deploy, and any time you change setup.js.

global.Parse = {};
const { SCHEMA } = require("../cloud/lib/setup");

// the REST address: local is .../parse, Back4app is https://parseapi.back4app.com (no /parse)
const base = (process.argv[2] || "http://127.0.0.1:1337/parse").replace(/[/]$/, "");
const appId = process.argv[3] || "mib-local";
const jsKey = process.argv[4] || "mib-local-js";

async function read(cls) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  try {
    const res = await fetch(`${base}/classes/${cls}?limit=1`, { headers: { "X-Parse-Application-Id": appId, "X-Parse-Javascript-Key": jsKey }, signal: ac.signal });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, code: body.code, error: body.error, rows: Array.isArray(body.results) ? body.results.length : null };
  } catch (e) { return { status: 0, error: e.name === "AbortError" ? "no answer in 15 s" : e.message }; }
  finally { clearTimeout(timer); }
}

(async () => {
  const classes = [...Object.keys(SCHEMA), "_User", "_Role", "_Installation"];
  const failures = [];
  for (const c of classes) {
    const r = await read(c);
    const denied = r.status >= 400 && r.status !== 0 && r.code === 119;          // 119 = operation forbidden by class-level permissions
    console.log(`${denied ? "PASS" : "FAIL"}  ${c.padEnd(20)} ${r.status} ${r.error || (r.rows !== null ? `answered with ${r.rows} row(s)` : "")}`);
    if (!denied) failures.push(c);
    await new Promise((ok) => setTimeout(ok, 100));
  }
  console.log(failures.length ? `\n${failures.length} of ${classes.length} classes are NOT confirmed locked: ${failures.join(", ")}\nRun the "setup" function with the master key, then "verifyLocked", then run this again.`
    : `\nAll ${classes.length} classes refuse anonymous reads.`);
  process.exit(failures.length ? 1 : 0);
})();
