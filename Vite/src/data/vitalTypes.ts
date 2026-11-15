// vitalTypes.ts — the vital sign types the site supports, with their reference ranges. A copy of VITAL_TYPES in
// Parse/cloud/lib/reference.js (the server keeps its own copy for the field rules, previsit and share codes): change
// both together. The old GET /vitals/types answer is vitalTypes() (the same list without sort_order).

export type VitalTypeInfo = {
  vital_type: string; display_name: string; default_unit: string; is_dual_value: boolean;
  value_label: string | null; secondary_label: string | null;
  normal_min: number | null; normal_max: number | null; secondary_min: number | null; secondary_max: number | null;
  decimal_places: number; sort_order: number;
};

export const VITAL_TYPES: VitalTypeInfo[] = [
  { vital_type: "blood_pressure", display_name: "Blood Pressure", default_unit: "mmHg", is_dual_value: true, value_label: "Systolic", secondary_label: "Diastolic", normal_min: 90, normal_max: 120, secondary_min: 60, secondary_max: 80, decimal_places: 0, sort_order: 10 },
  { vital_type: "heart_rate", display_name: "Heart Rate", default_unit: "bpm", is_dual_value: false, value_label: null, secondary_label: null, normal_min: 60, normal_max: 100, secondary_min: null, secondary_max: null, decimal_places: 0, sort_order: 20 },
  { vital_type: "temperature", display_name: "Body Temperature", default_unit: "F", is_dual_value: false, value_label: null, secondary_label: null, normal_min: 97, normal_max: 99, secondary_min: null, secondary_max: null, decimal_places: 1, sort_order: 30 },
  { vital_type: "respiratory_rate", display_name: "Respiratory Rate", default_unit: "breaths/min", is_dual_value: false, value_label: null, secondary_label: null, normal_min: 12, normal_max: 20, secondary_min: null, secondary_max: null, decimal_places: 0, sort_order: 40 },
  { vital_type: "oxygen_saturation", display_name: "Oxygen Saturation", default_unit: "%", is_dual_value: false, value_label: null, secondary_label: null, normal_min: 95, normal_max: 100, secondary_min: null, secondary_max: null, decimal_places: 0, sort_order: 50 },
  { vital_type: "weight", display_name: "Weight", default_unit: "lb", is_dual_value: false, value_label: null, secondary_label: null, normal_min: null, normal_max: null, secondary_min: null, secondary_max: null, decimal_places: 1, sort_order: 60 },
  { vital_type: "height", display_name: "Height", default_unit: "in", is_dual_value: false, value_label: null, secondary_label: null, normal_min: null, normal_max: null, secondary_min: null, secondary_max: null, decimal_places: 1, sort_order: 70 },
  { vital_type: "bmi", display_name: "Body Mass Index", default_unit: "%", is_dual_value: false, value_label: null, secondary_label: null, normal_min: 18.5, normal_max: 24.9, secondary_min: null, secondary_max: null, decimal_places: 1, sort_order: 80 },
  { vital_type: "blood_glucose", display_name: "Blood Glucose", default_unit: "mg/dL", is_dual_value: false, value_label: null, secondary_label: null, normal_min: 70, normal_max: 140, secondary_min: null, secondary_max: null, decimal_places: 0, sort_order: 90 },
  { vital_type: "hemoglobin_a1c", display_name: "Hemoglobin A1C", default_unit: "%", is_dual_value: false, value_label: null, secondary_label: null, normal_min: null, normal_max: 5.7, secondary_min: null, secondary_max: null, decimal_places: 1, sort_order: 100 },
  { vital_type: "pain_level", display_name: "Pain Level", default_unit: "score", is_dual_value: false, value_label: null, secondary_label: null, normal_min: null, normal_max: null, secondary_min: null, secondary_max: null, decimal_places: 0, sort_order: 110 },
];

export const typeOf = (vitalType: string): VitalTypeInfo | null => VITAL_TYPES.find((t) => t.vital_type === vitalType) || null;

// GET /vitals/types: every type, without sort_order
export function vitalTypes(): Omit<VitalTypeInfo, "sort_order">[] {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- sort_order is left out on purpose
  return VITAL_TYPES.map(({ sort_order, ...t }) => t);
}
