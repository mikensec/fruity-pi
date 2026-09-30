import { useEffect, useRef, useState, type ReactNode } from "react";
import { useStore, seedJobLog } from "./store";
import { get } from "./api";
import type { Status } from "./types";

// ---------------------------------------------------------------- toasts

type Toast = { id: number; text: string; err?: boolean };
let toastSeq = 0;
let toastList: Toast[] = [];
const toastSubs = new Set<(t: Toast[]) => void>();
export function toast(text: string, err = false) {
  const t = { id: ++toastSeq, text, err };
  toastList = [...toastList, t];
  toastSubs.forEach((f) => f(toastList));
  setTimeout(() => {
    toastList = toastList.filter((x) => x.id !== t.id);
    toastSubs.forEach((f) => f(toastList));
  }, err ? 7000 : 3500);
}
export function toastError(e: unknown) {
  toast(e instanceof Error ? e.message : String(e), true);
}
export function Toasts() {
  const [list, setList] = useState<Toast[]>([]);
  useEffect(() => {
    toastSubs.add(setList);
    return () => {
      toastSubs.delete(setList);
    };
  }, []);
  return (
    <div className="toasts">
      {list.map((t) => (
        <div key={t.id} className={`toast ${t.err ? "err" : ""}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- overlays

export function Modal({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true">
        <div className="modal-h">
          <h2>{title}</h2>
          <button className="btn ghost icon right" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-b">{children}</div>
        {footer && <div className="modal-f">{footer}</div>}
      </div>
    </div>
  );
}

export function Drawer({ title, onClose, children, actions }: { title: ReactNode; onClose: () => void; children: ReactNode; actions?: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <>
      <div className="overlay" style={{ background: "rgba(5,4,8,.4)" }} onMouseDown={onClose} />
      <aside className="drawer">
        <div className="modal-h">
          <h2 className="ellipsis">{title}</h2>
          <div className="row right nowrap">
            {actions}
            <button className="btn ghost icon" onClick={onClose} aria-label="Close">
              ✕
            </button>
          </div>
        </div>
        <div className="drawer-b">{children}</div>
      </aside>
    </>
  );
}

/** In-page confirmation (no window.confirm). */
export function useConfirm() {
  const [pending, setPending] = useState<{ text: ReactNode; danger?: boolean; label?: string; resolve: (v: boolean) => void } | null>(null);
  const confirm = (text: ReactNode, opts: { danger?: boolean; label?: string } = {}) =>
    new Promise<boolean>((resolve) => setPending({ text, ...opts, resolve }));
  const node = pending ? (
    <Modal
      title="Are you sure?"
      onClose={() => {
        pending.resolve(false);
        setPending(null);
      }}
      footer={
        <>
          <button
            className="btn"
            onClick={() => {
              pending.resolve(false);
              setPending(null);
            }}
          >
            Cancel
          </button>
          <button
            className={`btn ${pending.danger ? "danger" : "primary"}`}
            autoFocus
            onClick={() => {
              pending.resolve(true);
              setPending(null);
            }}
          >
            {pending.label ?? "Confirm"}
          </button>
        </>
      }
    >
      <div>{pending.text}</div>
    </Modal>
  ) : null;
  return { confirm, node };
}

// ---------------------------------------------------------------- bits

export function StatusPill({ status }: { status: Status }) {
  return (
    <span className={`status ${status}`}>
      <span className="dot" />
      {status}
    </span>
  );
}

export function Switch({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </label>
  );
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.value} className={o.value === value ? "on" : ""} onClick={() => onChange(o.value)} type="button">
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Empty({ icon, title, children }: { icon: string; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="big">{icon}</div>
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function Spinner() {
  return <span className="status starting" style={{ gap: 0 }}><span className="dot" /></span>;
}

/** Live-streaming log for a background job. */
export function JobLog({ jobId, height = 260 }: { jobId: string; height?: number }) {
  const lines = useStore((s) => s.jobLogs[jobId]);
  const job = useStore((s) => s.state?.jobs.find((j) => j.id === jobId));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    get(`/api/jobs/${jobId}`)
      .then((j) => seedJobLog(jobId, j.log))
      .catch(() => {});
  }, [jobId]);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [lines?.length]);
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row small">
        <strong>{job?.title ?? "Job"}</strong>
        {job && <span className={`badge ${job.status === "done" ? "kiwi" : job.status === "failed" ? "straw" : "mango"}`}>{job.status}</span>}
      </div>
      <div className="log" ref={ref} style={{ height }}>
        {(lines ?? []).join("\n") || "…"}
      </div>
    </div>
  );
}

export function timeAgo(iso?: string) {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}

export function fmtCost(n: number) {
  return n ? `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}` : "$0";
}

export function useTick(ms = 5000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

export function download(filename: string, content: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied to clipboard");
  } catch {
    toast("Copy failed — select and copy manually", true);
  }
}

// ---------------------------------------------------------------- safe markdown → React (no innerHTML)

function inline(text: string, key = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(!\[([^\]]*)\]\((https?:[^)\s]+)\))|(\[([^\]]+)\]\((https?:[^)\s]+)\))|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = key * 1000;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<code key={k++}>{m[1].slice(1, -1)}</code>);
    else if (m[2]) out.push(<img key={k++} alt={m[3]} src={m[4]} loading="lazy" referrerPolicy="no-referrer" />);
    else if (m[5])
      out.push(
        <a key={k++} href={m[7]} target="_blank" rel="noreferrer noopener">
          {m[6]}
        </a>,
      );
    else if (m[8]) out.push(<strong key={k++}>{m[9]}</strong>);
    else if (m[10]) out.push(<em key={k++}>{m[11]}</em>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, "").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) code.push(lines[i++]);
      i++;
      blocks.push(
        <pre key={key++}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lvl = Math.min(3, h[1].length);
      const H = `h${lvl}` as "h1";
      blocks.push(<H key={key++}>{inline(h[2], key)}</H>);
      i++;
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*+]|\d+\.)\s+/, ""));
      blocks.push(
        <ul key={key++}>
          {items.map((it, j) => (
            <li key={j}>{inline(it, key * 100 + j)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !lines[i].startsWith("```") && !/^#{1,6}\s/.test(lines[i]) && !/^\s*([-*+]|\d+\.)\s+/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={key++}>{inline(para.join(" "), key)}</p>);
  }
  return <div className="md">{blocks}</div>;
}
