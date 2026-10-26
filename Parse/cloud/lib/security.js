// security.js — rate limits, code hashing, encryption, NPI check, email.
const crypto = require("crypto");
const { M, findAll, create, destroyAll } = require("./db");

// ---------- rate limits (stored in the database, so they work across server instances) ----------
// key: e.g. "login:email@x.com". `limit` hits per `windowMs`.
//
// A key normally has ONE row { key, count, reset_at }. Parse can't declare RateLimit.key unique, so requests that arrive at
// the very same moment on a new key (or just after its window ended) each create their own row. So every count here is the
// SUM over all live rows of the key, and it is read AFTER the write. A request that finishes its write therefore sees every
// request that finished before it, and no more than `limit` simultaneous requests can ever get a count of `limit` or less.
// Expired rows are deleted when the key is next used, so a key never piles up rows.
async function liveRows(key, prune = false) {
  const now = new Date();
  const all = await findAll("RateLimit", { key });
  const live = all.filter((r) => r.get("reset_at") > now);
  if (prune && live.length < all.length) {
    await destroyAll(all.filter((r) => r.get("reset_at") <= now)).catch(() => {});   // another request may have deleted them already
  }
  return live;
}
const sumCounts = (rows) => rows.reduce((n, r) => n + (r.get("count") || 0), 0);

// { count, resetAt } for the current window, or null when the key has no live window
async function limitState(key) {
  const rows = await liveRows(key);
  if (!rows.length) return null;
  return { count: sumCounts(rows), resetAt: new Date(Math.max(...rows.map((r) => r.get("reset_at").getTime()))) };
}
async function blocked(key, limit) {
  const state = await limitState(key);
  return !!state && state.count >= limit;
}
// hit(key, windowMs): counts one request. Use take() when you need the count; use hit() after the fact.
async function hit(key, windowMs) {
  await take(key, windowMs);
}
// take(key, windowMs): counts one request and returns the count in the current window, so the caller compares AFTER
// counting (no gap between checking and counting):  if ((await sec.take(key, windowMs)) > LIMIT) refuse.
async function take(key, windowMs) {
  const rows = await liveRows(key, true);
  if (rows.length) {
    rows[0].increment("count");                      // the database applies this atomically
    await rows[0].save(null, M);
  } else {
    await create("RateLimit", { key, count: 1, reset_at: new Date(Date.now() + windowMs) });
  }
  return sumCounts(await liveRows(key));             // read back after the write (see the note above)
}
// refund(key): gives one count back. Use it together with take(): count the attempt BEFORE checking the password or code,
// then refund it if the attempt was fine. A wrong guess stays counted even when many guesses arrive at the same moment
// (checking first and counting afterwards lets all of them through together).
async function refund(key) {
  const row = (await liveRows(key)).find((r) => r.get("count") > 0);
  if (row) {
    row.increment("count", -1);
    await row.save(null, M);
  }
}
async function resetLimit(key) {
  await destroyAll(await findAll("RateLimit", { key }));
}
async function minutesLeft(key) {
  const state = await limitState(key);
  return state ? Math.max(1, Math.ceil((state.resetAt - Date.now()) / 60000)) : 0;
}
// ---------- codes ----------
const new2faCode = () => String(crypto.randomInt(0, 100000000)).padStart(8, "0");
const newResetCode = () => crypto.randomBytes(8).toString("hex");
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
// slow, salted hash for short codes (8 digits are easy to brute-force from a plain hash)
function hashCode(code, salt = crypto.randomBytes(16).toString("hex")) {
  return `${salt}:${crypto.scryptSync(String(code), salt, 32).toString("hex")}`;
}
function checkCode(code, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(String(code), salt, 32);
  return crypto.timingSafeEqual(test, Buffer.from(hash, "hex"));
}
// 8 chars, no lookalike letters (0/O/1/I), formatted XXXX-XXXX
function newShareCode() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 8; i++) s += alphabet[crypto.randomInt(alphabet.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

// ---------- encryption for stored files (AES-256-GCM) ----------
// ENCRYPTION_KEY: 64 hex characters. Generate with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
const MAGIC = Buffer.from("MIB1");
function fileKey() {
  const hex = process.env.ENCRYPTION_KEY;
  return typeof hex === "string" && /^[0-9a-fA-F]{64}$/.test(hex) ? Buffer.from(hex, "hex") : null;
}
// ENCRYPTION_KEY set (not blank) but not 64 hex characters: fileKey() can't use it. Uploads must refuse (503) instead of
// quietly storing plain text; opening an encrypted file refuses too. No key at all is fine (files are stored unencrypted).
const KEY_INVALID = "ENCRYPTION_KEY is set but not valid; fix it before uploading";
// REQUIRE_ENCRYPTION=true (set it on Back4app): uploads are refused until a valid ENCRYPTION_KEY exists, so the Privacy Policy's statement that
// uploaded files are encrypted is always true. Without the setting, a missing key still stores files unencrypted (fine on your own computer).
const KEY_REQUIRED = "File uploads are turned off until an ENCRYPTION_KEY is set on the server";
const uploadBlock = () => (keyIsInvalid() ? KEY_INVALID : (process.env.REQUIRE_ENCRYPTION === "true" && !fileKey() ? KEY_REQUIRED : null));
const keyIsInvalid = () => !!String(process.env.ENCRYPTION_KEY || "").trim() && !fileKey();
function encrypt(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}
function decrypt(key, blob) {
  if (!blob.subarray(0, 4).equals(MAGIC)) throw new Error("not an MIB-encrypted file");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, blob.subarray(4, 16));
  decipher.setAuthTag(blob.subarray(16, 32));
  return Buffer.concat([decipher.update(blob.subarray(32)), decipher.final()]);
}

// ---------- NPI (National Provider Identifier) check digit ----------
// Luhn over "80840" + the first 9 digits must give the 10th digit.
function isValidNpi(npi) {
  if (typeof npi !== "string" || !/^\d{10}$/.test(npi)) return false;
  const digits = ("80840" + npi.slice(0, 9)).split("").map(Number);
  let sum = 0;
  for (let i = digits.length - 1, double = true; i >= 0; i--, double = !double) {
    let d = digits[i];
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return (10 - (sum % 10)) % 10 === Number(npi[9]);
}

// ---------- email ----------
// Set SMTP_USER + SMTP_PASS (a Gmail app password works) in the Back4app environment
// variables to send real emails.
// Without them the server does NOT quietly print login codes into its log: sending fails, so login and password reset
// stop working (they fail closed) until email is set up. Printing codes is allowed only when MIB_DEV_MODE=true is set;
// Parse/local/local-server.js sets it for you on your own computer. Do not set it on any site with real users (a demo site
// with made-up data is fine).
// With MIB_DEV_MODE=true and no SMTP, codes are written to the log, and with MIB_SHOW_CODES=true they are also shown on
// screen (demo only, never with real users).
const DEV_MODE = !process.env.SMTP_USER || !process.env.SMTP_PASS;   // no mail server configured
const DEV_CODES = DEV_MODE && process.env.MIB_DEV_MODE === "true";   // ...and printing codes instead is explicitly allowed
let transporter = null;
function mailer() {
  if (DEV_MODE) return null;
  if (!transporter) {
    const nodemailer = require("nodemailer");
    transporter = process.env.SMTP_HOST
      ? nodemailer.createTransport({
          host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587),
          secure: Number(process.env.SMTP_PORT || 587) === 465,
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        })
      : nodemailer.createTransport({ service: process.env.SMTP_SERVICE || "gmail", auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
  }
  return transporter;
}
async function sendEmail(to, subject, text, devLabel) {
  const m = mailer();
  if (!m) {
    // No mail server. Refuse, unless printing codes was explicitly allowed (your own computer only).
    if (!DEV_CODES) throw new Error("email is not set up: set SMTP_USER and SMTP_PASS (or MIB_DEV_MODE=true on your own computer)");
    console.log(`[DEV] ${devLabel} for ${to}: ${text.match(/\b[0-9a-f]{8,16}\b/)?.[0] ?? text}`);
    return;
  }
  await m.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text });
}
const showCodes = () => DEV_CODES && process.env.MIB_SHOW_CODES === "true";

module.exports = {
  blocked, hit, take, refund, resetLimit, minutesLeft,
  new2faCode, newResetCode, sha256, hashCode, checkCode, newShareCode,
  fileKey, keyIsInvalid, uploadBlock, KEY_INVALID, encrypt, decrypt, isValidNpi, sendEmail, showCodes, DEV_MODE,
};
