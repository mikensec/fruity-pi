import { useState } from "react";
import { post, put, del } from "../api";
import { useAppState } from "../store";
import { Modal, Empty, JobLog, Switch, toast, toastError, useConfirm, FieldLabel, Help } from "../ui";
import type { PackageEntry, Profile } from "../types";

const src = (p: PackageEntry) => (typeof p === "string" ? p : p.source);

const BLANK: Profile = { id: "", packages: [], repos: [], skills: [], extraArgs: [], env: {}, approve: false };

export function Profiles() {
  const state = useAppState()!;
  const [editing, setEditing] = useState<{ p: Profile; isNew: boolean } | null>(null);
  const [job, setJob] = useState<string>();
  const { confirm, node } = useConfirm();

  const rollout = async (id: string) => {
    try {
      setJob((await post(`/api/profiles/${id}/rollout`)).job.id);
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <>
      <div className="topbar">
        <h1>Profiles</h1>
        <span className="sub">Reusable pi configurations: skills repos, packages, model, flags</span>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setEditing({ p: { ...BLANK }, isNew: true })}>
          + New profile
        </button>
      </div>
      <div className="page">
        {job && (
          <div className="card card-b">
            <JobLog jobId={job} height={160} />
          </div>
        )}
        {!state.profiles.length ? (
          <div className="card">
            <Empty icon="◈" title="No profiles yet">
              <span>A profile is the recipe for an instance: which skill repos and pi packages it loads, which model it uses, and any flags.</span>
              <button className="btn primary" onClick={() => setEditing({ p: { ...BLANK, id: "default" }, isNew: true })}>
                Create "default"
              </button>
            </Empty>
          </div>
        ) : (
          <div className="grid2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))" }}>
            {state.profiles.map((p) => {
              const users = state.instances.filter((i) => i.profile === p.id);
              const drift = users.filter((i) => i.configDrift).length;
              return (
                <div className="card" key={p.id}>
                  <div className="card-h">
                    <h3 className="mono">{p.id}</h3>
                    <span className="badge">{users.length} instance(s)</span>
                    {drift > 0 && <span className="badge mango">{drift} outdated</span>}
                  </div>
                  <div className="card-b col" style={{ gap: 8 }}>
                    {p.description && <div className="muted">{p.description}</div>}
                    <div className="row small">
                      <span className="muted">model</span> <span className="mono">{p.model ?? "pi default"}</span>
                      {p.thinking && <span className="badge">thinking: {p.thinking}</span>}
                      {p.approve && <span className="badge mango" title="--approve: trust project-local .pi files">-a</span>}
                      {p.modelsJson && <span className="badge berry">custom models</span>}
                    </div>
                    <div className="chips">
                      {p.repos.map((r) => (
                        <span key={r} className="badge grape">
                          ⟳ {r}
                        </span>
                      ))}
                      {p.packages.map((x) => (
                        <span key={src(x)} className="badge berry ellipsis" style={{ maxWidth: 260 }}>
                          ▣ {src(x)}
                        </span>
                      ))}
                      {p.skills.map((s) => (
                        <span key={s} className="badge kiwi">
                          ✦ {s}
                        </span>
                      ))}
                      {!p.repos.length && !p.packages.length && !p.skills.length && <span className="muted small">no skills or packages — plain pi</span>}
                    </div>
                    <div className="row" style={{ marginTop: 6 }}>
                      <button className="btn sm" onClick={() => setEditing({ p: structuredClone(p), isNew: false })}>
                        Edit
                      </button>
                      {users.length > 0 && (
                        <button className={`btn sm ${drift ? "primary" : ""}`} onClick={() => rollout(p.id)}>
                          Roll out to {users.length}
                        </button>
                      )}
                      <button
                        className="btn sm ghost right"
                        onClick={() => setEditing({ p: { ...structuredClone(p), id: `${p.id}-copy` }, isNew: true })}
                      >
                        Duplicate
                      </button>
                      <button
                        className="btn sm danger"
                        onClick={async () => {
                          if (!(await confirm(`Delete profile ${p.id}?`, { danger: true, label: "Delete" }))) return;
                          del(`/api/profiles/${p.id}`).catch(toastError);
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {editing && (
        <ProfileEditor
          initial={editing.p}
          isNew={editing.isNew}
          onClose={() => setEditing(null)}
          onSaved={(id, hasUsers) => {
            setEditing(null);
            if (hasUsers) toast(`Saved ${id}. Use "Roll out" to apply it to running instances.`);
            else toast(`Saved ${id}`);
          }}
        />
      )}
      {node}
    </>
  );
}

function ProfileEditor({ initial, isNew, onClose, onSaved }: { initial: Profile; isNew: boolean; onClose: () => void; onSaved: (id: string, hasUsers: boolean) => void }) {
  const state = useAppState()!;
  const [p, setP] = useState<Profile>(initial);
  const [pkgInput, setPkgInput] = useState("");
  const [envText, setEnvText] = useState(Object.entries(initial.env).map(([k, v]) => `${k}=${v}`).join("\n"));
  const set = <K extends keyof Profile>(k: K, v: Profile[K]) => setP((x) => ({ ...x, [k]: v }));

  const save = async () => {
    const env: Record<string, string> = {};
    for (const line of envText.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m) env[m[1]] = m[2];
    }
    try {
      await put(`/api/profiles/${encodeURIComponent(p.id)}`, { ...p, env });
      onSaved(p.id, state.instances.some((i) => i.profile === p.id));
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <Modal
      title={isNew ? "New profile" : `Edit ${p.id}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={!p.id}>
            Save profile
          </button>
        </>
      }
    >
      <div className="grid2">
        <label className="field">
          <FieldLabel text="Profile id" help="profileId" />
          <input className="mono-input" value={p.id} disabled={!isNew} onChange={(e) => set("id", e.target.value.toLowerCase())} placeholder="code-review" />
        </label>
        <label className="field">
          <FieldLabel text="Description" />
          <input value={p.description ?? ""} onChange={(e) => set("description", e.target.value)} />
        </label>
        <label className="field">
          <FieldLabel text="Model" help="model" hint="provider/model-id" />
          <input className="mono-input" value={p.model ?? ""} onChange={(e) => set("model", e.target.value || undefined)} placeholder="pi default" />
        </label>
        <label className="field">
          <FieldLabel text="Thinking level" help="thinking" />
          <select value={p.thinking ?? ""} onChange={(e) => set("thinking", e.target.value || undefined)}>
            <option value="">default</option>
            {["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <FieldLabel text="Tools allowlist" help="tools" hint="blank = pi defaults" />
          <input className="mono-input" value={p.tools ?? ""} onChange={(e) => set("tools", e.target.value || undefined)} placeholder="read,bash,edit,write" />
        </label>
        <div className="field" style={{ justifyContent: "flex-end" }}>
          <div className="row nowrap">
            <Switch checked={!!p.approve} onChange={(v) => set("approve", v)} />
            <span className="grow">
              <FieldLabel text={<>Trust project files (<span className="mono">pi -a</span>)</>} help="approve" />
              <br />
              <span className="muted tiny">Loads .pi/ settings, packages & skills from the working directory.</span>
            </span>
          </div>
        </div>
      </div>

      <div className="col">
        <p className="section-title">
          Tracked skill repos · auto-update <Help topic="trackedRepos" />
        </p>
        {!state.repos.length ? (
          <div className="muted small">
            No tracked repos yet — <a href="#/repos">track a GitHub repo</a> and every instance using this profile updates when it changes.
          </div>
        ) : (
          <div className="chips">
            {state.repos.map((r) => {
              const on = p.repos.includes(r.id);
              return (
                <span key={r.id} className={`chip ${on ? "on" : ""}`} onClick={() => set("repos", on ? p.repos.filter((x) => x !== r.id) : [...p.repos, r.id])}>
                  {on ? "✓ " : ""}
                  {r.id} <span className="muted">@{r.ref}</span>
                </span>
              );
            })}
          </div>
        )}
      </div>

      <div className="col">
        <p className="section-title">
          pi packages <Help topic="packages" />
        </p>
        {p.packages.map((x, i) => (
          <div key={i} className="res">
            <span className="mono small grow ellipsis">{src(x)}</span>
            {typeof x !== "string" && <span className="badge mango">filtered</span>}
            <button className="btn sm ghost" onClick={() => set("packages", p.packages.filter((_, j) => j !== i))}>
              Remove
            </button>
          </div>
        ))}
        <div className="row nowrap">
          <input
            className="mono-input grow"
            value={pkgInput}
            onChange={(e) => setPkgInput(e.target.value)}
            placeholder="npm:@scope/pkg · git:github.com/user/repo@v1 · /local/path"
            onKeyDown={(e) => {
              if (e.key === "Enter" && pkgInput.trim()) {
                set("packages", [...p.packages, pkgInput.trim()]);
                setPkgInput("");
              }
            }}
          />
          <button
            className="btn"
            onClick={() => {
              if (!pkgInput.trim()) return;
              set("packages", [...p.packages, pkgInput.trim()]);
              setPkgInput("");
            }}
          >
            Add
          </button>
        </div>
        <span className="muted tiny">
          Browse the catalog on the <a href="#/packages">Packages</a> page. Packages run with full user permissions — only add ones you trust.
        </span>
      </div>

      <div className="grid2">
        <label className="field">
          <FieldLabel text="Local skill paths" help="skillPaths" hint="one per line" />
          <textarea className="mono-input" value={p.skills.join("\n")} onChange={(e) => set("skills", e.target.value.split("\n"))} placeholder="~/skills/my-skill" />
        </label>
        <label className="field">
          <FieldLabel text="Environment" help="env" hint="KEY=value per line" />
          <textarea className="mono-input" value={envText} onChange={(e) => setEnvText(e.target.value)} placeholder="MY_FLAG=1" />
        </label>
        <label className="field">
          <FieldLabel text="Append to system prompt" help="appendSystemPrompt" />
          <textarea value={p.appendSystemPrompt ?? ""} onChange={(e) => set("appendSystemPrompt", e.target.value || undefined)} />
        </label>
        <label className="field">
          <FieldLabel text="Extra CLI args" help="extraArgs" hint="one per line" />
          <textarea className="mono-input" value={p.extraArgs.join("\n")} onChange={(e) => set("extraArgs", e.target.value.split("\n"))} placeholder="--no-context-files" />
        </label>
      </div>
      <label className="field">
        <FieldLabel text="Custom models.json" help="modelsJson" hint="optional" />
        <textarea
          className="mono-input"
          style={{ minHeight: 90 }}
          value={p.modelsJson ?? ""}
          onChange={(e) => set("modelsJson", e.target.value || undefined)}
          placeholder={'{ "providers": { "ollama": { "baseUrl": "http://localhost:11434/v1", "api": "openai-completions", "apiKey": "ollama", "models": [{ "id": "qwen2.5-coder:7b" }] } } }'}
        />
      </label>
    </Modal>
  );
}
