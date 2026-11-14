// serve.js — serves the built website (dist/) on Back4app Web Deployment. Run with `npm start`.
// Uses only Node's built-in modules, because Back4app removes dev dependencies (vite, tsc) after the build.
// Any path that isn't a real file gets index.html, so React Router pages like /emergency-access work on refresh.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist");
const PORT = Number(process.env.PORT) || 5173;   // must match the Port setting in Back4app
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".json": "application/json",
  ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};

// Security headers sent with every page (the website itself; the Parse API has its own).
// The Content-Security-Policy starts in REPORT-ONLY mode: the browser lists what it WOULD block in its console, but nothing breaks.
// Open the site, use each page (documents and lab PDFs open in a frame, emergency forms open from a blob link), check the browser
// console for "Content-Security-Policy" messages, and when it is clean set CSP_MODE=enforce in the Back4app environment variables.
// connect-src must allow the Parse API address the site talks to (parseapi.back4app.com, or the address in VITE_PARSE_SERVER_URL).
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self'",
  `connect-src 'self' ${process.env.PARSE_API_ORIGIN || "https://parseapi.back4app.com"}`,
  "frame-src 'self' blob:", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
].join("; ");
const SECURITY_HEADERS = {
  "Strict-Transport-Security": "max-age=31536000",                 // browsers keep using https for a year (add includeSubDomains only when every subdomain has https)
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  [process.env.CSP_MODE === "enforce" ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only"]: CSP,
};

if (!fs.existsSync(path.join(DIST, "index.html"))) {
  console.error("dist/index.html not found. Run `npm run build` first.");
  process.exit(1);
}

http.createServer((req, res) => {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { res.writeHead(400).end(); return; }
  let file = path.join(DIST, path.normalize(rel));
  if (!file.startsWith(DIST)) { res.writeHead(403).end(); return; }        // no ../ escapes out of dist
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, "index.html");
  const ext = path.extname(file);
  res.writeHead(200, {
    "Content-Type": TYPES[ext] || "application/octet-stream",
    // built files have a hash in their name, so they can be cached; index.html must always be fresh
    "Cache-Control": file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
    ...SECURITY_HEADERS,
  });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, "0.0.0.0", () => console.log(`Serving dist/ on port ${PORT}`));
