import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import PasswordInput from "../components/PasswordInput";
import { checkPassword } from "../password";
import { MIN_AGE } from "../legal";

// The password rules are in password.ts (the server enforces the same ones: Parse/cloud/lib/password.js)

function Register() {
  const navigate = useNavigate();

  const [formData, setFormData] = useState({
    name: "",
    email: "",
    password: "",
    confirmPassword: "",
  });
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    const { name, value } = event.target;
    setFormData((previousData) => ({ ...previousData, [name]: value }));
  }

  function validate(): string {
    if (!formData.name.trim()) return "Please enter your full name.";
    if (!formData.email.trim()) return "Please enter your email address.";
    if (!checkPassword(formData.password, { email: formData.email, name: formData.name }).ok)
      return "Please choose a stronger password. The checklist under the password box shows what is missing.";
    if (formData.password !== formData.confirmPassword) return "Passwords do not match.";
    if (!agreed) return `Please agree to the Terms of Service, Privacy Policy and Medical Disclaimer, and confirm you are ${MIN_AGE} or older.`;
    return "";
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }

    setBusy(true);
    setError("");
    try {
      await api("/register", {
        method: "POST",
        body: JSON.stringify({
          name: formData.name.trim(),
          email: formData.email.trim(),
          password: formData.password,
          accepted_terms: true,
        }),
      });
      // Send them to the login page with their email filled in
      navigate("/", {
        state: { registeredEmail: formData.email.trim().toLowerCase() },
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const passwordsMismatch =
    formData.confirmPassword.length > 0 && formData.password !== formData.confirmPassword;

  return (
    <main className="login-page">
      <section className="login-card">
        <h1>Create an Account</h1>
        <p>Sign up to securely store and share your medical information.</p>

        {error && <p role="alert" className="notice error">{error}</p>}

        <form onSubmit={handleSubmit} noValidate>
          <div className="form-group">
            <label htmlFor="name">Full Name</label>
            <input
              id="name"
              name="name"
              type="text"
              autoComplete="name"
              placeholder="Enter your full name"
              maxLength={255}
              value={formData.name}
              onChange={handleChange}
            />
          </div>

          <div className="form-group">
            <label htmlFor="email">Email Address</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              placeholder="Enter your email"
              maxLength={255}
              value={formData.email}
              onChange={handleChange}
            />
          </div>

          <PasswordInput id="password" label="Password" value={formData.password} autoComplete="new-password" meter
            who={{ email: formData.email, name: formData.name }} onChange={(v) => setFormData((d) => ({ ...d, password: v }))} />
          <small className="form-hint">A passphrase of several words works well, e.g. three or four unrelated words. Use a password you don't use anywhere else.</small>

          <PasswordInput id="confirmPassword" label="Confirm Password" value={formData.confirmPassword} autoComplete="new-password"
            placeholder="Re-enter your password" onChange={(v) => setFormData((d) => ({ ...d, confirmPassword: v }))} />
          {passwordsMismatch && (
            <small className="form-hint form-hint-error">Passwords do not match.</small>
          )}

          <label className="check-row">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            <span>I am {MIN_AGE} or older and I agree to the <Link to="/terms" target="_blank">Terms of Service</Link>, <Link to="/privacy" target="_blank">Privacy Policy</Link> and <Link to="/disclaimer" target="_blank">Medical Disclaimer</Link>. I understand this is not medical advice and not for emergencies.</span>
          </label>

          <button className="primary-button full-width" type="submit" disabled={busy}>
            {busy ? "Creating account…" : "Create Account"}
          </button>
        </form>

        <p className="auth-switch">
          Already have an account? <Link to="/">Log in</Link>
        </p>
      </section>
    </main>
  );
}

export default Register;
