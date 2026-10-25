// password.js — what makes a password acceptable (used when signing up and when resetting a password).
//
// The website shows the same rules live while someone types (Vite/src/password.ts). KEEP THE TWO FILES IN STEP: the website is only a
// convenience, this file is the one that is enforced.
//
// Rules: at least 10 characters; not on the list of very common passwords; not mostly one repeated character or a simple run
// (12345678, abcdefgh); does not contain the person's email name or their name; and uses at least 3 of: lower case, UPPER CASE,
// numbers, symbols. (A long passphrase of several words is also fine: 16+ characters only needs 2 kinds.)

const MIN_LENGTH = 10;
const MAX_LENGTH = 128;
const LONG_ENOUGH = 16;                 // a long passphrase needs fewer kinds of character

// the most common passwords, lower case (the check also catches simple changes such as "Password1!")
const COMMON = new Set(("password passw0rd p@ssword p@ssw0rd 123456 1234567 12345678 123456789 1234567890 12345 111111 000000 123123 654321 qwerty qwerty123 qwertyuiop " +
  "qwerty1 1q2w3e4r 1qaz2wsx qazwsx abc123 abcd1234 letmein welcome welcome1 admin administrator login master dragon monkey shadow sunshine princess football baseball " +
  "iloveyou trustno1 superman batman starwars whatever freedom hello hello123 charlie donald michael jordan harley ranger summer winter spring autumn secret changeme " +
  "default test test123 guest user health healthy medical medicine doctor patient hospital nurse hib healthinformationbanking passwords password1 password12 password123").split(" "));

const kinds = (p) => [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(p)).length;

// leet-speak and trailing digits/symbols stripped, so "P@ssw0rd!!" is seen as "password"
function base(p) {
  return p.toLowerCase().replace(/@/g, "a").replace(/0/g, "o").replace(/1/g, "i").replace(/3/g, "e").replace(/\$/g, "s").replace(/5/g, "s").replace(/[^a-z]/g, "");
}
const trimmed = (p) => p.toLowerCase().replace(/[^a-z0-9@$]+$/g, "").replace(/\d+$/g, "");

// a run like "abcdefgh", "12345678" or "aaaaaaaa"
function simplePattern(p) {
  const s = p.toLowerCase();
  if (new Set(s).size <= 2) return true;
  let run = 1, best = 1;
  for (let i = 1; i < s.length; i++) {
    const step = s.charCodeAt(i) - s.charCodeAt(i - 1);
    run = Math.abs(step) === 1 && i > 1 && step === s.charCodeAt(i - 1) - s.charCodeAt(i - 2) ? run + 1 : 2;
    best = Math.max(best, run);
  }
  return best >= Math.min(s.length, 8) && s.length <= 14;
}

// returns a list of plain-language problems (empty = acceptable). `who` = { email, name } to keep the password from containing them
function problems(password, who = {}) {
  const out = [];
  if (typeof password !== "string" || !password) return ["Enter a password"];
  if (password.length < MIN_LENGTH) out.push(`Use at least ${MIN_LENGTH} characters`);
  if (password.length > MAX_LENGTH) out.push(`Use ${MAX_LENGTH} characters or fewer`);
  if (/^\s|\s$/.test(password)) out.push("Remove the spaces at the start or end");
  const need = password.length >= LONG_ENOUGH ? 2 : 3;
  if (kinds(password) < need) out.push(need === 3 ? "Mix at least 3 of: lower case, UPPER CASE, numbers and symbols (or make it 16+ characters long)" : "Mix at least 2 of: lower case, UPPER CASE, numbers and symbols");
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || COMMON.has(trimmed(password)) || COMMON.has(base(password))) out.push("This is a very common password");
  else if (password.length >= MIN_LENGTH && simplePattern(password)) out.push("Avoid repeated characters and simple runs like 12345678");
  const name = String((who.email || "")).split("@")[0].toLowerCase().replace(/[^a-z0-9]/g, "");
  if (name.length >= 4 && lower.replace(/[^a-z0-9]/g, "").includes(name)) out.push("Don't use your email name in your password");
  for (const part of String(who.name || "").toLowerCase().split(/\s+/)) {
    if (part.length >= 4 && lower.includes(part)) { out.push("Don't use your name in your password"); break; }
  }
  return out;
}

// the first problem as one sentence (what the server returns), or null when the password is fine
const firstProblem = (password, who) => { const p = problems(password, who); return p.length ? `${p[0]}. ${p.length > 1 ? "See the password tips for more." : ""}`.trim() : null; };

module.exports = { problems, firstProblem, MIN_LENGTH, MAX_LENGTH, COMMON };
