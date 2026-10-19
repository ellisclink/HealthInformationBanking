// security.js — rate limits, code hashing, encryption, NPI check, email.
const crypto = require("crypto");
const { findOne, create, save } = require("./db");

// ---------- rate limits (stored in the database, so they work across server instances) ----------
// key: e.g. "login:email@x.com". `limit` hits per `windowMs`.
async function limitState(key) {
  const row = await findOne("RateLimit", { key });
  if (!row) return null;
  if (row.get("reset_at") <= new Date()) return null;
  return row;
}
async function blocked(key, limit) {
  const row = await limitState(key);
  return !!row && row.get("count") >= limit;
}
async function hit(key, windowMs) {
  const existing = await findOne("RateLimit", { key });
  if (existing && existing.get("reset_at") > new Date()) {
    existing.increment("count");
    await existing.save(null, { useMasterKey: true });
    return;
  }
  const resetAt = new Date(Date.now() + windowMs);
  if (existing) await save(existing, { count: 1, reset_at: resetAt });
  else await create("RateLimit", { key, count: 1, reset_at: resetAt });
}
// take(key, windowMs): counts one request and returns the count in the current window, so the caller compares AFTER
// counting (no gap between checking and counting). The count uses Parse's increment operation, which the database
// applies atomically and returns. Limitation: Parse can't declare RateLimit.key unique, so two first requests at the
// same moment can each create a row (the window then undercounts a little); later requests add to one of them.
async function take(key, windowMs) {
  const existing = await findOne("RateLimit", { key });
  if (existing && existing.get("reset_at") > new Date()) {
    existing.increment("count");
    await existing.save(null, { useMasterKey: true });
    return existing.get("count");
  }
  const resetAt = new Date(Date.now() + windowMs);
  if (existing) await save(existing, { count: 1, reset_at: resetAt });
  else await create("RateLimit", { key, count: 1, reset_at: resetAt });
  return 1;
}
async function resetLimit(key) {
  const row = await findOne("RateLimit", { key });
  if (row) await row.destroy({ useMasterKey: true });
}
async function minutesLeft(key) {
  const row = await limitState(key);
  return row ? Math.max(1, Math.ceil((row.get("reset_at") - Date.now()) / 60000)) : 0;
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
// variables to send real emails. Without them, codes are written to the Cloud Code logs,
// and with MIB_SHOW_CODES=true they're also shown on screen (demo only — never with real users).
const DEV_MODE = !process.env.SMTP_USER || !process.env.SMTP_PASS;
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
    console.log(`[DEV] ${devLabel} for ${to}: ${text.match(/\b[0-9a-f]{8,16}\b/)?.[0] ?? text}`);
    return;
  }
  await m.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text });
}
const showCodes = () => DEV_MODE && process.env.MIB_SHOW_CODES === "true";

module.exports = {
  blocked, hit, take, resetLimit, minutesLeft,
  new2faCode, newResetCode, sha256, hashCode, checkCode, newShareCode,
  fileKey, keyIsInvalid, KEY_INVALID, encrypt, decrypt, isValidNpi, sendEmail, showCodes, DEV_MODE,
};
