// parse.ts — connects the website to Parse (Back4app), once, for the whole app.
//
// Where it points:
//   - opened from this computer (localhost / 127.0.0.1): the local Parse Server (Parse/local), no setup needed
//   - anywhere else (the Back4app site): the Back4app app set by these environment variables at build time
//       VITE_PARSE_APP_ID      Back4app > App Settings > Security & Keys > Application ID
//       VITE_PARSE_JS_KEY      Back4app > App Settings > Security & Keys > JavaScript key
//       VITE_PARSE_SERVER_URL  optional, defaults to https://parseapi.back4app.com
//     Set them in the Back4app web deployment's environment variables, or in Vite/.env.local to test a build.
// The App ID and JavaScript key end up in every visitor's browser, so they are not secrets.
// What protects the data is that every class is locked to Cloud Code (Parse/cloud/lib/setup.js).
// NEVER put the Master Key here or in any VITE_ variable.
import Parse from "parse";

const isLocal = ["localhost", "127.0.0.1"].includes(window.location.hostname);
const env = import.meta.env;
const LOCAL = { appId: "mib-local", jsKey: "mib-local-js", serverURL: `${window.location.origin}/parse` };

const config = {
  appId: env.VITE_PARSE_APP_ID || (isLocal ? LOCAL.appId : ""),
  jsKey: env.VITE_PARSE_JS_KEY || (isLocal ? LOCAL.jsKey : ""),
  serverURL: env.VITE_PARSE_SERVER_URL || (isLocal ? LOCAL.serverURL : "https://parseapi.back4app.com"),
};
if (!config.appId || !config.jsKey) {
  // the site was built without the Back4app keys: say so plainly instead of failing on every request
  throw new Error("Missing VITE_PARSE_APP_ID or VITE_PARSE_JS_KEY. Add them to the web deployment's environment variables and redeploy.");
}

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
Parse.initialize(config.appId, config.jsKey);
Parse.serverURL = config.serverURL;

export default Parse;
