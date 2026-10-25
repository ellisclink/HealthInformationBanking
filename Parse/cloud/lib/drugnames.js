// drugnames.js — recognising the same medicine written different ways (Task 8-2). Pure functions: no database.
//
//   ingredientsOf("Zestril 10 mg")        -> ["lisinopril"]          brand -> generic
//   ingredientsOf("Vitamin D3", "Cholecalciferol") -> ["vitamin d"]  supplement names
//   ingredientsOf("Lisinopril-HCTZ")      -> ["hydrochlorothiazide", "lisinopril"]   a combination is several ingredients
//   compareMedicines(a, b)                -> { level, ... }  see below
//
// How careful it is: a medicine counts as "the same" only when it has exactly the same ingredient(s). A different drug in the
// same family (enalapril vs lisinopril) is NEVER a match. The dose is compared after changing units (0.05 mg = 50 mcg):
//   exact        same ingredient(s) and the same strength           -> a true duplicate
//   dose_change  same ingredient(s) but a different strength          -> shown to the patient, never hidden
//   possible     overlapping ingredients, or a strength that is missing or can't be compared (IU vs mcg)
//   none         nothing in common
// Matching errs on the side of SHOWING a possible duplicate: it is only ever used to warn, and to stop an EXACT repeat.

const { DRUG_CLASS_MEMBERS } = require("./reference");

// brand -> generic (lower case). Brands already listed in reference.js are included so the two lists agree.
const BRANDS = {
  zestril: "lisinopril", prinivil: "lisinopril", qbrelis: "lisinopril", vasotec: "enalapril", lotensin: "benazepril", altace: "ramipril", accupril: "quinapril",
  cozaar: "losartan", diovan: "valsartan", benicar: "olmesartan", micardis: "telmisartan", avapro: "irbesartan", atacand: "candesartan",
  coumadin: "warfarin", jantoven: "warfarin", eliquis: "apixaban", xarelto: "rivaroxaban", pradaxa: "dabigatran", lovenox: "enoxaparin",
  plavix: "clopidogrel", brilinta: "ticagrelor", effient: "prasugrel", bayer: "aspirin", ecotrin: "aspirin",
  xanax: "alprazolam", ativan: "lorazepam", klonopin: "clonazepam", valium: "diazepam", restoril: "temazepam",
  keflex: "cephalexin", rocephin: "ceftriaxone", cipro: "ciprofloxacin", levaquin: "levofloxacin", zithromax: "azithromycin", "z-pak": "azithromycin",
  biaxin: "clarithromycin", amoxil: "amoxicillin", augmentin: "amoxicillin+clavulanate", bactrim: "sulfamethoxazole+trimethoprim", septra: "sulfamethoxazole+trimethoprim",
  nardil: "phenelzine", parnate: "tranylcypromine", nitrostat: "nitroglycerin", imdur: "isosorbide mononitrate", isordil: "isosorbide dinitrate",
  advil: "ibuprofen", motrin: "ibuprofen", aleve: "naproxen", naprosyn: "naproxen", celebrex: "celecoxib", mobic: "meloxicam", voltaren: "diclofenac",
  tylenol: "acetaminophen", paracetamol: "acetaminophen", apap: "acetaminophen",
  dilaudid: "hydromorphone", norco: "hydrocodone+acetaminophen", vicodin: "hydrocodone+acetaminophen", percocet: "oxycodone+acetaminophen",
  oxycontin: "oxycodone", ultram: "tramadol", cialis: "tadalafil", viagra: "sildenafil", revatio: "sildenafil", levitra: "vardenafil",
  aldactone: "spironolactone", lasix: "furosemide", microzide: "hydrochlorothiazide", hctz: "hydrochlorothiazide", bumex: "bumetanide",
  "k-dur": "potassium chloride", "klor-con": "potassium chloride",
  celexa: "citalopram", cymbalta: "duloxetine", effexor: "venlafaxine", lexapro: "escitalopram", paxil: "paroxetine", prozac: "fluoxetine", zoloft: "sertraline",
  wellbutrin: "bupropion", desyrel: "trazodone", remeron: "mirtazapine", seroquel: "quetiapine", abilify: "aripiprazole", zyprexa: "olanzapine", risperdal: "risperidone",
  lamictal: "lamotrigine", depakote: "divalproex", keppra: "levetiracetam", topamax: "topiramate", neurontin: "gabapentin", lyrica: "pregabalin", tegretol: "carbamazepine",
  lipitor: "atorvastatin", crestor: "rosuvastatin", zocor: "simvastatin", pravachol: "pravastatin", zetia: "ezetimibe", tricor: "fenofibrate",
  glucophage: "metformin", januvia: "sitagliptin", jardiance: "empagliflozin", farxiga: "dapagliflozin", actos: "pioglitazone", amaryl: "glimepiride", glucotrol: "glipizide",
  lantus: "insulin glargine", basaglar: "insulin glargine", levemir: "insulin detemir", humalog: "insulin lispro", novolog: "insulin aspart", ozempic: "semaglutide", victoza: "liraglutide",
  norvasc: "amlodipine", cardizem: "diltiazem", calan: "verapamil", procardia: "nifedipine", toprol: "metoprolol", lopressor: "metoprolol", tenormin: "atenolol", coreg: "carvedilol",
  inderal: "propranolol", lanoxin: "digoxin", catapres: "clonidine", hytrin: "terazosin", flomax: "tamsulosin", proscar: "finasteride",
  synthroid: "levothyroxine", levoxyl: "levothyroxine", unithroid: "levothyroxine", euthyrox: "levothyroxine", cytomel: "liothyronine",
  prilosec: "omeprazole", nexium: "esomeprazole", protonix: "pantoprazole", prevacid: "lansoprazole", pepcid: "famotidine", zantac: "ranitidine", zofran: "ondansetron",
  claritin: "loratadine", zyrtec: "cetirizine", allegra: "fexofenadine", benadryl: "diphenhydramine", singulair: "montelukast", flonase: "fluticasone",
  ventolin: "albuterol", proair: "albuterol", proventil: "albuterol", pulmicort: "budesonide", spiriva: "tiotropium",
  deltasone: "prednisone", medrol: "methylprednisolone", decadron: "dexamethasone", fosamax: "alendronate", boniva: "ibandronate",
  flexeril: "cyclobenzaprine", zanaflex: "tizanidine", robaxin: "methocarbamol", soma: "carisoprodol", ambien: "zolpidem", lunesta: "eszopiclone",
  mucinex: "guaifenesin", sudafed: "pseudoephedrine", zovirax: "acyclovir", valtrex: "valacyclovir", diflucan: "fluconazole", plaquenil: "hydroxychloroquine",
};
// reference.js brands that weren't listed above map to themselves (so they are still recognised as a brand name)
for (const [, name, isBrand] of DRUG_CLASS_MEMBERS) if (isBrand && !BRANDS[name]) BRANDS[name] = name;

// supplements: every spelling -> one name
const SUPPLEMENT_GROUPS = {
  "vitamin d": ["vitamin d", "vitamin d2", "vitamin d3", "vit d", "vit d3", "d3", "d-3", "cholecalciferol", "ergocalciferol", "calciferol"],
  "vitamin b12": ["vitamin b12", "vitamin b-12", "vit b12", "b12", "b-12", "cobalamin", "cyanocobalamin", "methylcobalamin"],
  "vitamin c": ["vitamin c", "vit c", "ascorbic acid", "ascorbate"],
  "vitamin e": ["vitamin e", "vit e", "tocopherol"],
  "vitamin a": ["vitamin a", "retinol"],
  "vitamin k": ["vitamin k", "vitamin k2", "phytonadione", "menaquinone"],
  "folic acid": ["folic acid", "folate", "vitamin b9", "methylfolate"],
  "omega-3": ["fish oil", "omega-3", "omega 3", "omega-3 fatty acids", "krill oil"],
  "calcium": ["calcium", "calcium carbonate", "calcium citrate", "tums"],
  "magnesium": ["magnesium", "magnesium oxide", "magnesium citrate", "magnesium glycinate"],
  "iron": ["iron", "ferrous sulfate", "ferrous gluconate", "ferrous fumarate"],
  "zinc": ["zinc", "zinc sulfate", "zinc gluconate"],
  "coenzyme q10": ["coq10", "coenzyme q10", "ubiquinone", "ubiquinol"],
  "multivitamin": ["multivitamin", "multi-vitamin", "multivitamins", "centrum", "one a day"],
  "melatonin": ["melatonin"], "biotin": ["biotin"], "probiotic": ["probiotic", "probiotics"],
};
const SUPPLEMENTS = {};
for (const [canon, names] of Object.entries(SUPPLEMENT_GROUPS)) for (const n of names) SUPPLEMENTS[n] = canon;

const PHRASES = new Set([...DRUG_CLASS_MEMBERS.filter((m) => !m[2]).map((m) => m[1]), ...Object.values(BRANDS).flatMap((g) => g.split("+"))]);
const SALT_WORDS = new Set(["calcium", "magnesium", "potassium", "sodium", "zinc"]);   // "atorvastatin calcium" is the drug, not a calcium supplement
const GENERICS = PHRASES;
// words that describe the product, not the medicine
const NOISE = new Set(["hydrochloride", "hcl", "hydrobromide", "hbr", "sodium", "tartrate", "succinate", "besylate", "maleate", "mesylate", "sulfate", "fumarate",
  "acetate", "citrate", "phosphate", "bromide", "nitrate", "dihydrate", "monohydrate", "er", "xr", "sr", "dr", "cr", "la", "xl", "cd", "ec", "odt", "chewable",
  "tablet", "tablets", "tab", "tabs", "capsule", "capsules", "cap", "caps", "softgel", "softgels", "gummy", "gummies", "oral", "solution", "suspension",
  "injection", "pen", "inhaler", "patch", "cream", "ointment", "drops", "spray", "powder", "liquid", "extra", "strength", "daily", "the", "of", "extended", "release",
  "delayed", "immediate", "plus", "otc", "generic", "brand", "ds", "hs", "forte"]);

const clean = (s) => String(s || "").toLowerCase()
  .replace(/\d+(?:[.,]\d+)?(?:\s*\/\s*\d+(?:[.,]\d+)?)?\s*(?:mg|mcg|µg|μg|ug|g|ml|iu|units?|meq|%)\b/g, " ")   // strengths
  .replace(/[()[\]]/g, ",").replace(/[^a-z0-9,;/+&\-\s']/g, " ");

function ingredientsOf(...texts) {
  const found = new Set();
  for (const text of texts) {
    for (const part of clean(text).split(/[,;/+&]| and | with /)) {
      // drop the product words and loose numbers ("ER", "M20", "600") but always keep the first word
      const pieces = part.split(/\s+/).filter((w, i) => w && (i === 0 || (!NOISE.has(w) && !/^m?\d+$/.test(w))));
      const phrase = pieces.join(" ").trim();
      if (!phrase) continue;
      if (SUPPLEMENTS[phrase]) { found.add(SUPPLEMENTS[phrase]); continue; }
      if (PHRASES.has(phrase)) { found.add(phrase); continue; }                                  // "potassium chloride", "lisinopril"
      if (BRANDS[phrase]) { BRANDS[phrase].split("+").forEach((g) => found.add(g)); continue; }   // "zestril", "norco" (a combination)
      // "atorvastatin calcium": the drug plus a salt, not a calcium supplement
      const words = phrase.split(/[\s-]+/).filter(Boolean);
      const first = BRANDS[words[0]] || (PHRASES.has(words[0]) ? words[0] : null);
      if (first && words.length > 1 && words.slice(1).every((w) => SALT_WORDS.has(w))) { first.split("+").forEach((g) => found.add(g)); continue; }
      // a hyphenated or spaced combination ("lisinopril-hctz"): when every word is a known drug, each one is an ingredient
      const names = words.map((w) => SUPPLEMENTS[w] || BRANDS[w] || (PHRASES.has(w) ? w : null));
      if (words.length > 1 && names.every(Boolean)) names.forEach((n) => n.split("+").forEach((g) => found.add(g)));
      else found.add(phrase);
    }
  }
  return [...found].filter(Boolean).sort();
}
const isKnownDrug = (...texts) => ingredientsOf(...texts).some((i) => GENERICS.has(i) || Object.values(SUPPLEMENTS).includes(i));
const isSupplement = (...texts) => ingredientsOf(...texts).some((i) => Object.values(SUPPLEMENTS).includes(i));

// ---- strengths ----
// 'mg' is the base for weight units. IU, units, mEq, ml and % can only be compared with themselves.
const WEIGHT = { mg: 1, g: 1000, mcg: 0.001, ug: 0.001, "µg": 0.001, "μg": 0.001 };
function strengthOf(value, unit) {
  const n = Number(value);
  const u = String(unit || "").toLowerCase().replace(/\s+/g, "");
  if (!Number.isFinite(n) || n <= 0 || !u) return null;
  if (WEIGHT[u]) return { amount: n * WEIGHT[u], family: "weight" };
  const family = /^units?$/.test(u) ? "units" : u;
  return { amount: n, family };
}
const sameAmount = (a, b) => Math.abs(a - b) <= Math.max(a, b) * 1e-6;

// a / b = { name, brand?, strength, unit }
function compareMedicines(a, b) {
  const ia = ingredientsOf(a.name, a.brand), ib = ingredientsOf(b.name, b.brand);
  const common = ia.filter((x) => ib.includes(x));
  if (!common.length) return { level: "none" };
  const sameSet = ia.length === ib.length && ia.every((x, i) => x === ib[i]);
  if (!sameSet) return { level: "possible", reason: "combination", ingredients: common };
  const sa = strengthOf(a.strength, a.unit), sb = strengthOf(b.strength, b.unit);
  if (!sa || !sb) return { level: "possible", reason: "missing_strength", ingredients: common };
  if (sa.family !== sb.family) return { level: "possible", reason: "different_units", ingredients: common };
  return sameAmount(sa.amount, sb.amount) ? { level: "exact", ingredients: common } : { level: "dose_change", ingredients: common };
}

// ---- lab-or-medicine decision for a number + unit ----
// A dose is written in mg, mcg, IU, units, mEq, tablets... A lab result is a CONCENTRATION: it has "per" in it (mg/dL, ng/mL,
// mmol/L, U/L) or is a percent. "Vitamin D3 2000 IU" has a dose unit, so it is a medicine even though 'vitamin d' is also a lab test.
const DOSE_UNIT = /^(mg|mcg|µg|μg|ug|g|iu|units?|meq|ml|tabs?|tablets?|caps?|capsules?|softgels?|gummies|drops|puffs|sprays|billion|cfu)$/i;
const DOSE_PER = /\/(day|d|dose|tab|tablet|cap|capsule|wk|week|mo|month|puff|spray|kg|hr|h)$/i;
function unitKind(unit) {
  const u = String(unit || "").trim().replace(/\s+/g, "");
  if (!u) return "none";
  if (DOSE_UNIT.test(u) || DOSE_PER.test(u)) return "dose";
  if (u === "%" || /\//.test(u) || /^(fl|pg|x10|10\^|k\/|m\/)/i.test(u)) return "lab";
  return "unknown";
}

module.exports = { ingredientsOf, compareMedicines, strengthOf, isKnownDrug, isSupplement, unitKind, BRANDS, SUPPLEMENTS };
