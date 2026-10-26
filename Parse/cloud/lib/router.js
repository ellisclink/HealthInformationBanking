// router.js — the `api` Cloud Function: one entry point with the same paths the old
// Node server had, so the website's pages didn't need to change.
//
//   Parse.Cloud.run("api", { method: "GET", path: "/medications", query: {...}, body: {...} })
//
// Returns { status, ...payload } (status 4xx/5xx = error, with `error` explaining it).
// Patient-data routes are for patient accounts only; physicians read patient data through
// share codes (read-only) and never through these.

const auth = require("./auth");
const records = require("./records");
const medications = require("./medications");
const vitals = require("./vitals");
const diary = require("./diary");
const conditions = require("./conditions");
const calendar = require("./calendar");
const calendarFeed = require("./calendarFeed");
const nutrition = require("./nutrition");
const labs = require("./labs");
const safety = require("./safety");
const links = require("./links");
const disposal = require("./disposal");
const documents = require("./documents");
const respiratory = require("./respiratory");
const reminders = require("./reminders");
const notifications = require("./notifications");
const ccdaApi = require("./ccdaApi");
const emergency = require("./emergency");
const autofill = require("./autofill");
const previsit = require("./previsit");
const account = require("./account");

const PATIENT_ONLY = ["records", "share", "medications", "diary-entries", "vitals", "conditions", "calendar", "nutrition", "labs", "safety", "links",
  "disposal", "documents", "respiratory", "reminders", "notifications", "emergency", "previsit"];
const notFound = () => ({ status: 404, error: "unknown endpoint" });
const hooks = { afterRecordSaved: (userId, data) => safety.syncAllergiesFromRecord(userId, data) };

async function route({ method, path, query, body }, ctx) {
  const m = String(method || "GET").toUpperCase();
  const p = String(path || "").split("?")[0];
  const parts = p.split("/").filter(Boolean);   // ["medications", id?, sub?]
  const [section, id, sub, extra] = parts;
  body = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  query = query && typeof query === "object" ? query : {};

  // ---- no login needed ----
  if (m === "POST" && p === "/register") return auth.register(body, ctx);
  if (m === "POST" && p === "/login") return auth.login(body, ctx);
  if (m === "POST" && p === "/verify-2fa") return auth.verify2fa(body, ctx);
  if (m === "POST" && p === "/forget") return auth.forget(body, ctx);
  if (m === "POST" && p === "/reset") return auth.reset(body, ctx);
  if (m === "POST" && p === "/logout") return auth.logout(ctx);
  // provider codes check the physician login inside; family codes need none
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
  // /records has no sub-paths; answer 404 for every role (a physician would otherwise get the patient-only 403)
  if (section === "records" && parts.length > 1) return notFound();
  if (PATIENT_ONLY.includes(section) && user.role !== "patient") {
    return { status: 403, error: "this is for patient accounts; physicians view patients through a sharing code" };
  }

  // the account itself: any role (a physician can export or delete their own login too)
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
    case "records":
      if (parts.length === 1 && m === "GET") return records.getRecord(user);
      if (parts.length === 1 && m === "PUT") return records.putRecord(body, user, ctx, hooks);
      return notFound();

    case "share":
      if (parts.length === 1 && m === "POST") return records.createShare(body, user, ctx);
      if (parts.length === 1 && m === "GET") return records.listShares(user);
      if (id === "access-log" && parts.length === 2 && m === "GET") return records.listAccessLog(user);
      if (id && parts.length === 2 && m === "DELETE") return records.revokeShare(id, user, ctx);
      return notFound();

    case "medications":
      if (parts.length > 3) return notFound();
      if (!id) {
        if (m === "GET") return medications.list(query, user);
        if (m === "POST") return medications.create(body, user);
      } else if (id === "summary" && !sub) {
        if (m === "GET") return medications.summary(user);
      } else if (!sub) {
        if (m === "GET") return medications.getById(id, user);
        if (m === "PUT") return medications.update(id, body, user);
        if (m === "DELETE") return medications.remove(id, user);
      } else if (sub === "doses") {
        if (m === "GET") return medications.getDoses(id, query, user);
        if (m === "POST") return medications.logDose(id, body, user);
      } else if (sub === "refills") {
        if (m === "GET") return medications.getRefills(id, user);
        if (m === "POST") return medications.addRefill(id, body, user);
      }
      return notFound();

    case "diary-entries":
      if (parts.length > 2) return notFound();
      if (!id && m === "GET") return diary.list(user);
      if (!id && m === "POST") return diary.create(body, user);
      if (id && m === "GET") return diary.getById(id, user);
      if (id && m === "PUT") return diary.update(id, body, user);
      if (id && m === "DELETE") return diary.remove(id, user);
      return notFound();

    case "vitals":
      if (parts.length > 2) return notFound();
      if (!id && m === "GET") return vitals.list(query, user);
      if (!id && m === "POST") return vitals.create(body, user);
      if (id === "types" && m === "GET") return vitals.types();
      if (id === "summary" && m === "GET") return vitals.summary(user);
      if (id === "trends" && m === "GET") return vitals.trends(query, user);
      if (id === "quick-look" && m === "GET") return vitals.quickLook(query, user);
      if (id && m === "GET") return vitals.getById(id, user);
      if (id && m === "PUT") return vitals.update(id, body, user);
      if (id && m === "DELETE") return vitals.remove(id, user);
      return notFound();

    case "conditions":
      if (parts.length > 3) return notFound();
      if (!id) {
        if (m === "GET") return conditions.list(query, user);
        if (m === "POST") return conditions.create(body, user);
      } else if (id === "summary" && !sub) {
        if (m === "GET") return conditions.summary(user);
      } else if (!sub) {
        if (m === "GET") return conditions.getById(id, user);
        if (m === "PUT") return conditions.update(id, body, user);
        if (m === "DELETE") return conditions.remove(id, user);
      } else if (sub === "notes") {
        if (m === "GET") return conditions.notes(id, user);
        if (m === "POST") return conditions.addNote(id, body, user);
      } else if (sub === "targets") {
        if (m === "POST") return conditions.setTarget(id, body, user);
      }
      return notFound();

    case "calendar":
      // /calendar/events/:id/occurrences/:date — five parts, so it sits outside the <= 4 block below
      if (id === "events" && extra === "occurrences" && parts.length === 5 && m === "DELETE") {
        return calendar.skipOccurrence(sub, parts[4], user, ctx);
      }
      if (id === "events" && parts.length <= 4) {
        if (!sub) {
          if (m === "GET") return calendar.list(query, user);
          if (m === "POST") return calendar.create(body, user);
        } else if (!extra) {
          if (m === "GET") return calendar.getById(sub, user);
          if (m === "PUT") return calendar.update(sub, body, user);
          if (m === "DELETE") return calendar.remove(sub, user);
        } else if (extra === "ics" && m === "GET") return calendar.eventIcs(sub, user);
      }
      if (id === "upcoming" && parts.length === 2 && m === "GET") return calendar.upcoming(query, user);
      if (id === "ics" && parts.length === 2 && m === "GET") return calendar.calendarIcs(user);
      // subscribe links (D-016); the feed itself is a plain web route, not part of api (see calendarFeed.js)
      if (id === "feed-tokens" && parts.length === 2 && m === "GET") return calendarFeed.listTokens(user);
      if (id === "feed-tokens" && parts.length === 2 && m === "POST") return calendarFeed.createToken(body, user, ctx);
      if (id === "feed-tokens" && parts.length === 3 && m === "DELETE") return calendarFeed.revokeToken(sub, user, ctx);
      return notFound();

    case "nutrition":
      if (id === "search" && !sub && m === "POST") return nutrition.search(body);
      if (id === "logs" && !sub && m === "GET") return nutrition.logs(query, user);
      if (id === "summary" && !sub && m === "GET") return nutrition.summary(query, user);
      if (id === "log" && parts.length <= 3) {
        if (!sub && m === "POST") return nutrition.log(body, user);
        if (sub && m === "PUT") return nutrition.update(sub, body, user);
        if (sub && m === "DELETE") return nutrition.remove(sub, user);
      }
      return notFound();

    case "labs":
      if (parts.length > 4) return notFound();
      if (id === "catalog" && !sub && m === "GET") return labs.getCatalog();
      if (id === "summary" && !sub && m === "GET") return labs.summary(user);
      if (id === "results" && !extra) {
        if (!sub && m === "GET") return labs.listResults(query, user);
        if (!sub && m === "POST") return labs.createResults(body, user);
        if (sub && m === "GET") return labs.getResult(sub, user);
        if (sub && m === "PUT") return labs.updateResult(sub, body, user);
        if (sub && m === "DELETE") return labs.deleteResult(sub, user);
      }
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
      if (id === "allergies" && !sub && m === "GET") return safety.getAllergies(user);
      if (id === "alerts" && !sub && m === "GET") return safety.getAlerts(user);
      if (id === "check" && !sub && m === "POST") return safety.check(body, user);
      if (id === "alerts" && sub && extra === "acknowledge" && parts.length === 4 && m === "POST") return safety.acknowledge(sub, body, user);
      return notFound();

    case "links":
      if (parts.length > 3) return notFound();
      if (!id && m === "GET") return links.list(query, user);
      if (!id && m === "POST") return links.create(body, user);
      if (id && !sub && m === "GET") return links.getById(id, user);
      if (id && !sub && m === "PUT") return links.update(id, body, user);
      if (id && !sub && m === "DELETE") return links.remove(id, user);
      if (id && sub === "opened" && m === "POST") return links.opened(id, user);
      return notFound();

    case "disposal":
      if (id === "methods" && !sub && m === "GET") return disposal.methods();
      if (id === "guidance" && !sub && m === "GET") return disposal.guidance(query);
      if (id === "due" && !sub && m === "GET") return disposal.due(user);
      if (id === "logs" && !extra) {
        if (!sub && m === "GET") return disposal.listLogs(user);
        if (!sub && m === "POST") return disposal.createLog(body, user, ctx);
        if (sub && m === "DELETE") return disposal.removeLog(sub, user, ctx);
      }
      return notFound();

    case "documents":
      // PDF auto-fill (7-2): "autofill" is checked first so it is never read as a document id
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

    case "respiratory":
      if (parts.length > 4) return notFound();
      if (id === "summary" && !sub && m === "GET") return { status: 200, ...(await respiratory.summary(user)) };   // summary() returns only the sections
      if (id === "devices") {
        if (!sub) {
          if (m === "GET") return respiratory.listDevices(user);
          if (m === "POST") return respiratory.createDevice(body, user, ctx);
        } else if (!extra) {
          if (m === "GET") return respiratory.getDevice(sub, user);
          if (m === "PUT") return respiratory.updateDevice(sub, body, user, ctx);
          if (m === "DELETE") return respiratory.removeDevice(sub, user, ctx);
        } else if (extra === "supplies" && parts.length === 4) {
          if (m === "GET") return respiratory.listSupplies(sub, user);
          if (m === "POST") return respiratory.addSupply(sub, body, user, ctx);
        }
      }
      if (id === "supplies" && sub) {
        if (!extra && m === "PUT") return respiratory.updateSupply(sub, body, user, ctx);
        if (!extra && m === "DELETE") return respiratory.removeSupply(sub, user, ctx);
        if (extra === "replaced" && m === "POST") return respiratory.markReplaced(sub, body, user, ctx);
      }
      if (id === "logs" && !extra) {
        if (!sub && m === "GET") return respiratory.listLogs(query, user);
        if (!sub && m === "POST") return respiratory.createLog(body, user, ctx);
        if (sub && m === "PUT") return respiratory.updateLog(sub, body, user, ctx);
        if (sub && m === "DELETE") return respiratory.removeLog(sub, user, ctx);
      }
      return notFound();

    case "reminders":
      if (parts.length > 3) return notFound();
      if (!id) {
        if (m === "GET") return reminders.list(user);
        if (m === "POST") return reminders.create(body, user, ctx);
      } else if (!sub) {
        if (m === "GET") return reminders.get(id, user);
        if (m === "PUT") return reminders.update(id, body, user, ctx);
        if (m === "DELETE") return reminders.remove(id, user, ctx);
      } else if (sub === "snooze" && m === "POST") {
        return reminders.snooze(id, body.minutes, user, ctx);
      }
      return notFound();
      
    case "emergency":
      if (parts.length === 2 && id === "settings") {
        if (m === "GET") return emergency.getSettings(user);
        if (m === "PUT") return emergency.putSettings(body, user, ctx);
      }
      if (parts.length === 2 && id === "preview" && m === "GET") return emergency.preview(user);
      if (parts.length === 2 && id === "code") {
        if (m === "POST") return emergency.createCode(user, ctx);
        if (m === "DELETE") return emergency.revokeCode(user, ctx);
      }
      if (parts.length === 2 && id === "access-log" && m === "GET") return emergency.accessLog(user);
      return notFound();

    case "previsit":
      if (parts.length === 2 && id === "appointments" && m === "GET") return previsit.appointments(query, user);
      if (parts.length === 2 && id === "summary" && m === "POST") return previsit.summary(body, user, ctx);
      return notFound();

    case "ccda":
      if (parts.length !== 2 || m !== "POST") return notFound();
      if (id === "preview") return ccdaApi.preview(body, user, ctx);
      if (id === "import") return ccdaApi.importSelected(body, user, ctx);
      return notFound();
      
    case "notifications":
      if (parts.length > 3) return notFound();
      if (!id) {
        if (m === "GET") return notifications.list(user);
        if (m === "DELETE") return notifications.clearRead(user);
      } else if (!sub) {
        if (id === "count") return m === "GET" ? notifications.count(user) : notFound();   // "count" is not an ID, so DELETE is not "invalid ID"
        if (id === "read-all" && m === "POST") return notifications.readAll(user);
        if (id === "settings" && m === "GET") return notifications.getSettings(user);
        if (id === "settings" && m === "PUT") return notifications.putSettings(body, user);
        if (m === "DELETE") return notifications.dismiss(id, user);
      } else if (sub === "read" && m === "POST") {
        return notifications.markRead(id, user);
      }
      return notFound();
  }
  return notFound();
}

module.exports = { route };
