import { useEffect, useState } from "react";
import AlertBanner from "../components/AlertBanner";
import NavigationBar from "../components/NavigationBar";
import AccountData from "../components/AccountData";
import { api, type Me } from "../api";

// Profile now shows the logged-in account (GET /api/me) instead of the hard-coded
// "Maria Rodriguez / maria@example.com", and it's read-only because there is no
// endpoint to change it yet — the old editable fields looked like they saved but didn't.
// The "Two-Factor Authentication" toggle defaulted to OFF even though every login
// already requires an emailed code, so it's shown as a fact instead of a switch.
function Settings() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [settings, setSettings] = useState({
    emailNotifications: true,
    securityAlerts: true,
  });

  useEffect(() => {
    api<Me>("/me").then(setMe).catch((e) => setError((e as Error).message));
  }, []);

  function handleToggle(event: React.ChangeEvent<HTMLInputElement>) {
    const { name, checked } = event.target;
    setSettings((previousSettings) => ({ ...previousSettings, [name]: checked }));
  }

  function handleSave() {
    // Used to alert "Settings saved successfully." without saving anything.
    setMessage("Notification preferences are kept for this visit only. Saving them to your account isn't built yet.");
  }

  return (
    <>
      <NavigationBar />

      <main className="page-container">
        <AlertBanner
          message="Review your privacy and security settings regularly."
          type="info"
        />

        <section className="page-heading">
          <h2>Account Settings</h2>
          <p>Manage your account, security, and notification preferences.</p>
        </section>

        {error && <p className="notice error" role="alert">{error}</p>}

        <section className="settings-card">
          <h3>Profile Information</h3>

          <div className="form-group">
            <label htmlFor="full-name">Full Name</label>
            <input id="full-name" type="text" value={me?.name ?? ""} readOnly />
          </div>

          <div className="form-group">
            <label htmlFor="settings-email">Email Address</label>
            <input id="settings-email" type="email" value={me?.email ?? ""} readOnly />
          </div>

          <p>Account type: <strong>{me ? "Patient" : ""}</strong></p>
        </section>

        <section className="settings-card">
          <h3>Notifications and Security</h3>

          <label className="toggle-row">
            <span>Email Notifications</span>
            <input
              name="emailNotifications"
              type="checkbox"
              checked={settings.emailNotifications}
              onChange={handleToggle}
            />
          </label>

          <label className="toggle-row">
            <span>Security Alerts</span>
            <input
              name="securityAlerts"
              type="checkbox"
              checked={settings.securityAlerts}
              onChange={handleToggle}
            />
          </label>

          <p className="toggle-row">
            <span>Two-Factor Authentication</span>
            <strong>Always on — a code is emailed at every login</strong>
          </p>
        </section>

        {message && <p className="notice success" role="status">{message}</p>}

        <AccountData />

        <button
          className="primary-button"
          type="button"
          onClick={handleSave}
        >
          Save Settings
        </button>
      </main>
    </>
  );
}

export default Settings;
