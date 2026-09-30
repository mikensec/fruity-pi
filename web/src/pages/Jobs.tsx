import { useState } from "react";
import { useAppState } from "../store";
import { Drawer, JobLog, timeAgo } from "../ui";

export function JobsButton() {
  const state = useAppState();
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<string>();
  const jobs = state?.jobs ?? [];
  const running = jobs.filter((j) => j.status === "running").length;
  return (
    <>
      <div className="nav-item" onClick={() => setOpen(true)}>
        <span style={{ width: 18, textAlign: "center", opacity: 0.8 }}>☰</span>
        Activity
        {running > 0 ? <span className="count" style={{ color: "var(--mango)" }}>{running} running</span> : jobs.length > 0 && <span className="count">{jobs.length}</span>}
      </div>
      {open && (
        <Drawer title="Activity" onClose={() => setOpen(false)}>
          {!jobs.length && <span className="muted">No background jobs yet.</span>}
          {sel && <JobLog jobId={sel} height={300} />}
          {jobs.map((j) => (
            <div key={j.id} className="res" style={{ cursor: "pointer", borderColor: sel === j.id ? "var(--straw)" : undefined }} onClick={() => setSel(j.id)}>
              <span className={`badge ${j.status === "done" ? "kiwi" : j.status === "failed" ? "straw" : "mango"}`} style={{ width: 64, justifyContent: "center" }}>
                {j.status}
              </span>
              <span className="grow ellipsis small">{j.title}</span>
              <span className="muted tiny nowrap">{timeAgo(j.startedAt)}</span>
            </div>
          ))}
        </Drawer>
      )}
    </>
  );
}
