import { useEffect, useMemo, useState } from "react";
import { get, post } from "../api";
import { useAppState, refresh } from "../store";
import { Modal, Empty, JobLog, toast, toastError, timeAgo, fmtBytes, Seg, FieldLabel } from "../ui";

interface Session {
  file: string;
  id: string;
  cwd: string;
  cwdExists: boolean;
  startedAt: string;
  updatedAt: string;
  bytes: number;
  messages: number;
  firstPrompt: string;
  lastPrompt: string;
  name?: string;
  model?: string;
}

interface Setup {
  home: string;
  dir: string;
  exists: boolean;
  packages: unknown[];
  skills: string[];
  extensions: string[];
  prompts: string[];
  agentsMd: boolean;
  modelsJson: boolean;
  authJson: boolean;
  model?: string;
  thinking?: string;
  sessions: number;
}

let serverHome = "";
const home = (p: string) => {
  if (serverHome && (p === serverHome || p.startsWith(serverHome + "/"))) return "~" + p.slice(serverHome.length);
  return p.replace(/^\/home\/[^/]+|^\/Users\/[^/]+/, "~");
};

export function Import() {
  const state = useAppState()!;
  const [dir, setDir] = useState("");
  const [setup, setSetup] = useState<Setup | null>(null);
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [filter, setFilter] = useState("");
  const [pick, setPick] = useState<Session | null>(null);
  const [profileId, setProfileId] = useState("my-pi");
  const [job, setJob] = useState<string>();

  const load = () => {
    const q = dir ? `?dir=${encodeURIComponent(dir)}` : "";
    get<Setup>(`/api/import/setup${q}`)
      .then((r) => {
        serverHome = r.home;
        setSetup(r);
      })
      .catch(toastError);
    get<{ sessions: Session[] }>(`/api/import/sessions${q}`)
      .then((r) => setSessions(r.sessions))
      .catch(toastError);
  };
  useEffect(load, []);

  const shown = useMemo(
    () => (sessions ?? []).filter((s) => !filter || `${s.cwd} ${s.firstPrompt} ${s.lastPrompt} ${s.name ?? ""}`.toLowerCase().includes(filter.toLowerCase())),
    [sessions, filter],
  );

  const importSetup = async () => {
    try {
      const r = await post("/api/import/setup", { id: profileId, dir: dir || undefined });
      toast(`Profile ${r.profile.id} created from your pi setup`);
      if (r.notCopied?.length) toast(`Not copied: ${r.notCopied.join("; ")}`, true);
      refresh();
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <>
      <div className="topbar">
        <h1>Import from pi</h1>
        <span className="sub">Bring an existing pi setup and conversations into fruity-pi</span>
      </div>
      <div className="page">
        <div className="notice ok">
          <span>🔒</span>
          <span>
            <strong>Read-only.</strong> fruity-pi only <em>copies</em> from your existing pi. Nothing in {setup ? <span className="mono">{home(setup.dir)}</span> : "~/.pi"} is modified, moved or used afterwards, so you can keep running plain <span className="mono">pi</span> side by side.
          </span>
        </div>

        <div className="row nowrap">
          <input className="mono-input grow" placeholder="~/.pi/agent (default): or another pi agent dir" value={dir} onChange={(e) => setDir(e.target.value)} onKeyDown={(e) => e.key === "Enter" && load()} />
          <button className="btn" onClick={load}>
            Scan
          </button>
        </div>

        {job && (
          <div className="card card-b">
            <JobLog jobId={job} height={150} />
          </div>
        )}

        <div className="card">
          <div className="card-h">
            <h3>Your pi setup → profile</h3>
            {setup && !setup.exists && <span className="badge">not found</span>}
          </div>
          <div className="card-b col">
            {!setup ? (
              <span className="muted">Scanning…</span>
            ) : !setup.exists ? (
              <span className="muted">No pi configuration found at {home(setup.dir)}.</span>
            ) : (
              <>
                <div className="chips">
                  <span className="badge berry">model: {setup.model ?? "pi default"}</span>
                  {setup.thinking && <span className="badge">thinking: {setup.thinking}</span>}
                  <span className="badge">{setup.packages.length} package(s)</span>
                  <span className="badge kiwi">{setup.skills.length} skill(s)</span>
                  <span className="badge mango">{setup.extensions.length} extension(s)</span>
                  <span className="badge">{setup.prompts.length} prompt(s)</span>
                  {setup.agentsMd && <span className="badge">AGENTS.md</span>}
                  {setup.modelsJson && <span className="badge">models.json</span>}
                  <span className="badge grape">{setup.sessions} session(s)</span>
                </div>
                {setup.skills.length > 0 && <div className="muted small mono ellipsis">{setup.skills.slice(0, 8).join(" · ")}</div>}
                <div className="row nowrap">
                  <label className="field" style={{ width: 260 }}>
                    <FieldLabel text="New profile id" help="profileId" />
                    <input className="mono-input" value={profileId} onChange={(e) => setProfileId(e.target.value.toLowerCase())} />
                  </label>
                  <button className="btn primary" style={{ alignSelf: "flex-end" }} onClick={importSetup} disabled={!profileId}>
                    Import as profile
                  </button>
                </div>
                <span className="muted tiny">
                  Skills, extensions, prompts, AGENTS.md, models.json and local packages are snapshotted into ~/.fruity-pi/imports/{profileId || "<id>"}. npm/git packages are reinstalled per instance.
                  {setup.authJson && " Logins in auth.json are not copied: add provider keys in System → Secrets."}
                </span>
              </>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-h">
            <h3>Sessions</h3>
            <span className="muted small">continue any conversation in an isolated instance</span>
            <input className="right" style={{ width: 260 }} placeholder="Filter by folder or prompt…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          {!sessions ? (
            <div className="card-b muted">Scanning…</div>
          ) : !shown.length ? (
            <Empty icon="💬" title={sessions.length ? "No matches" : "No pi sessions found"} />
          ) : (
            <div className="tbl-wrap" style={{ maxHeight: 520 }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Project folder</th>
                    <th>Conversation</th>
                    <th>Msgs</th>
                    <th>Updated</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((s) => (
                    <tr key={s.file}>
                      <td className="mono small" style={{ maxWidth: 260 }}>
                        <div className="ellipsis" title={s.cwd}>
                          {home(s.cwd) || "?"}
                        </div>
                        {!s.cwdExists && <span className="badge">folder gone</span>}
                      </td>
                      <td style={{ maxWidth: 480 }}>
                        {s.name && <strong>{s.name} · </strong>}
                        <span className="ellipsis" style={{ display: "block" }} title={s.firstPrompt}>
                          {s.firstPrompt || <span className="muted">(no prompt)</span>}
                        </span>
                        {s.lastPrompt && s.lastPrompt !== s.firstPrompt && (
                          <span className="muted tiny ellipsis" style={{ display: "block" }} title={s.lastPrompt}>
                            last: {s.lastPrompt}
                          </span>
                        )}
                      </td>
                      <td className="small">{s.messages}</td>
                      <td className="small nowrap" title={s.updatedAt}>
                        {timeAgo(s.updatedAt)}
                        <div className="muted tiny">{fmtBytes(s.bytes)}</div>
                      </td>
                      <td>
                        <button className="btn sm" onClick={() => setPick(s)} disabled={!state.profiles.length}>
                          Import…
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!state.profiles.length && sessions?.length ? <div className="card-b muted small">Create or import a profile first: the imported instance needs one.</div> : null}
        </div>
      </div>
      {pick && <ImportSession s={pick} dir={dir} onClose={() => setPick(null)} onJob={setJob} />}
    </>
  );
}

function ImportSession({ s, dir, onClose, onJob }: { s: Session; dir: string; onClose: () => void; onJob: (id: string) => void }) {
  const state = useAppState()!;
  const [profile, setProfile] = useState(state.profiles[0]?.id ?? "");
  const [name, setName] = useState(`imported-${s.id.slice(-6)}`.toLowerCase());
  const [mode, setMode] = useState<"original" | "private">(s.cwdExists ? "original" : "private");
  const go = async () => {
    try {
      const r = await post("/api/import/session", { file: s.file, dir: dir || undefined, profile, name, cwd: mode });
      onJob(r.job.id);
      onClose();
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <Modal
      title="Continue this session in fruity-pi"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={go} disabled={!profile || !name}>
            Import & start
          </button>
        </>
      }
    >
      <div className="res" style={{ alignItems: "flex-start" }}>
        <div className="grow">
          <div className="mono small">{home(s.cwd)}</div>
          <div className="small">{s.firstPrompt}</div>
          <div className="muted tiny">
            {s.messages} messages · {s.model ?? "model unknown"}
          </div>
        </div>
      </div>
      <div className="grid2">
        <label className="field">
          <FieldLabel text="Profile" help="profileId" />
          <select value={profile} onChange={(e) => setProfile(e.target.value)}>
            {state.profiles.map((p) => (
              <option key={p.id}>{p.id}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <FieldLabel text="Instance name" />
          <input className="mono-input" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} />
        </label>
      </div>
      <div className="field">
        <FieldLabel text="Working directory" help="cwd" />
        <Seg
          value={mode}
          onChange={setMode}
          options={[
            { value: "original", label: "Original project folder" },
            { value: "private", label: "Private workspace" },
          ]}
        />
        <span className="muted tiny">
          {mode === "original"
            ? `The agent keeps working in ${home(s.cwd)}, like your original pi did. Avoid running your own pi on the same folder at the same time.`
            : "The agent gets an empty private folder. It remembers the conversation but won't see or change the original project files."}
          {!s.cwdExists && " (The original folder no longer exists.)"}
        </span>
      </div>
      <div className="notice info small">A copy of the session file is made. Your original session stays where it is and remains usable with plain pi.</div>
    </Modal>
  );
}
