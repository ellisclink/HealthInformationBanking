// router.js — the `api` Cloud Function: one entry point for what must run on the server.
//
//   Parse.Cloud.run("api", { method: "GET", path: "/calendar/feed-tokens", query: {...}, body: {...} })
//
// Returns { status, ...payload } (status 4xx/5xx = error, with `error` explaining it).
// Every account is a patient (there are no physician accounts); patient-data routes still refuse any other role.
// Other people see a patient's data only through a sharing code (read-only) or the emergency code.
//
// Only these stay here, because each needs a server secret, another user's data, the drug reference, a locked class
// or the master key: login / 2FA / password reset, /me, the account (export, deletion, terms), share codes and the
// shared view, the emergency code / its access log / the responder view, calendar subscribe links, the USDA food
// search, documents (encrypted files) and the PDF auto-fill, lab PDF reports (encrypted), the medication safety
// check / recheck (they write SafetyAlert rows), the C-CDA import and the notification sweep (it writes Notification
// rows). Everything else (the setup.js OWNER_CLASSES) is read and written by the website with the Parse SDK
// (Vite/src/data/*.ts), guarded per class by the RULES in access.js.

const auth = require("./auth");
const records = require("./records");
const vitals = require("./vitals");   // only for the shared view (records.openShared: the vitals summary)
const calendarFeed = require("./calendarFeed");
const nutrition = require("./nutrition");
const labs = require("./labs");
const safety = require("./safety");
const documents = require("./documents");
const notifications = require("./notifications");
const ccdaApi = require("./ccdaApi");
const emergency = require("./emergency");
const autofill = require("./autofill");
const account = require("./account");

const PATIENT_ONLY = ["share", "calendar", "nutrition", "labs", "safety", "documents", "notifications", "emergency"];
const notFound = () => ({ status: 404, error: "unknown endpoint" });

async function route({ method, path, query, body }, ctx) {
  const m = String(method || "GET").toUpperCase();
  const p = String(path || "").split("?")[0];
  const parts = p.split("/").filter(Boolean);   // ["calendar", id?, sub?]
  const [section, id, sub, extra] = parts;
  body = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  query = query && typeof query === "object" ? query : {};

  // ---- no login needed ----
  // (sign-up is Parse's own signUp from the Register page, checked by auth.beforeSaveUser; there is no /register here)
  if (m === "POST" && p === "/login") return auth.login(body, ctx);
  if (m === "POST" && p === "/verify-2fa") return auth.verify2fa(body, ctx);
  if (m === "POST" && p === "/forget") return auth.forget(body, ctx);
  if (m === "POST" && p === "/reset") return auth.reset(body, ctx);
  if (m === "POST" && p === "/logout") return auth.logout(ctx);
  // sharing codes need no login (an old provider code is refused inside)
  if (m === "POST" && section === "shared" && id && parts.length === 2) return records.openShared(id, body, ctx.user, ctx, { vitals });

  // emergency responders have no account; the code is the key (rate-limited, logged, and the patient is told)
  if (m === "POST" && section === "emergency-access" && id) {
    if (parts.length === 2) return emergency.respond(id, body, ctx);
    if (parts.length === 3 && sub === "document") return emergency.respondDocument(id, body, ctx);
    return notFound();
  }

  // ---- everything below needs a live session ----
  const user = ctx.user;
  if (!user) return { status: 401, error: "authentication required" };
  if (m === "GET" && p === "/me") return auth.me(user);
  if (PATIENT_ONLY.includes(section) && user.role !== "patient") {
    return { status: 403, error: "this is for patient accounts" };
  }

  // the account itself: any role (an account can always export or delete its own login)
  if (section === "account") {
    if (parts.length === 2 && id === "export" && m === "POST") return account.exportData(body, user, ctx);
    if (parts.length === 2 && id === "accept-terms" && m === "POST") return account.acceptTerms(body, user, ctx);
    if (parts.length === 2 && id === "deletion") {
      if (m === "GET") return account.deletionStatus(user);
      if (m === "POST") return account.requestDeletion(body, user, ctx);
      if (m === "DELETE") return account.cancelDeletion(user, ctx);
    }
    return notFound();
  }

  switch (section) {
    case "share":
      // share codes link to this patient's data for someone without an account
      if (parts.length === 1 && m === "POST") return records.createShare(body, user, ctx);
      if (parts.length === 1 && m === "GET") return records.listShares(user);
      if (id === "access-log" && parts.length === 2 && m === "GET") return records.listAccessLog(user);
      if (id && parts.length === 2 && m === "DELETE") return records.revokeShare(id, user, ctx);
      return notFound();

    case "calendar":
      // only the subscribe links (D-016); the feed itself is a plain web route, not part of api (see calendarFeed.js)
      if (id === "feed-tokens" && parts.length === 2 && m === "GET") return calendarFeed.listTokens(user);
      if (id === "feed-tokens" && parts.length === 2 && m === "POST") return calendarFeed.createToken(body, user, ctx);
      if (id === "feed-tokens" && parts.length === 3 && m === "DELETE") return calendarFeed.revokeToken(sub, user, ctx);
      return notFound();

    case "nutrition":
      // only the USDA search (it needs the server's USDA key)
      if (id === "search" && !sub && m === "POST") return nutrition.search(body);
      return notFound();

    case "labs":
      // only the PDF reports (stored encrypted)
      if (parts.length > 4) return notFound();
      if (id === "reports") {
        if (!sub && m === "GET") return labs.listReports(user);
        if (!sub && m === "POST") return labs.uploadReport({ ...query, ...body }, user);
        if (sub && !extra && m === "GET") return labs.getReport(sub, user);
        if (sub && !extra && m === "PUT") return labs.updateReport(sub, body, user);
        if (sub && !extra && m === "DELETE") return labs.deleteReport(sub, user);
        if (sub && extra === "file" && m === "GET") return labs.getReportFile(sub, user);
      }
      return notFound();

    case "safety":
      // the checks against the drug reference (they write SafetyAlert rows, which only the server may do)
      if (id === "recheck" && !sub && m === "POST") return safety.recheck(user);
      if (id === "check" && !sub && m === "POST") return safety.check(body, user);
      return notFound();

    case "documents":
      // encrypted files. PDF auto-fill (7-2): "autofill" is checked first so it is never read as a document id
      if (id === "autofill") {
        if (parts.length === 2 && m === "POST") return autofill.extract(body, user, ctx);
        if (parts.length === 3 && m === "GET") return autofill.getDraft(sub, user);
        if (parts.length === 3 && m === "DELETE") return autofill.cancel(sub, user, ctx);
        if (parts.length === 4 && extra === "confirm" && m === "POST") return autofill.confirm(sub, body, user, ctx);
        return notFound();
      }
      if (parts.length > 3) return notFound();
      if (!id) {
        if (m === "GET") return documents.list(query, user);
        if (m === "POST") return documents.upload({ ...query, ...body }, user, ctx);
      } else if (!sub) {
        if (m === "GET") return documents.getById(id, user);
        if (m === "PUT") return documents.update(id, body, user, ctx);
        if (m === "DELETE") return documents.remove(id, user, ctx);
      } else if (sub === "file" && m === "GET") {
        return documents.getFile(id, user, ctx);
      }
      return notFound();

    case "emergency":
      // only the code (EmergencyAccess stays locked) and the access log; the responder view is /emergency-access above
      if (parts.length === 2 && id === "code") {
        if (m === "GET") return emergency.codeStatus(user);
        if (m === "POST") return emergency.createCode(user, ctx);
        if (m === "DELETE") return emergency.revokeCode(user, ctx);
      }
      if (parts.length === 2 && id === "access-log" && m === "GET") return emergency.accessLog(user);
      return notFound();

    case "ccda":
      if (parts.length !== 2 || m !== "POST") return notFound();
      if (id === "preview") return ccdaApi.preview(body, user, ctx);
      if (id === "import") return ccdaApi.importSelected(body, user, ctx);
      return notFound();

    case "notifications":
      // only the sweep (it creates Notification rows, which only the server may do)
      if (id === "sweep" && parts.length === 2 && m === "POST") return notifications.sweep(user);
      return notFound();
  }
  return notFound();
}

module.exports = { route };
