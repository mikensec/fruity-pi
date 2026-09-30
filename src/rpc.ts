import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { JsonlSplitter } from "./jsonl.js";

export interface RpcResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: any;
  error?: string;
}

export interface RpcOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/**
 * One pi process in `--mode rpc`. Emits:
 *  - "event"  (record)   every non-response stdout record
 *  - "stderr" (line)
 *  - "exit"   (code, signal)
 */
export class PiRpc extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { resolve: (r: RpcResponse) => void; timer: NodeJS.Timeout }>();
  private seq = 0;
  exited = false;

  constructor(private opts: RpcOptions) {
    super();
  }

  get pid() {
    return this.child?.pid;
  }

  start() {
    const child = spawn(this.opts.command, this.opts.args, {
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    const out = new JsonlSplitter((line) => this.onRecord(line));
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stdout.on("end", () => out.end());
    const err = new JsonlSplitter((line) => this.emit("stderr", line));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.stderr.on("end", () => err.end());
    child.stdin.on("error", () => {});
    child.on("error", (e) => this.emit("stderr", `spawn error: ${e.message}`));
    child.on("exit", (code, signal) => {
      this.exited = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.resolve({ type: "response", command: "unknown", success: false, error: "pi process exited" });
      }
      this.pending.clear();
      this.emit("exit", code, signal);
    });
  }

  private onRecord(line: string) {
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      this.emit("stderr", `unparseable stdout: ${line.slice(0, 500)}`);
      return;
    }
    if (rec?.type === "response" && typeof rec.id === "string" && this.pending.has(rec.id)) {
      const p = this.pending.get(rec.id)!;
      this.pending.delete(rec.id);
      clearTimeout(p.timer);
      p.resolve(rec);
      return;
    }
    this.emit("event", rec);
  }

  /** Send a command and wait for its response (not for the run to finish). */
  send(cmd: Record<string, unknown>, timeoutMs = 30_000): Promise<RpcResponse> {
    if (!this.child || this.exited) {
      return Promise.resolve({ type: "response", command: String(cmd.type), success: false, error: "instance not running" });
    }
    const id = `fp-${++this.seq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ type: "response", command: String(cmd.type), success: false, error: "timeout waiting for pi" });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.child!.stdin.write(JSON.stringify({ ...cmd, id }) + "\n");
    });
  }

  /** Graceful stop: close stdin, then escalate. */
  stop(graceMs = 5000): Promise<void> {
    return new Promise((resolve) => {
      if (!this.child || this.exited) return resolve();
      const child = this.child;
      const t1 = setTimeout(() => child.kill("SIGTERM"), graceMs);
      const t2 = setTimeout(() => child.kill("SIGKILL"), graceMs * 2);
      child.once("exit", () => {
        clearTimeout(t1);
        clearTimeout(t2);
        resolve();
      });
      child.stdin.end();
    });
  }
}
