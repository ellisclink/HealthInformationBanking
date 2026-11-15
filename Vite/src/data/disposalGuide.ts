// disposalGuide.ts — how to dispose of a medicine: the eight methods (steps and FDA / DEA links) and the rules that pick one
// (the FDA flush list, controlled substances, the dosage form). A copy of the lists in Parse/cloud/lib/disposal.js (the
// server keeps them for the leftover-medicine alert): change both together. Pure, no imports.
// methods() / guidance() are the old GET /disposal/methods and GET /disposal/guidance answers.

export type Link = { key: string; label: string; url: string };
export type Guidance = { method: string; title: string; summary: string; steps: string[]; links: Link[]; on_flush_list: boolean };
type MethodInfo = { title: string; summary: string; steps: string[]; links: string[] };

export const GENERAL_NOTE = "General guidance, not a pharmacist. Follow the label, and ask your pharmacist if you're unsure.";

const LINKS: Record<string, { label: string; url: string }> = {
  "dea_locator": {
    "label": "DEA drug disposal locator",
    "url": "https://apps.deadiversion.usdoj.gov/pubdispsearch"
  },
  "dea_take_back": {
    "label": "DEA National Take Back Day",
    "url": "https://www.dea.gov/takebackday"
  },
  "fda_disposal": {
    "label": "FDA: where and how to dispose of unused medicines",
    "url": "https://www.fda.gov/consumers/consumer-updates/where-and-how-dispose-unused-medicines"
  },
  "fda_flush": {
    "label": "FDA flush list for certain medicines",
    "url": "https://www.fda.gov/drugs/disposal-unused-medicines-what-you-should-know/drug-disposal-fdas-flush-list-certain-medicines"
  },
  "fda_sharps": {
    "label": "FDA: safe disposal of needles and syringes",
    "url": "https://www.fda.gov/medical-devices/safely-using-medical-devices-home/safe-disposal-needles-and-syringes"
  }
};

const METHODS: Record<string, MethodInfo> = {
  "take_back": {
    "title": "Take it to a take-back site",
    "summary": "The safest choice. Many pharmacies, police stations and clinics have drop boxes that accept most medicines.",
    "steps": [
      "Find a drop box with the DEA locator, or ask your pharmacy.",
      "Keep the medicine in its container or a sealed bag.",
      "Drop it off. Most sites don't need your name or a receipt."
    ],
    "links": [
      "dea_locator",
      "dea_take_back",
      "fda_disposal"
    ]
  },
  "flush": {
    "title": "Flush it down the toilet",
    "summary": "This medicine is on the FDA flush list. One accidental dose can be fatal, especially for a child, so flush it only when no take-back site is near you.",
    "steps": [
      "Look for a take-back site first. Flush only if none is available.",
      "Don't crush or dissolve tablets. Flush them whole.",
      "Flush it, then keep the empty container out of reach of children and pets."
    ],
    "links": [
      "fda_flush",
      "dea_locator"
    ]
  },
  "flush_patch": {
    "title": "Fold the patch and flush it",
    "summary": "A used patch still contains medicine. This one is on the FDA flush list.",
    "steps": [
      "Fold the used patch in half, sticky sides together.",
      "Flush it if no take-back site is near you.",
      "Wash your hands. Keep unused patches out of reach of children and pets."
    ],
    "links": [
      "fda_flush",
      "dea_locator"
    ]
  },
  "trash": {
    "title": "Mix it and put it in the trash",
    "summary": "Most leftover medicines can go in the household trash when no take-back site is near you.",
    "steps": [
      "Mix the medicine with something unappealing, like used coffee grounds, dirt or cat litter.",
      "Seal the mixture in a bag or container and put it in the trash.",
      "Scratch out your name and Rx number on the empty bottle, then recycle or trash it."
    ],
    "links": [
      "fda_disposal",
      "dea_locator"
    ]
  },
  "patch": {
    "title": "Fold the patch and put it in the trash",
    "summary": "A used patch still contains medicine, so fold it to protect people and pets.",
    "steps": [
      "Fold the used patch in half, sticky sides together.",
      "Put it in the household trash, out of reach of children and pets.",
      "Wash your hands."
    ],
    "links": [
      "fda_disposal",
      "dea_take_back"
    ]
  },
  "inhaler": {
    "title": "Inhaler: ask your pharmacy first",
    "summary": "Some pharmacies and manufacturers run inhaler take-back programs. Don't puncture or burn the inhaler.",
    "steps": [
      "Ask your pharmacy whether it takes inhalers back.",
      "If not, don't puncture or burn it. Seal it in a bag and put it in the household trash."
    ],
    "links": [
      "fda_disposal",
      "dea_locator"
    ]
  },
  "sharps": {
    "title": "Needles and syringes: sharps container",
    "summary": "Loose needles can injure people who handle the trash. Put them in a sharps container.",
    "steps": [
      "Put used needles, syringes and pens in a sharps container, or a heavy plastic bottle with a screw cap.",
      "Don't recap, bend or break needles.",
      "When the container is about three-quarters full, seal it and take it to a pharmacy, clinic or sharps drop-off, or follow your local rules."
    ],
    "links": [
      "fda_sharps"
    ]
  },
  "controlled": {
    "title": "Controlled medicine: take-back first",
    "summary": "This is a controlled substance, such as an opioid, benzodiazepine or stimulant. Take it to a take-back site, and never give it to anyone else.",
    "steps": [
      "Use a DEA take-back drop box at a pharmacy or police station, or a mail-back envelope from your pharmacy.",
      "If none is near you, follow the trash steps.",
      "Keep the bottle locked up or out of sight until you dispose of it."
    ],
    "links": [
      "dea_locator",
      "dea_take_back",
      "fda_disposal"
    ]
  }
};
export const METHOD_KEYS = Object.keys(METHODS);

// FDA flush list: active ingredients and brand examples. The FDA page is the authority.
const FLUSH_TERMS = [
  "buprenorphine",
  "belbuca",
  "buavail",
  "butrans",
  "suboxone",
  "subutex",
  "zubsolv",
  "fentanyl",
  "abstral",
  "actiq",
  "duragesic",
  "fentora",
  "onsolis",
  "hydrocodone",
  "benzhydrocodone",
  "apadaz",
  "hysingla",
  "norco",
  "reprexain",
  "vicodin",
  "vicoprofen",
  "zohydro",
  "hydromorphone",
  "exalgo",
  "meperidine",
  "demerol",
  "methadone",
  "dolophine",
  "methadose",
  "morphine",
  "arymo",
  "morphabond",
  "ms contin",
  "oxycodone",
  "oxycontin",
  "roxicodone",
  "oxaydo",
  "xtampza",
  "percocet",
  "endocet",
  "oxymorphone",
  "opana",
  "tapentadol",
  "nucynta",
  "diastat",
];

// Controlled substances (benzodiazepines, opioids, stimulants and other scheduled drugs)
const CONTROLLED_TERMS = [
  "alprazolam",
  "xanax",
  "lorazepam",
  "ativan",
  "clonazepam",
  "klonopin",
  "diazepam",
  "valium",
  "temazepam",
  "restoril",
  "triazolam",
  "halcion",
  "chlordiazepoxide",
  "oxazepam",
  "clorazepate",
  "codeine",
  "tramadol",
  "ultram",
  "amphetamine",
  "adderall",
  "dextroamphetamine",
  "methylphenidate",
  "ritalin",
  "concerta",
  "lisdexamfetamine",
  "vyvanse",
  "dexmethylphenidate",
  "focalin",
  "modafinil",
  "provigil",
  "armodafinil",
  "nuvigil",
  "phentermine",
  "adipex",
  "zolpidem",
  "ambien",
  "eszopiclone",
  "lunesta",
  "phenobarbital",
];

const tokens = (s: unknown) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);

// whole words, in order: "ms contin" matches "MS Contin 15 mg", not "amsterdam"
function findTerm(nameTokens: string[], terms: string[]): string | null {
  for (const term of terms) {
    const t = tokens(term);
    for (let i = 0; i + t.length <= nameTokens.length; i++) {
      if (t.every((word, j) => nameTokens[i + j] === word)) return term;
    }
  }
  return null;
}

export type MedicineInfo = { medication_name?: string | null; brand_name?: string | null; dosage_form?: string | null; route?: string | null };

// Order matters: injection, then flush list, inhaler, controlled, patch, and trash last.
export function decide({ medication_name, brand_name, dosage_form, route }: MedicineInfo): { method: string; matched?: string } {
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

const pickLinks = (keys: string[]): Link[] => keys.map((k) => ({ key: k, ...LINKS[k] }));

export function guidanceFor(med: MedicineInfo): Guidance {
  const d = decide(med);
  const m = METHODS[d.method];
  return { method: d.method, title: m.title, summary: m.summary, steps: m.steps, links: pickLinks(m.links), on_flush_list: d.method.startsWith("flush") };
}

// GET /disposal/methods
export function methods() {
  return {
    methods: METHOD_KEYS.map((key) => ({ key, title: METHODS[key].title, summary: METHODS[key].summary, steps: METHODS[key].steps, links: pickLinks(METHODS[key].links) })),
    note: GENERAL_NOTE,
  };
}

// GET /disposal/guidance?name=&brand=&form=&route= (the old 400 messages are thrown)
export function guidance(query: { name?: string | null; brand?: string | null; form?: string | null; route?: string | null }): { guidance: Guidance; note: string } {
  const name = query.name || null;
  const brand = query.brand || null;
  if (!name && !brand) throw new Error("Type the medicine's name");
  if (String(name || "").length > 200 || String(brand || "").length > 200) throw new Error("Names must be 200 characters or fewer");
  return { guidance: guidanceFor({ medication_name: name, brand_name: brand, dosage_form: query.form || null, route: query.route || null }), note: GENERAL_NOTE };
}
