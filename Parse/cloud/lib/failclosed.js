// failclosed.js — what main.js registers for the owner classes when access.js fails to load.
// Every browser request on these classes is refused (code 1); requests with the master key (Cloud Code) still work.
// OWNER_CLASSES is a copy of setup.js OWNER_CLASSES (this file must load with no dependencies; a test checks they match).
const OWNER_CLASSES = ["Medication", "DoseLog", "Refill", "DiaryEntry", "Condition", "ConditionNote", "ConditionTarget", "ccda_object", "PersonalLink", "NutritionLog", "VitalReading", "RespiratoryDevice", "DeviceSupply", "RespiratoryLog", "Reminder", "Notification", "NotificationPrefs", "CalendarEvent", "LabResult", "Allergy", "SafetyAlert", "DisposalLog", "MedicalRecord", "EmergencyProfile"];
function registerFailClosed(Parse, classes) {
  const closed = (request) => { if (!request.master) throw new Parse.Error(Parse.Error.INTERNAL_SERVER_ERROR, "The server is starting up or has a problem; please try again shortly."); };
  for (const c of classes) {
    Parse.Cloud.beforeFind(c, closed);
    Parse.Cloud.beforeSave(c, closed);
    Parse.Cloud.beforeDelete(c, closed);
  }
}
module.exports = { registerFailClosed, OWNER_CLASSES };
