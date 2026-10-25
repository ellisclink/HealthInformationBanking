// legal.js — which version of the Terms of Service and Privacy Policy is in force, and who has accepted it.
//
// The text of both documents is in the website (Vite/src/legal.ts and the Terms / Privacy pages). When you change either one in a way a
// user must agree to again, change the version here AND in Vite/src/legal.ts. Every account that accepted an older version is then asked
// to accept the new one the next time they open the app (see GET /me and POST /account/accept-terms).
//
// What is stored, per account (fields on the user, see setup.js): terms_version, terms_accepted_at. The audit log also gets a
// "terms_accepted" entry, so there is a dated record of every acceptance.

const TERMS_VERSION = "2026-10-25";            // the Terms of Service and Privacy Policy are versioned together
const MIN_AGE = 18;

// the user fields to save when someone accepts the current version
const acceptanceFields = (now = new Date()) => ({ terms_version: TERMS_VERSION, terms_accepted_at: now });

// what GET /me tells the website (acceptedVersion = the version stored on the account, or nothing)
function status(acceptedVersion) {
  const accepted = acceptedVersion || null;
  return { current_version: TERMS_VERSION, accepted_version: accepted, needs_acceptance: accepted !== TERMS_VERSION };
}

module.exports = { TERMS_VERSION, MIN_AGE, acceptanceFields, status };
