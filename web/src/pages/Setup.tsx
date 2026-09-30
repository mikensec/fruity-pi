import { useState } from "react";
import { post, put } from "../api";
import { useAppState, refresh } from "../store";
import { toast, toastError, JobLog } from "../ui";
import { PiInstaller, SecretsEditor, useSystem } from "./System";

export function Setup() {
  const state = useAppState()!;
  const { sys, reload } = useSystem();
  const [repoUrl, setRepoUrl] = useState("");
  const [repoJob, setRepoJob] = useState<string>();
  const [profile, setProfile] = useState({ id: "default", model: "", repos: [] as string[] });
  const [count, setCount] = useState(3);

  if (!sys) return <div className="page muted">Loading…</div>;
  const ok = (id: string) => sys.checks.find((c) => c.id === id)?.ok;
  const steps = [
    { n: 1, title: "Install pi", done: ok("pi") && ok("node") && ok("git") },
    { n: 2, title: "Add a provider API key", done: ok("keys") },
    { n: 3, title: "Track a skills repo (optional)", done: state.repos.length > 0 },
    { n: 4, title: "Create a profile", done: state.profiles.length > 0 },
    { n: 5, title: "Launch instances", done: state.instances.length > 0 },
  ];
  const next = steps.find((s) => !s.done)?.n ?? 6;

  const Step = ({ n, title, done, children }: { n: number; title: string; done?: boolean; children: React.ReactNode }) => (
    <div className="card" style={{ opacity: n > next ? 0.55 : 1 }}>
      <div className="card-h">
        <span className={`check`} style={{ padding: 0, border: 0, background: "none" }}>
          <span className={`ico ${done ? "ok" : "no"}`}>{done ? "✓" : n}</span>
        </span>
        <h3>{title}</h3>
        {done && <span className="badge kiwi">done</span>}
      </div>
      {(n === next || !done) && <div className="card-b">{children}</div>}
    </div>
  );

  return (
    <>
      <div className="topbar">
        <h1>Setup</h1>
        <span className="sub">Five steps from zero to a fleet of pi agents</span>
        <div className="spacer" />
        {next > 5 && (
          <a className="btn primary" href="#/">
            Open dashboard →
          </a>
        )}
      </div>
      <div className="page" style={{ maxWidth: 960 }}>
        <div className="col">
          {sys.checks.map((c) => (
            <div key={c.id} className="check">
              <span className={`ico ${c.ok ? "ok" : "no"}`}>{c.ok ? "✓" : "!"}</span>
              <span className="grow">{c.label}</span>
              <span className="muted small mono">{c.detail}</span>
            </div>
          ))}
        </div>

        <Step n={1} title="Install pi" done={steps[0].done}>
          <PiInstaller current={sys.piVersion} onDone={reload} />
        </Step>

        <Step n={2} title="Add a provider API key" done={steps[1].done}>
          <SecretsEditor secrets={sys.secrets} providerKeys={sys.providerKeys} onChange={reload} />
          <p className="muted tiny">Using a local model (Ollama, LM Studio…) instead? Skip this and paste a models.json into your profile.</p>
        </Step>

        <Step n={3} title="Track a skills repo (optional)" done={steps[2].done}>
          <div className="row nowrap">
            <input className="mono-input grow" placeholder="github.com/owner/my-pi-skills" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} />
            <button
              className="btn primary"
              disabled={!repoUrl}
              onClick={() =>
                post("/api/repos", { url: repoUrl })
                  .then((r) => {
                    setRepoJob(r.job.id);
                    setProfile((p) => ({ ...p, repos: [...p.repos, r.repo.id] }));
                  })
                  .catch(toastError)
              }
            >
              Track
            </button>
          </div>
          {repoJob && <JobLog jobId={repoJob} height={120} />}
          <p className="muted tiny">
            Tracked repos auto-update every instance that uses them. More options on the <a href="#/repos">Tracked repos</a> page.
          </p>
        </Step>

        <Step n={4} title="Create a profile" done={steps[3].done}>
          <div className="grid2">
            <label className="field">
              Profile id
              <input className="mono-input" value={profile.id} onChange={(e) => setProfile({ ...profile, id: e.target.value.toLowerCase() })} />
            </label>
            <label className="field">
              Model <span className="hint">provider/model — blank for pi's default</span>
              <input className="mono-input" value={profile.model} onChange={(e) => setProfile({ ...profile, model: e.target.value })} placeholder="anthropic/claude-sonnet-5-5" />
            </label>
          </div>
          {state.repos.length > 0 && (
            <div className="chips" style={{ marginTop: 10 }}>
              {state.repos.map((r) => {
                const on = profile.repos.includes(r.id);
                return (
                  <span key={r.id} className={`chip ${on ? "on" : ""}`} onClick={() => setProfile({ ...profile, repos: on ? profile.repos.filter((x) => x !== r.id) : [...profile.repos, r.id] })}>
                    {on ? "✓ " : ""}
                    {r.id}
                  </span>
                );
              })}
            </div>
          )}
          <div className="row" style={{ marginTop: 10 }}>
            <button
              className="btn primary"
              onClick={() =>
                put(`/api/profiles/${profile.id}`, { id: profile.id, model: profile.model || undefined, repos: profile.repos })
                  .then(() => {
                    toast(`Profile ${profile.id} created`);
                    refresh();
                    reload();
                  })
                  .catch(toastError)
              }
            >
              Create profile
            </button>
            <a href="#/profiles" className="small">
              Advanced editor →
            </a>
          </div>
        </Step>

        <Step n={5} title="Launch instances" done={steps[4].done}>
          <div className="row nowrap">
            <span>Spin up</span>
            <input type="number" min={1} max={50} value={count} onChange={(e) => setCount(Number(e.target.value))} style={{ width: 80 }} />
            <span>
              instance(s) of <strong className="mono">{state.profiles[0]?.id ?? "…"}</strong>
            </span>
            <button
              className="btn primary"
              disabled={!state.profiles.length}
              onClick={() =>
                post("/api/instances", { profile: state.profiles[0].id, count })
                  .then(() => {
                    toast("Launching…");
                    location.hash = "/";
                  })
                  .catch(toastError)
              }
            >
              Launch
            </button>
          </div>
        </Step>
      </div>
    </>
  );
}
