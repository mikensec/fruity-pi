import { useEffect, useState } from "react";
import { get, post, setCsrf } from "../api";
import { useAppState, refresh } from "../store";
import { JobLog, Switch, toast, toastError, fmtBytes, timeAgo, Modal } from "../ui";

export interface SystemInfo {
  checks: { id: string; label: string; ok: boolean; detail?: string }[];
  setupComplete: boolean;
  piVersion?: string;
  node: string;
  host: { hostname: string; platform: string; cpus: number; loadavg: number[]; memTotal: number; memFree: number; uptime: number };
  secrets: { key: string; preview: string }[];
  providerKeys: string[];
  root: string;
  audit: { at: string; action: string; ip?: string; detail?: Record<string, unknown> }[];
}

export function useSystem() {
  const [sys, setSys] = useState<SystemInfo | null>(null);
  const load = () => get<SystemInfo>("/api/system").then(setSys).catch(toastError);
  useEffect(() => {
    load();
  }, []);
  return { sys, reload: load };
}

export function PiInstaller({ current, onDone }: { current?: string; onDone?: () => void }) {
  const [latest, setLatest] = useState<string>();
  const [job, setJob] = useState<string>();
  const [version, setVersion] = useState("latest");
  const jobState = useAppState()?.jobs.find((j) => j.id === job);
  useEffect(() => {
    get("/api/system/latest-pi")
      .then((r) => setLatest(r.latest))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (jobState && jobState.status !== "running") onDone?.();
  }, [jobState?.status]);
  return (
    <div className="col">
      <div className="row">
        <span>
          Installed: <strong className="mono">{current ? `v${current}` : "not installed"}</strong>
        </span>
        <span className="muted">
          Latest: <span className="mono">{latest ? `v${latest}` : "…"}</span>
        </span>
        {current && latest && current === latest && <span className="badge kiwi">up to date</span>}
        {current && latest && current !== latest && <span className="badge mango">update available</span>}
        <div className="row right nowrap">
          <input className="mono-input" style={{ width: 110 }} value={version} onChange={(e) => setVersion(e.target.value)} title="latest or an exact version" />
          <button
            className="btn primary"
            onClick={() =>
              post("/api/system/upgrade-pi", { version })
                .then((r) => setJob(r.job.id))
                .catch(toastError)
            }
            disabled={jobState?.status === "running"}
          >
            {current ? "Install / upgrade pi" : "Install pi"}
          </button>
        </div>
      </div>
      <span className="muted tiny">Installs @earendil-works/pi-coding-agent into fruity-pi's app directory. Running instances are rolled onto the new version one or two at a time.</span>
      {job && <JobLog jobId={job} height={180} />}
    </div>
  );
}

export function SecretsEditor({ secrets, providerKeys, onChange }: { secrets: SystemInfo["secrets"]; providerKeys: string[]; onChange: () => void }) {
  const [key, setKey] = useState(providerKeys[0] ?? "ANTHROPIC_API_KEY");
  const [custom, setCustom] = useState("");
  const [value, setValue] = useState("");
  const save = async () => {
    const k = key === "__custom" ? custom.trim() : key;
    if (!k || !value) return;
    try {
      await post("/api/system/secrets", { [k]: value });
      setValue("");
      toast(`Saved ${k}. Restart instances to pick it up.`);
      onChange();
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <div className="col">
      {secrets.map((s) => (
        <div className="res" key={s.key}>
          <span className="mono small grow">{s.key}</span>
          <span className="mono muted small">{s.preview}</span>
          <button
            className="btn sm ghost"
            onClick={() =>
              post("/api/system/secrets", { [s.key]: null })
                .then(onChange)
                .catch(toastError)
            }
          >
            Remove
          </button>
        </div>
      ))}
      <div className="row nowrap">
        <select value={key} onChange={(e) => setKey(e.target.value)} style={{ width: 230 }}>
          {providerKeys.map((k) => (
            <option key={k}>{k}</option>
          ))}
          <option value="__custom">Other variable…</option>
        </select>
        {key === "__custom" && <input className="mono-input" style={{ width: 200 }} placeholder="NAME" value={custom} onChange={(e) => setCustom(e.target.value.toUpperCase())} />}
        <input type="password" className="mono-input grow" placeholder="value" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} autoComplete="off" />
        <button className="btn primary" onClick={save} disabled={!value}>
          Save
        </button>
      </div>
      <span className="muted tiny">Stored in secrets.env (mode 600), injected into every instance, redacted from logs, never sent back to the browser.</span>
    </div>
  );
}

export function System() {
  const state = useAppState()!;
  const { sys, reload } = useSystem();
  const [disk, setDisk] = useState<any>(null);
  const [pwModal, setPwModal] = useState<null | "shell" | "totp" | "totp-off" | "password">(null);

  if (!sys) return <div className="page muted">Loading…</div>;
  const cfg = state.config;

  return (
    <>
      <div className="topbar">
        <h1>System</h1>
        <span className="sub">
          {sys.host.hostname} · {sys.host.platform} · node {sys.node}
        </span>
        <div className="spacer" />
        <a className="btn" href="#/setup">
          Setup checklist
        </a>
      </div>
      <div className="page">
        <div className="grid2">
          <div className="card">
            <div className="card-h">
              <h3>pi coding agent</h3>
            </div>
            <div className="card-b">
              <PiInstaller current={sys.piVersion} onDone={reload} />
            </div>
          </div>
          <div className="card">
            <div className="card-h">
              <h3>Host</h3>
            </div>
            <div className="card-b col" style={{ gap: 8 }}>
              <div className="row">
                <span className="badge">{sys.host.cpus} CPUs</span>
                <span className="badge">load {sys.host.loadavg.map((l) => l.toFixed(2)).join(" / ")}</span>
                <span className="badge">
                  mem {fmtBytes(sys.host.memTotal - sys.host.memFree)} / {fmtBytes(sys.host.memTotal)}
                </span>
              </div>
              <div className="progress">
                <div style={{ width: `${((sys.host.memTotal - sys.host.memFree) / sys.host.memTotal) * 100}%`, background: "var(--grad)" }} />
              </div>
              <div className="muted small">
                State dir <span className="mono">{sys.root}</span>
              </div>
              <div className="row">
                <button className="btn sm" onClick={() => get("/api/system/disk").then(setDisk).catch(toastError)}>
                  Disk usage
                </button>
                <button
                  className="btn sm"
                  onClick={() =>
                    post("/api/system/cleanup")
                      .then((r) => toast(r.removed.length ? `Removed ${r.removed.length} orphaned dir(s)` : "Nothing to clean"))
                      .catch(toastError)
                  }
                >
                  Clean up orphans
                </button>
              </div>
              {disk && (
                <div className="col small" style={{ gap: 4 }}>
                  {[...disk.instances.map((x: any) => ({ ...x, kind: "instance" })), ...disk.repos.map((x: any) => ({ ...x, kind: "repo" }))]
                    .sort((a, b) => b.bytes - a.bytes)
                    .slice(0, 12)
                    .map((x) => (
                      <div key={x.kind + x.id} className="row nowrap">
                        <span className="badge">{x.kind}</span>
                        <span className="mono grow ellipsis">{x.id}</span>
                        <span className="muted">{fmtBytes(x.bytes)}</span>
                      </div>
                    ))}
                  <div className="muted">npm cache {fmtBytes(disk.npmCache)}</div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-h">
            <h3>Secrets & API keys</h3>
          </div>
          <div className="card-b">
            <SecretsEditor secrets={sys.secrets} providerKeys={sys.providerKeys} onChange={reload} />
          </div>
        </div>

        <div className="grid2">
          <div className="card">
            <div className="card-h">
              <h3>Scheduling</h3>
            </div>
            <div className="card-b col">
              <label className="field">
                Max concurrent prompts <span className="hint">across all instances; extra prompts queue</span>
                <input
                  type="number"
                  min={1}
                  max={256}
                  defaultValue={cfg.maxConcurrent}
                  onBlur={(e) =>
                    post("/api/system/settings", { maxConcurrent: Number(e.target.value) })
                      .then(() => {
                        toast("Saved");
                        refresh();
                      })
                      .catch(toastError)
                  }
                />
              </label>
            </div>
          </div>

          <div className="card">
            <div className="card-h">
              <h3>Security</h3>
              <span className={`badge ${cfg.tls ? "kiwi" : "berry"}`}>{cfg.tls ? "TLS" : `bound to ${cfg.host}`}</span>
            </div>
            <div className="card-b col">
              <div className="row nowrap">
                <Switch
                  checked={cfg.shellEnabled}
                  disabled={cfg.shellLocked}
                  onChange={(v) => {
                    if (v) setPwModal("shell");
                    else
                      post("/api/system/shell", { enabled: false })
                        .then(() => refresh())
                        .catch(toastError);
                  }}
                />
                <div className="grow">
                  <div>Web shell</div>
                  <div className="muted tiny">{cfg.shellLocked ? "Locked off in config.json" : "Terminal on this VM from the browser. Off by default; enabling asks for your password."}</div>
                </div>
              </div>
              <div className="row nowrap">
                <Switch
                  checked={cfg.recordShell}
                  onChange={(v) =>
                    post("/api/system/settings", { recordShell: v })
                      .then(() => refresh())
                      .catch(toastError)
                  }
                />
                <div className="grow">
                  <div>Record shell sessions</div>
                  <div className="muted tiny">asciicast files in ~/.fruity-pi/recordings (mode 600)</div>
                </div>
              </div>
              <div className="row nowrap">
                <Switch checked={cfg.totpEnabled} onChange={(v) => setPwModal(v ? "totp" : "totp-off")} />
                <div className="grow">
                  <div>Two-factor login (TOTP)</div>
                  <div className="muted tiny">Any authenticator app</div>
                </div>
              </div>
              <div className="row">
                <button className="btn sm" onClick={() => setPwModal("password")}>
                  Change password
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-h">
            <h3>Audit log</h3>
            <button className="btn sm ghost right" onClick={reload}>
              Refresh
            </button>
          </div>
          <div className="tbl-wrap" style={{ maxHeight: 420 }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Action</th>
                  <th>Details</th>
                  <th>IP</th>
                </tr>
              </thead>
              <tbody>
                {sys.audit.map((a, i) => (
                  <tr key={i}>
                    <td className="nowrap small" title={a.at}>
                      {timeAgo(a.at)}
                    </td>
                    <td>
                      <span className={`badge ${/fail|bad/.test(a.action) ? "straw" : /shell/.test(a.action) ? "mango" : ""}`}>{a.action}</span>
                    </td>
                    <td className="mono tiny ellipsis" style={{ maxWidth: 560 }} title={JSON.stringify(a.detail)}>
                      {a.detail ? JSON.stringify(a.detail) : ""}
                    </td>
                    <td className="mono tiny">{a.ip}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      {pwModal && <PasswordAction kind={pwModal} onClose={() => setPwModal(null)} />}
    </>
  );
}

function PasswordAction({ kind, onClose }: { kind: "shell" | "totp" | "totp-off" | "password"; onClose: () => void }) {
  const [pw, setPw] = useState("");
  const [next, setNext] = useState("");
  const [code, setCode] = useState("");
  const [totp, setTotp] = useState<{ secret: string; uri: string } | null>(null);
  const titles = { shell: "Enable web shell", totp: "Enable two-factor login", "totp-off": "Disable two-factor login", password: "Change password" };
  const go = async () => {
    try {
      if (kind === "shell") await post("/api/system/shell", { enabled: true, password: pw });
      else if (kind === "totp-off") await post("/api/system/totp/disable", { password: pw });
      else if (kind === "password") {
        const r = await post("/api/system/password", { current: pw, next });
        setCsrf(r.csrf);
      } else if (kind === "totp") {
        if (!totp) {
          setTotp(await post("/api/system/totp/setup", { password: pw }));
          return;
        }
        await post("/api/system/totp/enable", { code });
      }
      toast("Done");
      refresh();
      onClose();
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <Modal
      title={titles[kind]}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={go}>
            {kind === "totp" && !totp ? "Next" : "Confirm"}
          </button>
        </>
      }
    >
      {kind === "shell" && <div className="notice warn small">Anyone signed in to this dashboard will be able to run commands on this VM as the fruity-pi user. Sessions are audit-logged.</div>}
      {!totp && (
        <label className="field">
          {kind === "password" ? "Current password" : "Confirm with your password"}
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus onKeyDown={(e) => e.key === "Enter" && kind !== "password" && go()} />
        </label>
      )}
      {kind === "password" && (
        <label className="field">
          New password (12+ characters)
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
        </label>
      )}
      {totp && (
        <>
          <div className="small">Add this secret to your authenticator app, then enter the 6-digit code.</div>
          <input className="mono-input" readOnly value={totp.secret} />
          <input className="mono-input" readOnly value={totp.uri} />
          <label className="field">
            Code
            <input className="mono-input" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} autoFocus onKeyDown={(e) => e.key === "Enter" && go()} />
          </label>
        </>
      )}
    </Modal>
  );
}
