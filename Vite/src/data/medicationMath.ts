// Inventory and adherence math for medications. Same rules as withInventoryInfo() and
// summary() in Parse/cloud/lib/medications.js: keep the two in step.

export type Dose = { dose_log_id: string; medication_id: string; taken_at: string; dose_status: string; quantity: number };
export type Refill = { refill_id: string; refill_date: string; quantity_added: number; pharmacy_name: string | null };

export type MedRow = {
  medication_id: string; user_id: string; medication_name: string; medication_type: "prescription" | "non_prescription";
  brand_name: string | null; rxnorm_code: string | null; ndc_code: string | null;
  strength: number | null; strength_unit: string | null; dosage_form: string | null; route: string | null;
  dose_amount: number; dose_unit: string; frequency: string; schedule_times: string[] | null;
  instructions: string | null; purpose: string | null; condition_id: string | null;
  prescriber_name: string | null; pharmacy_name: string | null;
  status: "active" | "paused" | "completed" | "discontinued";
  start_date: string | null; end_date: string | null; discontinued_reason: string | null;
  quantity_on_hand: number; refill_threshold: number | null; refills_remaining: number | null;
  last_refill_date: string | null; source: string; notes: string | null;
  created_at: string | null; updated_at: string | null;
};

export type Med = MedRow & {
  doses_per_day: number | null; days_supply: number | null; estimated_run_out_date: string | null; low_stock: boolean;
};

export const DOSES_PER_DAY: Record<string, number | null> = {
  once_daily: 1, twice_daily: 2, three_times_daily: 3, four_times_daily: 4, every_other_day: 0.5, weekly: 1 / 7,
  as_needed: null, other: null,
};
export const STATUSES = ["active", "paused", "completed", "discontinued"] as const;

export function withInventoryInfo(med: MedRow, now: Date): Med {
  const perDay = DOSES_PER_DAY[med.frequency] ?? null;
  const onHand = Number(med.quantity_on_hand);
  const dose = Number(med.dose_amount);
  const threshold = med.refill_threshold != null ? Number(med.refill_threshold) : null;
  let daysSupply: number | null = null, runOut: string | null = null;
  if (perDay && dose > 0) {
    daysSupply = Math.floor(onHand / (dose * perDay));
    const d = new Date(now.getTime());
    d.setDate(d.getDate() + daysSupply);
    runOut = d.toISOString().slice(0, 10);
  }
  const active = med.status === "active";
  return {
    ...med, doses_per_day: perDay,
    days_supply: active ? daysSupply : null,
    estimated_run_out_date: active ? runOut : null,
    low_stock: active && threshold !== null && onHand <= threshold,
  };
}

export type AdherenceRow = {
  medication_id: string; medication_name: string; frequency: string;
  taken_last_7_days: number; expected_last_7_days: number | null; adherence_7_day_pct: number | null;
  taken_last_30_days: number; expected_last_30_days: number | null; adherence_30_day_pct: number | null;
  skipped_or_missed_last_30_days: number; last_taken_at: string | null;
};
export type NeedsRefillRow = {
  medication_id: string; medication_name: string; quantity_on_hand: number; dose_unit: string;
  days_supply: number | null; estimated_run_out_date: string | null; refills_remaining: number | null;
  pharmacy_name: string | null; low_stock: boolean;
};
export type Summary = {
  total_medications: number; active_count: number; by_status: { status: string; count: number }[];
  needs_refill: NeedsRefillRow[];
  overall_adherence_7_day_pct: number | null; overall_adherence_30_day_pct: number | null;
  adherence: AdherenceRow[];
};

type Counts = { taken_7: number; taken_30: number; not_taken_30: number; last_taken_at: string | null };

// meds: all of the user's medications (already with inventory info); doses: their dose logs
export function summarize(
  meds: Med[], doses: { medication_id: string; taken_at: string; dose_status: string }[], now: Date,
): Summary {
  const nowMs = now.getTime();
  const active = meds.filter((m) => m.status === "active").sort((a, b) => a.medication_name.localeCompare(b.medication_name));
  const since30 = nowMs - 30 * 86400000, since7 = nowMs - 7 * 86400000;
  const recent = doses.filter((d) => new Date(d.taken_at).getTime() >= since30);
  const counts = new Map<string, Counts>();
  for (const d of recent) {
    const c = counts.get(d.medication_id) || { taken_7: 0, taken_30: 0, not_taken_30: 0, last_taken_at: null };
    const t = new Date(d.taken_at).getTime();
    if (d.dose_status === "taken") {
      c.taken_30++;
      if (t >= since7) c.taken_7++;
      if (!c.last_taken_at || d.taken_at > c.last_taken_at) c.last_taken_at = d.taken_at;
    } else c.not_taken_30++;
    counts.set(d.medication_id, c);
  }
  const expected = (med: Med, days: number): number | null => {
    if (!med.doses_per_day) return null;
    const began = new Date(med.start_date || med.created_at || nowMs);
    if (began.getTime() > nowMs) return null; // not started yet
    const windowStart = new Date(nowMs - days * 86400000);
    const from = began > windowStart ? began : windowStart;
    const activeDays = Math.max(0, (nowMs - from.getTime()) / 86400000);
    return Math.max(1, Math.round(activeDays * med.doses_per_day));
  };
  const pct = (taken: number, exp: number | null) => (exp ? Math.min(100, Math.round((taken / exp) * 100)) : null);
  let taken7 = 0, exp7 = 0, taken30 = 0, exp30 = 0;
  const adherence = active.map((med): AdherenceRow => {
    const c = counts.get(med.medication_id) || { taken_7: 0, taken_30: 0, not_taken_30: 0, last_taken_at: null };
    const e7 = expected(med, 7), e30 = expected(med, 30);
    if (e7) { taken7 += Math.min(c.taken_7, e7); exp7 += e7; }
    if (e30) { taken30 += Math.min(c.taken_30, e30); exp30 += e30; }
    return {
      medication_id: med.medication_id, medication_name: med.medication_name, frequency: med.frequency,
      taken_last_7_days: c.taken_7, expected_last_7_days: e7, adherence_7_day_pct: pct(c.taken_7, e7),
      taken_last_30_days: c.taken_30, expected_last_30_days: e30, adherence_30_day_pct: pct(c.taken_30, e30),
      skipped_or_missed_last_30_days: c.not_taken_30, last_taken_at: c.last_taken_at,
    };
  });
  const needs_refill = active.filter((m) => m.low_stock || (m.days_supply !== null && m.days_supply <= 7)).map((m): NeedsRefillRow => ({
    medication_id: m.medication_id, medication_name: m.medication_name, quantity_on_hand: m.quantity_on_hand,
    dose_unit: m.dose_unit, days_supply: m.days_supply, estimated_run_out_date: m.estimated_run_out_date,
    refills_remaining: m.refills_remaining, pharmacy_name: m.pharmacy_name, low_stock: m.low_stock,
  }));
  const by_status = STATUSES.map((s) => ({ status: s, count: meds.filter((m) => m.status === s).length })).filter((r) => r.count);
  return {
    total_medications: meds.length, active_count: active.length, by_status, needs_refill,
    overall_adherence_7_day_pct: pct(taken7, exp7), overall_adherence_30_day_pct: pct(taken30, exp30), adherence,
  };
}
