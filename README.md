
Medical Information Banking (MIB)
A patient-controlled health record. Patients keep their health history, medications, lab results, vital signs and a health diary in one place, and share a read-only view with a doctor or with family using a temporary code.

Backend: Parse Server Cloud Code (Parse/cloud/), hosted on Back4app
Frontend: React + TypeScript built with Vite (Vite/), talks to the backend with the Parse SDK
Local copy for development: Parse/local/ runs the same Cloud Code on your computer with a local Parse Server + PostgreSQL
What it does
Patients

Sign up / log in with an 8-digit code emailed at every login (two-factor). Forgot-password reset by emailed code.
Medical Records
Health History Form – an intake form like the one a doctor's office hands you (patient info, past medical history, surgeries, medications, allergies, immunizations, family and social history). Save and print.
Records List – searchable list of everything from the form and the Medications tracker, with View Details.
Medications – track pills on hand. Took dose subtracts, Add refill adds, low-stock warnings, days of supply, refills left, history, pause/stop.
Safety warnings – each medicine is checked against the allergies on the Health History form and against the other medicines (drug-family allergies like penicillin → amoxicillin, interactions like warfarin + ibuprofen, doubling up). A new medicine is checked before it is saved.
Lab Results – upload the PDF from the lab and view it any time, type in the numbers (one test or a whole panel), and see what is high or low, how far out of range, whether it is improving, and what it means.
Vital Signs – log readings (blood pressure, heart rate, glucose, weight…) and see trend charts. Each chart has its own value scale; hover a point to see the day and value.
Health Diary – symptom, medication and general notes.
My Links – insurance, pharmacy, patient portal and other health websites in one place (no passwords stored).
Share Records – make a temporary read-only code:
Healthcare provider code: only a logged-in physician account can open it.
Family or friend code: opens without an account at /view; the viewer must enter their name.
Choose which sections it shows, revoke any time, and see who viewed your records.
Physicians

Open a patient's shared record with their code (read-only). That is all a physician account can do with patient data.
Security built in: 2FA at every login, sessions end after 30 idle minutes or 12 hours, lockouts after repeated wrong passwords/codes/share codes (every attempt is counted before it is checked, so guesses sent at the same moment can't slip through), a security audit log, an access log patients can see, and every database class locked so browsers can't read or write it directly.

How it fits together
Browser (Vite/React)                       Back4app (Parse Server)
  pages call api('/medications', …)  ──►   Cloud Function "api"  (Parse/cloud/main.js)
  = Parse.Cloud.run('api', {method,           checks the session (30 min idle / 12 h max)
      path, query, body})                     router.js → medications.js / labs.js / …
                                              reads & writes classes with the master key
                                              (classes are locked: browsers can't touch them)
One door in. Every request goes through one Cloud Function, api, with the same paths the old server had (/medications, /labs/results, /share, …). So the pages barely changed.
Login (3 steps). api /login checks the password and emails a code → api /verify-2fa checks the code → the page calls Parse.User.logIn. A beforeLogin check refuses that last step unless the code was just verified, so the 2FA can't be skipped. Its refusal says Invalid username/password., the same text Parse gives for a wrong password, so calling Parse's /login directly cannot tell someone that a password guess was right.
Parse's own /login is separate from the app's rate limits. The limits in security.js protect api /login. Turn on Parse's account lockout as well (see "Deploying to Back4app", step 4).
Accounts can only be changed by Cloud Code (beforeSave on users). Nobody can make themselves a physician; that is done with the makePhysician function and the master key.
Project layout
Parse/
  cloud/                 ← uploaded to Back4app "Cloud Code" (the cloud folder)
    main.js              defines the Cloud Functions: api, makePhysician, setup, seedDemo
    app.js               serves the calendar subscribe feed (and the website, if you host it from Cloud Code)
    package.json         Cloud Code dependencies (nodemailer, for login emails)
    lib/
      router.js          maps method + path to the right module (like the old 2FAapi.js)
      auth.js            sign up, login + 2FA, sessions, password reset, makePhysician
      records.js         Health History record, share codes, who-viewed log
      medications.js     medications, doses (pill counts), refills
      labs.js            lab results (high/low), PDF reports (encrypted)
      safety.js          allergy + interaction checks
      vitals.js diary.js conditions.js calendar.js nutrition.js links.js
      reference.js       fixed lists: vital types, 30 lab tests, drug families, interactions
      setup.js           every class, its fields, and locked permissions (replaces the .sql files)
      security.js        rate limits, codes, encryption, NPI check digit, email
      db.js              small helpers for reading/writing Parse objects
      seed.js            the demo patient + doctor
  local/                 ← only for running on your own computer
    local-server.js      local Parse Server + the website on http://127.0.0.1:1337
    seed-demo.js         fills the local app with the demo accounts
Vite/
  serve.js               serves the built website on Back4app Web Deployment (security headers, CSP)
  src/parse.ts           connects to Parse (local or Back4app) — public keys only, never the Master Key
  src/api.ts             api(), apiUpload(), apiFile() → Parse.Cloud.run('api', …)
  src/pages/             one file per page (Login, Register, MedicalRecords, Medications, …)
  src/components/        shared pieces (NavigationBar, HealthHistoryForm, VitalTrendChart, …)
Run it on your computer
1. Install
Node.js (LTS)
PostgreSQL. Remember the password you set for the postgres user.
2. Create the database (once)
psql -U postgres -c "CREATE DATABASE mib_parse;"
No SQL files to run: the classes and fields are created automatically the first time the app starts. If your postgres password isn't 1234, set PARSE_DATABASE_URI=postgres://postgres:YOURPASSWORD@localhost:5432/mib_parse before starting.

3. Build the website
cd Vite
npm install
npm run build
4. Start
cd Parse/local
npm install
node local-server.js
Open http://127.0.0.1:1337. Login codes print in this window (no email needed locally: local-server.js sets MIB_DEV_MODE=true, which is what allows codes to be printed).

5. Demo data (optional)
With the server running, in another window: cd Parse/local then node seed-demo.js. It creates demo.patient@example.com / DemoPatient123 and demo.doctor@example.com / DemoDoctor123 full of made-up data (re-running rebuilds them). These passwords are public: never create them on a site that holds real people's data.

Making a physician account (local)
Sign up normally, then with the server running:

curl -X POST http://127.0.0.1:1337/parse/functions/makePhysician -H "X-Parse-Application-Id: mib-local" -H "X-Parse-Master-Key: mib-local-master-key" -H "Content-Type: application/json" -d "{\"email\":\"doctor@example.com\",\"npi\":\"1234567893\"}"
(1234567893 is a standard test NPI. The server only checks that an NPI's check digit is valid; it does not look the number up, so a physician account proves nothing about who the person is. Check a physician's identity yourself before running makePhysician.)

Deploying to Back4app
There are two parts: the Cloud Code (the API) and the website. The website is hosted with Back4app Web Deployment (Vite/serve.js).

Part 1: Cloud Code
Upload: Dashboard → Cloud Code → upload everything inside Parse/cloud/ into the cloud folder (main.js, app.js, package.json, lib/). Click Deploy. Upload app.js even if the website is hosted elsewhere: it also serves the calendar subscribe feed.
Environment variables: Server Settings → Environment Variables → Settings, one per line:
ENCRYPTION_KEY=<64 hex characters>
REQUIRE_ENCRYPTION=true
SMTP_USER=<project gmail address>
SMTP_PASS=<that gmail's app password>
USDA_API_KEY=<your USDA key>
TRUSTED_PROXY_HOPS=<number, see below>
ENCRYPTION_KEY (64 hex characters) encrypts uploaded files. Make one with node -e "console.log(require('crypto').randomBytes(32).toString('hex'))". Do not change it after files are uploaded, or those files cannot be opened.
REQUIRE_ENCRYPTION=true makes uploads fail (503) when there is no valid ENCRYPTION_KEY. Set it. The Privacy Policy says uploaded files are encrypted; without this setting a missing key would quietly store them unencrypted and that sentence would be false. To check it, remove the key on a test copy and try an upload: it must be refused.
SMTP_USER and SMTP_PASS send the login-code and reminder emails. A Gmail app password works for testing: use a project Gmail with 2-Step Verification and an app password, not a personal account. For real users, use a mail service for your own domain instead. Without them, login and password reset do not work (the server refuses to send, instead of writing codes into its log). Optional: SMTP_HOST, SMTP_PORT, SMTP_FROM, SMTP_SERVICE.
USDA_API_KEY is a free key from the USDA FoodData Central site. Without it the nutrition search uses DEMO_KEY, which is rate-limited.
TRUSTED_PROXY_HOPS tells the server which entry in X-Forwarded-For is the real client, which every rate limit depends on. If it is wrong, all callers may share one address (so a few bad guesses lock everyone out), or a caller may pick their own address (so the limits do nothing). Find the number: in the dashboard run the function debugClientIp (Master Key) with a made-up X-Forwarded-For header, see which entry is your address counted from the right, and set that number. With Cloudflare in front of a Back4app proxy it is probably 2 or more. Check it again whenever the hosting setup changes. See Parse/cloud/lib/clientip.js.
Demo sites only (fake data, no real people): MIB_DEV_MODE=true with no SMTP prints login codes in the Cloud Code logs, and adding MIB_SHOW_CODES=true shows them on screen. Never use either on a site with real users.
Settings: Server Settings → Core Settings: turn off "Allow client class creation".
Account lockout: turn on Parse's account lockout (lock for 15 minutes after 5 wrong passwords) in the app's Parse Server settings, if the dashboard offers it. The app's own limits only protect api /login, not Parse's built-in /login, which the browser calls in the last login step. (Parse/local/local-server.js sets accountLockout: { duration: 15, threshold: 5 } for local use.) If the dashboard has no such setting, ask Back4app support, or move the last login step into Cloud Code.
Set up the classes: API Console → REST Console (or Cloud Code Functions): run the setup function with Use Master Key ticked. (It also runs by itself on the first request.) Then run verifyLocked; it must answer { "ok": true }. Run verifyLocked after every deploy.
Physicians and demo data: in the same console, run makePhysician with {"email": "...", "npi": "..."}. seedDemo creates accounts with publicly known passwords: run it only on a test site.
Jobs: in the Back4app dashboard (Jobs) schedule:
sendReminders every 15 minutes. It creates the due reminder and alert notifications and sends the emails. (The local server runs the same work on a 5-minute timer.)
processAccountDeletions daily. It erases accounts whose 7-day waiting period is over, and expired PDF auto-fill drafts. Without it, deletion requests are never carried out.
Logs: By default, Parse Server writes the full result of every successful Cloud Function call to its log, and those results hold health data. The local server turns this off with logLevels: { cloudFunctionSuccess: "silent" } in Parse/local/local-server.js; errors are still logged. On Back4app, set the same log level to silent in the app's Parse Server settings if the dashboard offers it. If it does not, health data will appear in Back4app's logs. That is a known risk to accept. (The calendar subscribe link's secret does not pass through the server: the browser makes it and sends only its SHA-256, so it can't appear in these logs. Back4app's own proxy logs may still record the feed address when a calendar app fetches it.) The log does record the link's token_hash from the create request (the hash only, never the token). A hash is not a secret on its own, since it can't be turned back into the link. But it is one reason every hash ever registered is kept in UsedFeedHash and can never be registered again. Keep cloudFunctionSuccess silent wherever you can.
Client IP for the calendar feed: the audit record stores the first X-Forwarded-For value, or no IP when that header is missing. Back4app does not document its proxy chain, so this first value is whatever the first hop sent: a client can set it, and it may not be the real address. The limit on bad requests (120 an hour) counts by the right-most X-Forwarded-For value instead, which is the one Back4app's proxy adds, so a client can't choose it. When the header is missing, every bad request counts against Back4app's own proxy address, and the limit is shared by every caller. IPv6 addresses are counted per /64 network. At most 10,000 addresses are tracked. When the table is full, a new address takes the place of one with fewer than 10 bad requests in the hour; blocked and near-blocked addresses are never dropped. If every tracked address has 10 or more, a bad request from a new address is refused until entries expire. A valid link still works from any address.
Cloud Code web address: Server Settings → Web Hosting: enable it and pick a subdomain (for example https://<subdomain>.b4a.app). The calendar feed is served there, so give this address to the website as VITE_FEED_BASE_URL (Part 2).
Part 2: the website (Back4app Web Deployment)
Folder: Vite/. Build: npm run build. Start: node serve.js. serve.js uses only Node's built-in modules because Back4app removes dev dependencies after the build. Vite/package.json has no start script; if the platform insists on npm start, add "start": "node serve.js" to its scripts.
Port: the Port setting in Back4app must match the PORT variable (default 5173).
Environment variables (website):
CSP_MODE=enforce: serve.js first sends the Content-Security-Policy in report-only mode (the browser console lists what it would block, nothing breaks). Open the site, use every page (documents and lab PDFs open in a frame; the emergency form opens from a blob link), and check the console for "Content-Security-Policy" messages. When it is clean, set CSP_MODE=enforce. Until then the policy does not protect anything.
PARSE_API_ORIGIN: only if the API is not https://parseapi.back4app.com.
VITE_FEED_BASE_URL (set before the build): the Cloud Code web address from Part 1, step 10.
Custom domain: with Cloudflare in front, keep HTTPS-only. serve.js already sends Strict-Transport-Security, X-Frame-Options, Referrer-Policy, Permissions-Policy and Cross-Origin-Opener-Policy.
Alternative: the website can also be served from the Cloud Code public folder (upload everything inside Vite/dist/ to public; Parse/cloud/app.js serves it). That path sends fewer security headers and no Content-Security-Policy, so prefer Web Deployment.
The App ID and JavaScript key in Vite/src/parse.ts are public by design. The Master Key stays in the Back4app dashboard only — never in the code.

Before release
 Check the FLUSH_TERMS list in Parse/cloud/lib/disposal.js against the current FDA flush list (https://www.fda.gov/drugs/disposal-unused-medicines-what-you-should-know/drug-disposal-fdas-flush-list-certain-medicines). The list was compiled from search excerpts, not the full page.
 Open each link in LINKS in Parse/cloud/lib/disposal.js (DEA locator, DEA Take Back Day, FDA disposal page, FDA flush list, FDA sharps page) and fix any that fail.
 Have a clinician review the peak-flow advice wording in Parse/cloud/lib/respiratory.js (peakFlowSummary).
 Run the local server with seedDemo and check each new page at 390 px and 1280 px width, and that a physician account gets 403 on /disposal.
 Confirm the medication "Took it" behaviour (Vite/src/components/NotificationBell.tsx) is acceptable: if a mark-as-read call fails and the page reloads, the button can reappear for a dose already logged.
 Confirm calendar downloads: events saved before time zones were stored are written in UTC until they are edited once.
 On Back4app, set Cloud Function success logging (cloudFunctionSuccess) to silent in the app's Parse Server settings, if the dashboard offers it. If it does not, health data will appear in Back4app's logs; accept that risk knowingly. The same log also holds each calendar link's token_hash (not the token). That is not a secret on its own, and the UsedFeedHash record stops it from being registered again, but keep this logging silent wherever you can. See step 8 of "Deploying to Back4app".
 On Back4app, fetch a /calendar/feed/... link from two different networks and check that the right-most X-Forwarded-For value differs between them, i.e. that it is each client's own address and not the address of a Back4app proxy. If it is a proxy address, every caller shares one bad-link limit. Also note that the bad-link limit (120 an hour per address) is kept in memory per server instance: with several instances an address gets up to 120 per instance, and the counts reset when an instance restarts. See step 9 of "Deploying to Back4app".
 Login guessing: with the live site, send a wrong password and then the right password straight to Parse's /login (the curl pair below). The two answers must be the same text (Invalid username/password.), and repeated wrong passwords must lock the account. If either is not true, fix it before real users sign up.
 TRUSTED_PROXY_HOPS is set and was checked with debugClientIp (step 2).
 REQUIRE_ENCRYPTION=true and a valid ENCRYPTION_KEY are set, and an upload without the key is refused (step 2).
 CSP_MODE=enforce is set and the browser console is clean (Part 2).
 verifyLocked answers { "ok": true } (step 5).
 Both jobs are scheduled: sendReminders and processAccountDeletions (step 7).
 seedDemo has not been run on the live site, and MIB_DEV_MODE / MIB_SHOW_CODES are not set on it.
 npm audit in Vite/ and Parse/local/ shows nothing serious that reaches production, and Parse/cloud/package-lock.json is committed.
Login-guessing check (replace the placeholders; use your own test account):

curl -s -X POST https://parseapi.back4app.com/login -H "X-Parse-Application-Id: <app id>" -H "X-Parse-Javascript-Key: <js key>" -H "Content-Type: application/json" -d '{"username":"you@example.com","password":"wrong"}'
curl -s -X POST https://parseapi.back4app.com/login -H "X-Parse-Application-Id: <app id>" -H "X-Parse-Javascript-Key: <js key>" -H "Content-Type: application/json" -d '{"username":"you@example.com","password":"<the real password>"}'
Known limits
Calendar .ics files have no VTIMEZONE block (older calendar apps may need one).
Reminders are sent by email only (no SMS).
Nutrition day totals use the patient's browser time zone.
Locking an account after 5 wrong passwords also lets someone who knows an email address lock its owner out for 15 minutes. That is the cost of the protection.
Working on the frontend
Live reload: keep local-server.js running, then in Vite/ run npm run dev and open the address it prints. Parse calls are passed through to port 1337.
Lint: npm run lint in Vite/.
New page styles go in Vite/src/features.css.
Rebuild (npm run build) before testing on port 1337.
After pulling changes
npm install in Vite/ and Parse/local/ if their package files changed.
Rebuild the website.
Restart local-server.js (new fields are added automatically).
Security and compliance notes
This is a patient-controlled personal health record, which is generally not covered by HIPAA. The FTC Health Breach Notification Rule and Florida's breach law (FIPA) apply instead. HIPAA would apply if a clinic used it for its patients — and Back4app only signs a HIPAA agreement on its Dedicated plan. (Not legal advice.)
Do not describe the app as "HIPAA compliant" anywhere, and keep every security statement in the Privacy Policy true: each one is a promise (for example "uploaded files are encrypted" and "limits on repeated wrong guesses"), and a false one is a deceptive claim under the FTC Act.
Use only fake test data on the free hosting.
Every class is locked to the master key; browsers can only call the api function, which only touches the logged-in user's own data.
Physicians are read-only: they can only open what a patient shares with them.
Logins, resets, record edits, sharing, lab and link changes are logged in the AuditLog class. Every view of a shared record is logged in AccessLog.
Lab PDFs are checked to be real PDFs, limited to 8 MB, stored encrypted with ENCRYPTION_KEY (uploads are refused without a key when REQUIRE_ENCRYPTION=true), and only returned to their owner.
Medication safety warnings cover common drugs only and are a safety net, not a pharmacist's review.
Not finished yet
Lab results and safety warnings aren't included in share codes yet.
GIT COMMAND LINE TUTORIAL
If you don't have the repo set up yet:

git clone https://github.com/willmurray461/medicaldata
This will download the repo into whatever directory your terminal is currently in
I recommend running cd Desktop or cd Downloads beforehand to put the folder in your Desktop or Downloads
To open the repo with vscode, in that same terminal type: code medicaldata

Basic git commit workflow:

cd C:\Example\Path\To\medicaldata (Windows) cd ~/Example/Path/To/medicaldata (Mac/Linux)
This takes your terminal to wherever the repo is stored locally on your computer
Alternatively, if you opened the folder in vscode, just select the Terminal->New Terminal and you should automatically be taken to the right path
git pull
This refreshes your local copy of the repo to have the latest changes (VERY IMPORTANT!!!)
If you get a warning about resolving divergent branches your pull did not go through. You must figure out how to resolve the merge yourself before continuing!
git status
This will show you a list of files that you have modified
git add [put the files you want to commit here separated by spaces]
This is where you choose what files to push to the repo
git commit -m"[describe what you did here]"
This is where you set the commit message
git push
This pushes the files you configured earlier to GitHub
Using GitHub Desktop instead:

Fetch origin, then Pull origin to get changes made on GitHub
Commit your changes in the Changes tab, then Push origin
