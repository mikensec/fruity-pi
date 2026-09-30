import { useEffect, useRef, useState } from "react";
import { get, post } from "../api";
import { useAppState, useInstanceEvents } from "../store";
import { StatusPill, toast, toastError, useConfirm, copy, fmtCost, timeAgo, JobLog, Empty, Help, Markdown } from "../ui";
import { InstancePackages } from "./Packages";

interface Entry {
  kind: "user" | "assistant" | "tool" | "error" | "info";
  text?: string;
  thinking?: string;
  toolName?: string;
  args?: unknown;
  result?: string;
  isError?: boolean;
  toolCallId?: string;
  at?: string;
}

function textOf(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((c) => c?.type === "text").map((c) => c.text).join("");
  return "";
}

/** Fold pi events into a readable transcript. */
function reduce(entries: Entry[], ev: any): Entry[] {
  switch (ev.type) {
    case "message_end": {
      const m = ev.message ?? {};
      if (m.role === "user") return [...entries, { kind: "user", text: textOf(m.content), at: ev.at }];
      if (m.role === "assistant") {
        const text = textOf(m.content);
        const thinking = Array.isArray(m.content) ? m.content.filter((c: any) => c?.type === "thinking").map((c: any) => c.thinking).join("\n") : "";
        const out = [...entries];
        if (text || thinking) out.push({ kind: "assistant", text, thinking, at: ev.at });
        if (m.stopReason === "error" && m.errorMessage) out.push({ kind: "error", text: m.errorMessage });
        if (m.stopReason === "aborted") out.push({ kind: "info", text: "aborted" });
        return out;
      }
      return entries;
    }
    case "tool_execution_start":
      return [...entries, { kind: "tool", toolName: ev.toolName, args: ev.args, toolCallId: ev.toolCallId, at: ev.at }];
    case "tool_execution_end": {
      const idx = entries.findIndex((e) => e.kind === "tool" && e.toolCallId === ev.toolCallId);
      const result = textOf(ev.result?.content) || JSON.stringify(ev.result?.details ?? "", null, 2);
      if (idx < 0) return [...entries, { kind: "tool", toolName: ev.toolName, result, isError: ev.isError }];
      const next = entries.slice();
      next[idx] = { ...next[idx], result, isError: ev.isError };
      return next;
    }
    case "fp_error":
      return [...entries, { kind: "error", text: `${ev.command}: ${ev.error}` }];
    case "compaction_end":
      return [...entries, { kind: "info", text: "context compacted" }];
    default:
      return entries;
  }
}

export function InstanceView({ id }: { id: string }) {
  const state = useAppState()!;
  const inst = state.instances.find((i) => i.id === id);
  const [tab, setTab] = useState<"chat" | "packages" | "logs" | "info">("chat");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [streaming, setStreaming] = useState("");
  const [msg, setMsg] = useState("");
  const [info, setInfo] = useState<{ command: string } | null>(null);
  const [job, setJob] = useState<string>();
  const { confirm, node } = useConfirm();
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    get(`/api/instances/${id}/events?tail=2000`)
      .then((r) => setEntries(r.events.reduce(reduce, [] as Entry[])))
      .catch(toastError);
    get(`/api/instances/${id}`).then(setInfo).catch(() => {});
  }, [id]);

  useInstanceEvents(
    (iid, ev) => {
      if (iid !== id) return;
      if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") setStreaming((s) => s + ev.assistantMessageEvent.delta);
      if (ev.type === "message_end") setStreaming("");
      setEntries((e) => reduce(e, { ...ev, at: new Date().toISOString() }));
    },
    [id],
  );

  useEffect(() => {
    if (tab === "chat") endRef.current?.scrollIntoView({ block: "end" });
  }, [entries.length, streaming, tab]);

  if (!inst)
    return (
      <div className="page">
        <Empty icon="🫥" title="Instance not found">
          <a href="#/">Back to dashboard</a>
        </Empty>
      </div>
    );

  const send = async (action: "prompt" | "steer" | "follow_up") => {
    if (!msg.trim()) return;
    try {
      const r = await post("/api/send", { ids: [id], action, message: msg });
      const x = r.results[0];
      if (!x.ok) toast(x.error ?? "failed", true);
      else setMsg("");
    } catch (e) {
      toastError(e);
    }
  };
  const act = async (op: string) => {
    if (op === "delete" && !(await confirm(`Delete ${inst.name}? Its sessions, packages and workspace are removed.`, { danger: true, label: "Delete" }))) return;
    try {
      const r = await post(`/api/instances/${id}/${op}`);
      if (r.job) setJob(r.job.id);
      if (op === "delete") location.hash = "/";
    } catch (e) {
      toastError(e);
    }
  };
  const running = inst.status === "running" || inst.status === "queued";

  return (
    <>
      <div className="topbar">
        <a href="#/" className="muted">
          ← Dashboard
        </a>
        <h1 className="mono">{inst.name}</h1>
        <StatusPill status={inst.status} />
        {inst.cluster && <span className="badge grape">cluster:{inst.cluster}</span>}
        <span className="badge">{inst.profile}</span>
        {inst.modelLabel && <span className="badge berry">{inst.modelLabel}</span>}
        <div className="spacer" />
        {inst.status === "stopped" || inst.status === "error" ? (
          <button className="btn" onClick={() => act("start")}>
            ▶ Start
          </button>
        ) : (
          <button className="btn" onClick={() => act("stop")}>
            ■ Stop
          </button>
        )}
        <button className="btn" onClick={() => act("restart")}>
          Restart
        </button>
        <button className="btn" onClick={() => act("reprovision")}>
          Re-provision
        </button>
        <Help topic="reprovision" />
        {state.config.shellEnabled && (
          <a className="btn" href={`#/shell/${encodeURIComponent(inst.id)}`}>
            ›_ Shell
          </a>
        )}
        <button className="btn danger" onClick={() => act("delete")}>
          Delete
        </button>
      </div>
      <div className="page" style={{ gap: 14 }}>
        {inst.lastError && inst.status === "error" && <div className="notice err">{inst.lastError}</div>}
        {(inst.configDrift || inst.repoDrift) && (
          <div className="notice warn">
            <Help topic="drift" />
            <span>
              This instance is running an older config{inst.repoDrift ? " / tracked-repo commit" : ""}.{" "}
              {inst.pendingRestart ? "It will update after the current run settles." : "Re-provision to update it."}
            </span>
          </div>
        )}
        {job && <JobLog jobId={job} height={160} />}
        <div className="tabs">
          {(["chat", "packages", "logs", "info"] as const).map((t) => (
            <div key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
              {t === "chat" ? "Transcript" : t[0].toUpperCase() + t.slice(1)}
            </div>
          ))}
        </div>

        {tab === "chat" && (
          <>
            <div className="transcript">
              {!entries.length && !streaming && <Empty icon="💬" title="No messages yet" />}
              {entries.map((e, i) => (
                <EntryView key={i} e={e} />
              ))}
              {streaming && (
                <div className="msg assistant">
                  <div className="msg-role">assistant · streaming</div>
                  <div className="bubble">{streaming}▍</div>
                </div>
              )}
              <div ref={endRef} />
            </div>
            <div className="cmdbar" style={{ position: "sticky", bottom: 12 }}>
              <textarea
                placeholder={running ? "Steer the current run, or queue a follow-up…" : `Message ${inst.name}…  (Ctrl+Enter to send)`}
                value={msg}
                onChange={(e) => setMsg(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send(running ? "steer" : "prompt");
                }}
                disabled={inst.status === "stopped" || inst.status === "error"}
              />
              <div className="row">
                <span className="muted tiny">
                  {inst.tokens ? `${inst.tokens.toLocaleString()} tokens · ` : ""}
                  {fmtCost(inst.cost)} · session {inst.sessionId?.slice(0, 8) ?? "–"}
                </span>
                <div className="row right">
                  {running && (
                    <>
                      <button className="btn" onClick={() => post("/api/send", { ids: [id], action: "abort" }).catch(toastError)}>
                        Abort
                      </button>
                      <button className="btn" onClick={() => send("follow_up")}>
                        Queue follow-up
                      </button>
                      <button className="btn primary" onClick={() => send("steer")}>
                        Steer
                      </button>
                    </>
                  )}
                  {!running && (
                    <>
                      <button className="btn ghost" onClick={() => post("/api/send", { ids: [id], action: "new_session" }).then(() => setEntries([])).catch(toastError)}>
                        New session
                      </button>
                      <button className="btn primary" onClick={() => send("prompt")} disabled={inst.status !== "idle"}>
                        Send
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          </>
        )}

        {tab === "packages" && <InstancePackages instanceId={inst.id} />}

        {tab === "logs" && (
          <div className="col">
            <p className="section-title">pi stderr (last 20 lines)</p>
            <div className="log" style={{ minHeight: 200 }}>
              {inst.stderrTail.join("\n") || "(empty)"}
            </div>
          </div>
        )}

        {tab === "info" && (
          <div className="grid2">
            <div className="card">
              <div className="card-h">
                <h3>Instance</h3>
              </div>
              <div className="card-b">
                <table className="tbl">
                  <tbody>
                    {[
                      ["Profile", <a href="#/profiles">{inst.profile}</a>],
                      ["Deployment", inst.deployment ?? "–"],
                      ["Cluster", inst.cluster ?? "–"],
                      ["Working dir", <span className="mono">{inst.cwd ?? "(private workspace)"}</span>],
                      ["PID", inst.pid ?? "–"],
                      ["Started", timeAgo(inst.startedAt)],
                      ["Created", new Date(inst.createdAt).toLocaleString()],
                      ["Session", <span className="mono">{inst.sessionId ?? "–"}</span>],
                      ["Repo commits", Object.entries(inst.repoShas).map(([r, s]) => `${r}@${s.slice(0, 8)}`).join(", ") || "–"],
                    ].map(([k, v], i) => (
                      <tr key={i}>
                        <td className="muted">{k}</td>
                        <td>{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="card">
              <div className="card-h">
                <h3>Run pi interactively with this instance's env</h3>
              </div>
              <div className="card-b col">
                <p className="muted small" style={{ margin: 0 }}>
                  Stop the instance first so two pi processes don't write the same session. Paste into a terminal on this machine, or open the in-browser shell.
                </p>
                <div className="log" style={{ maxHeight: 200 }}>
                  {info?.command ?? "…"}
                </div>
                <div className="row">
                  <button className="btn sm" onClick={() => info && copy(info.command)}>
                    Copy command
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
      {node}
    </>
  );
}

function EntryView({ e }: { e: Entry }) {
  if (e.kind === "user")
    return (
      <div className="msg user">
        <div className="msg-role">you</div>
        <div className="bubble">{e.text}</div>
      </div>
    );
  if (e.kind === "assistant")
    return (
      <div className="msg assistant">
        <div className="msg-role">assistant</div>
        {e.thinking && (
          <details className="tool">
            <summary>thinking</summary>
            <pre className="thinking">{e.thinking}</pre>
          </details>
        )}
        {e.text && (
          <div className="bubble md-bubble">
            <Markdown text={e.text} />
          </div>
        )}
      </div>
    );
  if (e.kind === "tool") {
    const a = e.args as any;
    const summary = a?.command ?? a?.path ?? a?.file_path ?? a?.pattern ?? "";
    return (
      <details className="tool msg" style={{ maxWidth: 900 }}>
        <summary>
          <span style={{ color: e.isError ? "var(--danger)" : e.result === undefined ? "var(--mango)" : "var(--kiwi)" }}>●</span>
          <strong>{e.toolName}</strong>
          <span className="ellipsis muted">{String(summary).slice(0, 160)}</span>
        </summary>
        <pre>{`args: ${JSON.stringify(e.args, null, 2)}\n\n${e.result ?? "(running…)"}`}</pre>
      </details>
    );
  }
  if (e.kind === "error") return <div className="notice err">{e.text}</div>;
  return <div className="muted small" style={{ textAlign: "center" }}>— {e.text} —</div>;
}
