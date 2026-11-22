// serverSettings.js — reads the Parse Server's own security settings, so we can check them after a deploy, and unlocks
// an account after a password reset.
//
// Account lockout, the password policy and the session settings are Parse Server options. On Back4app they are set in
// the dashboard (App Settings > Server Settings > Parse Server Options); locally in Parse/local/local-server.js.
// The verifySettings function (main.js) compares what the server is really running with EXPECTED below.
//
// Parse doesn't give Cloud Code these options through its normal SDK, so this reads parse-server's own Config, the same
// object Parse uses. Parse Server is loaded from the folder of the program that started it (Back4app's server, or
// local-server.js). If that ever fails, verifySettings says it couldn't read the settings instead of guessing, and a
// password reset still works (the lockout then just runs out on its own).

const password = require("./password");

const EXPECTED = {
  accountLockout: { threshold: 5, duration: 15, unlockOnPasswordReset: true },
  passwordPolicy: { validatorPattern: password.PARSE_POLICY_PATTERN, doNotAllowUsername: true, maxPasswordHistory: 5 },
  sessionLength: 12 * 60 * 60,   // seconds; the app itself also ends a session after 12 hours or 30 idle minutes
  expireInactiveSessions: true,
  allowClientClassCreation: false,
  enableAnonymousUsers: false,
};

// parse-server's internal modules, found from the program that started the server (null if they can't be loaded)
function parseServerModule(name) {
  const roots = [require.main && require.main.path, process.cwd(), __dirname].filter(Boolean);
  try {
    return require(require.resolve(`parse-server/lib/${name}`, { paths: roots }));
  } catch {
    return null;
  }
}

function serverConfig() {
  const mod = parseServerModule("Config");
  const Config = mod && (mod.default || mod);
  try {
    return Config && typeof Config.get === "function" ? Config.get(Parse.applicationId) || null : null;
  } catch {
    return null;
  }
}

// After a password reset: clear Parse's failed-login count, so the patient can log in with the new password right away.
// Only when the server has accountLockout.unlockOnPasswordReset on (the same rule Parse uses for its own reset emails).
async function unlockAccount(username) {
  const config = serverConfig();
  const lockout = config && config.accountLockout;
  if (!lockout || !lockout.unlockOnPasswordReset || !config.database || !username) return false;
  await config.database.update("_User", { username }, {
    _failed_login_count: { __op: "Delete" },
    _account_lockout_expires_at: { __op: "Delete" },
  });
  return true;
}

// What the server is really running, compared with EXPECTED. {ok: true, problems: []} means everything matches.
function checkSettings() {
  const config = serverConfig();
  if (!config) {
    return { ok: false, problems: ["could not read the Parse Server settings from Cloud Code on this server; check them by hand in the dashboard"] };
  }
  const problems = [];
  const lock = config.accountLockout || null;
  const want = EXPECTED.accountLockout;
  if (!lock) problems.push("account lockout is off");
  else {
    if (!(lock.threshold > 0 && lock.threshold <= want.threshold)) problems.push(`account lockout threshold is ${lock.threshold}, should be ${want.threshold} or less`);
    if (!(lock.duration >= want.duration)) problems.push(`account lockout duration is ${lock.duration} minute(s), should be at least ${want.duration}`);
    if (lock.unlockOnPasswordReset !== true) problems.push("account lockout: unlock on password reset is off");
  }
  const policy = config.passwordPolicy || null;
  const wantPolicy = EXPECTED.passwordPolicy;
  if (!policy) problems.push("password policy is off");
  else {
    const pattern = policy.validatorPattern instanceof RegExp ? policy.validatorPattern.source : policy.validatorPattern;
    if (!pattern) problems.push("password policy has no validator pattern");
    else if (String(pattern) !== wantPolicy.validatorPattern) problems.push("password policy pattern is not the one in password.js (PARSE_POLICY_PATTERN)");
    if (policy.doNotAllowUsername !== true) problems.push("password policy: do not allow username is off");
    if (!(policy.maxPasswordHistory >= wantPolicy.maxPasswordHistory)) problems.push(`password history is ${policy.maxPasswordHistory || 0}, should be at least ${wantPolicy.maxPasswordHistory}`);
  }
  if (!(config.sessionLength > 0 && config.sessionLength <= EXPECTED.sessionLength)) problems.push(`session length is ${config.sessionLength} seconds, should be ${EXPECTED.sessionLength} or less`);
  if (config.expireInactiveSessions !== true) problems.push("expire inactive sessions is off");
  if (config.allowClientClassCreation !== false) problems.push("client class creation is on");
  if (config.enableAnonymousUsers !== false) problems.push("anonymous users are on");

  return {
    ok: problems.length === 0,
    problems,
    settings: {
      accountLockout: lock && { threshold: lock.threshold, duration: lock.duration, unlockOnPasswordReset: lock.unlockOnPasswordReset === true },
      passwordPolicy: policy && { hasPattern: !!policy.validatorPattern, doNotAllowUsername: policy.doNotAllowUsername === true, maxPasswordHistory: policy.maxPasswordHistory || 0 },
      sessionLength: config.sessionLength,
      expireInactiveSessions: config.expireInactiveSessions,
      allowClientClassCreation: config.allowClientClassCreation,
      enableAnonymousUsers: config.enableAnonymousUsers,
    },
  };
}

module.exports = { EXPECTED, serverConfig, unlockAccount, checkSettings };
