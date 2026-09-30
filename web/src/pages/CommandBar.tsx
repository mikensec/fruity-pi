import { useMemo, useRef, useState } from "react";
import { post } from "../api";
import { useAppState, useInstanceEvents } from "../store";
import { resolveSelector } from "../selectors";
import { Modal, StatusPill, toast, toastError, download, copy, Help, Markdown } from "../ui";

const ACTIONS = [
  { value: "prompt", label: "Prompt", needsMsg: true },
  { value: "steer", label: "Steer (mid-run)", needsMsg: true },
  { value: "follow_up", label: "Follow-up", needsMsg: true },
  { value: "abort", label: "Abort" },
  { value: "new_session", label: "New session" },
  { value: "compact", label: "Compact" },
  { value: "set_model", label: "Set model" },
  { value: "set_thinking", label: "Set thinking" },
  { value: "start", label: "Start" },
  { value: "stop", label: "Stop" },
  { value: "restart", label: "Restart" },
];

interface FanTarget {
  id: string;
  name: string;
  text: string;
  done: boolean;
  error?: string;
}

export function CommandBar({ selectedIds, onClearSelection }: { selectedIds: string[]; onClearSelection: () => void }) {
  const state = useAppState()!;
  const [selector, setSelector] = useState("");
  const [action, setAction] = useState("prompt");
  const [message, setMessage] = useState("");
  const [model, setModel] = useState("");
  const [level, setLevel] = useState("medium");
  const [busy, setBusy] = useState(false);
  const [fan, setFan] = useState<Record<string, FanTarget> | null>(null);
  const [results, setResults] = useState<any[] | null>(null);
  const fanRef = useRef(fan);
  fanRef.current = fan;

  const matches = useMemo(() => resolveSelector(selector, state.instances, selectedIds), [selector, state.instances, selectedIds]);
  const clusters = useMemo(() => [...new Set(state.instances.map((i) => i.cluster).filter(Boolean))] as string[], [state.instances]);
  const deployments = useMemo(() => [...new Set(state.instances.map((i) => i.deployment).filter(Boolean))] as string[], [state.instances]);
  const profiles = useMemo(() => [...new Set(state.instances.map((i) => i.profile))], [state.instances]);
  const spec = ACTIONS.find((a) => a.value === action)!;

  useInstanceEvents(
    (id, ev) => {
      if (!fanRef.current?.[id]) return;
      // Functional update: many deltas can arrive between renders; each must build on the latest text.
      setFan((f) => {
        const t = f?.[id];
        if (!f || !t) return f;
        let next: FanTarget | undefined;
        if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") next = { ...t, text: t.text + ev.assistantMessageEvent.delta };
        else if (ev.type === "tool_execution_start") next = { ...t, text: t.text + `\n⚙ ${ev.toolName}\n` };
        else if (ev.type === "agent_settled") next = { ...t, done: true };
        else if (ev.type === "message_end" && ev.message?.stopReason === "error") next = { ...t, error: ev.message.errorMessage };
        return next ? { ...f, [id]: next } : f;
      });
    },
    [],
  );

  const addChip = (c: string) => {
    const parts = selector.split(",").map((s) => s.trim()).filter(Boolean);
    setSelector(parts.includes(c) ? parts.filter((p) => p !== c).join(", ") : [...parts, c].join(", "));
  };

  const send = async () => {
    if (!matches.length) return toast("Selector matches no instances", true);
    if (spec.needsMsg && !message.trim()) return toast("Type a message first", true);
    setBusy(true);
    // Start listening BEFORE sending: fast models can finish before the request returns.
    if (action === "prompt") {
      const f: Record<string, FanTarget> = {};
      for (const m of matches) f[m.id] = { id: m.id, name: m.name, text: "", done: false };
      fanRef.current = f;
      setFan(f);
      setResults(null);
    }
    try {
      const r = await post("/api/send", { selector, ids: selectedIds, action, message, model, level });
      const ok = r.results.filter((x: any) => x.ok).length;
      toast(`${spec.label} → ${ok}/${r.results.length} instance(s)`, ok < r.results.length);
      if (action === "prompt") {
        setFan((cur) => {
          const next: Record<string, FanTarget> = {};
          for (const x of r.results) next[x.id] = x.ok ? (cur?.[x.id] ?? { id: x.id, name: x.name, text: "", done: false }) : { id: x.id, name: x.name, text: "", done: true, error: x.error };
          return next;
        });
        setMessage("");
      }
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const collect = async () => {
    try {
      const r = await post("/api/collect", { ids: Object.keys(fan ?? {}) });
      setResults(r.results);
    } catch (e) {
      toastError(e);
    }
  };

  const fanList = fan ? Object.values(fan) : [];
  const doneN = fanList.filter((t) => t.done).length;

  return (
    <>
      <div className="cmdbar">
        <div className="row nowrap">
          <span className="section-title nowrap">Target</span>
          <Help topic="selector" />
          <input
            className="target grow"
            placeholder={selectedIds.length ? `${selectedIds.length} selected (+ optional selector)` : "all · cluster:reviewers · profile:docs · writers-3 · review*"}
            value={selector}
            onChange={(e) => setSelector(e.target.value)}
          />
          <span className={`badge ${matches.length ? "kiwi" : ""}`}>{matches.length} match</span>
          <Help topic="action" />
          <select value={action} onChange={(e) => setAction(e.target.value)} style={{ width: 170 }}>
            {ACTIONS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
        <div className="chips">
          <span className={`chip ${selector.includes("all") ? "on" : ""}`} onClick={() => addChip("all")}>
            all
          </span>
          {clusters.map((c) => (
            <span key={c} className={`chip ${selector.includes(`cluster:${c}`) ? "on" : ""}`} onClick={() => addChip(`cluster:${c}`)}>
              cluster:{c}
            </span>
          ))}
          {deployments.map((d) => (
            <span key={d} className={`chip ${selector.includes(`deployment:${d}`) ? "on" : ""}`} onClick={() => addChip(`deployment:${d}`)}>
              deployment:{d}
            </span>
          ))}
          {profiles.map((p) => (
            <span key={p} className={`chip ${selector.includes(`profile:${p}`) ? "on" : ""}`} onClick={() => addChip(`profile:${p}`)}>
              profile:{p}
            </span>
          ))}
          {selectedIds.length > 0 && (
            <span className="chip on" onClick={onClearSelection} title="Clear checkbox selection">
              ✓ {selectedIds.length} selected ✕
            </span>
          )}
        </div>
        {spec.needsMsg || action === "compact" ? (
          <div className="row nowrap" style={{ alignItems: "flex-end" }}>
            <textarea
              className="grow"
              placeholder={action === "compact" ? "Optional compaction instructions…" : "Message to send to every matched instance…  (tip: /skill:name works too)"}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
              }}
              rows={2}
            />
            <button className="btn primary" style={{ height: 44, minWidth: 110 }} onClick={send} disabled={busy}>
              Send ⏎
            </button>
          </div>
        ) : (
          <div className="row">
            {action === "set_model" && <input className="mono-input" style={{ width: 320 }} placeholder="provider/model-id" value={model} onChange={(e) => setModel(e.target.value)} />}
            {action === "set_thinking" && (
              <select style={{ width: 160 }} value={level} onChange={(e) => setLevel(e.target.value)}>
                {["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((l) => (
                  <option key={l}>{l}</option>
                ))}
              </select>
            )}
            <button className="btn primary" onClick={send} disabled={busy}>
              {spec.label} {matches.length} instance(s)
            </button>
          </div>
        )}
        <div className="muted tiny">
          <span className="kbd">Ctrl</span>+<span className="kbd">Enter</span> to send · prompts beyond the concurrency limit ({state.stats.maxConcurrent}) queue automatically
        </div>
      </div>

      {fan && (
        <div className="card">
          <div className="card-h">
            <h3>Fan-out</h3>
            <span className="badge kiwi">{doneN} done</span>
            <span className="badge mango">{fanList.length - doneN} in flight</span>
            {fanList.some((t) => t.error) && <span className="badge straw">{fanList.filter((t) => t.error).length} error</span>}
            <div className="row right">
              <button className="btn sm" onClick={collect}>
                Collect results
              </button>
              <button className="btn sm ghost" onClick={() => setFan(null)}>
                Dismiss
              </button>
            </div>
          </div>
          <div className="card-b">
            <div className="fan">
              {fanList.map((t) => {
                const inst = state.instances.find((i) => i.id === t.id);
                return (
                  <div className="fan-col" key={t.id}>
                    <div className="fan-col-h">
                      <a href={`#/instance/${encodeURIComponent(t.id)}`}>{t.name}</a>
                      <span className="right">{inst && <StatusPill status={inst.status} />}</span>
                    </div>
                    <div className="fan-col-b" style={t.done && t.text ? { whiteSpace: "normal" } : undefined}>
                      {t.error ? (
                        <span style={{ color: "var(--danger)" }}>{t.error}</span>
                      ) : t.text ? (
                        t.done ? <Markdown text={t.text} /> : t.text
                      ) : (
                        <span className="muted">{inst?.status === "queued" ? "queued…" : "waiting…"}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {results && <Results results={results} onClose={() => setResults(null)} />}
    </>
  );
}

function Results({ results, onClose }: { results: any[]; onClose: () => void }) {
  const md = results.map((r) => `## ${r.name}${r.cluster ? ` (cluster:${r.cluster})` : ""}\n\n${r.text ?? "_no answer_"}\n`).join("\n");
  return (
    <Modal
      title={`Results from ${results.length} instance(s)`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={() => copy(md)}>
            Copy Markdown
          </button>
          <button className="btn" onClick={() => download("fruity-pi-results.md", md, "text/markdown")}>
            Export .md
          </button>
          <button className="btn" onClick={() => download("fruity-pi-results.json", JSON.stringify(results, null, 2), "application/json")}>
            Export .json
          </button>
          <button className="btn primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="fan" style={{ gridAutoColumns: "minmax(320px, 1fr)" }}>
        {results.map((r) => (
          <div className="fan-col" key={r.id} style={{ maxHeight: "65vh" }}>
            <div className="fan-col-h">
              {r.name}
              <span className="right">
                <StatusPill status={r.status} />
              </span>
            </div>
            <div className="fan-col-b" style={{ whiteSpace: "normal" }}>{r.text ? <Markdown text={r.text} /> : <span className="muted">no answer yet</span>}</div>
          </div>
        ))}
      </div>
    </Modal>
  );
}
