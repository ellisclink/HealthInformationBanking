import { Link } from "react-router-dom";
import { COMPANY_NAME, SITE_NAME } from "../legal";

// Shown at the bottom of every page (see App.tsx).
function Footer() {
  return (
    <footer className="site-footer no-print">
      <nav aria-label="Legal">
        <Link to="/terms">Terms of Service</Link>
        <Link to="/privacy">Privacy Policy</Link>
        <Link to="/disclaimer">Medical Disclaimer</Link>
        <a href="/privacy#healthdata">Consumer Health Data Privacy</a>
        <Link to="/emergency-access">Emergency responders</Link>
      </nav>
      <p>{SITE_NAME} keeps your records in one place. It is not a medical provider and is not for emergencies: call your local emergency number.</p>
      <p>© {new Date().getFullYear()} {COMPANY_NAME}</p>
    </footer>
  );
}

export default Footer;
