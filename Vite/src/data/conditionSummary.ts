// conditionSummary.ts — pure helpers for the Conditions page (no Parse, so node --test can load them; see conditions.test.ts).
// William Murray's summary from Conditions.tsx, moved here and made to match the old conditions.summary in
// Parse/cloud/lib/conditions.js: "active" means active or managed, and every active condition gets its OWN
// note_count and last_note_date (Will's version showed the number of conditions with notes on every row).

export type Condition = {
  condition_id: string; condition_name: string; icd10_code: string | null; category: string | null;
  status: string; severity: string | null; onset_date: string | null; diagnosed_date: string | null;
  resolved_date: string | null; diagnosing_provider: string | null; managing_provider: string | null;
  provider_facility: string | null; is_primary: boolean; source: string | null; notes: string | null;
};
export type Note = { note_id: string; condition_id: string; note_date: string; note_type: string; note_text: string; created_at: string };
export type Target = {
  target_id: string; condition_id: string; vital_type: string; target_min: number | null; target_max: number | null;
  secondary_min: number | null; secondary_max: number | null; set_by: string | null; active: boolean; created_at: string;
};
export type ActiveCondition = Condition & { note_count: number; last_note_date: string | null };
export type Summary = {
  total_conditions: number; active_count: number;
  by_status: { status: string; count: number }[];
  by_category: { category: string; count: number }[];
  active_conditions: ActiveCondition[];
};

const ACTIVE = ["active", "managed"];

// conditions.list's order: primary first, newest onset (none last), then name. Returns a new array.
export function sortConditions<T extends Condition>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0)
    || (b.onset_date || "").localeCompare(a.onset_date || "") || a.condition_name.localeCompare(b.condition_name));
}

function counts(rows: Condition[], key: "status" | "category") {
  const m = new Map<string, number>();
  for (const r of rows) { const k = r[key] ?? "uncategorized"; m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()];
}

// conditions.summary(): counts by status (by name) and by category (most first), and the active/managed conditions
export function summarize(conditions: Condition[], notes: Note[]): Summary {
  const active = sortConditions(conditions.filter((c) => ACTIVE.includes(c.status))).map((c) => {
    const dates = notes.filter((n) => n.condition_id === c.condition_id).map((n) => n.note_date).sort();
    return { ...c, note_count: dates.length, last_note_date: dates.pop() || null };
  });
  return {
    total_conditions: conditions.length,
    active_count: active.length,
    by_status: counts(conditions, "status").map(([status, count]) => ({ status, count })).sort((a, b) => a.status.localeCompare(b.status)),
    by_category: counts(conditions, "category").map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
    active_conditions: active,
  };
}

// who set a target: the server stores "patient" for targets saved on this page; the demo seed (and the old route) also
// stored "provider" and "self"
export function setByText(v: string | null | undefined): string {
  if (!v) return "Not recorded";
  if (v === "patient" || v === "self") return "You";
  if (v === "provider") return "Your provider";
  return v.charAt(0).toUpperCase() + v.slice(1).replace(/_/g, " ");
}
