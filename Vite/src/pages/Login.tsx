import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import PasswordInput from "../components/PasswordInput";
import { checkPassword } from "../password";
import { api, dashboardPath, isLoggedIn, type Role } from '../api';
import Parse from '../parse';

// login → code (2FA) ; forgot → reset (password reset by emailed code)
type Mode = "login" | "code" | "forgot" | "reset";

function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  // Set by the Register page after a successful sign-up
  const navState = location.state as { registeredEmail?: string; loggedOutReason?: string } | null;
  const registeredEmail = navState?.registeredEmail;

  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState(registeredEmail ?? "");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(
    registeredEmail ? "Account created. Log in to continue." : navState?.loggedOutReason ?? "");
  const [busy, setBusy] = useState(false);

  // Already logged in? Skip the login page.
  useEffect(() => {
    if (isLoggedIn()) navigate(dashboardPath(), { replace: true });
  }, [navigate]);

  function switchMode(next: Mode, message = "") {
    setMode(next); setError(""); setNotice(message);
  }

  async function handleLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // (used alert() before; errors now show inline like everything else)
    if (!email.trim() || !password) { setError("Please enter an email and password."); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      await api('/login', { method: 'POST', body: JSON.stringify({ email: email.trim(), password }) });
      setCode(""); switchMode("code");
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  async function handleVerify(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      // The server says which kind of account this is. There's no "Account Type"
      // dropdown anymore: picking "Physician" used to be all it took to get in as one.
      const data = await api<{ role: Role; name: string }>('/verify-2fa', {
        method: 'POST', body: JSON.stringify({ email: email.trim(), code: code.trim() }),
      });
      // The code was right, so Parse now lets this email + password log in
      // (the beforeLogin check in Parse/cloud/lib/auth.js refuses it otherwise).
      await Parse.User.logIn(email.trim().toLowerCase(), password);
      setPassword("");
      navigate(dashboardPath(data.role));
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  async function handleForgot(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!email.trim()) { setError("Please enter your email address."); return; }
    setBusy(true); setError("");
    try {
      const data = await api<{ message: string }>('/forget', { method: 'POST', body: JSON.stringify({ email: email.trim() }) });
      setResetCode(""); setNewPassword(""); setConfirmPassword("");
      switchMode("reset", data.message);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  async function handleReset(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!resetCode.trim()) { setError("Enter the reset code from your email."); return; }
    if (!checkPassword(newPassword, { email }).ok) { setError("Please choose a stronger password. The checklist shows what is missing."); return; }
    if (newPassword !== confirmPassword) { setError("Passwords do not match."); return; }
    setBusy(true); setError("");
    try {
      const data = await api<{ message: string }>('/reset', {
        method: 'POST', body: JSON.stringify({ code: resetCode.trim(), newPassword }),
      });
      setPassword("");
      switchMode("login", data.message);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <main className="login-page">
      <section className="login-card">
        <h1>Health Information Banking</h1>
        <p>Securely access and manage medical information.</p>

        {notice && !error && <p role="status" className="notice success">{notice}</p>}
        {error && <p role="alert" className="notice error">{error}</p>}

        {mode === "code" && (
          <form onSubmit={handleVerify}>
            <p>Enter the 8-digit verification code sent to your email.</p>
            <div className="form-group">
              <label htmlFor="code">Verification code</label>
              <input id="code" inputMode="numeric" autoComplete="one-time-code" maxLength={8} required
                value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ""))} />
            </div>
            <button className="primary-button full-width" disabled={busy}>{busy ? "Verifying…" : "Verify and log in"}</button>
            <button type="button" className="text-button" onClick={() => { setCode(""); switchMode("login"); }}>Back</button>
          </form>
        )}

        {mode === "login" && (
          <form onSubmit={handleLogin} noValidate>
            <div className="form-group">
              <label htmlFor="email">Email Address</label>
              <input id="email" name="email" type="email" autoComplete="email" placeholder="Enter your email"
                value={email} onChange={e => setEmail(e.target.value)} />
            </div>

            <PasswordInput id="password" label="Password" value={password} onChange={setPassword} autoComplete="current-password" placeholder="Enter your password" />

            <button className="primary-button full-width" type="submit" disabled={busy}>
              {busy ? 'Signing in…' : 'Log In'}
            </button>

            <button className="text-button" type="button" onClick={() => switchMode("forgot")}>
              Forgot Password?
            </button>
          </form>
        )}

        {mode === "forgot" && (
          <form onSubmit={handleForgot} noValidate>
            <h2 className="auth-subheading">Reset your password</h2>
            <p>Enter your account email and we'll send you a reset code.</p>
            <div className="form-group">
              <label htmlFor="forgot-email">Email Address</label>
              <input id="forgot-email" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} />
            </div>
            <button className="primary-button full-width" disabled={busy}>{busy ? "Sending…" : "Send reset code"}</button>
            <button type="button" className="text-button" onClick={() => switchMode("login")}>Back to log in</button>
          </form>
        )}

        {mode === "reset" && (
          <form onSubmit={handleReset} noValidate>
            <h2 className="auth-subheading">Choose a new password</h2>
            <div className="form-group">
              <label htmlFor="reset-code">Reset code</label>
              <input id="reset-code" autoComplete="one-time-code" value={resetCode} onChange={e => setResetCode(e.target.value)} />
            </div>
            <PasswordInput id="new-password" label="New password" value={newPassword} onChange={setNewPassword} autoComplete="new-password" meter who={{ email }} />
            <PasswordInput id="confirm-new-password" label="Confirm new password" value={confirmPassword} onChange={setConfirmPassword} autoComplete="new-password" />
            {confirmPassword.length > 0 && newPassword !== confirmPassword && <small className="form-hint form-hint-error">Passwords do not match.</small>}
            <button className="primary-button full-width" disabled={busy}>{busy ? "Saving…" : "Reset password"}</button>
            <button type="button" className="text-button" onClick={() => switchMode("forgot")}>Send a new code</button>
          </form>
        )}

        {(mode === "login" || mode === "forgot") && (
          <>
            <p className="auth-switch">
              Don't have an account? <Link to="/register">Sign up</Link>
            </p>
            <p className="auth-switch">
              Someone shared their records with you? <Link to="/view">View with a code</Link>
            </p>
          </>
        )}
      </section>
    </main>
  );
}

export default Login;
