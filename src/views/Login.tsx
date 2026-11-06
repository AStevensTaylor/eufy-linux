import { useState, type FormEvent } from "react";
import { useStore } from "../lib/store";

const COUNTRIES: Array<[string, string]> = [
  ["GB", "United Kingdom"],
  ["US", "United States"],
  ["DE", "Germany"],
  ["FR", "France"],
  ["ES", "Spain"],
  ["IT", "Italy"],
  ["NL", "Netherlands"],
  ["AU", "Australia"],
  ["CA", "Canada"],
  ["IE", "Ireland"],
  ["SE", "Sweden"],
  ["NO", "Norway"],
  ["DK", "Denmark"],
  ["JP", "Japan"],
];

export function LoginView() {
  const { state, bridge, dispatch } = useStore();
  const [username, setUsername] = useState(state.auth?.username ?? "");
  const [password, setPassword] = useState("");
  const [country, setCountry] = useState("GB");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const auth = state.auth;
  const connecting = auth?.state === "connecting";
  const error = localError ?? state.authError?.message ?? null;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setLocalError(null);
    try {
      await fn();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onLogin = (e: FormEvent) => {
    e.preventDefault();
    dispatch({ type: "auth-clear-flow" });
    void run(() =>
      bridge.call("auth.login", {
        username: username.trim(),
        password,
        country: country.trim().toUpperCase() || "GB",
        language: "en",
        trustedDeviceName: "Eufy Linux",
      }),
    );
  };

  const onCaptcha = (e: FormEvent) => {
    e.preventDefault();
    if (!state.captcha) return;
    const id = state.captcha.id;
    void run(() => bridge.call("auth.captcha", { id, code: code.trim() })).then(() => setCode(""));
  };

  const onTfa = (e: FormEvent) => {
    e.preventDefault();
    void run(() => bridge.call("auth.verify_code", { code: code.trim() })).then(() => setCode(""));
  };

  const startOver = () => {
    dispatch({ type: "auth-clear-flow" });
    setCode("");
  };

  let step: "login" | "captcha" | "tfa" = "login";
  if (state.captcha) step = "captcha";
  else if (state.tfaRequired || auth?.state === "tfa_required") step = "tfa";

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1 className="login-title">Sign in to Eufy</h1>
        <p className="muted">
          Use your Eufy Security account. Credentials are stored by the local bridge so you stay signed in.
        </p>

        {connecting && (
          <div className="progress-row" role="status">
            <span className="spinner" aria-hidden="true" />
            <span>Connecting to Eufy…</span>
          </div>
        )}

        {error && <div className="alert alert-error">{error}</div>}

        {step === "login" && (
          <form onSubmit={onLogin} className="form">
            <label>
              Email
              <input
                type="email"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                disabled={busy || connecting}
              />
            </label>
            <label>
              Password
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                disabled={busy || connecting}
              />
            </label>
            <label>
              Country
              <select value={country} onChange={(e) => setCountry(e.target.value)} disabled={busy || connecting}>
                {COUNTRIES.map(([iso, name]) => (
                  <option key={iso} value={iso}>
                    {name} ({iso})
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="btn btn-primary" disabled={busy || connecting}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>
        )}

        {step === "captcha" && state.captcha && (
          <form onSubmit={onCaptcha} className="form">
            <p>Eufy asks you to solve a captcha:</p>
            <img className="captcha" src={state.captcha.image} alt="Captcha" />
            <label>
              Captcha text
              <input
                type="text"
                autoComplete="off"
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                disabled={busy}
              />
            </label>
            <div className="row">
              <button type="submit" className="btn btn-primary" disabled={busy}>
                Submit
              </button>
              <button type="button" className="btn" onClick={startOver} disabled={busy}>
                Start over
              </button>
            </div>
          </form>
        )}

        {step === "tfa" && (
          <form onSubmit={onTfa} className="form">
            <p>Eufy sent a verification code to your email or phone. Enter it below.</p>
            <label>
              Verification code
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                disabled={busy}
              />
            </label>
            <div className="row">
              <button type="submit" className="btn btn-primary" disabled={busy}>
                Verify
              </button>
              <button type="button" className="btn" onClick={startOver} disabled={busy}>
                Start over
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
