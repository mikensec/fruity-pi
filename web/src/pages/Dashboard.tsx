import { useMemo, useState } from "react";
import { post } from "../api";
import { useAppState } from "../store";
import { StatusPill, Modal, useConfirm, toast, toastError, fmtCost, timeAgo, useTick, Empty, JobLog, FieldLabel, Help } from "../ui";
import { CommandBar } from "./CommandBar";
import type { Instance } from "../types";

export function Dashboard() {
  const state = useAppState()!;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showNew, setShowNew] = useState(false);
  const [filter, setFilter] = useState(() => {
    try {
      const f = sessionStorage.getItem("fp-filter") ?? "";
      sessionStorage.removeItem("fp-filter");
      return f;
    } catch {
      return "";
    }
  });
  const { confirm, node: confirmNode } = useConfirm();
  useTick(10_000);

  const instances = state.instances.filter((i) => !filter || `${i.name} ${i.cluster ?? ""} ${i.profile} ${i.status}`.includes(filter));
  const groups = useMemo(() => {
    const m = new Map<string, Instance[]>();
    for (const i of instances) {
      const k = i.cluster ? `${i.deployment ?? ""}/${i.cluster}` : "~ad-hoc";
      m.set(k, [...(m.get(k) ?? []), i]);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [instances]);

  const counts = {
    running: state.instances.filter((i) => i.status === "running").length,
    idle: state.instances.filter((i) => i.status === "idle").length,
    error: state.instances.filter((i) => i.status === "error").length,
  };

  const toggle = (id: string, on?: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      (on ?? !n.has(id)) ? n.add(id) : n.delete(id);
      return n;
    });

  const bulk = async (action: string) => {
    if (action === "delete") {
      if (!(await confirm(`Delete ${selected.size} instance(s)? Their sessions and workspaces are removed.`, { danger: true, label: "Delete" }))) return;
      for (const id of selected) await post(`/api/instances/${id}/delete`).catch(toastError);
      setSelected(new Set());
      return;
    }
    const r = await post("/api/send", { ids: [...selected], action }).catch(toastError);
    if (r) toast(`${action}: ${r.results.filter((x: any) => x.ok).length}/${r.results.length} ok`);
  };

  return (
    <>
      <div className="topbar">
        <h1>Dashboard</h1>
        <span className="sub">
          {state.instances.length} instances · {state.profiles.length} profiles · {state.repos.length} tracked repos
        </span>
        <div className="spacer" />
        <input placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 200 }} />
        <button className="btn primary" onClick={() => setShowNew(true)} disabled={!state.profiles.length}>
          + New instances
        </button>
      </div>
      <div className="page">
        {!state.profiles.length && (
          <div className="notice info">
            <span>🍓</span>
            <span>
              Welcome! Start with the <a href="#/setup">setup checklist</a>: install pi, add an API key, track a skills repo, and create a profile.
            </span>
          </div>
        )}
        <div className="stats">
          <Stat k="Instances" v={state.instances.length} sub={`${state.stats.live} live`} c="var(--berry)" />
          <Stat k={<>Running <Help topic="concurrency" /></>} v={counts.running} sub={`max ${state.stats.maxConcurrent}`} c="var(--mango)" />
          <Stat k="Queued" v={state.stats.queued} c="var(--grape)" />
          <Stat k="Idle" v={counts.idle} c="var(--kiwi)" />
          <Stat k="Errors" v={counts.error} c="var(--straw)" />
          <Stat k="Spend" v={fmtCost(state.stats.cost)} sub="since start" c="var(--peach)" />
        </div>

        <CommandBar selectedIds={[...selected]} onClearSelection={() => setSelected(new Set())} />

        {selected.size > 0 && (
          <div className="row card" style={{ padding: "8px 12px" }}>
            <strong>{selected.size} selected</strong>
            <button className="btn sm" onClick={() => bulk("start")}>
              Start
            </button>
            <button className="btn sm" onClick={() => bulk("stop")}>
              Stop
            </button>
            <button className="btn sm" onClick={() => bulk("restart")}>
              Restart
            </button>
            <button className="btn sm" onClick={() => bulk("abort")}>
              Abort
            </button>
            <button className="btn sm" onClick={() => bulk("new_session")}>
              New session
            </button>
            <button className="btn sm danger" onClick={() => bulk("delete")}>
              Delete
            </button>
            <button className="btn sm ghost right" onClick={() => setSelected(new Set())}>
              Clear
            </button>
          </div>
        )}

        {!state.instances.length ? (
          <div className="card">
            <Empty icon="🌱" title="No instances yet">
              <span>Create a few from a profile, or apply a deployment to spin up whole clusters.</span>
              <div className="row">
                <button className="btn primary" onClick={() => setShowNew(true)} disabled={!state.profiles.length}>
                  + New instances
                </button>
                <a className="btn" href="#/deployments">
                  Deployments
                </a>
              </div>
            </Empty>
          </div>
        ) : (
          groups.map(([key, list]) => {
            const [dep, cluster] = key === "~ad-hoc" ? [undefined, undefined] : key.split("/");
            const allSel = list.every((i) => selected.has(i.id));
            return (
              <section className="group" key={key}>
                <div className="group-h">
                  <input type="checkbox" checked={allSel} onChange={(e) => list.forEach((i) => toggle(i.id, e.target.checked))} title="Select all in group" />
                  <h3>{cluster ? `cluster:${cluster}` : "ad-hoc"}</h3>
                  {dep && <span className="badge grape">{dep}</span>}
                  <span className="muted small">{list.length} instance(s)</span>
                  <GroupBar list={list} />
                </div>
                <div className="inst-grid">
                  {list.map((i) => (
                    <InstanceCard key={i.id} inst={i} selected={selected.has(i.id)} onSelect={() => toggle(i.id)} shellEnabled={state.config.shellEnabled} />
                  ))}
                </div>
              </section>
            );
          })
        )}
      </div>
      {showNew && <NewInstances onClose={() => setShowNew(false)} />}
      {confirmNode}
    </>
  );
}

function Stat({ k, v, sub, c }: { k: React.ReactNode; v: React.ReactNode; sub?: string; c: string }) {
  return (
    <div className="stat" style={{ ["--c" as any]: c }}>
      <div className="k">{k}</div>
      <div className="v">
        {v} {sub && <small>{sub}</small>}
      </div>
    </div>
  );
}

function GroupBar({ list }: { list: Instance[] }) {
  const n = list.length || 1;
  const seg = (s: string, color: string) => {
    const c = list.filter((i) => i.status === s).length;
    return c ? <div key={s} style={{ width: `${(c / n) * 100}%`, background: color }} title={`${c} ${s}`} /> : null;
  };
  return (
    <div className="progress right" style={{ width: 160 }}>
      {seg("running", "var(--mango)")}
      {seg("queued", "var(--berry)")}
      {seg("idle", "var(--kiwi)")}
      {seg("starting", "var(--grape)")}
      {seg("updating", "var(--grape)")}
      {seg("error", "var(--straw)")}
      {seg("stopped", "var(--surface-3)")}
    </div>
  );
}

function InstanceCard({ inst, selected, onSelect, shellEnabled }: { inst: Instance; selected: boolean; onSelect: () => void; shellEnabled: boolean }) {
  const act = (op: string) => post(`/api/instances/${inst.id}/${op}`).catch(toastError);
  const tail = inst.tail.trim().split("\n").slice(-9).join("\n");
  return (
    <div className={`inst ${selected ? "selected" : ""} ${inst.status}`}>
      <div className="inst-h">
        <input type="checkbox" checked={selected} onChange={onSelect} />
        <a className="inst-name ellipsis" href={`#/instance/${encodeURIComponent(inst.id)}`}>
          {inst.name}
        </a>
        <span className="right">
          <StatusPill status={inst.status} />
        </span>
      </div>
      <div className="inst-meta">
        <span className="badge">{inst.profile}</span>
        {inst.modelLabel && <span className="badge berry ellipsis" style={{ maxWidth: 170 }}>{inst.modelLabel}</span>}
        {inst.queuePosition && <span className="badge berry">queue #{inst.queuePosition}</span>}
        {inst.pendingRestart && <span className="badge mango">update after run</span>}
        {!inst.pendingRestart && (inst.configDrift || inst.repoDrift) && <span className="row nowrap" style={{ gap: 2 }}><span className="badge mango">drift</span><Help topic="drift" /></span>}
        {inst.lastError && inst.status === "error" && <span className="badge straw ellipsis" style={{ maxWidth: 200 }} title={inst.lastError}>{inst.lastError}</span>}
      </div>
      <div className="inst-tail">{tail ? tail : <span className="empty-tail">no output yet</span>}</div>
      <div className="inst-f">
        {inst.status === "stopped" || inst.status === "error" ? (
          <button className="btn sm" onClick={() => act("start")}>
            ▶ Start
          </button>
        ) : (
          <button className="btn sm" onClick={() => act("stop")} disabled={inst.status === "updating"}>
            ■ Stop
          </button>
        )}
        {inst.status === "running" && (
          <button className="btn sm" onClick={() => post("/api/send", { ids: [inst.id], action: "abort" }).catch(toastError)}>
            Abort
          </button>
        )}
        {shellEnabled && (
          <a className="btn sm ghost" href={`#/shell/${encodeURIComponent(inst.id)}`} title="Shell with this instance's isolated env">
            ›_
          </a>
        )}
        <span className="muted right" title={inst.lastEventAt}>
          {inst.cost ? `${fmtCost(inst.cost)} · ` : ""}
          {inst.lastEventAt ? timeAgo(inst.lastEventAt) : ""}
        </span>
      </div>
    </div>
  );
}

function NewInstances({ onClose }: { onClose: () => void }) {
  const state = useAppState()!;
  const [f, setF] = useState({ profile: state.profiles[0]?.id ?? "", count: 3, namePrefix: "", cluster: "", cwd: "", model: "" });
  const [job, setJob] = useState<string>();
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const submit = async () => {
    try {
      const r = await post("/api/instances", { ...f, namePrefix: f.namePrefix || f.cluster || undefined });
      setJob(r.job?.id);
      toast(`Creating ${r.instances.length} instance(s)`);
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <Modal
      title="New instances"
      onClose={onClose}
      footer={
        job ? (
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" onClick={submit} disabled={!f.profile}>
              Create {f.count}
            </button>
          </>
        )
      }
    >
      {job ? (
        <JobLog jobId={job} />
      ) : (
        <>
          <div className="grid2">
            <label className="field">
              <FieldLabel text="Profile" help="profileId" />
              <select value={f.profile} onChange={(e) => set("profile", e.target.value)}>
                {state.profiles.map((p) => (
                  <option key={p.id}>{p.id}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <FieldLabel text="How many" help="count" />
              <input type="number" min={1} max={200} value={f.count} onChange={(e) => set("count", Number(e.target.value))} />
            </label>
            <label className="field">
              <FieldLabel text="Cluster" help="cluster" hint="optional" />
              <input value={f.cluster} onChange={(e) => set("cluster", e.target.value.toLowerCase())} placeholder="e.g. scouts" />
            </label>
            <label className="field">
              <FieldLabel text="Name prefix" help="namePrefix" hint="optional" />
              <input value={f.namePrefix} onChange={(e) => set("namePrefix", e.target.value.toLowerCase())} />
            </label>
            <label className="field">
              <FieldLabel text="Working directory" help="cwd" hint="blank = private workspace" />
              <input className="mono-input" value={f.cwd} onChange={(e) => set("cwd", e.target.value)} placeholder="~/src/project" />
            </label>
            <label className="field">
              <FieldLabel text="Model override" help="modelOverride" hint="optional" />
              <input className="mono-input" value={f.model} onChange={(e) => set("model", e.target.value)} placeholder="(profile default)" />
            </label>
          </div>
          <p className="muted small" style={{ margin: 0 }}>
            Each instance gets its own HOME, pi config, packages and sessions. For reproducible clusters use a <a href="#/deployments">deployment</a>.
          </p>
        </>
      )}
    </Modal>
  );
}
