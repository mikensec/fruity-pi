import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { getCsrf, wsUrl } from "../api";
import { useAppState } from "../store";
import { Empty } from "../ui";

export function Shell({ instanceId }: { instanceId?: string }) {
  const state = useAppState()!;
  const [target, setTarget] = useState(instanceId ?? "");
  const [session, setSession] = useState(0);
  useEffect(() => setTarget(instanceId ?? ""), [instanceId]);

  const enabled = state.config.shellEnabled;
  return (
    <>
      <div className="topbar">
        <h1>Shell</h1>
        <span className="sub">{target ? `inside instance ${target} (isolated HOME, pi config & cwd)` : "host shell as the fruity-pi user"}</span>
        <div className="spacer" />
        {enabled && (
          <>
            <select
              style={{ width: 240 }}
              value={target}
              onChange={(e) => {
                location.hash = e.target.value ? `/shell/${encodeURIComponent(e.target.value)}` : "/shell";
              }}
            >
              <option value="">Host</option>
              {state.instances.map((i) => (
                <option key={i.id} value={i.id}>
                  instance: {i.name}
                </option>
              ))}
            </select>
            <button className="btn" onClick={() => setSession((s) => s + 1)}>
              New session
            </button>
          </>
        )}
      </div>
      <div className="page">
        {!enabled ? (
          <div className="card">
            <Empty icon="🔒" title="Web shell is disabled">
              <span style={{ maxWidth: 520 }}>
                {state.config.shellLocked
                  ? "It's locked off in config.json (shellLocked: true). Edit the file on the server to change that."
                  : "For safety the shell is off by default. Enable it in System → Security (requires your password). Every session is audit-logged."}
              </span>
              {!state.config.shellLocked && (
                <a className="btn primary" href="#/system">
                  Go to System
                </a>
              )}
            </Empty>
          </div>
        ) : (
          <Term key={`${target}:${session}`} instanceId={target || undefined} />
        )}
      </div>
    </>
  );
}

function Term({ instanceId }: { instanceId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("connecting…");
  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", ui-monospace, Menlo, monospace',
      fontSize: 13,
      theme: { background: "#0a090e", foreground: "#e6e0ef", cursor: "#ff5c7a", selectionBackground: "#ff5c7a55", black: "#1f1b28", red: "#ff5c7a", green: "#7ed957", yellow: "#ffb020", blue: "#6f8dff", magenta: "#b27bff", cyan: "#5fd7d7", white: "#ece8f3" },
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current!);
    fit.fit();
    const params = new URLSearchParams({ csrf: getCsrf(), cols: String(term.cols), rows: String(term.rows) });
    if (instanceId) params.set("instance", instanceId);
    const ws = new WebSocket(wsUrl(`/ws/shell?${params}`));
    ws.binaryType = "arraybuffer";
    const enc = new TextEncoder();
    ws.onopen = () => {
      setStatus("connected");
      term.focus();
    };
    ws.onmessage = (m) => term.write(typeof m.data === "string" ? m.data : new Uint8Array(m.data));
    ws.onclose = (e) => {
      setStatus(`closed${e.reason ? `: ${e.reason}` : ""}`);
      term.write(`\r\n\x1b[90m[session closed${e.reason ? `: ${e.reason}` : ""}]\x1b[0m\r\n`);
    };
    const d = term.onData((data) => ws.readyState === 1 && ws.send(enc.encode(data)));
    const onResize = () => {
      fit.fit();
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(ref.current!);
    return () => {
      ro.disconnect();
      d.dispose();
      ws.close();
      term.dispose();
    };
  }, [instanceId]);
  return (
    <div className="col">
      <div className="term-wrap" ref={ref} />
      <div className="muted tiny">
        {status} · sessions are audit-logged · runs as the same unprivileged user as fruity-pi
      </div>
    </div>
  );
}
