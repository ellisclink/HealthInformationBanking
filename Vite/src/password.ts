// password.ts — the password rules, shown live while someone types.
// KEEP IN STEP WITH Parse/cloud/lib/password.js: that file is the one the server enforces. This copy only gives instant feedback.

export const MIN_LENGTH = 10;
export const MAX_LENGTH = 128;
const LONG_ENOUGH = 16;

const COMMON = new Set(("password passw0rd p@ssword p@ssw0rd 123456 1234567 12345678 123456789 1234567890 12345 111111 000000 123123 654321 qwerty qwerty123 qwertyuiop " +
  "qwerty1 1q2w3e4r 1qaz2wsx qazwsx abc123 abcd1234 letmein welcome welcome1 admin administrator login master dragon monkey shadow sunshine princess football baseball " +
  "iloveyou trustno1 superman batman starwars whatever freedom hello hello123 charlie donald michael jordan harley ranger summer winter spring autumn secret changeme " +
  "default test test123 guest user health healthy medical medicine doctor patient hospital nurse hib healthinformationbanking passwords password1 password12 password123").split(" "));

const kinds = (p: string) => [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(p)).length;
const base = (p: string) => p.toLowerCase().replace(/@/g, "a").replace(/0/g, "o").replace(/1/g, "i").replace(/3/g, "e").replace(/\$/g, "s").replace(/5/g, "s").replace(/[^a-z]/g, "");
const trimmed = (p: string) => p.toLowerCase().replace(/[^a-z0-9@$]+$/g, "").replace(/\d+$/g, "");

function simplePattern(p: string) {
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

export type Check = { label: string; ok: boolean };
export type Strength = { checks: Check[]; ok: boolean; level: 0 | 1 | 2 | 3 | 4; text: string };

export function checkPassword(password: string, who: { email?: string; name?: string } = {}): Strength {
  const lower = password.toLowerCase();
  const need = password.length >= LONG_ENOUGH ? 2 : 3;
  const emailName = (who.email || "").split("@")[0].toLowerCase().replace(/[^a-z0-9]/g, "");
  const hasName = (emailName.length >= 4 && lower.replace(/[^a-z0-9]/g, "").includes(emailName)) ||
    (who.name || "").toLowerCase().split(/\s+/).some((part) => part.length >= 4 && lower.includes(part));
  const common = COMMON.has(lower) || COMMON.has(trimmed(password)) || COMMON.has(base(password));
  const checks: Check[] = [
    { label: `At least ${MIN_LENGTH} characters`, ok: password.length >= MIN_LENGTH && password.length <= MAX_LENGTH },
    { label: need === 3 ? "Mix of 3: lower case, UPPER CASE, numbers, symbols (or 16+ characters)" : "Mix of 2 kinds of character", ok: kinds(password) >= need },
    { label: "Not a very common password", ok: password.length > 0 && !common },
    { label: "No repeated characters or simple runs (12345678)", ok: password.length > 0 && !(password.length >= MIN_LENGTH && simplePattern(password)) },
    { label: "Doesn't contain your name or email", ok: password.length > 0 && !hasName },
  ];
  const passed = checks.filter((c) => c.ok).length;
  const ok = passed === checks.length && !/^\s|\s$/.test(password);
  let level: Strength["level"] = 0, text = "";
  if (password) {
    if (!ok) { level = passed >= 4 ? 2 : 1; text = level === 1 ? "Too weak" : "Almost there"; }
    else if (password.length >= 20) { level = 4; text = "Very strong"; }
    else if (password.length >= 14) { level = 3; text = "Strong"; }
    else { level = 2; text = "Acceptable"; }
  }
  return { checks, ok, level, text };
}
