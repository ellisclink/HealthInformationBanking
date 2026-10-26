import LegalLayout from "../components/LegalLayout";
import { Link } from "react-router-dom";
import { CONTACT_EMAIL, SITE_NAME } from "../legal";

// Medical Disclaimer (a starting draft; see the notes at the top of legal.ts). Public page: /disclaimer
// It is part of the Terms of Service (Terms section 3) and is linked from the footer, the sign-up box and the pages that show results.
// Written in short, plain sentences on purpose: the FTC expects disclaimers to be clear and easy to find, not buried in legal text.
const SECTIONS = [
  { id: "short", title: "In short" },
  { id: "info", title: "General information only" },
  { id: "advice", title: "No medical advice, no doctor–patient relationship" },
  { id: "emergency", title: "Not for emergencies" },
  { id: "accuracy", title: "Accuracy and out-of-date information" },
  { id: "results", title: "Ranges, flags, warnings and reminders" },
  { id: "yours", title: "Information you or others add" },
  { id: "wishes", title: "Emergency access and treatment wishes" },
  { id: "links", title: "Links and other people's content" },
  { id: "risk", title: "Use at your own risk" },
];

function Disclaimer() {
  return (
    <LegalLayout title="Medical Disclaimer" sections={SECTIONS}>
      <h3 id="short">1. In short</h3>
      <ul>
        <li>{SITE_NAME} helps you keep and organize <strong>your own</strong> health information. It is not a doctor, nurse, pharmacist or hospital.</li>
        <li>Nothing here is medical advice, a diagnosis or a treatment plan.</li>
        <li><strong>If you think you have an emergency, call your local emergency number. Do not use this service.</strong></li>
        <li>Numbers, flags, warnings and reminders can be wrong, late or missing. Always check with a health professional.</li>
        <li>You use the service at your own risk. This page is part of our <Link to="/terms">Terms of Service</Link>.</li>
      </ul>

      <h3 id="info">2. General information only</h3>
      <p>Everything the service shows you is for general information and to help you stay organized. It is based on what you typed in or uploaded and on short reference lists built into the service. It is not written for your particular situation, and it should not be the only thing you use to make a health decision.</p>

      <h3 id="advice">3. No medical advice, no doctor–patient relationship</h3>
      <p>We do not give medical, nursing, pharmacy or other professional advice. Using the service does not create a doctor–patient or any other professional relationship between you and us. Do not delay seeking care, ignore advice from a health professional, or start, stop or change a medicine or treatment because of something you read or saw here. Talk to your own doctor or pharmacist first.</p>

      <h3 id="emergency">4. Not for emergencies</h3>
      <p>The service is not monitored and cannot send help. If you or someone else may be having a medical emergency, call your local emergency number right away. The emergency-access feature only lets responders read information you chose to share, if they can reach it.</p>

      <h3 id="accuracy">5. Accuracy and out-of-date information</h3>
      <p>We try to keep reference information (such as typical lab ranges, drug warnings and disposal tips) reasonable, but we do not promise that it is complete, correct or current. Medicine and science change, and our lists are short and are updated only from time to time. Reference information reflects what we knew when it was last reviewed. Always check the label of your medicine and the instructions from your own health professional.</p>

      <h3 id="results">6. Ranges, flags, warnings and reminders</h3>
      <ul>
        <li><strong>"Outside the range" does not mean you are sick, and "in range" does not mean you are fine.</strong> Ranges differ between labs, people and situations. Your lab report and your doctor decide what a result means for you.</li>
        <li><strong>Medicine, allergy and interaction warnings cover only a short list of common drugs.</strong> The absence of a warning does not mean a medicine is safe for you. Ask your pharmacist or prescriber.</li>
        <li><strong>Reminders and alerts may fail.</strong> They can be late, missing or wrong because of your device, your connection, email delivery or a problem on our side. Do not rely on them for medicines or care that matter, and set your own backup alarms.</li>
        <li>Calculated values (such as pill counts, run-out dates, trends and body-mass index) are estimates based on what you entered.</li>
      </ul>

      <h3 id="yours">7. Information you or others add</h3>
      <p>The service stores what you enter. You are responsible for it being correct and complete. When you use PDF auto-fill or import a record, the service reads the file automatically and makes mistakes. Check every item before you confirm it. A summary built from your records (such as the pre-visit summary) is only as accurate as those records.</p>

      <h3 id="wishes">8. Emergency access and treatment wishes</h3>
      <p>Any wishes you record, such as "do not resuscitate" or treatments you decline, are your own statement. They are <strong>not a medical order and not a legal advance directive</strong>, and emergency staff may not see them or be able to act on them. To have your wishes followed, talk to your doctor and complete the forms used in your state, and keep copies where responders can find them.</p>

      <h3 id="links">9. Links and other people's content</h3>
      <p>The service uses outside sources, such as a government food database for nutrition search, and lets you save links to other websites. We do not control those sources or websites, we do not promise that they are accurate or safe, and a link does not mean we endorse it. People you share records with are not our employees or agents, and what they say or do is their own responsibility. Open links and rely on other people's content at your own risk.</p>

      <h3 id="risk">10. Use at your own risk</h3>
      <p>You use the service, and everything in it, at your own risk. To the fullest extent the law allows, we are not responsible for decisions you or others make using the service, or for harm, loss or damage that results. The Terms of Service explain the limits on our responsibility in more detail. Questions about this page: {CONTACT_EMAIL}</p>
    </LegalLayout>
  );
}

export default Disclaimer;
