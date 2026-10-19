// auth.js — accounts, two-step login, password reset, sessions.
//
// Login is three steps so the emailed code can't be skipped:
//   1. api POST /login {email, password}     -> checks the password (no session yet), emails a code
//   2. api POST /verify-2fa {email, code}    -> marks the code as passed for the next 5 minutes
//   3. browser: Parse.User.logIn(email, password)
//      beforeLogin (below) only lets a login through if step 2 happened in the last 5 minutes,
//      so calling Parse's login directly without the code is refused.
//
// Users: username = email (lower case), plus name, role ('patient' | 'physician') and npi.
// Only Cloud Code (master key) can create or change a user, so nobody can make
// themselves a physician from the browser.

const { M, findAll, findOne, create, save, destroyAll, audit } = require("./db");
const sec = require("./security");

const CODE_TTL_MIN = 10;
const MAX_CODE_ATTEMPTS = 5;
const VERIFIED_WINDOW_MIN = 5;     // time between passing the code and logging in
const SESSION_IDLE_MIN = 30;
const SESSION_MAX_HOURS = 12;
const RESET_TTL_MIN = 15;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN15 = 15 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

const tooMany = async (key, what) =>
  ({ status: 429, error: `too many ${what} — try again in ${await sec.minutesLeft(key)} minute(s)` });

function passwordProblem(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) return `password must be at least ${MIN_PASSWORD} characters`;
  if (password.length > MAX_PASSWORD) return `password must be ${MAX_PASSWORD} characters or fewer`;
  return null;
}

// plain user object handed to the feature modules
const asUser = (u) => u && ({
  user_id: u.id, user_email: u.get("username"), user_name: u.get("name") || u.get("username"),
  role: u.get("role") || "patient", npi: u.get("npi") || null,
});

async function userByEmail(email) {
  const q = new Parse.Query(Parse.User);
  q.equalTo("username", email);
  return q.first(M);
}

// ---------- POST /register {email, name, password} ----------
async function register(body, ctx) {
  const ipKey = `register-ip:${ctx.ip}`;
  if (await sec.blocked(ipKey, 10)) return tooMany(ipKey, "sign-ups from this device");
  await sec.hit(ipKey, HOUR);
  const { email, name, password } = body;
  if (typeof email !== "string" || typeof name !== "string" || typeof password !== "string" || !email.trim() || !name.trim() || !password) {
    return { status: 400, error: "email, name, password required" };
  }
  const cleanEmail = email.toLowerCase().trim();
  const cleanName = name.trim();
  if (cleanEmail.length > 255 || !EMAIL_RE.test(cleanEmail)) return { status: 400, error: "please enter a valid email address" };
  if (cleanName.length > 255) return { status: 400, error: "name must be 255 characters or fewer" };
  const pwError = passwordProblem(password);
  if (pwError) return { status: 400, error: pwError };
  if (await userByEmail(cleanEmail)) return { status: 409, error: "email already registered" };

  const user = new Parse.User();
  user.set({ username: cleanEmail, email: cleanEmail, password, name: cleanName, role: "patient" });
  try {
    await user.signUp(null, M);
  } catch (err) {
    if (err.code === Parse.Error.USERNAME_TAKEN || err.code === Parse.Error.EMAIL_TAKEN) return { status: 409, error: "email already registered" };
    throw err;
  }
  // only the owner (and Cloud Code) can see the account; no session until they pass 2FA
  user.setACL(new Parse.ACL(user));
  await user.save(null, M);
  await endAllSessions(user.id);
  await create("MedicalRecord", { user_id: user.id, data: {} });
  await audit({ userId: user.id, event: "register", ip: ctx.ip });
  return { status: 201, ok: true };
}

// ---------- POST /login {email, password} — step 1 ----------
async function login(body, ctx) {
  const { email, password } = body;
  if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
    return { status: 400, error: "email and password required" };
  }
  const cleanEmail = email.toLowerCase().trim();
  const emailKey = `login:${cleanEmail}`, ipKey = `login-ip:${ctx.ip}`;
  if (await sec.blocked(emailKey, 5)) {
    await audit({ event: "login_locked", ip: ctx.ip, detail: { email: cleanEmail } });
    return tooMany(emailKey, "failed logins for this account");
  }
  if (await sec.blocked(ipKey, 30)) return tooMany(ipKey, "failed logins from this device");

  // checks the password without starting a session (the session comes after the code)
  let user = null;
  try {
    await Parse.User.verifyPassword(cleanEmail, password);
    user = await userByEmail(cleanEmail);
  } catch {
    user = null;
  }
  if (!user) {
    await sec.hit(emailKey, MIN15);
    await sec.hit(ipKey, MIN15);
    await audit({ event: "login_failed", ip: ctx.ip, detail: { email: cleanEmail } });
    return { status: 401, error: "invalid credentials" };
  }
  await sec.resetLimit(emailKey);

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
  if (await sec.blocked(codeKey, 10)) return tooMany(codeKey, "wrong codes for this account");
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
    await sec.hit(codeKey, MIN15);
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
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, "Enter the code from your email to log in.");
  }
  await challenge.destroy(M);
  await audit({ userId: user.id, event: "login_success", ip: request.ip });
}

// ---------- POST /forget {email} ----------
async function forget(body, ctx) {
  const { email } = body;
  if (typeof email !== "string" || !email.trim()) return { status: 400, error: "email required" };
  const message = "If that email has an account, a reset code has been sent to it.";
  const cleanEmail = email.toLowerCase().trim();
  const ipKey = `reset-ip:${ctx.ip}`, emailKey = `reset:${cleanEmail}`;
  if (await sec.blocked(ipKey, 10)) return tooMany(ipKey, "reset requests from this device");
  await sec.hit(ipKey, HOUR);
  if (await sec.blocked(emailKey, 3)) return { status: 200, message };   // same reply: reveal nothing
  await sec.hit(emailKey, HOUR);

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
  if (pwError) return { status: 400, error: pwError };
  const ipKey = `reset-code-ip:${ctx.ip}`;
  if (await sec.blocked(ipKey, 10)) return tooMany(ipKey, "wrong reset codes from this device");

  const row = await findOne("PasswordReset", { token_hash: sec.sha256(code.trim().toLowerCase()) });
  if (!row || row.get("expires_at") <= new Date()) {
    await sec.hit(ipKey, MIN15);
    return { status: 400, error: "Your code is either invalid or expired. Please try again." };
  }
  const user = await new Parse.Query(Parse.User).get(row.get("user_id"), M);
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

// Called before every logged-in api request. Ends the session after 30 idle minutes
// or 12 hours, whichever comes first. Returns the user, or null if the session is over.
async function checkSession(parseUser, sessionToken) {
  if (!parseUser || !sessionToken) return null;
  const tokenHash = sec.sha256(sessionToken);
  const now = Date.now();
  let activity = await findOne("SessionActivity", { token_hash: tokenHash });
  if (activity) {
    const idle = now - activity.get("last_seen").getTime() > SESSION_IDLE_MIN * 60000;
    const old = now - activity.get("started_at").getTime() > SESSION_MAX_HOURS * HOUR;
    if (idle || old) {
      await endSession(sessionToken);
      return null;
    }
    await save(activity, { last_seen: new Date() });
  } else {
    // first request on this session: it must have been created recently (fresh login)
    const s = await new Parse.Query(Parse.Session).equalTo("sessionToken", sessionToken).first(M);
    if (!s || now - s.createdAt.getTime() > SESSION_IDLE_MIN * 60000) {
      if (s) await s.destroy(M);
      return null;
    }
    activity = await create("SessionActivity", { token_hash: tokenHash, user_id: parseUser.id, started_at: s.createdAt, last_seen: new Date() });
  }
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

// ---------- GET /me ----------
const me = (user) => ({
  status: 200, user_id: user.user_id, email: user.user_email, name: user.user_name, role: user.role,
  ...(user.role === "physician" ? { npi: user.npi } : {}),
});

// ---------- admin: make someone a physician (master key only) ----------
// Back4app dashboard > API Console > Cloud Code functions:
//   makePhysician  {"email": "doctor@example.com", "npi": "1234567893"}   (use the Master Key)
async function makePhysician({ email, npi }) {
  const cleanEmail = String(email || "").toLowerCase().trim();
  const user = await userByEmail(cleanEmail);
  if (!user) throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, `No account with email ${cleanEmail}. Have them sign up first.`);
  const typed = String(npi || "").replace(/\s+/g, "");
  if (!sec.isValidNpi(typed)) throw new Parse.Error(Parse.Error.VALIDATION_ERROR, "That is not a valid 10-digit NPI (check digit failed).");
  const q = new Parse.Query(Parse.User);
  q.equalTo("npi", typed);
  q.notEqualTo("objectId", user.id);
  if (await q.first(M)) throw new Parse.Error(Parse.Error.DUPLICATE_VALUE, "That NPI is already on another account.");
  user.set({ role: "physician", npi: typed });
  await user.save(null, M);
  await audit({ userId: user.id, event: "made_physician", detail: { npi: typed } });
  return { ok: true, email: cleanEmail, role: "physician", npi: typed };
}

// beforeSave on users: only Cloud Code may create or change accounts
function beforeSaveUser(request) {
  if (!request.master) throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, "Accounts are changed through the app.");
}

module.exports = {
  register, login, verify2fa, beforeLogin, forget, reset, logout, me, checkSession, makePhysician,
  beforeSaveUser, endAllSessions, asUser, userByEmail, SESSION_IDLE_MIN,
};
