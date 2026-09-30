import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pty from "node-pty";
import type { WebSocket } from "ws";
import { loadConfig } from "./config.js";
import { paths, ensureDir, APP_DIR } from "./paths.js";
import { instanceEnv } from "./pi.js";
import { store } from "./store.js";
import { audit } from "./audit.js";
import { getInstance, instanceCwd } from "./supervisor.js";

let active = 0;
const MAX_SHELLS = 8;

/**
 * Attach a WebSocket to a fresh PTY running a login shell as the server's own
 * (unprivileged) user. With `instanceId`, the shell gets that instance's
 * isolated env + cwd so `pi` inside it sees exactly what the instance sees.
 */
export function attachShell(ws: WebSocket, opts: { instanceId?: string; ip?: string; cols?: number; rows?: number }) {
  const cfg = loadConfig();
  if (!cfg.shellEnabled || cfg.shellLocked) {
    ws.close(4403, "shell disabled");
    return;
  }
  if (process.getuid?.() === 0) {
    ws.close(4403, "refusing to open a root shell");
    return;
  }
  if (active >= MAX_SHELLS) {
    ws.close(4429, "too many shells");
    return;
  }

  let env: Record<string, string>;
  let cwd: string;
  let label = "host";
  if (opts.instanceId) {
    const inst = getInstance(opts.instanceId);
    env = { ...instanceEnv(inst, store.get("profile", inst.profile)), TERM: "xterm-256color" };
    // Put the bundled pi on PATH inside instance shells.
    env.PATH = `${path.join(APP_DIR, "node_modules", ".bin")}:${env.PATH}`;
    cwd = instanceCwd(inst);
    label = `instance:${inst.name}`;
  } else {
    env = { ...(process.env as Record<string, string>), TERM: "xterm-256color" };
    cwd = os.homedir();
  }
  const shell = process.env.SHELL || "/bin/bash";
  const term = pty.spawn(shell, ["-l"], {
    name: "xterm-256color",
    cols: clamp(opts.cols ?? 120, 20, 500),
    rows: clamp(opts.rows ?? 32, 5, 200),
    cwd,
    env,
  });
  active++;
  const started = Date.now();
  audit("shell.open", { target: label, pid: term.pid }, opts.ip);

  let rec: fs.WriteStream | undefined;
  if (cfg.recordShell) {
    ensureDir(paths.shellRecordings);
    const file = path.join(paths.shellRecordings, `${new Date().toISOString().replace(/[:.]/g, "-")}-${label.replace(/[^\w-]/g, "_")}.cast`);
    rec = fs.createWriteStream(file, { mode: 0o600 });
    rec.write(JSON.stringify({ version: 2, width: opts.cols ?? 120, height: opts.rows ?? 32, timestamp: Math.floor(started / 1000), title: label }) + "\n");
  }
  const t = () => (Date.now() - started) / 1000;

  term.onData((d) => {
    if (ws.readyState === ws.OPEN) ws.send(d);
    rec?.write(JSON.stringify([t(), "o", d]) + "\n");
  });
  term.onExit(() => {
    if (ws.readyState === ws.OPEN) ws.close(1000, "shell exited");
  });
  ws.on("message", (raw: Buffer, isBinary: boolean) => {
    const s = raw.toString("utf8");
    // Control frames are JSON text; keystrokes are sent as binary.
    if (!isBinary && s.startsWith("{")) {
      try {
        const m = JSON.parse(s);
        if (m.type === "resize") term.resize(clamp(m.cols, 20, 500), clamp(m.rows, 5, 200));
        return;
      } catch {
        /* treat as input */
      }
    }
    term.write(s);
    rec?.write(JSON.stringify([t(), "i", s]) + "\n");
  });
  ws.on("close", () => {
    active--;
    try {
      term.kill();
    } catch {
      /* already gone */
    }
    rec?.end();
    audit("shell.close", { target: label, seconds: Math.round(t()) }, opts.ip);
  });
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, Math.floor(Number(n) || lo)));
}
