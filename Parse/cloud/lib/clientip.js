// clientip.js — which network address a request really came from, for the limits on guessing (logins, codes, sign-ups).
//
// The problem (found by a simulated attack): the address was taken from request.ip, and in front of a proxy that comes from the
// X-Forwarded-For header, whose FIRST entries anyone can write. A guesser who sends a different made-up address each time never hits the
// limit. Each proxy in front of the server ADDS the address it saw at the END of the header, so the entries at the end are trustworthy and
// the ones at the start are not.
//
// TRUSTED_PROXY_HOPS (environment variable) = how many proxies of yours sit in front of the server and append to the header.
//   0 (default)  keep the old behaviour: request.ip as the platform reports it
//   1            the last entry is the real client (one proxy in front)
//   2            the second-from-last entry is the real client (e.g. a CDN, then a load balancer), and so on
// Find the right number on your host with the master-key function `debugClientIp` (main.js): call it with a made-up X-Forwarded-For
// header and see which entry is YOUR address. If the number is wrong, one shared address may be counted for everybody: check before launch.

const IP_LIKE = /^[0-9a-fA-F:.]{3,45}$/;

function clientIp(request, hops = Number(process.env.TRUSTED_PROXY_HOPS || 0)) {
  const fallback = (request && request.ip) || "unknown";
  if (!(hops > 0)) return fallback;
  const header = request && request.headers ? request.headers["x-forwarded-for"] : undefined;
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  const pick = parts[parts.length - hops];
  return pick && IP_LIKE.test(pick) ? pick : fallback;
}

module.exports = { clientIp };
