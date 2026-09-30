import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { get, post, setCsrf, setUnauthorizedHandler } from "./api";
import { connectLive, disconnectLive, useAppState, useStore } from "./store";
import { Toasts, toastError } from "./ui";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { InstanceView } from "./pages/InstanceView";
import { Deployments } from "./pages/Deployments";
import { Profiles } from "./pages/Profiles";
import { Repos } from "./pages/Repos";
import { Packages } from "./pages/Packages";
import { Shell } from "./pages/Shell";
import { System } from "./pages/System";
import { Setup } from "./pages/Setup";
import { Import } from "./pages/Import";
import { JobsButton } from "./pages/Jobs";

function useRoute() {
  const [hash, setHash] = useState(location.hash.slice(1) || "/");
  useEffect(() => {
    const f = () => setHash(location.hash.slice(1) || "/");
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  return hash.split("/").filter(Boolean);
}

export function go(path: string) {
  location.hash = path;
}

const NAV = [
  { path: "", label: "Dashboard", icon: "◧" },
  { path: "deployments", label: "Deployments", icon: "⬡" },
  { path: "profiles", label: "Profiles", icon: "◈" },
  { path: "repos", label: "Tracked repos", icon: "⟳" },
  { path: "packages", label: "Packages", icon: "▣" },
  { path: "import", label: "Import from pi", icon: "⇲" },
  { path: "shell", label: "Shell", icon: "›_" },
  { path: "system", label: "System", icon: "⚙" },
];

function Shell_({ onLogout }: { onLogout: () => void }) {
  const route = useRoute();
  const state = useAppState();
  const connected = useStore((s) => s.connected);
  const page = route[0] ?? "";

  useEffect(() => {
    connectLive();
    return () => disconnectLive();
  }, []);

  const counts: Record<string, number | undefined> = {
    "": state?.instances.length,
    deployments: state?.deployments.length,
    profiles: state?.profiles.length,
    repos: state?.repos.length,
  };

  let body: React.ReactNode = null;
  if (!state) body = <div className="page muted">Loading…</div>;
  else if (page === "") body = <Dashboard />;
  else if (page === "instance" && route[1]) body = <InstanceView id={decodeURIComponent(route[1])} />;
  else if (page === "deployments") body = <Deployments />;
  else if (page === "profiles") body = <Profiles />;
  else if (page === "repos") body = <Repos />;
  else if (page === "packages") body = <Packages />;
  else if (page === "shell") body = <Shell instanceId={route[1] ? decodeURIComponent(route[1]) : undefined} />;
  else if (page === "system") body = <System />;
  else if (page === "setup") body = <Setup />;
  else if (page === "import") body = <Import />;
  else body = <div className="page">Not found</div>;

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">
          <div className="brand-mark">π</div>
          <div className="brand-name">
            fruity<span>-pi</span>
          </div>
        </div>
        {NAV.map((n) => (
          <a key={n.path} href={`#/${n.path}`} className={`nav-item ${page === n.path || (n.path === "" && page === "instance") ? "active" : ""}`}>
            <span style={{ width: 18, textAlign: "center", opacity: 0.8 }}>{n.icon}</span>
            {n.label}
            {counts[n.path] != null && <span className="count">{counts[n.path]}</span>}
          </a>
        ))}
        <div className="nav-sep" />
        <JobsButton />
        <div className="sidebar-foot">
          <span className={`conn ${connected ? "" : "off"}`}>
            <span className="dot" />
            {connected ? "live" : "reconnecting…"}
          </span>
          <button className="btn ghost sm" style={{ justifyContent: "flex-start", padding: 0 }} onClick={onLogout}>
            Sign out
          </button>
        </div>
      </nav>
      <main className="main">{body}</main>
      <Toasts />
    </div>
  );
}

function App() {
  const [me, setMe] = useState<{ authed: boolean; needsSetup: boolean; totp: boolean } | null>(null);
  const check = () =>
    get("/api/auth/me")
      .then((m) => {
        setCsrf(m.csrf);
        setMe(m);
      })
      .catch(() => setMe({ authed: false, needsSetup: false, totp: false }));
  useEffect(() => {
    setUnauthorizedHandler(() => setMe((m) => (m ? { ...m, authed: false } : m)));
    check();
  }, []);
  if (!me) return null;
  if (!me.authed)
    return (
      <>
        <Login needsSetup={me.needsSetup} totp={me.totp} onDone={check} />
        <Toasts />
      </>
    );
  return (
    <Shell_
      onLogout={() =>
        post("/api/auth/logout")
          .then(check)
          .catch(toastError)
      }
    />
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
