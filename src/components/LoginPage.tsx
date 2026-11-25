import { ArrowLeft, Lock } from "lucide-react";
import { useState } from "react";
import { signIn, signUp } from "../auth";

interface Props {
  onDone: () => void;      // signed in
  onGuest: () => void;     // continue without an account
  configured: boolean;
}

/** Sign in or create an account. Guests can use every feature; an account keeps the
 * library private and available on every device. */
export function LoginPage({ onDone, onGuest, configured }: Props) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const em = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return setError("Enter a valid email address.");
    if (password.length < 8) return setError("Use a password of at least 8 characters.");
    setBusy(true);
    try {
      if (mode === "signin") await signIn(em, password);
      else await signUp(name.trim(), em, password);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="login-card">
        <button className="btn-ghost btn-sm login-back" onClick={onGuest}><ArrowLeft size={14} /> Back</button>
        <div className="welcome-brand">
          <span className="brand-mark" aria-hidden="true">EF</span>
          <div>
            <h1>{mode === "signin" ? "Sign in" : "Create your account"}</h1>
            <p className="tagline">Evidence-First Research OS</p>
          </div>
        </div>
        <p className="hint">
          An account keeps your library private and on every device. You can also use everything as a guest.
        </p>
        {!configured && (
          <p className="notice notice-warn" role="status">Sign-in is not set up on this site yet. You can continue as a guest.</p>
        )}
        <div className="segmented" role="tablist" aria-label="Sign in or create an account">
          <button role="tab" aria-selected={mode === "signin"} className={mode === "signin" ? "seg-on" : ""}
            onClick={() => { setMode("signin"); setError(""); }}>Sign in</button>
          <button role="tab" aria-selected={mode === "signup"} className={mode === "signup" ? "seg-on" : ""}
            onClick={() => { setMode("signup"); setError(""); }}>Create account</button>
        </div>
        <form className="form" onSubmit={submit} noValidate>
          {mode === "signup" && (
            <label>Name <span className="optional">(optional)</span>
              <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={100} />
            </label>
          )}
          <label>Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email"
              inputMode="email" autoCapitalize="off" spellCheck={false} maxLength={254} required />
          </label>
          <label>Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} maxLength={128}
              autoComplete={mode === "signin" ? "current-password" : "new-password"} required />
          </label>
          {error && <p className="error" role="alert">{error}</p>}
          <button className="btn-primary" disabled={busy || !configured}>
            <Lock size={16} aria-hidden="true" />
            {busy ? (mode === "signin" ? "Signing in…" : "Creating account…") : mode === "signin" ? "Sign in" : "Create account"}
          </button>
        </form>
        <button className="btn-ghost" onClick={onGuest}>Continue as a guest</button>
        <p className="hint small">
          Passwords are handled by Neon Auth and are never stored by this site. Guest libraries stay on this device; you can
          save one to your account after signing in.
        </p>
      </div>
    </div>
  );
}
