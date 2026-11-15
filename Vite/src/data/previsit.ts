// previsit.ts — the pre-visit summary, built in the browser from the patient's own rows (the old POST /previsit/summary).
// Every read goes through the data files / Parse SDK finds that the Cloud Code triggers keep to the caller's own rows;
// the summary itself is previsitSummary.ts (ported from the old previsit.js). The medication warnings still come from
// the server's re-check (listAlerts: POST /safety/recheck, then the SafetyAlert rows), as the old route's did.
// The appointment picker is data/calendar.ts previsitAppointments.
import Parse from "../parse";
import { currentName } from "../api";
import { run } from "./parseCall";
import { getEvent } from "./calendar";
import { listConditions } from "./conditions";
import { listMedications } from "./medications";
import { listAlerts, listAllergies } from "./safety";
import { vitalsSummary } from "./vitals";
import { fetchResults, labSummary } from "./labs";
import { getRecord } from "./records";
import { ADHERENCE_DAYS, DAY_MS, buildSummary, checkRequest, type DiaryIn, type SummaryData, type SummaryRequest } from "./previsitSummary";
import { MAX_ROWS } from "./common";

export type { SummaryRequest };
export type PrevisitSummary = ReturnType<typeof buildSummary>;


// the old route's diary rows (diary.js row(): the stored values; newest entry_date first, then newest created)
async function diaryRows(): Promise<DiaryIn[]> {
  const rows = await new Parse.Query("DiaryEntry").descending("entry_date").addDescending("createdAt").limit(MAX_ROWS).find();
  const n = <T,>(v: T | undefined) => (v === undefined ? null : v);
  return rows.map((e) => ({
    entry_date: e.get("entry_date"), category: e.get("category"), title: e.get("title"), description: n(e.get("description")),
    severity: n(e.get("severity")), mood: n(e.get("mood")), follow_up_needed: n(e.get("follow_up_needed")),
  }));
}

export function previsitSummary(body: SummaryRequest): Promise<{ summary: PrevisitSummary }> {
  return run(async () => {
    const req = checkRequest(body);
    const want = (s: string) => req.sections.includes(s);
    const now = new Date();
    const user = Parse.User.current();
    const data: SummaryData = {
      patientName: currentName() || String((user && user.get("username")) || ""),
      record: (await getRecord()).data,
      visit: null,
    };
    if (req.eventId) {
      try { data.visit = (await getEvent(req.eventId)).event; }
      catch (err) { throw err instanceof Error && err.message === "Not found" ? new Error("Event not found") : err; }
    }
    const jobs: Promise<void>[] = [];
    if (want("conditions")) jobs.push(listConditions().then((c) => { data.conditions = c.summary.active_conditions; }));
    if (want("medications")) {
      jobs.push(listMedications().then((m) => { data.medications = m; }));
      const since = new Date(now.getTime() - ADHERENCE_DAYS * DAY_MS);
      jobs.push(new Parse.Query("DoseLog").greaterThanOrEqualTo("taken_at", since).limit(MAX_ROWS).find()
        .then((rows) => { data.doses = rows.map((l) => ({ medication_id: l.get("medication_id"), dose_status: l.get("dose_status"), taken_at: l.get("taken_at") ?? null })); }));
    }
    // the warnings first (the server's re-check also copies the form's allergies), then the allergy list
    const alerts = want("safety_alerts") ? listAlerts().then((a) => { data.alerts = a.alerts; }) : Promise.resolve();
    jobs.push(alerts);
    if (want("allergies")) jobs.push(alerts.then(() => listAllergies()).then((a) => { data.allergies = a.allergies; }));
    if (want("vitals")) jobs.push(vitalsSummary().then((v) => { data.vitals = v.summary; }));
    if (want("labs")) jobs.push(fetchResults().then((rows) => { data.labs = labSummary(rows, 0); }));
    if (want("diary")) jobs.push(diaryRows().then((rows) => { data.diary = rows; }));
    if (want("devices")) {
      jobs.push(new Parse.Query("RespiratoryDevice").limit(MAX_ROWS).find()
        .then((rows) => { data.devices = rows.map((d) => ({ device_type: d.get("device_type"), name: d.get("name") ?? null, is_active: d.get("is_active") })); }));
    }
    await Promise.all(jobs);
    return { summary: buildSummary(req, data, now) };
  });
}
