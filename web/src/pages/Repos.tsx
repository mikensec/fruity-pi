import { useState } from "react";
import { post, put, del } from "../api";
import { useAppState } from "../store";
import { Modal, Empty, JobLog, toastError, useConfirm, timeAgo, useTick, Seg, copy, FieldLabel, Help } from "../ui";
import type { Repo } from "../types";

export function Repos() {
  const state = useAppState()!;
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Repo | null>(null);
  const [job, setJob] = useState<string>();
  const [history, setHistory] = useState<Repo | null>(null);
  const { confirm, node } = useConfirm();
  useTick(5000);

  const check = (id: string) => post(`/api/repos/${id}/check`).then((r) => setJob(r.job.id)).catch(toastError);

  return (
    <>
      <div className="topbar">
        <h1>Tracked repos</h1>
        <span className="sub">Skill repos that auto-update across every instance using them</span>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setAdding(true)}>
          + Track repo
        </button>
      </div>
      <div className="page">
        {job && (
          <div className="card card-b">
            <JobLog jobId={job} height={150} />
          </div>
        )}
        {!state.repos.length ? (
          <div className="card">
            <Empty icon="⟳" title="No tracked repos">
              <span>
                Point at a GitHub repo of skills (or a full pi package). fruity-pi keeps one shared checkout, polls for new commits, and rolls every instance onto the new version, waiting for in-flight runs to finish first.
              </span>
              <button className="btn primary" onClick={() => setAdding(true)}>
                Track a repo
              </button>
            </Empty>
          </div>
        ) : (
          <div className="card">
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Repo</th>
                    <th>Ref</th>
                    <th>Commit</th>
                    <th>Rollout</th>
                    <th>Last check</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {state.repos.map((r) => {
                    const profiles = state.profiles.filter((p) => p.repos.includes(r.id)).map((p) => p.id);
                    const insts = state.instances.filter((i) => profiles.includes(i.profile));
                    const onLatest = insts.filter((i) => i.repoShas[r.id] === r.currentSha).length;
                    return (
                      <tr key={r.id}>
                        <td>
                          <div className="mono" style={{ fontWeight: 600 }}>
                            {r.id}
                          </div>
                          <div className="muted tiny ellipsis" style={{ maxWidth: 340 }}>
                            {r.url}
                            {r.subdir ? ` / ${r.subdir}` : ""}
                          </div>
                          {r.lastError && <div className="tiny" style={{ color: "var(--danger)" }}>{r.lastError}</div>}
                        </td>
                        <td>
                          <span className="mono small">{r.ref}</span>{" "}
                          <span className={`badge ${r.mode === "track" ? "kiwi" : "mango"}`}>{r.mode === "track" ? "tracking" : "pinned"}</span>
                          {r.kind && <span className="badge" style={{ marginLeft: 4 }}>{r.kind}</span>}
                        </td>
                        <td>
                          {r.updating ? <span className="status updating"><span className="dot" />fetching</span> : r.currentSha ? <span className="sha">{r.currentSha.slice(0, 10)}</span> : <span className="muted">–</span>}
                        </td>
                        <td>
                          {insts.length ? (
                            <span className={`badge ${onLatest === insts.length ? "kiwi" : "mango"}`}>
                              {onLatest}/{insts.length} on latest
                            </span>
                          ) : (
                            <span className="muted small">{profiles.length ? `profiles: ${profiles.join(", ")}` : "not used by any profile"}</span>
                          )}
                        </td>
                        <td className="small">
                          {timeAgo(r.lastCheck)}
                          <div className="muted tiny">{r.mode === "track" ? `every ${r.pollSeconds}s` : "no polling"}</div>
                        </td>
                        <td>
                          <div className="row nowrap">
                            <button className="btn sm" onClick={() => check(r.id)} disabled={r.updating}>
                              Check now
                            </button>
                            <button className="btn sm ghost" onClick={() => setHistory(r)}>
                              History
                            </button>
                            <button className="btn sm ghost" onClick={() => setEditing(r)}>
                              Settings
                            </button>
                            <button
                              className="btn sm ghost"
                              onClick={async () => {
                                if (!(await confirm(`Stop tracking ${r.id}?`, { danger: true, label: "Remove" }))) return;
                                del(`/api/repos/${r.id}`).catch(toastError);
                              }}
                            >
                              ✕
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
        <Webhook configured={state.config.webhookConfigured} />
      </div>
      {adding && <RepoForm onClose={() => setAdding(false)} onJob={setJob} />}
      {editing && <RepoForm repo={editing} onClose={() => setEditing(null)} onJob={setJob} />}
      {history && (
        <Modal title={`History · ${history.id}`} onClose={() => setHistory(null)}>
          {!history.history.length && <span className="muted">No commits fetched yet.</span>}
          {[...history.history].reverse().map((h) => (
            <div key={h.sha} className="res">
              <span className="sha">{h.sha.slice(0, 12)}</span>
              <span className="muted small">{new Date(h.at).toLocaleString()}</span>
              {h.sha === history.currentSha ? (
                <span className="badge kiwi right">current</span>
              ) : (
                <button
                  className="btn sm right"
                  onClick={async () => {
                    if (!(await confirm(`Roll ${history.id} back to ${h.sha.slice(0, 10)}? The repo becomes pinned until you switch it back to tracking.`, { label: "Roll back" }))) return;
                    post(`/api/repos/${history.id}/rollback`, { sha: h.sha })
                      .then((r) => {
                        setJob(r.job.id);
                        setHistory(null);
                      })
                      .catch(toastError);
                  }}
                >
                  Roll back
                </button>
              )}
            </div>
          ))}
        </Modal>
      )}
      {node}
    </>
  );
}

function RepoForm({ repo, onClose, onJob }: { repo?: Repo; onClose: () => void; onJob: (id: string) => void }) {
  const [f, setF] = useState({ url: repo?.url ?? "", ref: repo?.ref ?? "main", mode: repo?.mode ?? ("track" as "track" | "pinned"), pollSeconds: repo?.pollSeconds ?? 120, subdir: repo?.subdir ?? "", id: repo?.id ?? "" });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const submit = async () => {
    setBusy(true);
    try {
      const r = repo ? await put(`/api/repos/${repo.id}`, f) : await post("/api/repos", { ...f, id: f.id || undefined, subdir: f.subdir || undefined });
      onJob(r.job.id);
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={repo ? `Settings · ${repo.id}` : "Track a repo"}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={busy || !f.url}>
            {busy ? "Checking…" : repo ? "Save" : "Track"}
          </button>
        </>
      }
    >
      <label className="field">
        <FieldLabel text="Repository" help="repoUrl" />
        <input className="mono-input" value={f.url} disabled={!!repo} onChange={(e) => set("url", e.target.value)} placeholder="github.com/owner/skills  ·  git@github.com:owner/private.git" autoFocus />
      </label>
      <div className="grid2">
        <label className="field">
          <FieldLabel text="Branch, tag or commit" help="repoRef" />
          <input className="mono-input" value={f.ref} onChange={(e) => set("ref", e.target.value)} />
        </label>
        <div className="field">
          <FieldLabel text="Mode" help="repoMode" />
          <Seg
            value={f.mode}
            onChange={(v) => set("mode", v)}
            options={[
              { value: "track", label: "Track (auto-update)" },
              { value: "pinned", label: "Pinned" },
            ]}
          />
        </div>
        <label className="field">
          <FieldLabel text="Poll every (seconds)" help="pollSeconds" />
          <input type="number" min={30} value={f.pollSeconds} onChange={(e) => set("pollSeconds", Number(e.target.value))} disabled={f.mode === "pinned"} />
        </label>
        <label className="field">
          <FieldLabel text="Subdirectory" help="subdir" hint="optional" />
          <input className="mono-input" value={f.subdir} onChange={(e) => set("subdir", e.target.value)} placeholder="(repo root)" />
        </label>
        {!repo && (
          <label className="field">
            Id <span className="hint">optional; derived from the URL</span>
            <input className="mono-input" value={f.id} onChange={(e) => set("id", e.target.value.toLowerCase())} />
          </label>
        )}
      </div>
      <div className="notice info small">
        Private repo? Add <span className="mono">GITHUB_TOKEN</span> (or <span className="mono">GITLAB_TOKEN</span> / <span className="mono">FRUITY_PI_GIT_TOKENS</span>) in <a href="#/system">System → Secrets</a> <Help topic="privateRepos" />. Repos with a <span className="mono">package.json</span> "pi" manifest or <span className="mono">skills/ extensions/ prompts/ themes/</span> folders load as a pi package; anything else is scanned for <span className="mono">SKILL.md</span> files. Private repos use this machine's git credentials / SSH agent.
      </div>
    </Modal>
  );
}

function Webhook({ configured }: { configured: boolean }) {
  const [pw, setPw] = useState("");
  const [secret, setSecret] = useState<string>();
  const url = `${location.origin}/api/hooks/github`;
  return (
    <div className="card">
      <div className="card-h">
        <h3>Instant updates via GitHub webhook</h3>
        <Help topic="webhook" />
        <span className={`badge ${configured ? "kiwi" : ""}`}>{configured ? "configured" : "optional"}</span>
      </div>
      <div className="card-b col">
        <span className="muted small">
          Polling works everywhere. If GitHub can reach this server, add a push webhook (content type <span className="mono">application/json</span>) and updates land within seconds.
        </span>
        <div className="row nowrap">
          <input className="mono-input grow" readOnly value={url} />
          <button className="btn" onClick={() => copy(url)}>
            Copy URL
          </button>
        </div>
        {secret ? (
          <div className="notice warn col" style={{ alignItems: "stretch" }}>
            <span>Webhook secret — shown once. Paste it into GitHub → Settings → Webhooks.</span>
            <div className="row nowrap">
              <input className="mono-input grow" readOnly value={secret} />
              <button className="btn" onClick={() => copy(secret)}>
                Copy
              </button>
            </div>
          </div>
        ) : (
          <div className="row nowrap">
            <input type="password" placeholder="Admin password to generate a secret" value={pw} onChange={(e) => setPw(e.target.value)} style={{ maxWidth: 320 }} />
            <button
              className="btn"
              onClick={() =>
                post("/api/system/webhook", { password: pw })
                  .then((r) => setSecret(r.secret))
                  .catch(toastError)
              }
            >
              {configured ? "Rotate secret" : "Generate secret"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
