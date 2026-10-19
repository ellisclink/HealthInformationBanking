import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";

// Matches the checks in POST /api/register (Node/2FAapi.js)
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 72; // bcrypt ignores anything past 72 bytes

function Register() {
  const navigate = useNavigate();

  const [formData, setFormData] = useState({
    name: "",
    email: "",
    password: "",
    confirmPassword: "",
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    const { name, value } = event.target;
    setFormData((previousData) => ({ ...previousData, [name]: value }));
  }

  function validate(): string {
    if (!formData.name.trim()) return "Please enter your full name.";
    if (!formData.email.trim()) return "Please enter your email address.";
    if (formData.password.length < MIN_PASSWORD)
      return `Password must be at least ${MIN_PASSWORD} characters.`;
    if (new TextEncoder().encode(formData.password).length > MAX_PASSWORD)
      return `Password must be ${MAX_PASSWORD} characters or fewer.`;
    if (formData.password !== formData.confirmPassword) return "Passwords do not match.";
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

          <div className="form-group">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              placeholder={`At least ${MIN_PASSWORD} characters`}
              value={formData.password}
              onChange={handleChange}
              aria-describedby="password-hint"
            />
            <small id="password-hint" className="form-hint">
              Use {MIN_PASSWORD}+ characters. A passphrase works well.
            </small>
          </div>

          <div className="form-group">
            <label htmlFor="confirmPassword">Confirm Password</label>
            <input
              id="confirmPassword"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              placeholder="Re-enter your password"
              value={formData.confirmPassword}
              onChange={handleChange}
              aria-invalid={passwordsMismatch}
            />
            {passwordsMismatch && (
              <small className="form-hint form-hint-error">Passwords do not match.</small>
            )}
          </div>

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
