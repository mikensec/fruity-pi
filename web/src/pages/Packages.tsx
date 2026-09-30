import { useEffect, useMemo, useState } from "react";
import { get, post } from "../api";
import { useAppState } from "../store";
import { Drawer, Modal, Empty, JobLog, Markdown, Switch, toast, toastError, timeAgo, Spinner } from "../ui";
import { resolveSelector } from "../selectors";

type ScopeKind = "profile" | "cluster" | "deployment" | "instance" | "all";
interface Scope {
  kind: ScopeKind;
  value: string;
}

interface Resource {
  type: "skills" | "extensions" | "prompts" | "themes";
  path: string;
  name: string;
  description?: string;
  enabled?: boolean;
}

interface InstalledRow {
  identity: string;
  source: string;
  name?: string;
  version?: string;
  description?: string;
  tracked?: string;
  runsCode: boolean;
  resources: Resource[];
  instances: Record<string, { source: string; version?: string; installed: boolean; origin: "profile" | "instance" | "repo"; resources: Resource[]; enabledCount: number }>;
}

interface InstalledResp {
  instances: { id: string; name: string; cluster?: string; profile: string; deployment?: string }[];
  packages: InstalledRow[];
  profiles: { id: string; packages: unknown[]; repos: string[] }[];
}

const TYPE_ICON: Record<string, string> = { skills: "✦", extensions: "⚡", prompts: "✎", themes: "◐" };

export function Packages() {
  const [tab, setTab] = useState<"discover" | "installed" | "source">("discover");
  const [job, setJob] = useState<string>();
  return (
    <>
      <div className="topbar">
        <h1>Packages</h1>
        <span className="sub">Browse, install, toggle and remove pi packages across your fleet</span>
        <div className="spacer" />
        <a className="btn ghost" href="https://pi.dev/packages" target="_blank" rel="noreferrer">
          pi.dev/packages ↗
        </a>
      </div>
      <div className="page">
        <div className="tabs">
          <div className={`tab ${tab === "discover" ? "active" : ""}`} onClick={() => setTab("discover")}>
            Discover
          </div>
          <div className={`tab ${tab === "installed" ? "active" : ""}`} onClick={() => setTab("installed")}>
            Installed
          </div>
          <div className={`tab ${tab === "source" ? "active" : ""}`} onClick={() => setTab("source")}>
            Install from git / URL / path
          </div>
        </div>
        {job && (
          <div className="card card-b">
            <JobLog jobId={job} height={170} />
          </div>
        )}
        {tab === "discover" && <Discover onJob={setJob} />}
        {tab === "installed" && <Installed onJob={setJob} />}
        {tab === "source" && <FromSource onJob={setJob} />}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ scope picker + install confirm

function ScopePicker({ scope, onChange }: { scope: Scope; onChange: (s: Scope) => void }) {
  const state = useAppState()!;
  const clusters = [...new Set(state.instances.map((i) => i.cluster).filter(Boolean))] as string[];
  const deployments = [...new Set(state.instances.map((i) => i.deployment).filter(Boolean))] as string[];
  const values: Record<ScopeKind, string[]> = {
    profile: state.profiles.map((p) => p.id),
    cluster: clusters,
    deployment: deployments,
    instance: state.instances.map((i) => i.name),
    all: ["all"],
  };
  const setKind = (kind: ScopeKind) => onChange({ kind, value: values[kind][0] ?? "" });
  return (
    <div className="row nowrap">
      <select value={scope.kind} onChange={(e) => setKind(e.target.value as ScopeKind)} style={{ width: 150 }}>
        <option value="profile">Profile</option>
        <option value="cluster">Cluster</option>
        <option value="deployment">Deployment</option>
        <option value="instance">Instance</option>
        <option value="all">All instances</option>
      </select>
      {scope.kind !== "all" && (
        <select value={scope.value} onChange={(e) => onChange({ ...scope, value: e.target.value })} className="grow">
          {values[scope.kind].length ? values[scope.kind].map((v) => <option key={v}>{v}</option>) : <option value="">(none)</option>}
        </select>
      )}
    </div>
  );
}

function useScopeTargets(scope: Scope) {
  const state = useAppState()!;
  return useMemo(() => {
    if (scope.kind === "profile") return state.instances.filter((i) => i.profile === scope.value);
    if (scope.kind === "all") return state.instances;
    return resolveSelector(`${scope.kind}:${scope.value}`, state.instances);
  }, [scope, state.instances]);
}

function scopeLabel(s: Scope) {
  return s.kind === "all" ? "all instances" : `${s.kind} ${s.value}`;
}

function InstallPanel({ source, runsCode, onJob, onDone, verb = "install" }: { source: string; runsCode: boolean; onJob: (id: string) => void; onDone?: () => void; verb?: "install" | "remove" | "update" }) {
  const state = useAppState()!;
  const [scope, setScope] = useState<Scope>({ kind: state.profiles.length ? "profile" : "all", value: state.profiles[0]?.id ?? "all" });
  const [confirming, setConfirming] = useState(false);
  const targets = useScopeTargets(scope);
  const run = async () => {
    try {
      const r = await post("/api/packages/action", { action: verb, source, scope });
      if (r.skipped?.length) toast(`Skipped: ${r.skipped.join(", ")}`, true);
      if (r.job) onJob(r.job.id);
      setConfirming(false);
      onDone?.();
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <div className="col" style={{ gap: 8 }}>
      <p className="section-title">{verb === "install" ? "Install to" : verb === "remove" ? "Remove from" : "Update on"}</p>
      <ScopePicker scope={scope} onChange={setScope} />
      <div className="row">
        <span className="muted small">
          {scope.kind === "profile" ? `Saved to profile; ${targets.length} current instance(s) roll over and future replicas inherit it.` : `${targets.length} instance(s) affected.`}
        </span>
        <button className={`btn right ${verb === "remove" ? "danger" : "primary"}`} onClick={() => setConfirming(true)} disabled={!targets.length && scope.kind !== "profile"}>
          {verb === "install" ? "Install" : verb === "remove" ? "Remove" : "Update"}
        </button>
      </div>
      {confirming && (
        <Modal
          title={`${verb[0].toUpperCase() + verb.slice(1)} package`}
          onClose={() => setConfirming(false)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button className={`btn ${verb === "remove" ? "danger" : "primary"}`} onClick={run} autoFocus>
                {verb} on {targets.length} instance(s)
              </button>
            </>
          }
        >
          <div className="res">
            <span className="mono small grow">{source}</span>
            {runsCode && <span className="badge mango">⚡ runs code</span>}
          </div>
          <div>
            <strong>{verb}</strong> on <strong>{scopeLabel(scope)}</strong> →
          </div>
          <div className="chips">
            {targets.slice(0, 40).map((t) => (
              <span key={t.id} className="badge">
                {t.name}
              </span>
            ))}
            {targets.length > 40 && <span className="badge">+{targets.length - 40} more</span>}
            {!targets.length && <span className="muted small">no running instances yet</span>}
          </div>
          {runsCode && verb === "install" && (
            <div className="notice warn small">This package ships extensions: TypeScript that runs inside pi with this machine user's permissions. Review its source first.</div>
          )}
          <div className="muted small">Instances re-provision one or two at a time; busy ones wait for their current run to finish. Sessions continue.</div>
        </Modal>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ discover

function Discover({ onJob }: { onJob: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [data, setData] = useState<{ total: number; results: any[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string>();
  const [open, setOpen] = useState<string | null>(null);
  const [kind, setKind] = useState<string>("");

  useEffect(() => {
    const t = setTimeout(() => {
      setLoading(true);
      get(`/api/packages/search?q=${encodeURIComponent(q)}`)
        .then((d) => {
          setData(d);
          setErr(undefined);
        })
        .catch((e) => setErr(e.message))
        .finally(() => setLoading(false));
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const results = (data?.results ?? []).filter((r) => !kind || r.keywords.includes(kind) || r.keywords.includes(`pi-${kind}`));

  return (
    <>
      <div className="row nowrap">
        <input className="grow" style={{ height: 40, fontSize: 15 }} placeholder="Search pi packages — skills, extensions, themes…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        <select style={{ width: 160, height: 40 }} value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">Everything</option>
          <option value="skill">Skills</option>
          <option value="extension">Extensions</option>
          <option value="theme">Themes</option>
          <option value="prompt">Prompts</option>
        </select>
        {loading && <Spinner />}
      </div>
      {err && <div className="notice err">Catalog search failed: {err} (the server needs outbound HTTPS to registry.npmjs.org)</div>}
      {data && <div className="muted small">{data.total.toLocaleString()} packages tagged pi-package</div>}
      <div className="grid2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(290px, 1fr))" }}>
        {results.map((r) => (
          <div key={r.name} className="pkg-card" onClick={() => setOpen(r.name)}>
            <div className="row nowrap">
              <span className="pkg-name ellipsis">{r.name}</span>
              <span className="muted tiny right nowrap">v{r.version}</span>
            </div>
            <div className="pkg-desc">{r.description || <span className="muted">No description</span>}</div>
            <div className="chips" style={{ marginTop: "auto" }}>
              {r.keywords
                .filter((k: string) => k !== "pi-package")
                .slice(0, 4)
                .map((k: string) => (
                  <span key={k} className={`badge ${/extension/.test(k) ? "mango" : /skill/.test(k) ? "kiwi" : /theme/.test(k) ? "grape" : ""}`}>
                    {k}
                  </span>
                ))}
            </div>
            <div className="row muted tiny">
              {r.downloads != null && <span>⬇ {r.downloads.toLocaleString()}/wk</span>}
              {r.publisher && <span>by {r.publisher}</span>}
              <span className="right">{timeAgo(r.date)}</span>
            </div>
          </div>
        ))}
      </div>
      {data && !results.length && !loading && <Empty icon="🔍" title="Nothing matched" />}
      {open && <PackageDrawer name={open} onClose={() => setOpen(null)} onJob={onJob} />}
    </>
  );
}

function PackageDrawer({ name, onClose, onJob }: { name: string; onClose: () => void; onJob: (id: string) => void }) {
  const [info, setInfo] = useState<any>(null);
  const [preview, setPreview] = useState<any>(null);
  const [version, setVersion] = useState("");
  useEffect(() => {
    get(`/api/packages/info?name=${encodeURIComponent(name)}`)
      .then((i) => {
        setInfo(i);
        setVersion(i.version);
      })
      .catch(toastError);
    post("/api/packages/preview", { source: `npm:${name}` })
      .then(setPreview)
      .catch(() => setPreview({ error: true }));
  }, [name]);
  const source = version && info && version !== info.version ? `npm:${name}@${version}` : `npm:${name}`;
  const runsCode = preview?.runsCode ?? info?.runsCode;
  return (
    <Drawer title={name} onClose={onClose}>
      {!info ? (
        <span className="muted">Loading…</span>
      ) : (
        <>
          <div className="row">
            <span className="badge">v{info.version}</span>
            {info.license && <span className="badge">{info.license}</span>}
            {runsCode && <span className="badge mango">⚡ runs code</span>}
            {info.homepage && (
              <a href={info.homepage} target="_blank" rel="noreferrer" className="small">
                homepage ↗
              </a>
            )}
            {info.repository && (
              <a href={String(info.repository).replace(/^git\+/, "")} target="_blank" rel="noreferrer" className="small">
                source ↗
              </a>
            )}
          </div>
          {info.description && <div>{info.description}</div>}
          <div className="card card-b col" style={{ boxShadow: "none" }}>
            <div className="row nowrap">
              <span className="section-title">Version</span>
              <select value={version} onChange={(e) => setVersion(e.target.value)} style={{ width: 160 }}>
                {info.versions.map((v: string) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
              <span className="muted tiny">{version !== info.version ? "pinned" : "latest"}</span>
            </div>
            <InstallPanel source={source} runsCode={!!runsCode} onJob={onJob} onDone={onClose} />
          </div>
          <div className="col">
            <p className="section-title">What's inside</p>
            {!preview ? (
              <span className="muted small">Inspecting package…</span>
            ) : preview.error ? (
              <span className="muted small">Couldn't inspect the tarball.</span>
            ) : (
              <ResourceList resources={preview.resources} />
            )}
          </div>
          {info.readme && (
            <div className="col">
              <p className="section-title">README</p>
              <Markdown text={info.readme} />
            </div>
          )}
        </>
      )}
    </Drawer>
  );
}

function ResourceList({ resources, toggle }: { resources: Resource[]; toggle?: (r: Resource, on: boolean) => void }) {
  if (!resources.length) return <span className="muted small">No skills, extensions, prompts or themes found.</span>;
  return (
    <div className="col" style={{ gap: 6 }}>
      {resources.map((r) => (
        <div key={`${r.type}:${r.path}`} className="res">
          <span className="t">
            {TYPE_ICON[r.type]} {r.type.replace(/s$/, "")}
          </span>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="mono small">{r.name}</div>
            {r.description && <div className="muted tiny ellipsis">{r.description}</div>}
          </div>
          {toggle && <Switch checked={r.enabled !== false} onChange={(v) => toggle(r, v)} />}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ install from source

function FromSource({ onJob }: { onJob: (id: string) => void }) {
  const [source, setSource] = useState("");
  const [preview, setPreview] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const inspect = async () => {
    setLoading(true);
    setPreview(null);
    try {
      setPreview(await post("/api/packages/preview", { source: source.trim() }));
    } catch (e) {
      toastError(e);
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="card">
      <div className="card-b col">
        <div className="row nowrap">
          <input className="mono-input grow" style={{ height: 38 }} placeholder="git:github.com/user/repo@v1  ·  https://github.com/user/repo  ·  npm:@scope/pkg  ·  /path/on/vm" value={source} onChange={(e) => setSource(e.target.value)} onKeyDown={(e) => e.key === "Enter" && inspect()} />
          <button className="btn primary" style={{ height: 38 }} onClick={inspect} disabled={!source.trim() || loading}>
            {loading ? "Inspecting…" : "Inspect"}
          </button>
        </div>
        <span className="muted small">
          fruity-pi fetches the source into a temp dir and shows you what's inside before anything is installed. For repos you want to auto-update, use <a href="#/repos">Tracked repos</a> instead.
        </span>
        {preview && (
          <div className="grid2" style={{ alignItems: "start" }}>
            <div className="col">
              <div className="row">
                <strong className="mono">{preview.name ?? source}</strong>
                {preview.version && <span className="badge">v{preview.version}</span>}
                {preview.runsCode && <span className="badge mango">⚡ runs code</span>}
                {preview.hasDependencies && <span className="badge">npm deps</span>}
              </div>
              {preview.description && <div className="muted">{preview.description}</div>}
              <ResourceList resources={preview.resources} />
              {preview.readme && (
                <details className="tool">
                  <summary>README</summary>
                  <div style={{ padding: 12 }}>
                    <Markdown text={preview.readme} />
                  </div>
                </details>
              )}
            </div>
            <div className="card card-b" style={{ boxShadow: "none" }}>
              <InstallPanel source={source.trim()} runsCode={preview.runsCode} onJob={onJob} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ installed matrix

function useInstalled() {
  const state = useAppState()!;
  const [data, setData] = useState<InstalledResp | null>(null);
  const [n, setN] = useState(0);
  const jobsDone = state.jobs.filter((j) => j.status !== "running").length;
  useEffect(() => {
    get<InstalledResp>("/api/packages/installed").then(setData).catch(toastError);
  }, [n, jobsDone, state.instances.length]);
  return { data, reload: () => setN((x) => x + 1) };
}

function Installed({ onJob }: { onJob: (id: string) => void }) {
  const { data } = useInstalled();
  const [open, setOpen] = useState<InstalledRow | null>(null);
  if (!data) return <span className="muted">Loading…</span>;
  if (!data.instances.length) return <Empty icon="▣" title="No instances yet" />;
  if (!data.packages.length)
    return (
      <Empty icon="▣" title="Nothing installed">
        <span>Instances run plain pi. Discover packages or add tracked repos to profiles.</span>
      </Empty>
    );
  const insts = data.instances;
  return (
    <>
      <div className="card">
        <div className="tbl-wrap" style={{ maxHeight: "70vh" }}>
          <table className="tbl matrix">
            <thead>
              <tr>
                <th style={{ minWidth: 260 }}>Package</th>
                <th>Coverage</th>
                {insts.map((i) => (
                  <th key={i.id} title={`${i.name} · ${i.profile}`} style={{ writingMode: "vertical-rl", transform: "rotate(180deg)", textAlign: "left", padding: "10px 6px", fontFamily: "var(--mono)", textTransform: "none", letterSpacing: 0 }}>
                    {i.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.packages.map((p) => {
                const have = insts.filter((i) => p.instances[i.id]).length;
                return (
                  <tr key={p.identity} style={{ cursor: "pointer" }} onClick={() => setOpen(p)}>
                    <td>
                      <div className="row nowrap">
                        <span className="mono small" style={{ fontWeight: 600 }}>
                          {p.name ?? p.source.split("/").pop()}
                        </span>
                        {p.tracked && <span className="badge grape">⟳ {p.tracked}</span>}
                        {p.runsCode && <span className="badge mango">⚡</span>}
                      </div>
                      <div className="muted tiny ellipsis" style={{ maxWidth: 320 }}>
                        {p.source}
                      </div>
                    </td>
                    <td>
                      <span className={`badge ${have === insts.length ? "kiwi" : "berry"}`}>
                        {have}/{insts.length}
                      </span>
                    </td>
                    {insts.map((i) => {
                      const c = p.instances[i.id];
                      const cls = !c ? "off" : c.origin === "repo" ? "repo" : c.origin === "instance" ? "inst" : c.enabledCount < c.resources.length ? "partial" : "on";
                      return (
                        <td key={i.id} className="cell" title={c ? `${c.origin} · ${c.enabledCount}/${c.resources.length} resources enabled${c.version ? ` · v${c.version}` : ""}` : "not installed"}>
                          <span className={`cell-dot ${cls}`} />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <div className="row muted small">
        <span className="cell-dot on" /> from profile <span className="cell-dot partial" /> some resources disabled <span className="cell-dot inst" /> instance-level <span className="cell-dot repo" /> tracked repo <span className="cell-dot off" /> not installed
      </div>
      {open && <InstalledDrawer row={open} data={data} onClose={() => setOpen(null)} onJob={onJob} />}
    </>
  );
}

function InstalledDrawer({ row, data, onClose, onJob }: { row: InstalledRow; data: InstalledResp; onClose: () => void; onJob: (id: string) => void }) {
  const [inst, setInst] = useState(Object.keys(row.instances)[0]);
  const cell = row.instances[inst];
  const toggle = async (r: Resource, enabled: boolean) => {
    try {
      const res = await post("/api/packages/action", { action: "toggle", source: row.source, resourceType: r.type, resourcePath: r.path, enabled, scope: { kind: "instance", value: inst } });
      if (res.job) onJob(res.job.id);
      toast(`${enabled ? "Enabled" : "Disabled"} ${r.name} on ${inst}`);
      onClose();
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <Drawer title={row.name ?? row.source} onClose={onClose}>
      <div className="row">
        {row.version && <span className="badge">v{row.version}</span>}
        {row.tracked && <span className="badge grape">tracked repo {row.tracked}</span>}
        {row.runsCode && <span className="badge mango">⚡ runs code</span>}
      </div>
      <div className="mono small muted">{row.source}</div>
      {row.description && <div>{row.description}</div>}
      <div className="card card-b col" style={{ boxShadow: "none" }}>
        <div className="row nowrap">
          <span className="section-title">Resources on</span>
          <select value={inst} onChange={(e) => setInst(e.target.value)} className="grow">
            {Object.keys(row.instances).map((id) => (
              <option key={id} value={id}>
                {data.instances.find((i) => i.id === id)?.name ?? id}
              </option>
            ))}
          </select>
          {cell && <span className="badge">{cell.origin}</span>}
        </div>
        {cell && <ResourceList resources={cell.resources} toggle={toggle} />}
        <span className="muted tiny">Toggling on one instance creates an instance-level override; use profile scope in the Profiles editor to change everyone.</span>
      </div>
      {!row.tracked && (
        <div className="grid2">
          <div className="card card-b" style={{ boxShadow: "none" }}>
            <InstallPanel source={row.source} runsCode={row.runsCode} onJob={onJob} onDone={onClose} verb="update" />
          </div>
          <div className="card card-b" style={{ boxShadow: "none" }}>
            <InstallPanel source={row.source} runsCode={row.runsCode} onJob={onJob} onDone={onClose} verb="remove" />
          </div>
        </div>
      )}
      {row.tracked && <div className="notice info small">This comes from tracked repo <strong>{row.tracked}</strong>. Manage it on the <a href="#/repos">Tracked repos</a> page or detach it from the profile.</div>}
    </Drawer>
  );
}

/** Packages tab inside an instance view. */
export function InstancePackages({ instanceId }: { instanceId: string }) {
  const { data } = useInstalled();
  const [jobId, setJobId] = useState<string>();
  if (!data) return <span className="muted">Loading…</span>;
  const rows = data.packages.filter((p) => p.instances[instanceId]);
  const act = async (body: object) => {
    try {
      const r = await post("/api/packages/action", { ...body, scope: { kind: "instance", value: instanceId } });
      if (r.skipped?.length) toast(r.skipped.join(", "), true);
      if (r.job) setJobId(r.job.id);
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <div className="col">
      {jobId && <JobLog jobId={jobId} height={140} />}
      {!rows.length && <Empty icon="▣" title="No packages on this instance" />}
      {rows.map((p) => {
        const c = p.instances[instanceId];
        return (
          <div key={p.identity} className="card">
            <div className="card-h">
              <span className="mono small" style={{ fontWeight: 600 }}>
                {p.name ?? p.source}
              </span>
              {c.version && <span className="badge">v{c.version}</span>}
              <span className={`badge ${c.origin === "repo" ? "grape" : c.origin === "instance" ? "berry" : ""}`}>{c.origin}</span>
              {!c.installed && <span className="badge straw">missing on disk</span>}
              <div className="row right">
                {c.origin !== "repo" && (
                  <button className="btn sm" onClick={() => act({ action: "update", source: p.source })}>
                    Update
                  </button>
                )}
                {c.origin === "instance" && (
                  <button className="btn sm danger" onClick={() => act({ action: "remove", source: p.source })}>
                    Remove
                  </button>
                )}
              </div>
            </div>
            <div className="card-b">
              <ResourceList resources={c.resources} toggle={(r, on) => act({ action: "toggle", source: p.source, resourceType: r.type, resourcePath: r.path, enabled: on })} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
