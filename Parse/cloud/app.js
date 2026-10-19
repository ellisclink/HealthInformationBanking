// app.js — Back4app web hosting: serves the built website from the `public` folder and sends
// every page address (/patient-dashboard, /lab-results, ...) to index.html so React Router
// can show the right page. Back4app provides the Express `app` object; when this file is
// loaded somewhere without it (local testing), it does nothing.

const path = require("path");
const fs = require("fs");

if (typeof app !== "undefined") {
  const express = require("express");
  // Back4app keeps public/ next to cloud/; check both places to be safe
  const candidates = [path.join(__dirname, "..", "public"), path.join(__dirname, "public")];
  const publicDir = candidates.find((p) => fs.existsSync(path.join(p, "index.html"))) || candidates[0];

  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  // Calendar subscribe feed (D-016): the one public route outside the `api` function. It must come before the
  // catch-all below, or index.html would answer it. No request logger here: the path holds the private token.
  const calendarFeed = require("./lib/calendarFeed");
  // audits the first X-Forwarded-For value (or nothing) and limits bad requests by the right-most one (see
  // calendarFeed.BACK4APP); mount also adds an error handler so a badly encoded path is a plain 404, never printed
  calendarFeed.mount(app, calendarFeed.BACK4APP);
  app.use(express.static(publicDir, { index: "index.html" }));
  app.get("*", (req, res) => res.sendFile(path.join(publicDir, "index.html")));
}
