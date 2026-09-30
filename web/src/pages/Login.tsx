import { useState } from "react";
import { post, setCsrf } from "../api";
import { toastError } from "../ui";

export function Login({ needsSetup, totp, onDone }: { needsSetup: boolean; totp: boolean; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [token, setToken] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (needsSetup) {
        if (password !== confirm) throw new Error("Passwords don't match");
        const r = await post("/api/auth/setup", { token, password });
        setCsrf(r.csrf);
        location.hash = "/setup";
      } else {
        const r = await post("/api/auth/login", { password, totp: code || undefined });
        setCsrf(r.csrf);
      }
      onDone();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center-screen">
      <form className="login" onSubmit={submit}>
        <div className="row" style={{ justifyContent: "center", gap: 12 }}>
          <div className="brand-mark" style={{ width: 44, height: 44, fontSize: 22, borderRadius: 14 }}>
            π
          </div>
          <div className="brand-name" style={{ fontSize: 24 }}>
            fruity<span>-pi</span>
          </div>
        </div>
        <p className="muted" style={{ textAlign: "center", margin: 0 }}>
          {needsSetup ? "First run: set the admin password" : "Run a whole orchard of pi agents."}
        </p>
        <div className="card">
          <div className="card-b">
            {needsSetup && (
              <label className="field">
                Setup token <span className="hint">printed in the server console on first start</span>
                <input className="mono-input" value={token} onChange={(e) => setToken(e.target.value)} autoFocus required />
              </label>
            )}
            <label className="field">
              {needsSetup ? "New password (12+ characters)" : "Password"}
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus={!needsSetup} required autoComplete={needsSetup ? "new-password" : "current-password"} />
            </label>
            {needsSetup && (
              <label className="field">
                Confirm password
                <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required autoComplete="new-password" />
              </label>
            )}
            {totp && !needsSetup && (
              <label className="field">
                2FA code
                <input className="mono-input" inputMode="numeric" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required />
              </label>
            )}
            <button className="btn primary" disabled={busy} style={{ height: 38 }}>
              {busy ? "…" : needsSetup ? "Set password & continue" : "Sign in"}
            </button>
          </div>
        </div>
        <p className="muted tiny" style={{ textAlign: "center" }}>
          Anyone who can sign in here controls your agents{" "}
          {"and, if enabled, a shell on this machine. Keep it on localhost or behind TLS."}
        </p>
      </form>
    </div>
  );
}
