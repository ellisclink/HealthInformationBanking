// auth.js — accounts, two-step login, password reset, sessions.
//
// Login is three steps so the emailed code can't be skipped:
//   1. api POST /login {email, password}     -> checks the password (no session yet), emails a code
//   2. api POST /verify-2fa {email, code}    -> marks the code as passed for the next 5 minutes
//   3. browser: Parse.User.logIn(email, password)
//      beforeLogin (below) only lets a login through if step 2 happened in the last 5 minutes,
//      so calling Parse's login directly without the code is refused.
//      afterLogin then makes the SessionActivity row; checkSession refuses any session without one.
//
// Rate limits: every attempt is counted BEFORE it is checked (sec.take) and given back when it turns out to be fine
// (sec.refund / sec.resetLimit). Checking first and counting afterwards lets many guesses sent at the same moment all
// get through. Parse's own /login is not covered by these limits: turn on Parse's account lockout too (see the README).
//
// Users: username = email (lower case), plus name and role. Every account is a patient (physician accounts were
// removed on 2026-11-06; the convertPhysicians job in main.js turns old ones into patients). Old rows may still have
// an npi column; nothing reads it any more.
// A browser may CREATE an account with Parse's signUp (Register page), but only with the fields beforeSaveUser allows:
// it always becomes a patient, with the terms recorded, and gets no usable session (afterSaveUser). Only Cloud Code
// (master key) can change a user, so nobody can give themselves another role from the browser.

const { M, findAll, findOne, create, save, destroyAll, audit } = require("./db");
const sec = require("./security");
const legal = require("./legal");
const password = require("./password");
const { clientIp } = require("./clientip");

const CODE_TTL_MIN = 10;
const MAX_CODE_ATTEMPTS = 5;
const VERIFIED_WINDOW_MIN = 5;     // time between passing the code and logging in
const SESSION_IDLE_MIN = 30;
const SESSION_MAX_HOURS = 12;
const RESET_TTL_MIN = 15;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN15 = 15 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

const tooMany = async (key, what) =>
  ({ status: 429, error: `too many ${what} — try again in ${await sec.minutesLeft(key)} minute(s)` });

// the rules are in password.js; `who` keeps the password from containing the person's email name or name
const passwordProblem = (pw, who) => password.firstProblem(pw, who);

// plain user object handed to the feature modules
const asUser = (u) => u && ({
  user_id: u.id, user_email: u.get("username"), user_name: u.get("name") || u.get("username"),
  role: u.get("role") || "patient", terms_version: u.get("terms_version") || null,
});

async function userByEmail(email) {
  const q = new Parse.Query(Parse.User);
  q.equalTo("username", email);
  return q.first(M);
}

// ---------- sign-up: the browser calls Parse's own signUp (Register page) ----------
// beforeSaveUser (below) checks and completes the new account before Parse stores it; afterSaveUser then revokes the
// session signUp hands out (the only way in is login + emailed code), confirms the owner-only ACL, creates the
// MedicalRecord and writes the audit rows. Nothing a browser sends can pick the role or skip the terms.
const SIGNUP_FIELDS = new Set(["username", "email", "password", "name", "accepted_terms", "ACL"]);
const invalid = (message) => new Parse.Error(Parse.Error.VALIDATION_ERROR, message);

async function checkSignUp(request) {
  const user = request.object;
  // counted first: 10 sign-ups an hour per device (every attempt counts, as the old POST /register did).
  // The address is chosen the same way as for the api function (clientip.js, TRUSTED_PROXY_HOPS).
  const ipKey = `register-ip:${clientIp(request)}`;
  if ((await sec.take(ipKey, HOUR)) > 10) {
    throw new Parse.Error(Parse.Error.REQUEST_LIMIT_EXCEEDED, `too many sign-ups from this device — try again in ${await sec.minutesLeft(ipKey)} minute(s)`);
  }
  const sent = new Set([...Object.keys(user.attributes || {}), ...user.dirtyKeys()]);
  for (const key of sent) if (!SIGNUP_FIELDS.has(key)) throw invalid(`unknown field: ${key}`);

  const email = user.get("email"), name = user.get("name"), password = user.get("password");
  if (typeof email !== "string" || typeof name !== "string" || typeof password !== "string" || !email.trim() || !name.trim() || !password) {
    throw invalid("email, name, password required");
  }
  // agreeing to the Terms and Privacy Policy (and being 18 or older) is required, and is recorded with the account
  if (user.get("accepted_terms") !== true) throw invalid(`you must agree to the Terms of Service and Privacy Policy, and confirm you are ${legal.MIN_AGE} or older`);
  const cleanEmail = email.toLowerCase().trim();
  const cleanName = name.trim();
  if (cleanEmail.length > 255 || !EMAIL_RE.test(cleanEmail)) throw invalid("please enter a valid email address");
  if (cleanName.length > 255) throw invalid("name must be 255 characters or fewer");
  const pwError = passwordProblem(password, { email: cleanEmail, name: cleanName });
  if (pwError) throw invalid(`Choose a stronger password. ${pwError}`);
  if (await userByEmail(cleanEmail)) throw new Parse.Error(Parse.Error.EMAIL_TAKEN, "email already registered");

  // every account is a patient; the username is the email
  user.set({ username: cleanEmail, email: cleanEmail, name: cleanName, role: "patient", ...legal.acceptanceFields() });
  user.unset("accepted_terms");
  // nobody but the master key; Parse then adds the new user itself (read + write), so the stored ACL is owner-only
  user.setACL(new Parse.ACL());
}

// beforeSave on users: a browser may only CREATE an account (checked above); every change goes through Cloud Code
async function beforeSaveUser(request) {
  if (request.master) return;
  if (request.original || request.object.id) throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, "Accounts are changed through the app.");
  await checkSignUp(request);
}

// afterSave on users: a browser sign-up leaves no usable session. Parse waits for this trigger but only LOGS an error
// from it, so every step is tried on its own (one failing does not skip the others) and each failure is logged. The
// session signUp made is ended first; checkSession refuses it anyway, because only afterLogin starts a session.
async function afterSaveUser(request) {
  if (request.master || request.original) return;
  const user = request.object;
  const ip = clientIp(request);
  const step = async (name, fn) => {
    try { await fn(); } catch (err) { console.error(`sign-up ${user.id}: ${name} failed:`, err && err.message ? err.message : "error"); }
  };
  await step("ending the sign-up session", () => endAllSessions(user.id, "signup", ip));   // first: the token signUp returned stops working
  await step("setting the owner-only ACL", async () => { user.setACL(new Parse.ACL(user)); await user.save(null, M); });
  await step("creating the MedicalRecord", async () => {   // only if there isn't one yet
    if (!(await findOne("MedicalRecord", { user_id: user.id }))) await create("MedicalRecord", { user_id: user.id, data: {} });
  });
  await step("the register audit row", () => audit({ userId: user.id, event: "register", ip }));
  await step("the terms audit row", () => audit({ userId: user.id, event: "terms_accepted", ip, detail: { version: legal.TERMS_VERSION } }));
}

// ---------- POST /login {email, password} — step 1 ----------
async function login(body, ctx) {
  const { email, password } = body;
  if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
    return { status: 400, error: "email and password required" };
  }
  const cleanEmail = email.toLowerCase().trim();
  const emailKey = `login:${cleanEmail}`, ipKey = `login-ip:${ctx.ip}`;
  // Count this attempt first, then check the password. Limits are the same as before: 5 wrong passwords per account and
  // 30 per device in 15 minutes. A correct password gives its counts back below.
  if ((await sec.take(ipKey, MIN15)) > 30) return tooMany(ipKey, "failed logins from this device");
  if ((await sec.take(emailKey, MIN15)) > 5) {
    await sec.refund(ipKey);   // this attempt did nothing, so it should not use up the device's allowance
    await audit({ event: "login_locked", ip: ctx.ip, detail: { email: cleanEmail } });
    return tooMany(emailKey, "failed logins for this account");
  }

  // checks the password without starting a session (the session comes after the code)
  let user = null;
  try {
    await Parse.User.verifyPassword(cleanEmail, password);
    user = await userByEmail(cleanEmail);
  } catch {
    user = null;
  }
  if (!user) {
    // already counted above
    await audit({ event: "login_failed", ip: ctx.ip, detail: { email: cleanEmail } });
    return { status: 401, error: "invalid credentials" };
  }
  await sec.resetLimit(emailKey);
  await sec.refund(ipKey);

  // replace any earlier code with a fresh one
  await destroyAll(await findAll("LoginChallenge", { user_id: user.id }));
  const code = sec.new2faCode();
  await create("LoginChallenge", {
    user_id: user.id, code_hash: sec.hashCode(code), attempts: 0,
    expires_at: new Date(Date.now() + CODE_TTL_MIN * 60000),
  });
  await sec.sendEmail(cleanEmail, "Your Health Information Banking verification code",
    `Your verification code is ${code}. It expires in ${CODE_TTL_MIN} minutes.\nIf you didn't try to log in, you can ignore this email.`,
    "2FA code");
  await audit({ userId: user.id, event: "login_password_ok", ip: ctx.ip });
  return { status: 200, twoFactorRequired: true, message: "code sent to your email", ...(sec.showCodes() ? { dev_code: code } : {}) };
}

// ---------- POST /verify-2fa {email, code} — step 2 ----------
async function verify2fa(body, ctx) {
  const { email, code } = body;
  if (typeof email !== "string" || !email || (typeof code !== "string" && typeof code !== "number") || code === "") {
    return { status: 400, error: "email and code required" };
  }
  const cleanEmail = email.toLowerCase().trim();
  const codeKey = `code:${cleanEmail}`;
  // counted first (10 tries per account in 15 minutes); a correct code clears the count below
  if ((await sec.take(codeKey, MIN15)) > 10) return tooMany(codeKey, "wrong codes for this account");
  const user = await userByEmail(cleanEmail);
  if (!user) return { status: 401, error: "invalid code" };

  const challenge = await findOne("LoginChallenge", { user_id: user.id });
  if (!challenge || challenge.get("expires_at") <= new Date() || challenge.get("verified_at")) {
    return { status: 401, error: "no active code — log in again to get a new one" };
  }
  if (challenge.get("attempts") >= MAX_CODE_ATTEMPTS) {
    await challenge.destroy(M);
    return { status: 429, error: "too many attempts — log in again to get a new code" };
  }
  if (!sec.checkCode(String(code).trim(), challenge.get("code_hash"))) {
    await audit({ userId: user.id, event: "login_code_failed", ip: ctx.ip });
    challenge.increment("attempts");
    await challenge.save(null, M);
    const left = MAX_CODE_ATTEMPTS - challenge.get("attempts");
    if (left <= 0) {
      await challenge.destroy(M);
      return { status: 429, error: "too many attempts — log in again to get a new code" };
    }
    return { status: 401, error: `invalid code — ${left} attempt(s) remaining` };
  }
  await sec.resetLimit(codeKey);
  await save(challenge, { verified_at: new Date() });
  await audit({ userId: user.id, event: "login_code_ok", ip: ctx.ip });
  return {
    status: 200, verified: true, role: user.get("role") || "patient", name: user.get("name"),
    expiresInHours: SESSION_MAX_HOURS, idleTimeoutMinutes: SESSION_IDLE_MIN,
  };
}

// beforeLogin: step 3 is only allowed right after a passed code (consumes it)
async function beforeLogin(request) {
  const user = request.object;
  const challenge = await findOne("LoginChallenge", { user_id: user.id });
  const verifiedAt = challenge && challenge.get("verified_at");
  if (!verifiedAt || Date.now() - verifiedAt.getTime() > VERIFIED_WINDOW_MIN * 60000) {
    // The same text and code Parse itself gives for a wrong password. A different message here would tell someone calling
    // Parse's /login directly that the password they tried was right.
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, "Invalid username/password.");
  }
  await challenge.destroy(M);
  await audit({ userId: user.id, event: "login_success", ip: request.ip });
}

// afterLogin: the ONLY place a session's SessionActivity row is made. Parse has just created the session for this login
// (after beforeLogin passed) and its token is on request.object. checkSession refuses any session without a row, so a
// session made any other way (Parse's public POST /sessions, which anyone holding a token can call, or the session
// signUp hands out) never works. If this fails, Parse answers the login with an error and the session is refused on use.
async function afterLogin(request) {
  const user = request.object;
  const token = user && typeof user.getSessionToken === "function" ? user.getSessionToken() : null;
  if (!user || !user.id || !token) throw new Parse.Error(Parse.Error.OTHER_CAUSE, "The login could not be completed; please try again.");
  const now = new Date();
  await create("SessionActivity", { token_hash: sec.sha256(token), user_id: user.id, started_at: now, last_seen: now });
}

// ---------- POST /forget {email} ----------
async function forget(body, ctx) {
  const { email } = body;
  if (typeof email !== "string" || !email.trim()) return { status: 400, error: "email required" };
  const message = "If that email has an account, a reset code has been sent to it.";
  const cleanEmail = email.toLowerCase().trim();
  const ipKey = `reset-ip:${ctx.ip}`, emailKey = `reset:${cleanEmail}`;
  if ((await sec.take(ipKey, HOUR)) > 10) return tooMany(ipKey, "reset requests from this device");   // 10 an hour per device
  if ((await sec.take(emailKey, HOUR)) > 3) return { status: 200, message };   // 3 an hour per account; same reply: reveal nothing

  const user = await userByEmail(cleanEmail);
  if (!user) return { status: 200, message };
  await destroyAll(await findAll("PasswordReset", { user_id: user.id }));
  const code = sec.newResetCode();
  await create("PasswordReset", { user_id: user.id, token_hash: sec.sha256(code), expires_at: new Date(Date.now() + RESET_TTL_MIN * 60000) });
  await sec.sendEmail(cleanEmail, "Reset your Health Information Banking password",
    `Your password reset code is ${code}. It expires in ${RESET_TTL_MIN} minutes.\nIf you didn't ask to reset your password, you can ignore this email.`,
    "password reset code");
  await audit({ userId: user.id, event: "password_reset_requested", ip: ctx.ip });
  return { status: 200, message, ...(sec.showCodes() ? { dev_code: code } : {}) };
}

// ---------- POST /reset {code, newPassword} ----------
async function reset(body, ctx) {
  const { code, newPassword } = body;
  if (typeof code !== "string" || !code.trim() || typeof newPassword !== "string") {
    return { status: 400, error: "code and newPassword required" };
  }
  const pwError = passwordProblem(newPassword);
  if (pwError) return { status: 400, error: `Choose a stronger password. ${pwError}` };
  const ipKey = `reset-code-ip:${ctx.ip}`;
  // counted first (10 tries per device in 15 minutes); a real code gives its count back
  if ((await sec.take(ipKey, MIN15)) > 10) return tooMany(ipKey, "wrong reset codes from this device");

  const row = await findOne("PasswordReset", { token_hash: sec.sha256(code.trim().toLowerCase()) });
  if (!row || row.get("expires_at") <= new Date()) {
    return { status: 400, error: "Your code is either invalid or expired. Please try again." };   // already counted
  }
  await sec.refund(ipKey);
  const user = await new Parse.Query(Parse.User).get(row.get("user_id"), M);
  const whoPw = passwordProblem(newPassword, { email: user.get("username"), name: user.get("name") });
  if (whoPw) return { status: 400, error: `Choose a stronger password. ${whoPw}` };
  // Order matters. Calendar subscribe links work without a session, so they are revoked and every session is ended
  // BEFORE the password changes; then sessions are ended once more (in case one was started with the old password in
  // between); the reset code is used up only at the very end. If any step fails the reset answers 500 and the code
  // still works, so the patient can simply try again. A failure before the password is saved leaves it unchanged.
  const failed = (step, err) => {
    console.error(`password reset: ${step} failed:`, err && err.message ? err.message : "error");
    return { status: 500, error: "Your password could not be reset right now. Please try again in a few minutes." };
  };
  try {
    await require("./calendarFeed").revokeAllForUser(user.id, "password_reset", ctx.ip);
    await endAllSessions(user.id, "password_reset", ctx.ip);   // logs out everywhere and revokes links again
  } catch (err) {
    return failed("ending sessions and calendar links", err);
  }
  try {
    user.setPassword(newPassword);
    await user.save(null, M);
    await endAllSessions(user.id, "password_reset", ctx.ip);
  } catch (err) {
    return failed("saving the new password", err);
  }
  await row.destroy(M);
  await destroyAll(await findAll("LoginChallenge", { user_id: user.id }));
  await audit({ userId: user.id, event: "password_reset_done", ip: ctx.ip });
  return { status: 200, message: "Your password has been reset. You can log in now." };
}

// ---------- sessions ----------
// Logs the user out everywhere and revokes their calendar subscribe links (D-016), which work without a session.
async function endAllSessions(userId, reason = "sessions_ended", ip = null) {
  const q = new Parse.Query(Parse.Session);
  q.equalTo("user", Parse.User.createWithoutData(userId));
  await destroyAll(await q.find(M));
  await destroyAll(await findAll("SessionActivity", { user_id: userId }));
  await require("./calendarFeed").revokeAllForUser(userId, reason, ip);
}

// Called before every logged-in api request (and by access.js for the owner classes). Ends the session after 30 idle
// minutes or 12 hours, whichever comes first. Returns the user, or null if the session is over.
// A session counts only if it has a SessionActivity row, and only afterLogin (a real login, after the emailed code)
// makes one. A token with no row (a session minted with Parse's POST /sessions, the session signUp returns, or one
// already ended) is refused and its _Session deleted. A row is never created here.
async function checkSession(parseUser, sessionToken) {
  if (!parseUser || !sessionToken) return null;
  const now = Date.now();
  const activity = await findOne("SessionActivity", { token_hash: sec.sha256(sessionToken) });
  if (!activity || activity.get("user_id") !== parseUser.id) {
    await endSession(sessionToken);
    return null;
  }
  const idle = now - activity.get("last_seen").getTime() > SESSION_IDLE_MIN * 60000;
  const old = now - activity.get("started_at").getTime() > SESSION_MAX_HOURS * HOUR;
  if (idle || old) {
    await endSession(sessionToken);
    return null;
  }
  await save(activity, { last_seen: new Date() });
  return asUser(parseUser);
}

async function endSession(sessionToken) {
  const s = await new Parse.Query(Parse.Session).equalTo("sessionToken", sessionToken).first(M);
  if (s) await s.destroy(M);
  const a = await findOne("SessionActivity", { token_hash: sec.sha256(sessionToken) });
  if (a) await a.destroy(M);
}

// ---------- POST /logout ----------
async function logout(ctx) {
  if (ctx.sessionToken) {
    if (ctx.user) await audit({ userId: ctx.user.user_id, event: "logout", ip: ctx.ip });
    await endSession(ctx.sessionToken);
  }
  return { status: 200, ok: true };
}

// afterLogout (Parse.User.logOut in the browser): Parse has already deleted the session; write the "logout" audit row
// and end SessionActivity for that token, the same as POST /logout
async function afterLogout(request) {
  const session = request.object;
  const token = session && session.get("sessionToken");
  const user = session && session.get("user");
  if (user && user.id) await audit({ userId: user.id, event: "logout", ip: clientIp(request) });
  if (token) await endSession(token);
}

// ---------- GET /me ----------
const me = (user) => ({
  status: 200, user_id: user.user_id, email: user.user_email, name: user.user_name, role: user.role,
  terms: legal.status(user.terms_version),
});

// ---------- job convertPhysicians (master key; run once after deploying) ----------
// There are no physician accounts any more: every account that is not a plain patient (role "physician", any other
// role, or an old npi value) becomes a patient with no npi. Each change is audited ("role_cleared"). Safe to repeat.
async function convertPhysicians() {
  let converted = 0;
  for (;;) {
    const notPatient = new Parse.Query(Parse.User).notEqualTo("role", "patient");
    const hasNpi = new Parse.Query(Parse.User).exists("npi");
    const rows = await Parse.Query.or(notPatient, hasNpi).limit(500).find(M);
    if (!rows.length) break;
    for (const u of rows) {
      const oldRole = u.get("role") ?? null;
      u.set("role", "patient");
      u.unset("npi");
      await u.save(null, M);
      await audit({ userId: u.id, event: "role_cleared", detail: { old_role: oldRole } });
      converted++;
    }
  }
  return { converted };
}

module.exports = {
  login, verify2fa, beforeLogin, afterLogin, forget, reset, logout, afterLogout, me, checkSession,
  beforeSaveUser, afterSaveUser, convertPhysicians, endAllSessions, asUser, userByEmail, SESSION_IDLE_MIN,
};
