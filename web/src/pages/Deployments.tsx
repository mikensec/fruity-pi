import { useEffect, useState } from "react";
import YAML from "yaml";
import { get, post, put, del } from "../api";
import { useAppState } from "../store";
import { Modal, Empty, JobLog, toast, toastError, useConfirm, timeAgo, Seg } from "../ui";
import type { Deployment, PlanStep } from "../types";

interface Group {
  cluster: string;
  profile: string;
  replicas: number;
  cwd?: string;
  worktree?: boolean;
  model?: string;
}

export function Deployments() {
  const state = useAppState()!;
  const [editing, setEditing] = useState<{ yaml: string; isNew: boolean } | null>(null);
  const [job, setJob] = useState<string>();
  const { confirm, node } = useConfirm();

  const openNew = async () => {
    const r = await get("/api/deployments/example");
    const p = state.profiles[0]?.id ?? "default";
    setEditing({ yaml: r.yaml.replace("profile: default", `profile: ${p}`), isNew: true });
  };

  const scale = async (d: Deployment, cluster: string, delta: number) => {
    const doc = YAML.parseDocument(d.yaml);
    const groups = doc.get("groups") as any;
    const g = groups.items.find((x: any) => x.get("cluster") === cluster);
    g.set("replicas", Math.max(0, Number(g.get("replicas")) + delta));
    try {
      const r = await put("/api/deployments", { yaml: doc.toString(), apply: true });
      setJob(r.job.id);
    } catch (e) {
      toastError(e);
    }
  };

  const remove = async (d: Deployment) => {
    const n = state.instances.filter((i) => i.deployment === d.name).length;
    if (!(await confirm(`Tear down "${d.name}"? This deletes its ${n} instance(s) and their sessions.`, { danger: true, label: "Tear down" }))) return;
    try {
      setJob((await del(`/api/deployments/${d.name}`)).job.id);
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <>
      <div className="topbar">
        <h1>Deployments</h1>
        <span className="sub">Declarative clusters: "10× reviewers on profile A, 5× writers on profile B"</span>
        <div className="spacer" />
        <button className="btn primary" onClick={openNew} disabled={!state.profiles.length}>
          + New deployment
        </button>
      </div>
      <div className="page">
        {job && (
          <div className="card card-b">
            <JobLog jobId={job} height={180} />
          </div>
        )}
        {!state.profiles.length && <div className="notice info">Create a profile first — deployments reference profiles.</div>}
        {!state.deployments.length ? (
          <div className="card">
            <Empty icon="⬡" title="No deployments">
              <span>A deployment is a YAML spec of clusters. Apply it and fruity-pi creates, scales and rolling-updates the instances to match.</span>
              <button className="btn primary" onClick={openNew} disabled={!state.profiles.length}>
                Write your first spec
              </button>
            </Empty>
          </div>
        ) : (
          state.deployments.map((d) => {
            const plan = Array.isArray(d.plan) ? d.plan : [];
            const planErr = !Array.isArray(d.plan) ? d.plan.error : undefined;
            return (
              <div className="card" key={d.name}>
                <div className="card-h">
                  <h2 className="mono">{d.name}</h2>
                  {planErr ? (
                    <span className="badge straw">{planErr}</span>
                  ) : plan.length ? (
                    <span className="badge mango">{plan.length} pending change(s)</span>
                  ) : (
                    <span className="badge kiwi">in sync</span>
                  )}
                  <span className="muted small">applied {timeAgo(d.appliedAt)}</span>
                  <div className="row right">
                    {plan.length > 0 && (
                      <button className="btn sm primary" onClick={() => post(`/api/deployments/${d.name}/apply`).then((r) => setJob(r.job.id)).catch(toastError)}>
                        Apply
                      </button>
                    )}
                    <button className="btn sm" onClick={() => setEditing({ yaml: d.yaml, isNew: false })}>
                      Edit
                    </button>
                    <button className="btn sm danger" onClick={() => remove(d)}>
                      Tear down
                    </button>
                  </div>
                </div>
                <div className="tbl-wrap">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Cluster</th>
                        <th>Profile</th>
                        <th>Model</th>
                        <th>Working dir</th>
                        <th>Health</th>
                        <th style={{ width: 170 }}>Replicas</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.groups.map((g) => {
                        const members = state.instances.filter((i) => i.deployment === d.name && i.cluster === g.cluster);
                        const healthy = members.filter((i) => ["idle", "running", "queued"].includes(i.status)).length;
                        return (
                          <tr key={g.cluster}>
                            <td className="mono">
                              <a href="#/" onClick={() => {
                                  try {
                                    sessionStorage.setItem("fp-filter", g.cluster);
                                  } catch {
                                    /* storage unavailable */
                                  }
                                }}>
                                cluster:{g.cluster}
                              </a>
                            </td>
                            <td>{g.profile}</td>
                            <td className="mono small">{g.model ?? <span className="muted">profile default</span>}</td>
                            <td className="mono small">
                              {g.cwd ?? <span className="muted">private</span>}
                              {g.worktree && <span className="badge grape" style={{ marginLeft: 6 }}>worktree</span>}
                            </td>
                            <td>
                              <span className={`badge ${healthy === g.replicas ? "kiwi" : "mango"}`}>
                                {healthy}/{g.replicas} healthy
                              </span>
                            </td>
                            <td>
                              <div className="row nowrap">
                                <button className="btn sm icon" onClick={() => scale(d, g.cluster, -1)} disabled={g.replicas <= 0}>
                                  −
                                </button>
                                <strong style={{ minWidth: 28, textAlign: "center", fontSize: 16 }}>{g.replicas}</strong>
                                <button className="btn sm icon" onClick={() => scale(d, g.cluster, +1)}>
                                  +
                                </button>
                                <button className="btn sm ghost" onClick={() => scale(d, g.cluster, 5)}>
                                  +5
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
            );
          })
        )}
      </div>
      {editing && <Editor initial={editing.yaml} onClose={() => setEditing(null)} onApplied={(id) => setJob(id)} />}
      {node}
    </>
  );
}

function Editor({ initial, onClose, onApplied }: { initial: string; onClose: () => void; onApplied: (jobId: string) => void }) {
  const state = useAppState()!;
  const [yaml, setYaml] = useState(initial);
  const [mode, setMode] = useState<"form" | "yaml">("form");
  const [plan, setPlan] = useState<{ steps?: PlanStep[]; error?: string }>({});

  useEffect(() => {
    const t = setTimeout(() => {
      post("/api/deployments/plan", { yaml })
        .then((r) => setPlan({ steps: r.steps }))
        .catch((e) => setPlan({ error: e.message }));
    }, 350);
    return () => clearTimeout(t);
  }, [yaml]);

  let parsed: { name: string; groups: Group[] } | null = null;
  try {
    const p = YAML.parse(yaml);
    if (p && Array.isArray(p.groups)) parsed = p;
  } catch {
    /* show yaml mode */
  }

  const setGroups = (fn: (g: Group[]) => Group[]) => {
    if (!parsed) return;
    const doc = { name: parsed.name, groups: fn(parsed.groups).map((g) => Object.fromEntries(Object.entries(g).filter(([, v]) => v !== "" && v !== undefined && v !== false))) };
    setYaml(YAML.stringify(doc));
  };

  const save = async (apply: boolean) => {
    try {
      const r = await put("/api/deployments", { yaml, apply });
      if (r.job) onApplied(r.job.id);
      toast(apply ? `Applying ${r.deployment.name}` : `Saved ${r.deployment.name}`);
      onClose();
    } catch (e) {
      toastError(e);
    }
  };

  const steps = plan.steps ?? [];
  const n = (op: string) => steps.filter((s) => s.op === op).length;

  return (
    <Modal
      title="Deployment spec"
      onClose={onClose}
      wide
      footer={
        <>
          <span className="muted small" style={{ marginRight: "auto" }}>
            {plan.error ? <span style={{ color: "var(--danger)" }}>{plan.error}</span> : `Plan: +${n("create")} create · ~${n("update")} update · −${n("remove")} remove`}
          </span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" onClick={() => save(false)} disabled={!!plan.error}>
            Save only
          </button>
          <button className="btn primary" onClick={() => save(true)} disabled={!!plan.error}>
            Save & apply
          </button>
        </>
      }
    >
      <div className="row">
        <Seg
          value={parsed ? mode : "yaml"}
          onChange={setMode}
          options={[
            { value: "form", label: "Form" },
            { value: "yaml", label: "YAML" },
          ]}
        />
        {parsed && mode === "form" && (
          <label className="field row nowrap" style={{ flexDirection: "row", alignItems: "center" }}>
            Name
            <input
              className="mono-input"
              style={{ width: 220 }}
              value={parsed.name ?? ""}
              onChange={(e) => {
                const p = YAML.parse(yaml);
                p.name = e.target.value.toLowerCase();
                setYaml(YAML.stringify(p));
              }}
            />
          </label>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr)", gap: 16 }}>
        <div>
          {parsed && mode === "form" ? (
            <div className="col">
              {parsed.groups.map((g, i) => (
                <div key={i} className="card card-b" style={{ boxShadow: "none", display: "grid", gridTemplateColumns: "1fr 1fr 110px", gap: 10, alignItems: "end" }}>
                  <label className="field">
                    Cluster
                    <input className="mono-input" value={g.cluster ?? ""} onChange={(e) => setGroups((gs) => gs.map((x, j) => (j === i ? { ...x, cluster: e.target.value.toLowerCase() } : x)))} />
                  </label>
                  <label className="field">
                    Profile
                    <select value={g.profile} onChange={(e) => setGroups((gs) => gs.map((x, j) => (j === i ? { ...x, profile: e.target.value } : x)))}>
                      {state.profiles.map((p) => (
                        <option key={p.id}>{p.id}</option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    Replicas
                    <input type="number" min={0} max={200} value={g.replicas} onChange={(e) => setGroups((gs) => gs.map((x, j) => (j === i ? { ...x, replicas: Number(e.target.value) } : x)))} />
                  </label>
                  <label className="field">
                    Model override
                    <input className="mono-input" placeholder="profile default" value={g.model ?? ""} onChange={(e) => setGroups((gs) => gs.map((x, j) => (j === i ? { ...x, model: e.target.value } : x)))} />
                  </label>
                  <label className="field">
                    Working dir
                    <input className="mono-input" placeholder="private workspace" value={g.cwd ?? ""} onChange={(e) => setGroups((gs) => gs.map((x, j) => (j === i ? { ...x, cwd: e.target.value } : x)))} />
                  </label>
                  <div className="row nowrap" style={{ height: 34 }}>
                    <label className="row nowrap small" title="One git worktree per replica">
                      <input type="checkbox" checked={!!g.worktree} onChange={(e) => setGroups((gs) => gs.map((x, j) => (j === i ? { ...x, worktree: e.target.checked } : x)))} /> worktree
                    </label>
                    <button className="btn sm ghost icon" title="Remove group" onClick={() => setGroups((gs) => gs.filter((_, j) => j !== i))}>
                      🗑
                    </button>
                  </div>
                </div>
              ))}
              <button
                className="btn"
                onClick={() => setGroups((gs) => [...gs, { cluster: `cluster-${gs.length + 1}`, profile: state.profiles[0]?.id ?? "", replicas: 1 }])}
              >
                + Add cluster
              </button>
            </div>
          ) : (
            <textarea className="mono-input" style={{ minHeight: 420, fontSize: 13 }} value={yaml} onChange={(e) => setYaml(e.target.value)} spellCheck={false} />
          )}
        </div>
        <div className="col">
          <p className="section-title">Plan preview</p>
          {plan.error && <div className="notice err">{plan.error}</div>}
          {!plan.error && !steps.length && <div className="notice ok">No changes — running instances already match.</div>}
          <div className="col" style={{ gap: 6, maxHeight: 440, overflow: "auto" }}>
            {steps.map((s, i) => (
              <div key={i} className="res">
                <span className={`badge ${s.op === "create" ? "kiwi" : s.op === "remove" ? "straw" : "mango"}`} style={{ width: 64, justifyContent: "center" }}>
                  {s.op}
                </span>
                <span className="mono small">{s.name}</span>
                {s.reasons && <span className="muted tiny ellipsis">{s.reasons.join("; ")}</span>}
              </div>
            ))}
          </div>
          <p className="muted tiny">Updates roll 2 at a time and wait for in-flight runs to finish. Sessions continue across restarts.</p>
        </div>
      </div>
    </Modal>
  );
}
