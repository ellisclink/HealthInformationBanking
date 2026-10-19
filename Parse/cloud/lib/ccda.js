// Parse/cloud/lib/ccda.js
// Parses a C-CDA XML file into plain JSON. Does NOT write to the database.
// Never log the XML or the parsed result (health data).
const { transform } = require("camaro");

const MAX_BYTES = 8 * 1024 * 1024;
const ln = (n) => `*[local-name()='${n}']`;
const sec = (oid) => `//${ln("section")}[${ln("templateId")}/@root='${oid}']`;

// C-CDA R2.1 section template OIDs
const SECTIONS = {
  medications: "2.16.840.1.113883.10.20.22.2.1.1",
  problems: "2.16.840.1.113883.10.20.22.2.5.1",
  allergies: "2.16.840.1.113883.10.20.22.2.6.1",
  immunizations: "2.16.840.1.113883.10.20.22.2.2.1",
  vitals: "2.16.840.1.113883.10.20.22.2.4.1",
  procedures: "2.16.840.1.113883.10.20.22.2.7.1",
  social: "2.16.840.1.113883.10.20.22.2.17",
};

// Rows are read one <tr> at a time, so columns can't drift out of line the way
// parallel arrays do. Columns are matched by header text, not by position.
const sectionTemplate = (oid) => ({
  headers: [`${sec(oid)}//${ln("thead")}//${ln("th")}`, "normalize-space(.)"],
  rows: [`${sec(oid)}//${ln("tbody")}/${ln("tr")}`, { cells: [ln("td"), "normalize-space(.)"] }],
});

const template = {
  isCcda: `count(//${ln("ClinicalDocument")})`,
  patient: {
    givenName: `//${ln("recordTarget")}//${ln("patient")}/${ln("name")}/${ln("given")}`,
    familyName: `//${ln("recordTarget")}//${ln("patient")}/${ln("name")}/${ln("family")}`,
    birthDate: `//${ln("recordTarget")}//${ln("birthTime")}/@value`,
    gender: `//${ln("recordTarget")}//${ln("administrativeGenderCode")}/@displayName`,
    maritalStatus: `//${ln("recordTarget")}//${ln("maritalStatusCode")}/@displayName`,
    street: `//${ln("recordTarget")}/${ln("patientRole")}/${ln("addr")}/${ln("streetAddressLine")}`,
    city: `//${ln("recordTarget")}/${ln("patientRole")}/${ln("addr")}/${ln("city")}`,
    state: `//${ln("recordTarget")}/${ln("patientRole")}/${ln("addr")}/${ln("state")}`,
    postalCode: `//${ln("recordTarget")}/${ln("patientRole")}/${ln("addr")}/${ln("postalCode")}`,
    telephone: `//${ln("recordTarget")}/${ln("patientRole")}/${ln("telecom")}[1]/@value`,
  },
  ...Object.fromEntries(Object.entries(SECTIONS).map(([k, oid]) => [k, sectionTemplate(oid)])),
};

// Turn { headers, rows:[{cells}] } into [{ "medication": "...", "status": "..." }, ...]
function toObjects(section) {
  const headers = (section.headers || []).map((h) => h.toLowerCase());
  return (section.rows || [])
    .filter((r) => r.cells.some(Boolean))
    .map((r) => Object.fromEntries(r.cells.map((c, i) => [headers[i] || `col${i + 1}`, c])));
}

// YYYYMMDD[HHMMSS] -> YYYY-MM-DD
const hl7Date = (v) => (/^\d{8}/.test(v || "") ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : null);

async function parseCcda(buffer) {
  if (!buffer || buffer.length === 0) throw new Error("The file is empty");
  if (buffer.length > MAX_BYTES) throw new Error("That file is too large (8 MB max)");
  const head = buffer.slice(0, 4096).toString("utf8");
  if (/<!DOCTYPE|<!ENTITY/i.test(head)) throw new Error("This XML file isn't allowed");

  let r;
  try { r = await transform(buffer, template); }
  catch { throw new Error("That file isn't valid XML"); }
  if (!Number(r.isCcda)) throw new Error("That XML file isn't a C-CDA document");

  const p = r.patient;
  return {
    patient: {
      name: [p.givenName, p.familyName].filter(Boolean).join(" ") || null,
      birth_date: hl7Date(p.birthDate),
      gender: p.gender || null,
      marital_status: p.maritalStatus || null,
      address: [p.street, p.city, p.state, p.postalCode].filter(Boolean).join(", ") || null,
      telephone: p.telephone ? p.telephone.split(":").pop() : null,
    },
    medications: toObjects(r.medications),
    problems: toObjects(r.problems),
    allergies: toObjects(r.allergies),
    immunizations: toObjects(r.immunizations),
    vitals: toObjects(r.vitals),
    procedures: toObjects(r.procedures),
    social_history: toObjects(r.social),
  };
}

module.exports = { parseCcda };
