import { useState } from "react";
import { checkPassword } from "../password";

// A password box with a Show / Hide button, and (when `meter` is set) a strength bar with a checklist of the rules.
// Use meter on sign-up and reset; leave it off for logging in. Strength is only advice: the server checks the rules again.
type Props = {
  id: string; label: string; value: string; onChange: (value: string) => void;
  autoComplete: "new-password" | "current-password"; placeholder?: string; name?: string;
  meter?: boolean; who?: { email?: string; name?: string }; describedBy?: string;
};
const COLORS = ["#c8ced6", "#c0392b", "#d68910", "#2e8b57", "#1b6b3a"];

function PasswordInput({ id, label, value, onChange, autoComplete, placeholder, name, meter, who, describedBy }: Props) {
  const [shown, setShown] = useState(false);
  const s = meter ? checkPassword(value, who) : null;
  const tipsId = `${id}-tips`;
  return (
    <div className="form-group password-field">
      <label htmlFor={id}>{label}</label>
      <div className="password-row">
        <input id={id} name={name ?? id} type={shown ? "text" : "password"} autoComplete={autoComplete} placeholder={placeholder}
          value={value} onChange={(e) => onChange(e.target.value)} aria-describedby={[meter ? tipsId : "", describedBy ?? ""].filter(Boolean).join(" ") || undefined}
          spellCheck={false} autoCapitalize="none" autoCorrect="off" />
        <button type="button" className="secondary-button password-toggle" aria-pressed={shown} aria-controls={id} onClick={() => setShown((v) => !v)}>
          {shown ? "Hide" : "Show"}
        </button>
      </div>
      {s && (
        <div id={tipsId} className="password-tips">
          {value && (
            <>
              <div className="password-bar" role="img" aria-label={`Password strength: ${s.text}`}>
                {[1, 2, 3, 4].map((n) => <span key={n} style={{ background: s.level >= n ? COLORS[s.level] : COLORS[0] }} />)}
              </div>
              <p role="status" className="password-level" style={{ color: COLORS[s.level] }}>{s.text}</p>
            </>
          )}
          <ul>
            {s.checks.map((c) => (
              <li key={c.label} className={value ? (c.ok ? "ok" : "bad") : ""}>
                <span aria-hidden="true">{value ? (c.ok ? "✔ " : "✖ ") : "• "}</span>{c.label}
                <span className="sr-only">{value ? (c.ok ? " (met)" : " (not met)") : ""}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default PasswordInput;
