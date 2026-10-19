// disposal.js — Safe medication disposal (Task 6-1).
//   GET    /disposal/methods          the eight disposal methods, with steps and links
//   GET    /disposal/guidance         how to dispose of one medicine (name, brand, form, route)
//   GET    /disposal/due              stopped, completed or expired medicines still on hand (flush list first)
//   GET    /disposal/logs             disposal history
//   POST   /disposal/logs             record a disposal; takes the quantity off the medicine's count
//   DELETE /disposal/logs/:id         remove a history entry (the count is not changed back)
// Classes: DisposalLog (Medication is read and updated)
//
// The lists below are matched by whole words, in order: "norco" matches "Norco 10/325",
// "ms contin" needs both words. Check them against the current FDA and DEA pages (LINKS)
// whenever they change.

const { isId, isDate, today, toRow, findAll, getOwned, save, create, destroy, audit, param, optText, maxDate, fail } = require("./db");
const { medRow, withInventoryInfo } = require("./medications");

const GENERAL_NOTE = "General guidance, not a pharmacist. Follow the label, and ask your pharmacist if you're unsure.";
const LOG_FIELDS = ["user_id", "medication_id", "medication_name", "method", "location", "disposed_date", "notes", "quantity"];
const logRow = (o) => toRow(o, "disposal_id", LOG_FIELDS);

const LINKS = {
  dea_locator: { label: "DEA drug disposal locator", url: "https://apps.deadiversion.usdoj.gov/pubdispsearch" },
  dea_take_back: { label: "DEA National Take Back Day", url: "https://www.dea.gov/takebackday" },
  fda_disposal: { label: "FDA: where and how to dispose of unused medicines", url: "https://www.fda.gov/consumers/consumer-updates/where-and-how-dispose-unused-medicines" },
  fda_flush: { label: "FDA flush list for certain medicines", url: "https://www.fda.gov/drugs/disposal-unused-medicines-what-you-should-know/drug-disposal-fdas-flush-list-certain-medicines" },
  fda_sharps: { label: "FDA: safe disposal of needles and syringes", url: "https://www.fda.gov/medical-devices/safely-using-medical-devices-home/safe-disposal-needles-and-syringes" },
};

const METHODS = {
  take_back: {
    title: "Take it to a take-back site",
    summary: "The safest choice. Many pharmacies, police stations and clinics have drop boxes that accept most medicines.",
    steps: [
      "Find a drop box with the DEA locator, or ask your pharmacy.",
      "Keep the medicine in its container or a sealed bag.",
      "Drop it off. Most sites don't need your name or a receipt.",
    ],
    links: ["dea_locator", "dea_take_back", "fda_disposal"],
  },
  flush: {
    title: "Flush it down the toilet",
    summary: "This medicine is on the FDA flush list. One accidental dose can be fatal, especially for a child, so flush it only when no take-back site is near you.",
    steps: [
      "Look for a take-back site first. Flush only if none is available.",
      "Don't crush or dissolve tablets. Flush them whole.",
      "Flush it, then keep the empty container out of reach of children and pets.",
    ],
    links: ["fda_flush", "dea_locator"],
  },
  flush_patch: {
    title: "Fold the patch and flush it",
    summary: "A used patch still contains medicine. This one is on the FDA flush list.",
    steps: [
      "Fold the used patch in half, sticky sides together.",
      "Flush it if no take-back site is near you.",
      "Wash your hands. Keep unused patches out of reach of children and pets.",
    ],
    links: ["fda_flush", "dea_locator"],
  },
  trash: {
    title: "Mix it and put it in the trash",
    summary: "Most leftover medicines can go in the household trash when no take-back site is near you.",
    steps: [
      "Mix the medicine with something unappealing, like used coffee grounds, dirt or cat litter.",
      "Seal the mixture in a bag or container and put it in the trash.",
      "Scratch out your name and Rx number on the empty bottle, then recycle or trash it.",
    ],
    links: ["fda_disposal", "dea_locator"],
  },
  patch: {
    title: "Fold the patch and put it in the trash",
    summary: "A used patch still contains medicine, so fold it to protect people and pets.",
    steps: [
      "Fold the used patch in half, sticky sides together.",
      "Put it in the household trash, out of reach of children and pets.",
      "Wash your hands.",
    ],
    links: ["fda_disposal", "dea_take_back"],
  },
  inhaler: {
    title: "Inhaler: ask your pharmacy first",
    summary: "Some pharmacies and manufacturers run inhaler take-back programs. Don't puncture or burn the inhaler.",
    steps: [
      "Ask your pharmacy whether it takes inhalers back.",
      "If not, don't puncture or burn it. Seal it in a bag and put it in the household trash.",
    ],
    links: ["fda_disposal", "dea_locator"],
  },
  sharps: {
    title: "Needles and syringes: sharps container",
    summary: "Loose needles can injure people who handle the trash. Put them in a sharps container.",
    steps: [
      "Put used needles, syringes and pens in a sharps container, or a heavy plastic bottle with a screw cap.",
      "Don't recap, bend or break needles.",
      "When the container is about three-quarters full, seal it and take it to a pharmacy, clinic or sharps drop-off, or follow your local rules.",
    ],
    links: ["fda_sharps"],
  },
  controlled: {
    title: "Controlled medicine: take-back first",
    summary: "This is a controlled substance, such as an opioid, benzodiazepine or stimulant. Take it to a take-back site, and never give it to anyone else.",
    steps: [
      "Use a DEA take-back drop box at a pharmacy or police station, or a mail-back envelope from your pharmacy.",
      "If none is near you, follow the trash steps.",
      "Keep the bottle locked up or out of sight until you dispose of it.",
    ],
    links: ["dea_locator", "dea_take_back", "fda_disposal"],
  },
};
const METHOD_KEYS = Object.keys(METHODS);

// FDA flush list: active ingredients and brand examples. The FDA page is the authority.
const FLUSH_TERMS = [
  "buprenorphine", "belbuca", "buavail", "butrans", "suboxone", "subutex", "zubsolv",
  "fentanyl", "abstral", "actiq", "duragesic", "fentora", "onsolis",
  "hydrocodone", "benzhydrocodone", "apadaz", "hysingla", "norco", "reprexain", "vicodin", "vicoprofen", "zohydro",
  "hydromorphone", "exalgo",
  "meperidine", "demerol",
  "methadone", "dolophine", "methadose",
  "morphine", "arymo", "morphabond", "ms contin",
  "oxycodone", "oxycontin", "roxicodone", "oxaydo", "xtampza", "percocet", "endocet",
  "oxymorphone", "opana",
  "tapentadol", "nucynta",
  "diastat",
];

// Controlled substances (benzodiazepines, opioids, stimulants and other scheduled drugs)
const CONTROLLED_TERMS = [
  "alprazolam", "xanax", "lorazepam", "ativan", "clonazepam", "klonopin", "diazepam", "valium",
  "temazepam", "restoril", "triazolam", "halcion", "chlordiazepoxide", "oxazepam", "clorazepate",
  "codeine", "tramadol", "ultram",
  "amphetamine", "adderall", "dextroamphetamine", "methylphenidate", "ritalin", "concerta",
  "lisdexamfetamine", "vyvanse", "dexmethylphenidate", "focalin", "modafinil", "provigil",
  "armodafinil", "nuvigil", "phentermine", "adipex",
  "zolpidem", "ambien", "eszopiclone", "lunesta", "phenobarbital",
];

const tokens = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);

// whole words, in order: "ms contin" matches "MS Contin 15 mg", not "amsterdam"
function findTerm(nameTokens, terms) {
  for (const term of terms) {
    const t = tokens(term);
    for (let i = 0; i + t.length <= nameTokens.length; i++) {
      if (t.every((word, j) => nameTokens[i + j] === word)) return term;
    }
  }
  return null;
}

// Order matters: injection, then flush list, inhaler, controlled, patch, and trash last.
function decide({ medication_name, brand_name, dosage_form, route }) {
  const name = tokens(`${medication_name || ""} ${brand_name || ""}`);
  const form = String(dosage_form || "").toLowerCase();
  const via = String(route || "").toLowerCase();
  const isPatch = form === "patch" || via === "transdermal";
  const isInhaler = form === "inhaler" || via === "inhalation";
  if (form === "injection" || via === "injection") return { method: "sharps" };
  const flush = findTerm(name, FLUSH_TERMS);
  if (flush) return { method: isPatch ? "flush_patch" : "flush", matched: flush };
  if (isInhaler) return { method: "inhaler" };
  const controlled = findTerm(name, CONTROLLED_TERMS);
  if (controlled) return { method: "controlled", matched: controlled };
  if (isPatch) return { method: "patch" };
  return { method: "trash" };
}

const pickLinks = (keys) => keys.map((k) => ({ key: k, ...LINKS[k] }));

function guidanceFor(med) {
  const d = decide(med);
  const m = METHODS[d.method];
  return {
    method: d.method,
    title: m.title,
    summary: m.summary,
    steps: m.steps,
    links: pickLinks(m.links),
    on_flush_list: d.method.startsWith("flush"),
  };
}

// GET /disposal/methods
function methods() {
  return {
    status: 200,
    methods: METHOD_KEYS.map((key) => ({ key, title: METHODS[key].title, summary: METHODS[key].summary, steps: METHODS[key].steps, links: pickLinks(METHODS[key].links) })),
    note: GENERAL_NOTE,
  };
}

// GET /disposal/guidance?name=&brand=&form=&route=
function guidance(query) {
  const name = param(query, "name");
  const brand = param(query, "brand");
  if (!name && !brand) return fail(400, "Type the medicine's name");
  if (String(name || "").length > 200 || String(brand || "").length > 200) return fail(400, "Names must be 200 characters or fewer");
  const med = {
    medication_name: name, brand_name: brand,
    dosage_form: param(query, "form"), route: param(query, "route"),
  };
  return { status: 200, guidance: guidanceFor(med), note: GENERAL_NOTE };
}

// GET /disposal/due — medicines still on hand that are stopped, completed or past their end date
async function due(user) {
  const t = today();
  const meds = (await findAll("Medication", { user_id: user.user_id })).map(medRow);
  const rows = meds
    .filter((m) => Number(m.quantity_on_hand) > 0 &&
      (m.status === "completed" || m.status === "discontinued" || (m.end_date && m.end_date < t)))
    .map((m) => ({
      medication_id: m.medication_id, medication_name: m.medication_name, brand_name: m.brand_name,
      dosage_form: m.dosage_form, quantity_on_hand: Number(m.quantity_on_hand), status: m.status,
      end_date: m.end_date, guidance: guidanceFor(m),
    }));
  rows.sort((a, b) => Number(b.guidance.on_flush_list) - Number(a.guidance.on_flush_list) ||
    String(a.medication_name || "").localeCompare(String(b.medication_name || "")));
  return { status: 200, medications: rows, note: GENERAL_NOTE };
}

// GET /disposal/logs
async function listLogs(user) {
  const logs = await findAll("DisposalLog", { user_id: user.user_id }, { descending: "disposed_date" });
  return { status: 200, logs: logs.map(logRow) };
}

// Quantities may have decimals (12.5 mL), up to 2 places. Counts are compared with a tolerance so float error
// (0.1 + 0.2) never leaves a remainder or refuses an exact amount.
const TOLERANCE = 0.000001;
const QUANTITY_ERROR = "Quantity must be a number above 0 and up to 100,000, with at most 2 decimal places";
// A count with float noise removed; anything under the tolerance is 0
const cleanCount = (n) => (Math.abs(n) < TOLERANCE ? 0 : Math.round(n * 1e6) / 1e6);
// The quantity as a number, or null. A number, or a string of digits with up to 2 decimals: Number() alone would accept true, [5] and similar.
function readQuantity(q) {
  let n = NaN;
  if (typeof q === "number") n = q;
  else if (typeof q === "string" && /^\d+(\.\d{1,2})?$/.test(q)) n = Number(q);
  if (!Number.isFinite(n) || n <= 0 || n > 100000) return null;
  if (Math.abs(n * 100 - Math.round(n * 100)) > TOLERANCE) return null;
  const rounded = Math.round(n * 100) / 100;
  return rounded > 0 ? rounded : null;   // something like 1e-9 rounds to 0.00: the smallest quantity is 0.01
}

// POST /disposal/logs {medication_id | medication_name, quantity, method, location?, disposed_date?, notes?}
async function createLog(body, user, ctx) {
  const quantity = readQuantity(body.quantity);
  if (quantity === null) return fail(400, QUANTITY_ERROR);
  if (!METHOD_KEYS.includes(body.method)) return fail(400, "Choose how you got rid of it");

  const location = optText(body.location, 200, "Location");
  if (location.error) return fail(400, location.error);
  const notes = optText(body.notes, 500, "Notes");
  if (notes.error) return fail(400, notes.error);

  const date = body.disposed_date || today();
  if (!isDate(date)) return fail(400, "Use the date format YYYY-MM-DD");
  if (date > maxDate()) return fail(400, "The disposal date can't be in the future");

  let med = null;
  let name = null;
  if (body.medication_id) {
    if (!isId(body.medication_id)) return fail(400, "Invalid medication ID");
    med = await getOwned("Medication", body.medication_id, user.user_id);
    if (!med) return fail(404, "Medication not found");
  } else {
    name = typeof body.medication_name === "string" ? body.medication_name.trim() : "";
    if (!name) return fail(400, "Choose the medicine, or type its name");
    if (name.length > 200) return fail(400, "Medicine name must be 200 characters or fewer");
    const wanted = name.toLowerCase();
    const matches = (await findAll("Medication", { user_id: user.user_id }))
      .filter((m) => String(m.get("medication_name") || "").trim().toLowerCase() === wanted)
      .sort((a, b) => (Number(b.get("quantity_on_hand")) || 0) - (Number(a.get("quantity_on_hand")) || 0));
    med = matches[0] || null;
  }

  const onHand = med ? Number(med.get("quantity_on_hand")) || 0 : null;
  // A medicine typed by name whose count is 0 (used up, or never counted) is recorded as it is: the count stays 0.
  // A medication_id match, or a named match with stock, can't dispose of more than is on hand.
  const countsStock = !!med && (!!body.medication_id || onHand > TOLERANCE);
  if (countsStock && quantity > onHand + TOLERANCE) return fail(400, `Only ${cleanCount(onHand)} left on hand`);

  // The medicine's count is updated first: if that can't be saved, nothing is recorded (no history entry for a count that never changed)
  let medication = null, medAudit = null;
  if (med && !countsStock) medication = withInventoryInfo(medRow(med));
  if (countsStock) {
    const oldData = medRow(med);
    const left = cleanCount(Math.max(0, onHand - quantity));   // never negative; 0 when float error leaves a remainder under the tolerance
    const changes = { quantity_on_hand: left };
    if (left === 0 && med.get("status") === "active") {
      changes.status = "completed";
      if (!med.get("end_date")) changes.end_date = today();
    }
    try { await save(med, changes); }
    catch (err) {
      console.error("disposal: medication save failed:", err.message);
      return fail(500, "Couldn't update the medicine's count, so nothing was recorded. Try again.");
    }
    const newData = medRow(med);
    medAudit = { userId: user.user_id, event: "UPDATE", targetClass: "Medication", targetId: med.id, oldData, newData, ip: ctx.ip };
    medication = withInventoryInfo(newData);
  }

  const log = await create("DisposalLog", {
    user_id: user.user_id,
    medication_id: med ? med.id : null,
    medication_name: med ? med.get("medication_name") : name,
    method: body.method,
    location: location.value,
    disposed_date: date,
    notes: notes.value,
    quantity,
  });
  const row = logRow(log);
  await audit({ userId: user.user_id, event: "INSERT", targetClass: "DisposalLog", targetId: log.id, newData: row, ip: ctx.ip });
  if (medAudit) await audit(medAudit);
  return { status: 201, message: "Disposal recorded", log: row, medication };
}

// DELETE /disposal/logs/:id — removes the history entry only; the count is not changed back
async function removeLog(id, user, ctx) {
  if (!isId(id)) return fail(400, "Invalid disposal record ID");
  const log = await getOwned("DisposalLog", id, user.user_id);
  if (!log) return fail(404, "Disposal record not found");
  const oldData = logRow(log);
  await destroy(log);
  await audit({ userId: user.user_id, event: "DELETE", targetClass: "DisposalLog", targetId: id, oldData, ip: ctx.ip });
  return { status: 200, message: "Disposal record removed" };
}

module.exports = { methods, guidance, due, listLogs, createLog, removeLog, guidanceFor, decide, GENERAL_NOTE, TOLERANCE };
