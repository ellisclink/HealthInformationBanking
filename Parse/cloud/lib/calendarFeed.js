// calendarFeed.js — calendar subscribe links (decision D-016). Class: FeedToken
//
// Patient API (through the `api` Cloud Function, patient accounts only; see router.js):
//   POST   /calendar/feed-tokens {token_hash, days?, label?} -> {token_id, expires_at, label}
//   GET    /calendar/feed-tokens                  -> {tokens: [{token_id, label, expires_at, revoked_at, created_at, status}]}
//   DELETE /calendar/feed-tokens/:id              -> revoke (sets revoked_at; the row is kept)
//
// Public feed (the one approved exception to "everything goes through api"): GET /calendar/feed/:token, a plain web
// route a phone calendar app can poll without a session. Wired in cloud/app.js (Back4app) and local/local-server.js
// (local), both with expressHandler below.
//
// The token is made in the BROWSER (32 random bytes, base64url) and only its SHA-256 (64 hex) is sent here, so the
// token never passes through the server or any server log. The browser builds the feed address itself and shows it
// once. The server stores only the hash, so the database can't give the token back. The feed
// answers the same "Not found" for an unknown, expired or revoked token, and writes only titles and times
// (calendar.feedIcs). Every successful fetch is audited (FEED_FETCH) without the token or the URL.
// Nothing here logs the token or the request path.

const crypto = require("crypto");
const net = require("net");
const db = require("./db");
const { M, isId, findAll, findOne, getOwned, create, save, destroy } = db;
const audit = (entry) => db.audit(entry);   // looked up at call time (tests replace db.audit to simulate a failure)
const sec = require("./security");
const calendar = require("./calendar");

const DAY_OPTIONS = [30, 90, 365];
const DEFAULT_DAYS = 365;
const MAX_ACTIVE = 5;
const MAX_LABEL = 100;
const DEFAULT_LABEL = "Calendar link";
const RATE_LIMIT = 60;                    // successful fetches per token per hour
const RATE_WINDOW_MS = 60 * 60 * 1000;
const CREATE_LIMIT = 20;                  // new links per patient per day
const CREATE_WINDOW_MS = 24 * 60 * 60 * 1000;
const PURGE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;   // ended links are deleted 30 days after they ended
const FEED_PREFIX = "/calendar/feed/";
const FEED_ROUTE = `${FEED_PREFIX}:token`;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes as base64url, no padding
const HASH_SHAPE = /^[0-9a-f]{64}$/;       // SHA-256 as lower-case hex, made in the browser

// A token the browser could have made: 43 base64url characters that decode to exactly 32 bytes and encode back to the
// same text (so the last character carries no stray bits). The server only ever sees hashes at create time, so this is
// what keeps a hand-picked string out of the feed lookup.
const browserShaped = (token) => typeof token === "string" && TOKEN_SHAPE.test(token)
  && Buffer.from(token, "base64url").length === 32 && Buffer.from(token, "base64url").toString("base64url") === token;
const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");
const iso = (d) => (d instanceof Date ? d.toISOString() : null);

function statusOf(t, now = Date.now()) {
  if (t.get("revoked_at")) return "revoked";
  const exp = t.get("expires_at");
  return exp instanceof Date && exp.getTime() > now ? "active" : "expired";
}
// What the patient (and the audit log) may see of a link: never the token or its hash
const publicRow = (t) => ({
  token_id: t.id, label: t.get("label") ?? null, expires_at: iso(t.get("expires_at")),
  revoked_at: iso(t.get("revoked_at")), created_at: iso(t.get("created_at")) ?? iso(t.createdAt), status: statusOf(t),
  last_fetched_at: iso(t.get("last_fetched_at")), fetch_count: t.get("fetch_count") || 0,
});

// ---------- patient API ----------

async function createToken(body, user, ctx = {}) {
  const tokenHash = body.token_hash;
  if (typeof tokenHash !== "string" || !HASH_SHAPE.test(tokenHash)) return { status: 400, error: "token_hash must be 64 lower-case hex characters" };
  const days = body.days === undefined ? DEFAULT_DAYS : body.days;
  if (!DAY_OPTIONS.includes(days)) return { status: 400, error: `days must be one of: ${DAY_OPTIONS.join(", ")}` };
  let label = DEFAULT_LABEL;
  if (body.label !== undefined && body.label !== null && body.label !== "") {
    if (typeof body.label !== "string" || body.label.trim().length > MAX_LABEL) {
      return { status: 400, error: `label must be text of ${MAX_LABEL} characters or fewer` };
    }
    label = body.label.trim() || DEFAULT_LABEL;
  }
  const mine = await purgeEnded(user.user_id, ctx);
  if (mine.filter((t) => statusOf(t) === "active").length >= MAX_ACTIVE) return { status: 400, error: "Revoke an old link first" };
  // at most CREATE_LIMIT new links per patient per day (counted atomically, then compared; see sec.take)
  if ((await sec.take(`feed-create:${user.user_id}`, CREATE_WINDOW_MS)) > CREATE_LIMIT) {
    return { status: 429, error: "Too many new links today. Try again tomorrow." };
  }

  // A hash is usable once, ever. FeedToken rows are purged, so UsedFeedHash keeps every hash that was registered:
  // otherwise someone who learned an old link's hash could register it again and put their own events in the calendar
  // of whoever still subscribes to that old link. (No unique index is available; see setup.js.)
  if (await findOne("FeedToken", { token_hash: tokenHash }) || await findOne("UsedFeedHash", { token_hash: tokenHash })) {
    return { status: 409, error: "That link already exists. Try again." };
  }

  // The session is checked again right before the save, and once more after it. A password reset ends every session
  // (it deletes the SessionActivity rows), so a create that overlaps a reset is refused, and a link it managed to save
  // is revoked at once: no active link outlives a reset.
  if (!(await sessionLive(ctx, user.user_id))) return SESSION_ENDED();
  const now = new Date();
  await create("UsedFeedHash", { token_hash: tokenHash, created_at: now });
  const t = await create("FeedToken", {
    user_id: user.user_id, label, token_hash: tokenHash,
    expires_at: new Date(now.getTime() + days * 24 * 60 * 60 * 1000), created_at: now,
  });
  // a check that throws (a database error) counts as "not live": the link is revoked, never left active by an error
  let live = false, checkFailed = false;
  try { live = await sessionLive(ctx, user.user_id); } catch (err) {
    checkFailed = true;
    console.error("calendar link: session check after saving failed:", err && err.message ? err.message : "error");
  }
  if (!live) {
    // revoke the link just saved; one retry, then a 500 (the link may then still be active: say so, don't hide it)
    const asSaved = publicRow(t);   // the link as it is stored now (active), before revoked_at is set on the object
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await save(t, { revoked_at: new Date() }); lastErr = null; break; } catch (err) { lastErr = err; }
    }
    if (lastErr) {
      console.error("calendar link: revoking after the session ended failed:", lastErr && lastErr.message ? lastErr.message : "error");
      // the link exists and is active: record it like any new link (flagged), and tell the patient as for any new link
      // each step on its own: a failure in one never skips the other or the 500 (only the message is logged)
      try {
        await audit({ userId: user.user_id, event: "INSERT", targetClass: "FeedToken", targetId: t.id, newData: asSaved, ip: ctx.ip,
          detail: { revoke_failed: true } });
      } catch (err) {
        console.error("calendar link: audit of a failed revoke failed:", err && err.message ? err.message : "error");
      }
      try {
        await tellPatient(user);
      } catch (err) {
        console.error("calendar link: telling the patient failed:", err && err.message ? err.message : "error");
      }
      return CREATE_FAILED();
    }
    await audit({ userId: user.user_id, event: "UPDATE", targetClass: "FeedToken", targetId: t.id, newData: publicRow(t), ip: ctx.ip,
      detail: { action: "revoked", reason: checkFailed ? "session_check_failed" : "session_ended_during_create" } });
    return checkFailed ? CREATE_FAILED() : SESSION_ENDED();
  }
  const data = publicRow(t);
  await audit({ userId: user.user_id, event: "INSERT", targetClass: "FeedToken", targetId: t.id, newData: data, ip: ctx.ip });
  await tellPatient(user);
  return { status: 201, message: "Link created", token_id: t.id, expires_at: data.expires_at, label };
}

// Is the caller's session still there? Both rows must exist and belong to the user:
//  - Parse's own _Session row for the session token (read with the master key). endAllSessions (password reset)
//    deletes these FIRST, so checking it closes the gap before the SessionActivity rows are deleted.
//  - the SessionActivity row auth.checkSession creates (keyed by the SHA-256 of the session token).
async function sessionLive(ctx, userId) {
  if (!ctx || typeof ctx.sessionToken !== "string" || !ctx.sessionToken) return false;
  const q = new Parse.Query(Parse.Session);
  q.equalTo("sessionToken", ctx.sessionToken);
  const s = await q.first(M);
  const owner = s && s.get("user");
  if (!owner || owner.id !== userId) return false;
  const activity = await findOne("SessionActivity", { token_hash: sec.sha256(ctx.sessionToken) });
  return !!activity && activity.get("user_id") === userId;
}
const CREATE_FAILED = () => ({ status: 500, error: "Something went wrong. Please log in again and check your calendar links." });
const SESSION_ENDED = () => ({ status: 401, error: "your session has ended — please log in again" });

// The UsedFeedHash tombstone for a hash, created if it is missing (links saved before UsedFeedHash existed have none).
async function ensureTombstone(tokenHash) {
  if (typeof tokenHash !== "string" || !tokenHash) return;
  if (!(await findOne("UsedFeedHash", { token_hash: tokenHash }))) await create("UsedFeedHash", { token_hash: tokenHash, created_at: new Date() });
}

// One-time backfill (run from setup.ensureSetup until it has succeeded once per server start; safe to repeat): every
// FeedToken hash gets a UsedFeedHash tombstone. Returns how many were created. Reads up to db.js's 10,000-row limit
// per class, far above this app's expected link count.
async function backfillUsedFeedHashes() {
  const used = new Set((await findAll("UsedFeedHash", {}, { select: ["token_hash"] })).map((r) => r.get("token_hash")));
  let created = 0;
  for (const t of await findAll("FeedToken", {}, { select: ["token_hash"] })) {
    const h = t.get("token_hash");
    if (typeof h !== "string" || !h || used.has(h)) continue;
    await create("UsedFeedHash", { token_hash: h, created_at: new Date() });
    used.add(h);
    created += 1;
  }
  return created;
}

// Deletes this user's links that ended (revoked, or expired) more than PURGE_AFTER_MS ago, each with a DELETE audit
// row, and returns the ones left.
async function purgeEnded(userId, ctx = {}) {
  const cutoff = Date.now() - PURGE_AFTER_MS;
  const kept = [];
  for (const t of await findAll("FeedToken", { user_id: userId })) {
    const status = statusOf(t);
    const endedAt = status === "revoked" ? t.get("revoked_at") : status === "expired" ? t.get("expires_at") : null;
    if (endedAt instanceof Date && endedAt.getTime() < cutoff) {
      const old = publicRow(t);
      await ensureTombstone(t.get("token_hash"));   // first, so a purge can never free a hash (a failure stops here)
      await destroy(t);
      await audit({ userId, event: "DELETE", targetClass: "FeedToken", targetId: t.id, oldData: old, ip: ctx.ip || null, detail: { action: "purged" } });
    } else kept.push(t);
  }
  return kept;
}

// A new link gets an email, so a patient notices one they didn't make. Generic on purpose: no link, label or health
// details. A failed send never fails the create.
const LINK_EMAIL_SUBJECT = "Health Information Banking: a calendar link was created";
const LINK_EMAIL_TEXT = "Hello, a new calendar subscribe link was just created for your Health Information Banking account.\n\n"
  + "If you made it, you don't need to do anything. If you didn't, sign in, open Calendar and revoke it, then change your password.\n\n"
  + "For your privacy, this email never includes the link or any health details.\n";
async function tellPatient(user) {
  if (!user.user_email) return;
  try {
    await sec.sendEmail(user.user_email, LINK_EMAIL_SUBJECT, LINK_EMAIL_TEXT, "Calendar link email");
  } catch (err) {
    console.error("calendar link email failed:", err && err.message ? err.message : "error");
  }
}

// Revoke every active link of a user (password reset, ending all sessions). Returns how many were revoked.
async function revokeAllForUser(userId, reason, ip = null) {
  let n = 0;
  for (const t of await findAll("FeedToken", { user_id: userId })) {
    if (statusOf(t) !== "active") continue;
    const old = publicRow(t);
    await save(t, { revoked_at: new Date() });
    await audit({ userId, event: "UPDATE", targetClass: "FeedToken", targetId: t.id, oldData: old, newData: publicRow(t), ip,
      detail: { action: "revoked", reason } });
    n += 1;
  }
  return n;
}

async function listTokens(user) {
  const tokens = (await findAll("FeedToken", { user_id: user.user_id }))
    .map(publicRow)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 100);
  return { status: 200, tokens };
}

async function revokeToken(id, user, ctx = {}) {
  const t = isId(id) ? await getOwned("FeedToken", id, user.user_id) : null;
  if (!t) return { status: 404, error: "Link not found" };
  if (!t.get("revoked_at")) {
    const old = publicRow(t);
    await save(t, { revoked_at: new Date() });
    await audit({ userId: user.user_id, event: "UPDATE", targetClass: "FeedToken", targetId: t.id, oldData: old, newData: publicRow(t),
      ip: ctx.ip, detail: { action: "revoked" } });
  }
  return { status: 200, message: "Link revoked", token: publicRow(t) };
}

// ---------- public feed ----------

const BASE_HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
const plain = (status, body) => ({ status, headers: { ...BASE_HEADERS, "Content-Type": "text/plain; charset=utf-8" }, body });
const NOT_FOUND = () => plain(404, "Not found");

// Bad requests (a token that is malformed, unknown, expired or revoked) per address (see limitKey), kept in memory
// with a sliding one-hour window. Per server instance; the counts reset when the instance restarts.
//  - An address already at BAD_LIMIT is refused BEFORE the database.
//  - Otherwise a malformed token is found bad without the database, and a well-formed one is looked up first: from an
//    address that isn't tracked yet, a bad well-formed token DOES reach the database before it is counted.
//  - At most BAD_MAX_IPS addresses are tracked. When the table is full and a new address sends a bad request, room is
//    made by sweeping stale entries and then by dropping one entry with fewer than EVICT_BELOW hits; blocked and
//    near-blocked addresses are never dropped (see cannotTrack). If no entry can be dropped, the full-table refusal
//    (429, fail closed) applies only to that bad request. A valid link works from any address.
//  - Each address keeps at most BAD_LIMIT timestamps, which is all the check needs.
// Calendar services poll from shared addresses, so one address polling many revoked links can be blocked for an hour.
// README step 9 describes the same rules.
const BAD_LIMIT = 120, BAD_WINDOW_MS = 60 * 60 * 1000, BAD_MAX_IPS = 10000, SWEEP_EVERY_MS = 60 * 1000;
const badHits = new Map();   // ip -> [timestamps, oldest first]
let lastSweep = 0;
function badCount(ip, now) {
  const list = badHits.get(ip);
  if (!list) return 0;
  while (list.length && list[0] <= now - BAD_WINDOW_MS) list.shift();
  if (!list.length) { badHits.delete(ip); return 0; }
  return list.length;
}
// true when `ip` is not tracked and there is no room to track it. Room is made, in this order: by sweeping entries with
// nothing left in the window (at most once a minute), then by dropping ONE entry with fewer than EVICT_BELOW hits in
// the window (the oldest such entry). Blocked and near-blocked addresses (EVICT_BELOW hits or more) are never dropped.
const EVICT_BELOW = 10;
function cannotTrack(ip, now) {
  if (badHits.has(ip) || badHits.size < BAD_MAX_IPS) return false;
  if (now - lastSweep >= SWEEP_EVERY_MS) {
    lastSweep = now;
    for (const key of [...badHits.keys()]) badCount(key, now);   // drops entries with nothing left in the window
  }
  if (badHits.size < BAD_MAX_IPS) return false;
  for (const key of badHits.keys()) {   // insertion order: the oldest first
    const n = badCount(key, now);
    if (n === 0) return false;           // it expired just now and was removed
    if (n < EVICT_BELOW) { badHits.delete(key); return false; }
  }
  return true;
}
function noteBad(ip, now) {
  let list = badHits.get(ip);
  if (!list) {
    if (badHits.size >= BAD_MAX_IPS) return;   // never make room by dropping another address
    list = [];
    badHits.set(ip, list);
  }
  list.push(now);
  if (list.length > BAD_LIMIT) list.splice(0, list.length - BAD_LIMIT);
}
const TOO_MANY_BAD = () => plain(429, "Too many requests. Try again later.");

// An IPv6 address as its eight 16-bit groups (numbers). A trailing dotted IPv4 part counts as the last two groups.
function ipv6Groups(s) {
  let text = s;
  const dotted = text.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.includes("::") ? text.split("::") : [text, null];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const parts = tail === null ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  return parts.map((g) => parseInt(g, 16) || 0);
}
const v4From = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");

// The key an address is counted under:
//  - IPv4 as it is;
//  - IPv4-mapped IPv6 (::ffff:0:0/96, in any spelling) and NAT64 (64:ff9b::/96) as the IPv4 address in the last 32 bits;
//  - other addresses whose first 64 bits are all zero (loopback ::1, unspecified ::, and the rest of ::/64) as the
//    whole address, so they never share a bucket with each other;
//  - every other IPv6 address by its /64 prefix (one customer usually gets a whole /64, so counting single addresses
//    would be easy to dodge).
function limitKey(ip) {
  const s = String(ip).trim().replace(/%.*$/, "").toLowerCase();   // drop an IPv6 zone id
  if (!net.isIPv6(s)) return s;
  const g = ipv6Groups(s);
  const zero = (from, to) => g.slice(from, to).every((x) => x === 0);
  if (zero(0, 5) && g[5] === 0xffff) return v4From(g[6], g[7]);                    // ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return v4From(g[6], g[7]);   // 64:ff9b::a.b.c.d
  const hex = (list) => list.map((x) => x.toString(16)).join(":");
  if (zero(0, 4)) return hex(g);                                                     // ::1, ::, ... each alone
  return `${hex(g.slice(0, 4))}::/64`;
}

// handleFeed(token, {ip, limitKey, userAgent}) -> {status, headers, body}. Unknown, expired and revoked look the same.
// ip is what the audit row records (null = nothing); limitKey is what the bad-request limit counts by (defaults to ip).
async function handleFeed(token, meta = {}) {
  const ipKey = limitKey(meta.limitKey || meta.ip || "unknown");
  const now = Date.now();
  // an address over the limit is refused before the database; a full table only refuses requests that turn out bad,
  // so valid links keep working from any address
  if (badCount(ipKey, now) >= BAD_LIMIT) return TOO_MANY_BAD();
  const bad = () => {
    if (cannotTrack(ipKey, now)) return TOO_MANY_BAD();
    noteBad(ipKey, now);
    return NOT_FOUND();
  };
  if (!browserShaped(token)) return bad();
  const t = await findOne("FeedToken", { token_hash: hashToken(token) });
  if (!t || statusOf(t) !== "active") return bad();

  // counted first, then compared (atomic increment; see sec.take). The key is the token's id, never its text.
  if ((await sec.take(`feed:${t.id}`, RATE_WINDOW_MS)) > RATE_LIMIT) return plain(429, "Too many requests for this calendar link. Try again later.");

  const userId = t.get("user_id");
  const body = await calendar.feedIcs(userId);
  t.increment("fetch_count");
  await save(t, { last_fetched_at: new Date() });
  await audit({ userId, event: "FEED_FETCH", targetClass: "FeedToken", targetId: t.id, ip: meta.ip || null,
    detail: { user_agent: String(meta.userAgent || "").slice(0, 256) } });
  return { status: 200, headers: { ...BASE_HEADERS, "Content-Type": calendar.ICS_TYPE }, body };
}

// X-Forwarded-For on Back4app. The FIRST value is whatever the first hop sent, so a client can set it: it is kept only
// in the audit record. The RIGHT-MOST value is the one Back4app's proxy appends (the address that actually connected),
// so the bad-request limit counts by it and a client can't pick its own key. Values that don't look like an IP are null.
const IP_SHAPE = /^[0-9A-Fa-f:.]{2,45}$/;
function forwardedValues(req) {
  let v = req && req.headers ? req.headers["x-forwarded-for"] : undefined;
  if (Array.isArray(v)) v = v.join(",");
  return typeof v === "string" ? v.split(",").map((s) => s.trim()) : [];
}
function forwardedFor(req) {
  const first = forwardedValues(req)[0];
  return first && IP_SHAPE.test(first) ? first : null;
}
function lastForwardedFor(req) {
  const all = forwardedValues(req);
  const last = all[all.length - 1];
  return last && IP_SHAPE.test(last) ? last : null;
}
// Back4app (cloud/app.js): audit the first value, limit by the right-most one (or the socket address without the header)
const BACK4APP = { clientIp: forwardedFor, limitIp: (req) => lastForwardedFor(req) || req.ip || null };

// makeHandler({clientIp, limitIp}) -> Express handler for GET /calendar/feed/:token. clientIp(req) gives the IP to
// audit (or null); limitIp(req) gives the key the bad-request limit counts by. Errors are logged without the token
// or the path.
function makeHandler({ clientIp = (req) => req.ip || null, limitIp = (req) => req.ip || null } = {}) {
  return async function feedHandler(req, res) {
    let out;
    try {
      const headers = req.headers || {};
      const ip = clientIp(req) || null;
      out = await handleFeed(req.params && req.params.token, { ip, limitKey: limitIp(req) || null, userAgent: headers["user-agent"] || "" });
    } catch (err) {
      console.error("calendar feed failed:", err && err.message ? err.message : "error");
      out = plain(500, "Server error");
    }
    res.status(out.status);
    for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
    res.send(out.body);
  };
}
const expressHandler = makeHandler();

// Express error handler for the feed path. A badly encoded path (Express can't decode :token) would otherwise reach
// Express's default handler, which prints the error (holding the raw path) and its stack. Here it is a plain 404 like
// any other bad link, and nothing is logged.
function feedErrorHandler(err, req, res, next) {   // eslint-disable-line no-unused-vars -- Express needs 4 arguments
  if (res.headersSent) { res.end(); return; }
  const out = NOT_FOUND();
  res.status(out.status);
  for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
  res.send(out.body);
}

// Adds the feed route and its error handler to an Express app (cloud/app.js on Back4app, local/local-server.js
// locally). Call it before the website's catch-all.
function mount(app, options = {}) {
  app.get(FEED_ROUTE, makeHandler(options));
  app.use(FEED_PREFIX.slice(0, -1), feedErrorHandler);   // errors under /calendar/feed only
}

module.exports = { createToken, listTokens, revokeToken, revokeAllForUser, backfillUsedFeedHashes, handleFeed, expressHandler, makeHandler, feedErrorHandler, mount, forwardedFor, lastForwardedFor, BACK4APP, hashToken, FEED_ROUTE,
  _badIpCount: () => badHits.size, _limitKey: limitKey,
  _seedBadIp: (ip, hits) => { const now = Date.now(); badHits.set(limitKey(ip), Array(Math.min(hits, BAD_LIMIT)).fill(now)); },
  _badCountOf: (ip) => badCount(limitKey(ip), Date.now()), _resetBadIps: () => { badHits.clear(); lastSweep = 0; } };
