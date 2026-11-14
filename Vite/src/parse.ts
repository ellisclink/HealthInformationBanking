// parse.ts — connects the website to Parse (Back4app), once, for the whole app.
//
// Where it points:
//   - set VITE_PARSE_APP_ID / VITE_PARSE_JS_KEY / VITE_PARSE_SERVER_URL in a .env file to override
//   - opened from this computer (localhost / 127.0.0.1): the local Parse Server (Parse/local)
//   - anywhere else (the Back4app site): the Back4app app below
// The App ID and JavaScript key are meant to be public (every visitor's browser has them).
// What protects the data is that every class is locked to Cloud Code, except the 7 owner classes (Medication, DoseLog,
// Refill, DiaryEntry, Condition, ConditionNote, ConditionTarget), which logged-in patients reach for their own rows only
// (triggers in Parse/cloud/lib/access.js), and _User, which allows public create for sign-up only (checked by the
// triggers in Parse/cloud/lib/auth.js). Permissions are in Parse/cloud/lib/setup.js.
// NEVER put the Master Key in this file.
import Parse from "parse";

const BACK4APP = {
  appId: "KCJXY2rFr1eu1cAWPYJPnZr89yx68fXGnsF7u9a3",
  jsKey: "bFVBDImmKKEfQGs8PpAiunSXe4SM49fo3EsxkLbJ",
  serverURL: "https://parseapi.back4app.com",
};
const LOCAL = { appId: "mib-local", jsKey: "mib-local-js", serverURL: `${window.location.origin}/parse` };

const isLocal = ["localhost", "127.0.0.1"].includes(window.location.hostname);
const env = import.meta.env;
const config = {
  appId: env.VITE_PARSE_APP_ID || (isLocal ? LOCAL.appId : BACK4APP.appId),
  jsKey: env.VITE_PARSE_JS_KEY || (isLocal ? LOCAL.jsKey : BACK4APP.jsKey),
  serverURL: env.VITE_PARSE_SERVER_URL || (isLocal ? LOCAL.serverURL : BACK4APP.serverURL),
};

// Keep the login in sessionStorage (not localStorage), so closing the tab logs out —
// important on shared or clinic computers.
Parse.CoreManager.setStorageController({
  async: 0,
  getItem: (k: string) => sessionStorage.getItem(k),
  setItem: (k: string, v: string) => sessionStorage.setItem(k, v),
  removeItem: (k: string) => sessionStorage.removeItem(k),
  getAllKeys: () => Object.keys(sessionStorage),
  clear: () => {
    for (const k of Object.keys(sessionStorage)) if (k.startsWith("Parse/")) sessionStorage.removeItem(k);
  },
});
// the same values, for pages that call Parse.initialize themselves (CCDA.tsx): they re-initialize to this app,
// and the sessionStorage controller above stays in place
export const parseConfig = config;
Parse.initialize(config.appId, config.jsKey);
Parse.serverURL = config.serverURL;

export default Parse;
