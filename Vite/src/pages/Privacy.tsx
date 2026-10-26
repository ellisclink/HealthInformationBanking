import LegalLayout from "../components/LegalLayout";
import { COMPANY_ADDRESS, COMPANY_NAME, MIN_AGE, PRIVACY_EMAIL, SITE_NAME, SITE_SHORT } from "../legal";

// Privacy Policy (a starting draft; see the notes at the top of legal.ts). Public page: /privacy
// Keep the statements below true to the code. Where the code changes (what is logged, who processes data), change this page too.
const SECTIONS = [
  { id: "summary", title: "The short version" },
  { id: "collect", title: "What we collect" },
  { id: "use", title: "How we use it" },
  { id: "who", title: "Who can see your information" },
  { id: "providers", title: "Service providers" },
  { id: "laws", title: "Health privacy laws" },
  { id: "healthdata", title: "Consumer health data" },
  { id: "security", title: "How we protect it" },
  { id: "storage", title: "Cookies and browser storage" },
  { id: "keep", title: "How long we keep it" },
  { id: "choices", title: "Your choices and rights" },
  { id: "children", title: "Children" },
  { id: "breach", title: "If something goes wrong" },
  { id: "changes", title: "Changes to this policy" },
  { id: "contact", title: "Contact" },
];

function Privacy() {
  return (
    <LegalLayout title="Privacy Policy" sections={SECTIONS}>
      <section className="mpn" aria-labelledby="glance">
        <h3 id="glance">Privacy at a glance</h3>
        <p>This summary follows the U.S. government's voluntary Model Privacy Notice for health apps. It does not replace the full policy below. "We" means {SITE_NAME}; "you" means the person using it.</p>
        <table>
          <tbody>
            <tr><th scope="row">HIPAA</th><td>We are <strong>not</strong> a HIPAA covered entity. The health information you keep in {SITE_NAME} is <strong>not</strong> covered by HIPAA.</td></tr>
            <tr><th scope="row">Use: how we use your data inside {SITE_SHORT}</th><td>Our main purpose is to let you keep your health records in one place and share them as you choose. We use your identifiable data to <strong>provide that service</strong> and to <strong>support our operations</strong> (security, preventing abuse, fixing problems). We do <strong>not</strong> use it for marketing, scientific research, or analytics to develop products.</td></tr>
            <tr><th scope="row">Share: how we share your data with others</th><td>We share your identifiable data only to <strong>provide the service</strong> (with the people you choose, and the providers that host and run it) and to <strong>support our operations</strong>. We do <strong>not</strong> share it for marketing, research or analytics. We do <strong>not</strong> share data after removing identifiers.</td></tr>
            <tr><th scope="row">Sell: who we sell your data to</th><td><strong>No.</strong> We do not sell your identifiable data, and we do not sell data after removing identifiers.</td></tr>
            <tr><th scope="row">Store: how we store your data</th><td>Your records are <strong>not</strong> kept on your device (only a temporary login session is). They are stored outside your device, with our hosting provider.</td></tr>
            <tr><th scope="row">Encryption: how we encrypt your data</th><td>In your browser: not applicable (no health records are kept there). On our servers: <strong>uploaded files are encrypted automatically</strong>; other records are protected by our hosting provider's database security and we do not add a separate encryption layer to them. While being sent: <strong>yes, automatically</strong>.</td></tr>
            <tr><th scope="row">Deactivation: what happens to your data when you delete your account</th><td>Deleted after 7 days if you schedule the deletion (you can cancel), or immediately if you choose. Copies in our hosting provider's backups are removed as those backups expire. Accounts are not deleted for inactivity; we keep your data until you delete it.</td></tr>
            <tr><th scope="row">Policy changes: how we tell you</th><td>We ask you to accept the new version the next time you use the service and, where practical, email you first. We ask for your clear permission before using your health data in a new way.</td></tr>
            <tr><th scope="row">Breach: how we tell you and protect your data</th><td>We follow the law, including the FTC's Health Breach Notification Rule: we investigate, stop the problem, and tell affected people (email plus a notice in the app or on our website) and the authorities. See section 13.</td></tr>
            <tr><th scope="row">Privacy: other data this app can reach</th><td>It does <strong>not</strong> use your camera, contacts, location, microphone or health monitoring devices. It reads only the files you choose to upload. It does <strong>not</strong> let you share your data to social media accounts.</td></tr>
            <tr><th scope="row">User options: what you can do with your data</th><td>You can <strong>access</strong> (download), <strong>edit</strong>, <strong>share</strong> and <strong>delete</strong> your data. Most of this is in the app; see section 11.</td></tr>
            <tr><th scope="row">Contact us</th><td>{COMPANY_NAME}, {COMPANY_ADDRESS}, {PRIVACY_EMAIL}</td></tr>
          </tbody>
        </table>
        <p className="mpn-defs"><small><strong>Words used.</strong> Identifiable data: data, such as your name, email, health services or information about your physical or mental health, that can be used alone or with other information to identify you. Analytics: examining data to draw conclusions from it. Data broker: a company that collects personal information about people from many sources and resells it. Encryption: converting text into code so that only authorized parties can read it. Cloud computing: internet-based computing that provides shared processing resources and data on demand. Deactivation: you or the company closing your account. Breach: an unauthorized disclosure.</small></p>
      </section>

      <h3 id="summary">1. The short version</h3>
      <ul>
        <li>You decide what to put in {SITE_NAME} and who can see it.</li>
        <li>We do not sell your information, we do not share it for advertising, and we do not show ads.</li>
        <li>We use service providers to host and protect the service. They are listed in section 5.</li>
        <li>You can download all of your data and delete your account from Settings.</li>
        <li>{SITE_NAME} is not a doctor, hospital or health plan, so the health privacy law that applies to them (HIPAA) does not apply to us. Other rules do. See section 6.</li>
        <li>No online service is perfectly secure. Section 8 says what we do and what we cannot promise.</li>
      </ul>

      <h3 id="collect">2. What we collect</h3>
      <p><strong>Information you give us:</strong></p>
      <ul>
        <li>your name, email address and password (the password is stored so that it cannot be read back);</li>
        <li>the health information you enter or import, such as medications, conditions, allergies, lab results, vital signs, diary entries, food logs, reminders, calendar events, breathing-device details, saved links and your health history form;</li>
        <li>files you upload, such as PDFs and images;</li>
        <li>your sharing and emergency-access settings, including any wishes about treatment that you record; and</li>
        <li>messages you send us.</li>
      </ul>
      <p><strong>Information created as you use the service:</strong></p>
      <ul>
        <li>login and security records, such as login attempts and the time and network address of requests that matter for security;</li>
        <li>a history of changes to your records, which includes copies of the values before and after each change; and</li>
        <li>a log of who opened a sharing code or emergency code: the name, agency or badge number they typed in, the time, their network address and their browser details. You can see the sharing and emergency logs in the app.</li>
      </ul>
      <p><strong>Information from PDFs and imports:</strong> if you use PDF auto-fill, the text of the PDF is read on our servers to suggest entries. A temporary copy of the file and the suggestions are kept for up to 24 hours, or until you confirm or cancel, and are then erased. Nothing is added to your records until you confirm it. The PDF is kept only if you choose to save it to your documents.</p>

      <h3 id="use">3. How we use it</h3>
      <p>We use your information to provide the service you asked for: showing and organizing your records, calculating things like pill counts and trends, sending login codes and reminders, letting you share, keeping the service secure, preventing abuse, fixing problems, and meeting legal duties. The emails we send you (login codes, password resets and reminder notices) do not contain your health details.</p>
      <p>We do not sell your health information. We do not share it with advertisers, data brokers or analytics companies, and we do not use it for advertising.</p>

      <h3 id="who">4. Who can see your information</h3>
      <ul>
        <li><strong>You.</strong></li>
        <li><strong>People you share with.</strong> Anyone with a sharing code you create can see the sections you chose until the code expires or you revoke it. Provider codes open only for physician accounts. A physician or other person who sees your information gets a view of it and may keep a copy. They handle it under their own rules, not ours.</li>
        <li><strong>Anyone with your emergency code,</strong> if you turn it on, for the sections you chose and your recorded wishes.</li>
        <li><strong>Anyone with a calendar subscribe link you create,</strong> for the event titles and times in it.</li>
        <li><strong>Our service providers,</strong> only as needed to run the service (section 5).</li>
        <li><strong>Authorities,</strong> if the law requires it. We will tell you first where we are allowed to.</li>
        <li><strong>A buyer or successor,</strong> if the service is sold or merged. We will give you notice and the chance to download your data and delete your account first.</li>
      </ul>
      <p>We limit who on our team can reach the database, and we do not look at your records except when needed to keep the service running, to help with a problem you have asked us about, or to follow the law. Because the service runs on hosting providers, we cannot promise that nobody at those providers could technically reach stored data.</p>

      <h3 id="providers">5. Service providers</h3>
      <ul>
        <li><strong>Back4app</strong> hosts the application and its database.</li>
        <li><strong>Cloudflare</strong> provides our web address (DNS) and network protection. Web traffic to our website passes through it.</li>
        <li><strong>An email provider</strong> sends login codes, password-reset codes and reminder notices.</li>
        <li><strong>The U.S. Department of Agriculture (FoodData Central)</strong> receives the food names you search for in Nutrition. Our servers send the search, so it does not include your name or account details.</li>
      </ul>
      <p>Links that you save in the app lead to other websites. We do not control them and this policy does not cover them.</p>
      <p>These providers have their own terms and practices, which we do not control, and they may keep standard technical logs. We choose providers that offer security features, and we do not give them your information for their own marketing, but we cannot guarantee how they handle it.</p>

      <h3 id="laws">6. Health privacy laws</h3>
      <p>{SITE_NAME} is a personal health record that you control. It is not a doctor, hospital, health insurer or one of their service providers, so HIPAA, the federal law that protects health information held by those organizations, does not apply to the information you keep here. Other rules do apply to us, including the Federal Trade Commission Act and the FTC's Health Breach Notification Rule, and, depending on where you live, state privacy and consumer-health-data laws. We handle your information as described in this policy. If you share information from here with a doctor, that doctor's own copy is protected by the rules that apply to them.</p>

      <h3 id="healthdata">7. Consumer health data</h3>
      <p>Some states, such as Washington and Nevada, have laws about "consumer health data" and ask for a separate notice. This section is that notice. It applies to everyone who uses the service, wherever you live.</p>
      <ul>
        <li><strong>What we collect:</strong> health conditions, treatments and medications, allergies, lab and other test results, vital signs and body measurements, health-related diary, nutrition and breathing-device entries, reminders and appointments, any wishes about treatment you record, and the files you upload.</li>
        <li><strong>Why:</strong> only to provide the features you use and keep the service secure (section 3). You agree to this when you create an account and accept the Terms.</li>
        <li><strong>Where it comes from:</strong> you, and the files or records you choose to upload or import. We do not collect health data about you from anyone else.</li>
        <li><strong>Who it is shared with:</strong> the people you choose to share with (section 4) and the service providers that help us run the service (section 5). We do not sell it, and we do not share it for advertising.</li>
        <li><strong>Your rights:</strong> you can ask us to confirm what we collect, get a copy, withdraw your consent, and delete it. You can do most of this yourself in Settings, or email us. If we turn down a request, you can ask us to reconsider by email, and you may also contact your state attorney general.</li>
      </ul>

      <h3 id="security">8. How we protect it</h3>
      <p>Steps we take: a code emailed to you at every login; password rules that reject weak and common passwords; sessions that end after inactivity; passwords and codes stored in a form that cannot be read back; encrypted connections to the service; limits on repeated wrong guesses; checks so that each person can reach only their own records; and a log of important actions.</p>
      <p>Uploaded files (such as PDFs and images) are encrypted by us before they are stored. The rest of your records are protected by the security of the database and hosting services we use. We do not add a separate layer of encryption to them.</p>
      <p><strong>What this does not mean:</strong> these steps reduce risk but do not remove it. No online service can promise that information will never be accessed without permission, lost or changed. The emailed login code is only as safe as your email account. Anyone who has a sharing code or emergency code you created can see what it allows. Please use a strong password that you use nowhere else, protect your email account, and log out on shared computers.</p>

      <h3 id="storage">9. Cookies and browser storage</h3>
      <p>We do not use advertising or tracking cookies. When you log in, your browser keeps your session in its temporary session storage, which is cleared when you close the tab. Our network provider may set cookies or use similar technology that is needed to protect the site from attacks and keep it running, and it may collect basic traffic information such as network addresses. We do not use analytics tools that follow you across other sites. Because we do not track you across sites, a "Do Not Track" setting in your browser does not change what we do.</p>

      <h3 id="keep">10. How long we keep it</h3>
      <p>We keep your information while your account is open. When you delete your account, we remove your records, your sharing information and the logs about your account from our database. If you schedule the deletion, there is a short waiting period during which you can cancel. Copies in our hosting provider's backups are deleted as those backups expire. We keep a small anonymous record that an account was deleted, with no health information in it. Short-lived data (login codes, reset codes and PDF auto-fill drafts) is erased automatically. We may keep information longer where the law requires.</p>

      <h3 id="choices">11. Your choices and rights</h3>
      <ul>
        <li><strong>Access and download:</strong> Settings, then Your data, gives you everything in your account as a file.</li>
        <li><strong>Correct:</strong> you can edit most of your records yourself.</li>
        <li><strong>Delete:</strong> you can delete your account in Settings.</li>
        <li><strong>Control sharing:</strong> create, review and revoke sharing codes, calendar links and the emergency code at any time.</li>
        <li><strong>Other rights:</strong> depending on where you live, you may have further rights, such as to know what we hold, to correct or delete it, to limit its use, or to complain to a regulator. Email us and we will respond within the time the law gives us. We will not treat you differently for using these rights.</li>
      </ul>

      <h3 id="children">12. Children</h3>
      <p>The service is for people who are {MIN_AGE} or older. We do not knowingly collect information from children. If you think a child has given us information, contact us and we will delete it.</p>

      <h3 id="breach">13. If something goes wrong</h3>
      <p>If we learn that your information was accessed or disclosed without your authorization, we will investigate and take steps to stop it. We will then tell the people affected, the Federal Trade Commission and, where the law requires it, the news media, as the FTC's Health Breach Notification Rule and state laws require. We will not wait longer than the law allows, which for the FTC rule is no more than 60 days after we discover the problem. We will contact you by email and also put a notice in the app or on our website. We count unauthorized sharing of your health information as a breach, not only a hack.</p>

      <h3 id="changes">14. Changes to this policy</h3>
      <p>We may update this policy. For changes that matter, we will change its version date, ask you to accept it again the next time you use the service, and, where practical, tell you by email before the change takes effect. If a change would let us use or share your health information in a new way, we will ask for your clear permission first, and it will not apply to information you already gave us unless you agree.</p>

      <h3 id="contact">15. Contact</h3>
      <p>{COMPANY_NAME}<br />{COMPANY_ADDRESS}<br />{PRIVACY_EMAIL}</p>
    </LegalLayout>
  );
}

export default Privacy;
