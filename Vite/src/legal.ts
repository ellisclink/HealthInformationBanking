// legal.ts — the details that appear in the Terms of Service and the Privacy Policy.
//
// BEFORE LAUNCH:
//   1. Fill in every value marked "FILL IN" below (the pages show them in the text).
//   2. Have a lawyer who knows health-data and privacy law read both pages (Terms.tsx, Privacy.tsx). They are a starting draft, not legal advice.
//   3. Set LEGAL_DRAFT to false. While it is true, both pages show a banner saying they are drafts.
// The Medical Disclaimer (pages/Disclaimer.tsx) is versioned together with the Terms and Privacy Policy.
// When you change any of the three in a way people must agree to again, change TERMS_VERSION here AND in Parse/cloud/lib/legal.js.
// Every account is then asked to accept the new version the next time they open the app.

export const SITE_NAME = "Health Information Banking";
export const SITE_SHORT = "HIB";

// No legal owner has been chosen yet, so this uses the product name as a stand-in. It is NOT a legal entity. Before launch,
// replace it with whoever actually runs the service (a registered company, or a named person) and keep LEGAL_DRAFT = true until then.
export const COMPANY_NAME = "Health Information Banking";
export const COMPANY_ADDRESS = "271 NE 26th St, Boca Raton, Florida 33431";
export const CONTACT_EMAIL = "healthinformationbanking@gmail.com";
export const PRIVACY_EMAIL = "healthinformationbanking@gmail.com";
export const GOVERNING_STATE = "Florida";

export const TERMS_VERSION = "2026-10-25";      // must match Parse/cloud/lib/legal.js
export const EFFECTIVE_DATE = "October 25, 2026";
export const MIN_AGE = 18;

export const LEGAL_DRAFT = true;
