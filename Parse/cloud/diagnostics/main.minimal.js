// main.minimal.js — a one-function Cloud Code, used to find out whether Back4app's Cloud Code runs AT ALL for your app.
//
// How to use it (see docs/DEPLOY-BACK4APP-CLOUDFLARE.md, "If Cloud Code does not answer"):
//   1. Back4app > your app > Cloud Code > Functions: replace cloud/main.js with THIS file's content and deploy. Keep a copy of the real main.js.
//   2. Call it from your own computer:
//        curl -X POST https://parseapi.back4app.com/functions/ping -H "X-Parse-Application-Id: YOUR_APP_ID" -H "X-Parse-Javascript-Key: YOUR_JS_KEY" -H "Content-Type: application/json" -d "{}"
//   3. Answer { "result": { "ok": true, ... } } quickly  -> Cloud Code works; the problem is in the real code (put the real main.js back and read the logs).
//      No answer / timeout                                -> the problem is Back4app-side (plan, paused app, Cloud Code settings): contact Back4app support.
Parse.Cloud.define("ping", () => ({ ok: true, node: process.version, time: new Date().toISOString() }));
