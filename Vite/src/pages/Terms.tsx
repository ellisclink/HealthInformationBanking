import { Link } from "react-router-dom";
import LegalLayout from "../components/LegalLayout";
import { COMPANY_ADDRESS, COMPANY_NAME, CONTACT_EMAIL, GOVERNING_STATE, MIN_AGE, SITE_NAME } from "../legal";

// Terms of Service (a starting draft; see the notes at the top of legal.ts). Public page: /terms
// Keep the statements below true to the code. Where the code changes (sharing, emergency access, deletion), change this page too.
const SECTIONS = [
  { id: "agree", title: "Agreeing to these terms" },
  { id: "service", title: "What the service is" },
  { id: "medical", title: "Not medical advice, not for emergencies" },
  { id: "account", title: "Your account and security" },
  { id: "sharing", title: "Sharing your records" },
  { id: "emergency", title: "Emergency access and treatment wishes" },
  { id: "content", title: "Your information and what we may do with it" },
  { id: "use", title: "Acceptable use" },
  { id: "third", title: "Other services we rely on" },
  { id: "availability", title: "Availability and your own copies" },
  { id: "ending", title: "Ending your account" },
  { id: "disclaimers", title: "Disclaimers" },
  { id: "liability", title: "Limits on our responsibility" },
  { id: "law", title: "Governing law and disputes" },
  { id: "changes", title: "Changes to these terms" },
  { id: "general", title: "General" },
  { id: "contact", title: "Contact" },
];

function Terms() {
  return (
    <LegalLayout title="Terms of Service" sections={SECTIONS}>
      <h3 id="agree">1. Agreeing to these terms</h3>
      <p>These terms are an agreement between you and {COMPANY_NAME} ("we", "us") about your use of {SITE_NAME} (the "service"). By creating an account or using the service you agree to them and to our Privacy Policy. If you do not agree, do not use the service.</p>
      <p>You must be at least {MIN_AGE} years old to create an account. The service is intended for use in the United States. If you manage records for someone else, you must have the right to do so.</p>

      <h3 id="service">2. What the service is</h3>
      <p>{SITE_NAME} is a tool for keeping your own health information in one place: medications, conditions, lab results, vital signs, documents, reminders and similar records. You can share what you choose with other people, and you can set up emergency access. It is a personal record-keeping tool. It is not a hospital, a doctor's office, a pharmacy or an electronic health record used by your care team, and it is not a substitute for any of them.</p>

      <h3 id="medical">3. Not medical advice, not for emergencies</h3>
      <p>Our <Link to="/disclaimer">Medical Disclaimer</Link> is part of these terms. The service does not give medical advice and does not diagnose or treat anything. Ranges, flags, alerts, interaction and allergy warnings, reminders and summaries are general information based on what you entered and on short reference lists. They can be incomplete, out of date or wrong. Always talk to a qualified health professional about your care, and never delay or ignore medical advice because of something you saw here.</p>
      <p><strong>Do not use the service in an emergency.</strong> If you think you or someone else has a medical emergency, call your local emergency number right away. The emergency-access feature only lets responders read information you chose to share. It is not an emergency service, and nobody here monitors it or sends help.</p>
      <p>Information read automatically from a PDF or imported from another record is a best guess. You must check it before you confirm it. You are responsible for the accuracy of what you save.</p>

      <h3 id="account">4. Your account and security</h3>
      <p>You are responsible for your account. Give accurate information, keep your password private, and keep access to the email address used for login codes. Tell us at once if you think someone else has accessed your account. We use an emailed code at login and end sessions after a period of inactivity, but no system is perfectly secure and we cannot promise that it will never be breached.</p>
      <p>You agree that we may send you emails that are needed to run the service, such as login codes, password resets, security notices and reminders you ask for. You are responsible for what happens under your account, including anything you share, unless we caused it.</p>

      <h3 id="sharing">5. Sharing your records</h3>
      <p>You decide what to share and with whom. A sharing code lets anyone who has it see the sections you chose until it expires or you revoke it. Treat codes like keys: send them only to people you trust, and revoke any code you no longer want active. Once someone has seen your information they may copy it, and we cannot take that back. We keep a log of when sharing codes are opened and show it to you.</p>
      <p>Doctors and other people you share with are not our employees or agents, and we are not responsible for what they do with your information or for any care they give.</p>

      <h3 id="emergency">6. Emergency access and treatment wishes</h3>
      <p>If you turn on emergency access, anyone who has your emergency code and gives a name and agency can see what you chose to include. This is meant for emergency responders, but we cannot check who uses the code. Keep the code private, and replace or turn it off if it is lost.</p>
      <p>Any wishes you record (such as "do not resuscitate" or treatments you decline) are your own statement of your wishes. They are <strong>not a medical order and not a legal advance directive</strong>. Emergency staff may be unable to see or act on them. To have them followed, talk to your doctor, complete the forms used in your state (for example a POLST/MOLST or DNR order) and keep copies where responders can find them. We do not promise that anyone will see, trust or follow what you record here.</p>

      <h3 id="content">7. Your information and what we may do with it</h3>
      <p>Your records remain yours. You give us permission to store, process, display and back up your information, and to share it only as you direct, so that we can run the service for you. We do not sell your health information and we do not use it for advertising. How we handle it is described in the Privacy Policy.</p>
      <p>We may remove content that is illegal, that harms others, or that breaks these terms.</p>
      <p>We own the service itself (its software, design and name). We give you a limited, personal, non-commercial, non-transferable permission to use it as these terms allow. You may not copy it, reverse engineer it, resell it, or use it to build a competing product.</p>

      <h3 id="use">8. Acceptable use</h3>
      <p>Do not:</p>
      <ul>
        <li>break the law;</li>
        <li>use someone else's account or information without permission;</li>
        <li>try to guess sharing or emergency codes, or to get into parts of the service or other people's data that you are not allowed to see;</li>
        <li>disrupt, overload or probe the service for weaknesses;</li>
        <li>upload malware, or content you have no right to upload;</li>
        <li>use the service to harass or deceive others; or</li>
        <li>use automated tools to copy the service.</li>
      </ul>

      <h3 id="third">9. Other services we rely on</h3>
      <p>The service runs on third-party providers for hosting, data storage, network protection and email, and it uses a public food database for nutrition search. They are listed in the Privacy Policy. We are not responsible for their services. Links to other websites that you save are not controlled by us.</p>

      <h3 id="availability">10. Availability and your own copies</h3>
      <p>We work to keep the service running, but we do not promise that it will always be available or error-free, or that data will never be lost. We may change or stop parts of it, and we are not required to provide support. The service is currently free. If we ever start charging, we will tell you first, and you can delete your account instead. You can download your data at any time from Settings. Please keep your own copies of anything important, and do not rely on the service as your only record.</p>

      <p><strong>Reminders and alerts may fail.</strong> Reminders, alerts, notifications and emails depend on things we do not control, such as your device, your internet connection, email delivery and your time settings. They may arrive late, not arrive, or be wrong. Do not rely on them for medicines or care that matter. Set your own backup alarms and check your records yourself.</p>

      <h3 id="ending">11. Ending your account</h3>
      <p>You can delete your account from Settings. You can schedule the deletion, which starts a short waiting period during which you can cancel, or you can choose to delete immediately. Deleting removes your records from our database. Copies in our hosting provider's backups are removed as those backups expire. Anything you shared that others have already seen or copied cannot be recalled.</p>
      <p>We may suspend or close an account that breaks these terms or puts others or the service at risk. If we do this without a violation, we will try to give you notice and a chance to download your data.</p>

      <h3 id="disclaimers">12. Disclaimers</h3>
      <p>The service is provided "as is" and "as available". To the fullest extent the law allows, we disclaim all warranties, including any warranty that the service is accurate, complete, uninterrupted, secure or fit for a particular purpose, and any warranty about the reference information, warnings and automatic readings it contains. Some places do not allow some disclaimers, so some of this may not apply to you.</p>

      <h3 id="liability">13. Limits on our responsibility</h3>
      <p>To the fullest extent the law allows, we are not responsible for indirect, incidental, special, consequential or punitive losses, or for harm that results from medical decisions you or others make, from information that is missing, wrong or out of date, from codes that you share or lose, or from the actions of people you share with. Our total responsibility for any claim relating to the service is limited to the greater of the amount you paid us in the past 12 months or 100 U.S. dollars. Nothing in these terms limits responsibility that cannot be limited by law.</p>

      <h3 id="law">14. Governing law and disputes</h3>
      <p>These terms are governed by the laws of {GOVERNING_STATE}, without regard to its conflict-of-law rules. Before starting a formal claim, please contact us and give us a chance to resolve it informally. Any claim must be brought in the courts located in {GOVERNING_STATE}, unless the law where you live gives you the right to bring it elsewhere.</p>

      <h3 id="changes">15. Changes to these terms</h3>
      <p>We may update these terms. When we make a change that matters, we will change the version, ask you to accept the new terms the next time you use the service, and, where practical, tell you by email before it takes effect. If you do not agree, you can download your data and delete your account.</p>

      <h3 id="general">16. General</h3>
      <p>These terms and the Privacy Policy are the whole agreement between you and us about the service. If a part of them cannot be enforced, the rest still applies. If we do not enforce a part right away, we have not given it up. We may give you notices by email, in the app or on the website. You may not transfer your account to someone else. We may transfer our rights and duties if the service is sold or merged. The parts of these terms that by their nature should continue after your account ends (such as sections 5, 12, 13 and 14) do.</p>

      <h3 id="contact">17. Contact</h3>
      <p>{COMPANY_NAME}<br />{COMPANY_ADDRESS}<br />{CONTACT_EMAIL}</p>
    </LegalLayout>
  );
}

export default Terms;
